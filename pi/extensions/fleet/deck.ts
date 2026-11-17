/**
 * pi-deck server layer (docs/pi-deck-design.md §4, §5, §7, §8; phase 1): the private tmux server
 * `tmux -L pifleet -f ~/env/pi/deck.tmux.conf`, its `pool` of hidden panes, the right slot, slot
 * sizes, the preview holder, lazy nvim pairing, and deck.sock. Not an extension module (index.ts
 * does not load it): the CLI (cli.ts) and the list process use it, and extension modules may import
 * its functions. No module-level state: servers and list handles are returned as objects.
 *
 * Layout (tmux is the source of truth; every function re-reads it):
 *   session `deck`, window `deck`: pane 0 = the list (@pi_fleet_role=list), pane 1 = the slot.
 *   session `pool` (never attached): one window per hidden pane, window-size manual, all at the
 *     slot size: pi panes (run-pi), nvim panes (lazy), the preview holder (one), an anchor (one,
 *     keeps the session alive when every other pane is shown or gone).
 *   Pane options: @pi_fleet_role list|pi|nvim|preview|anchor, @pi_fleet_session, @pi_fleet_peer
 *     (pi <-> nvim), @pi_fleet_nvim_sock, @pi_fleet_shown=nvim (on a pi whose nvim was in the slot
 *     when the slot moved on). Global options: @deck_tui_pid, @deck_bin, @deck_list_pct,
 *     @deck_outer (`socket|client` of the last popup, bin/pi-deck-attach), @deck_jump.
 *
 * deck.sock (<runtime dir>/deck.sock; deck-<name>.sock for a non-default deck socket): NDJSON, one
 * reply line per request, private bind + rename, 64 KB line cap, 2 s idle.
 *   {"type":"ping"}                                          → {ok,pid}
 *   {"type":"open","cwd":D,"piArgs":[…],"focus":bool}        → {ok,session,pane,created}
 *   {"type":"open","session":F|ID,"piArgs":[…],"focus":bool} → {ok,session,pane,created} |
 *                                                              {ok:false,error[,outside:{socket,pane,windowIndex}]}
 *   {"type":"select","session":ID,"focus":bool}              → {ok,session,pane}
 * `focus` defaults to true for open, false for select.
 *
 * Environment: PI_FLEET_DECK_SOCKET (deck tmux socket name, or a path; default `pifleet`),
 * PI_FLEET_DECK_CONF (default <repo>/pi/deck.tmux.conf), PI_FLEET_TMUX_GUARD (refuse `default` and
 * `pifleet`), plus cli.ts's PI_FLEET_* (runtime dir, state dir, pi/nvim commands).
 */

import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	PASS_ENV,
	clearStaleSocket,
	ctlSockPath,
	fmtLiteral,
	guardedSocket,
	nvimSockPath,
	readStatus,
	resolveSession,
	runtimeDir,
	shQuote,
	which,
	words,
} from "./cli.ts";

// ---------------------------------------------------------------- names and paths

export const DECK_SESSION = "deck";
export const POOL_SESSION = "pool";
/** The list pane and the right slot (exact session and window names). */
export const LIST_TARGET = "=deck:=deck.0";
export const SLOT_TARGET = "=deck:=deck.1";
export const DECK_WINDOW_TARGET = "=deck:=deck";
/** The pool session (`=pool:` as a session target; `=pool:=NAME` for one of its windows). */
export const POOL_TARGET = "=pool:";
export const DEFAULT_LIST_PCT = 50;
export const DECK_SOCK_MAX_LINE = 64 * 1024;
export const DECK_SOCK_IDLE_MS = 2000;

const SLEEP_FOREVER = "exec sleep 2147483647";
/** The preview holder: a silent tty the list writes frames to (`#{pane_tty}`). */
export const HOLDER_CMD = `stty -echo -icanon 2>/dev/null; printf '\\033[?25l'; ${SLEEP_FOREVER}`;
const ANCHOR_CMD = SLEEP_FOREVER;

/**
 * Pool panes (pi, nvim) run under this sh: when the program exits it marks the pane
 * @pi_fleet_exited=<status> and wakes the list (SIGUSR2), which then kills the pane. tmux 3.2a
 * sometimes loses the SIGCHLD of a pane (the pane-died hook then fires only at the next child
 * exit), so the list must not depend on pane-died alone. `trap :` keeps the sh alive through a
 * stray SIGINT/SIGQUIT while the program decides (caught signals reset to default in the child).
 */
export const POOL_WRAP =
	'trap : INT QUIT; "$@"; s=$?; tmux set-option -p -t "$TMUX_PANE" @pi_fleet_exited "$s" \\; ' +
	"run-shell -b 'kill -USR2 #{@deck_tui_pid} 2>/dev/null; true' >/dev/null 2>&1; exit \"$s\"";

/**
 * The list pane's command: `pi-fleet deck` restarted in place if it ever exits (a crash), so the list
 * does not depend on pane-died either; the deck config's pane-died hook still respawns a dead list.
 */
export const LIST_LOOP = 'while :; do "$0" deck; sleep 0.3; done';
export function listCommand(env: NodeJS.ProcessEnv = process.env): string[] {
	return ["sh", "-c", LIST_LOOP, env.PI_FLEET_BIN || "pi-fleet"];
}

function uid(): number {
	return process.getuid?.() ?? 0;
}

/** The deck's tmux socket: $PI_FLEET_DECK_SOCKET (a name, or a path with `/`), default `pifleet`. */
export function deckSocketName(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_FLEET_DECK_SOCKET || "pifleet";
}

/** The deck socket's full path (what $TMUX and status files name). */
export function deckSocketPath(env: NodeJS.ProcessEnv = process.env): string {
	const name = deckSocketName(env);
	if (name.includes("/")) return resolve(name);
	return join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid()}`, name);
}

/** `-L name` / `-S path` for the deck server. PI_FLEET_TMUX_GUARD refuses `default` and `pifleet`. */
export function deckTmuxArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	const name = deckSocketName(env);
	if (env.PI_FLEET_TMUX_GUARD && guardedSocket(name)) {
		throw new Error(`pi-fleet: PI_FLEET_TMUX_GUARD refuses the deck socket ${name}`);
	}
	return name.includes("/") ? ["-S", name] : ["-L", name];
}

/** ~/env/pi/deck.tmux.conf (this file is pi/extensions/fleet/deck.ts), or $PI_FLEET_DECK_CONF. */
export function deckConfPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_FLEET_DECK_CONF || fileURLToPath(new URL("../../deck.tmux.conf", import.meta.url));
}

/** <runtime dir>/deck.sock (deck-<name>.sock for another deck socket, so tests never meet the real one). */
export function deckSockPath(env: NodeJS.ProcessEnv = process.env): string {
	const name = deckSocketName(env);
	const file = name === "pifleet" ? "deck.sock" : `deck-${basename(name).replace(/[^\w.-]/g, "_")}.sock`;
	return join(runtimeDir(env), file);
}

/** This process runs inside the deck server (a deck pi, nvim or the list). */
export function inDeck(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.PI_FLEET_DECK === "1") return true;
	const socket = env.TMUX?.split(",")[0];
	return !!socket && resolve(socket) === deckSocketPath(env);
}

// Variables that belong to one pane or one pi process, never to the deck server's environment.
const SERVER_DROP = [
	"TMUX",
	"TMUX_PANE",
	"PI_FLEET_TMUX_SOCKET",
	"PI_FLEET_SESSION",
	"PI_FLEET_OPENING",
	"PI_FLEET_PI_PANE",
	"PI_FLEET_CTL_SOCK",
	"PI_FLEET_DECK",
	"PI_CODING_AGENT",
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
];

function sshLink(): string | undefined {
	const link = join(homedir(), ".ssh", "ssh_auth_sock");
	return existsSync(link) ? link : undefined;
}

/** The environment a new deck server starts with: the caller's, minus per-pane variables, plus the stable agent link. */
export function deckServerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...env };
	for (const name of SERVER_DROP) delete out[name];
	const link = sshLink();
	if (link) out.SSH_AUTH_SOCK = link;
	return out;
}

/** `-e NAME=VALUE` for a new deck pane (cli.ts PASS_ENV without the outer socket). */
export function deckPaneEnv(env: NodeJS.ProcessEnv = process.env): string[] {
	const out: string[] = [];
	for (const name of PASS_ENV) {
		if (name === "PI_FLEET_TMUX_SOCKET") continue;
		if (env[name] !== undefined) out.push("-e", `${name}=${env[name]}`);
	}
	const link = sshLink();
	if (link) out.push("-e", `SSH_AUTH_SOCK=${link}`);
	return out;
}

// ---------------------------------------------------------------- tmux

/** Run tmux on the deck server (argument array, `";"` separates commands). Rejects with tmux's stderr. */
export function deckTmux(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
	let base: string[];
	try {
		base = deckTmuxArgs(env);
	} catch (error) {
		return Promise.reject(error);
	}
	return new Promise((res, rej) => {
		execFile("tmux", [...base, ...args], { timeout: 5000, env: deckServerEnv(env) }, (error, stdout, stderr) => {
			if (error) rej(new Error(String(stderr).trim() || error.message));
			else res(String(stdout).replace(/\n$/, ""));
		});
	});
}

async function deckTmuxOk(args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
	try {
		await deckTmux(args, env);
		return true;
	} catch {
		return false;
	}
}

/** The deck session exists (the server runs). */
export function deckRunning(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	return deckTmuxOk(["has-session", "-t", `=${DECK_SESSION}`], env);
}

export type DeckRole = "list" | "pi" | "nvim" | "preview" | "anchor" | "";

/** One pane of the deck server. */
export interface DeckPane {
	pane: string;
	window: string;
	/** `deck` or `pool`. */
	sessionName: string;
	windowName: string;
	index: number;
	role: DeckRole;
	session: string;
	peer: string;
	nvimSock: string;
	/** `nvim` when the nvim was in the slot as the slot moved on (showSession shows it again). */
	shown: string;
	dead: boolean;
	deadStatus: number | undefined;
	width: number;
	height: number;
	cwd: string;
	tty: string;
	pid: number;
	/** The program in a pool pane exited (POOL_WRAP) with this status; the pane is about to go. */
	exited: string;
	/** dead, or exited: the pane is finished. */
	gone: boolean;
	inSlot: boolean;
	isList: boolean;
}

const DECK_PANE_FORMAT = [
	"#{pane_id}",
	"#{window_id}",
	"#{session_name}",
	"#{window_name}",
	"#{pane_index}",
	"#{@pi_fleet_role}",
	"#{@pi_fleet_session}",
	"#{@pi_fleet_peer}",
	"#{@pi_fleet_nvim_sock}",
	"#{@pi_fleet_shown}",
	"#{pane_dead}",
	"#{pane_dead_status}",
	"#{pane_width}",
	"#{pane_height}",
	"#{pane_current_path}",
	"#{pane_tty}",
	"#{pane_pid}",
	"#{@pi_fleet_exited}",
].join("\t");

function parseDeckPane(line: string): DeckPane {
	const f = line.split("\t");
	const inDeckWindow = f[2] === DECK_SESSION && f[3] === DECK_SESSION;
	return {
		pane: f[0],
		window: f[1],
		sessionName: f[2],
		windowName: f[3],
		index: Number(f[4]),
		role: (f[5] ?? "") as DeckRole,
		session: f[6] ?? "",
		peer: f[7] ?? "",
		nvimSock: f[8] ?? "",
		shown: f[9] ?? "",
		dead: f[10] === "1",
		deadStatus: f[11] ? Number(f[11]) : undefined,
		width: Number(f[12]),
		height: Number(f[13]),
		cwd: f[14] ?? "",
		tty: f[15] ?? "",
		pid: Number(f[16]),
		exited: f[17] ?? "",
		gone: f[10] === "1" || !!f[17],
		inSlot: inDeckWindow && f[4] === "1",
		isList: inDeckWindow && f[4] === "0",
	};
}

/** Every pane of the deck server (deck and pool); [] if it does not run. */
export async function deckPanes(env: NodeJS.ProcessEnv = process.env): Promise<DeckPane[]> {
	try {
		const out = await deckTmux(["list-panes", "-a", "-F", DECK_PANE_FORMAT], env);
		return out ? out.split("\n").map(parseDeckPane) : [];
	} catch {
		return [];
	}
}

/** One deck pane by id, or undefined. */
export async function deckPane(pane: string, env: NodeJS.ProcessEnv = process.env): Promise<DeckPane | undefined> {
	if (!/^%\d+$/.test(pane)) return undefined;
	try {
		const p = parseDeckPane(await deckTmux(["display-message", "-p", "-t", pane, DECK_PANE_FORMAT], env));
		return p.pane === pane ? p : undefined;
	} catch {
		return undefined;
	}
}

/** What the right slot shows now (read from tmux, never cached). */
export async function readSlot(env: NodeJS.ProcessEnv = process.env): Promise<DeckPane | undefined> {
	try {
		const p = parseDeckPane(await deckTmux(["display-message", "-p", "-t", SLOT_TARGET, DECK_PANE_FORMAT], env));
		return p.inSlot ? p : undefined;
	} catch {
		return undefined;
	}
}

/** The live pi pane of a deck session. */
export function sessionPiPane(panes: DeckPane[], sessionId: string): DeckPane | undefined {
	return panes.find((p) => p.role === "pi" && p.session === sessionId && !p.gone) ?? panes.find((p) => p.role === "pi" && p.session === sessionId);
}

/** The live peer of a deck pane (exists, points back, not dead). */
export function livePeerIn(panes: DeckPane[], pane: DeckPane): DeckPane | undefined {
	if (!pane.peer) return undefined;
	const peer = panes.find((p) => p.pane === pane.peer);
	return peer && peer.peer === pane.pane && !peer.gone ? peer : undefined;
}

// ---------------------------------------------------------------- sizes (§5)

export interface SlotSize {
	width: number;
	height: number;
}

/** Slot size for a deck window of W×H with the list at pct% (resize-pane -x pct% rounds down; one border column). */
export function slotSizeFor(windowWidth: number, windowHeight: number, pct: number): { listWidth: number; slot: SlotSize } {
	const listWidth = Math.max(1, Math.floor((windowWidth * pct) / 100));
	return { listWidth, slot: { width: Math.max(1, windowWidth - listWidth - 1), height: Math.max(1, windowHeight) } };
}

function parsePct(value: string | undefined): number {
	const n = Number(value);
	return Number.isFinite(n) && n >= 10 && n <= 90 ? Math.round(n) : DEFAULT_LIST_PCT;
}

export interface ApplySizesResult {
	/** A write call ran (list width, pool default-size or a pool window changed). */
	changed: boolean;
	slot: SlotSize;
	/** Pool windows resized. */
	resized: number;
}

/**
 * Keep the list at @deck_list_pct and every pool window at exactly the slot size: one read, then (only
 * if something differs) ONE tmux call with `resize-pane` + `set default-size` + every `resize-window`.
 */
export async function applySizes(env: NodeJS.ProcessEnv = process.env): Promise<ApplySizesResult | undefined> {
	let out: string;
	try {
		out = await deckTmux(
			[
				"display-message", "-p", "-t", LIST_TARGET, "#{@deck_list_pct}\t#{window_width}\t#{window_height}\t#{pane_width}", ";",
				"show-options", "-v", "-t", POOL_TARGET, "default-size", ";",
				"list-windows", "-t", POOL_TARGET, "-F", "#{window_id}\t#{window_width}\t#{window_height}",
			],
			env,
		);
	} catch {
		return undefined;
	}
	const [head, defaultSize, ...windows] = out.split("\n");
	const [pctS, wS, hS, listS] = head.split("\t");
	const { listWidth, slot } = slotSizeFor(Number(wS), Number(hS), parsePct(pctS));
	const cmds: string[][] = [];
	if (Number(listS) !== listWidth) cmds.push(["resize-pane", "-t", LIST_TARGET, "-x", String(listWidth)]);
	const size = `${slot.width}x${slot.height}`;
	if (defaultSize !== size) cmds.push(["set-option", "-t", POOL_TARGET, "default-size", size]);
	let resized = 0;
	for (const line of windows) {
		const [id, ww, wh] = line.split("\t");
		if (!id || (Number(ww) === slot.width && Number(wh) === slot.height)) continue;
		cmds.push(["resize-window", "-t", id, "-x", String(slot.width), "-y", String(slot.height)]);
		resized++;
	}
	if (!cmds.length) return { changed: false, slot, resized: 0 };
	await deckTmux(cmds.flatMap((c, i) => (i ? [";", ...c] : c)), env);
	return { changed: true, slot, resized };
}

/** The slot size as the layout is now (the slot pane's size; the computed one if the slot is missing). */
export async function currentSlotSize(env: NodeJS.ProcessEnv = process.env): Promise<SlotSize | undefined> {
	try {
		const [pct, w, h] = (await deckTmux(["display-message", "-p", "-t", LIST_TARGET, "#{@deck_list_pct}\t#{window_width}\t#{window_height}"], env)).split("\t");
		return slotSizeFor(Number(w), Number(h), parsePct(pct)).slot;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------- pool, holder, layout

function token(): string {
	return randomBytes(4).toString("hex");
}

/** `new-window` into the pool at the slot size, then (same call) window-size manual and pane options. Returns the pane id. */
async function newPoolWindow(
	kind: string,
	opts: { cwd?: string; envArgs?: string[]; options: Record<string, string>; command: string[] },
	env: NodeJS.ProcessEnv,
): Promise<string> {
	const name = `${kind}-${token()}`;
	const target = `${POOL_TARGET}=${name}`;
	const args = [
		"new-window", "-d", "-t", POOL_TARGET, "-n", name, "-P", "-F", "#{pane_id}",
		...(opts.cwd ? ["-c", fmtLiteral(opts.cwd)] : []),
		...(opts.envArgs ?? []),
		"--", ...opts.command,
		";", "set-option", "-w", "-t", target, "window-size", "manual",
	];
	for (const [k, v] of Object.entries(opts.options)) args.push(";", "set-option", "-p", "-t", target, k, v);
	return (await deckTmux(args, env)).split("\n")[0];
}

/** Create the `pool` session (anchor window, manual size) unless it exists. */
export async function ensurePool(size: SlotSize | undefined, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (await deckTmuxOk(["has-session", "-t", POOL_TARGET], env)) return;
	const s = size ?? { width: 80, height: 24 };
	try {
		await deckTmux(
			[
				"new-session", "-d", "-s", POOL_SESSION, "-n", "anchor", "-x", String(s.width), "-y", String(s.height), "sh", "-c", ANCHOR_CMD, ";",
				"set-option", "-t", POOL_TARGET, "default-size", `${s.width}x${s.height}`, ";",
				"set-option", "-w", "-t", `${POOL_TARGET}=anchor`, "window-size", "manual", ";",
				"set-option", "-p", "-t", `${POOL_TARGET}=anchor`, "@pi_fleet_role", "anchor",
			],
			env,
		);
	} catch (error) {
		if (!(await deckTmuxOk(["has-session", "-t", POOL_TARGET], env))) throw error;
	}
}

/**
 * The deck window has exactly the list and the slot: a missing slot gets the holder (joined back
 * from the pool, or a new one), extra panes go to the pool. Run with the pool present.
 */
export async function ensureLayout(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const panes = await deckPanes(env);
	const inWindow = panes.filter((p) => p.sessionName === DECK_SESSION && p.windowName === DECK_SESSION).sort((a, b) => a.index - b.index);
	if (!inWindow.length) throw new Error("deck: no deck window");
	const pct = parsePct(await deckTmux(["show-options", "-gqv", "@deck_list_pct"], env).catch(() => ""));
	for (const extra of inWindow.slice(2)) {
		await deckTmux(
			["break-pane", "-d", "-s", extra.pane, "-t", POOL_TARGET, ";", "set-option", "-w", "-t", extra.pane, "window-size", "manual"],
			env,
		);
	}
	if (inWindow.length >= 2) return;
	const holder = panes.find((p) => p.role === "preview" && p.sessionName === POOL_SESSION);
	if (holder) {
		await deckTmux(["join-pane", "-d", "-h", "-l", `${100 - pct}%`, "-s", holder.pane, "-t", inWindow[0].pane], env);
		return;
	}
	await deckTmux(
		[
			"split-window", "-d", "-h", "-l", `${100 - pct}%`, "-t", inWindow[0].pane, "sh", "-c", HOLDER_CMD, ";",
			"set-option", "-p", "-t", SLOT_TARGET, "@pi_fleet_role", "preview",
		],
		env,
	);
}

/** The preview holder pane (created in the pool if there is none). */
export async function ensureHolder(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const holder = (await deckPanes(env)).find((p) => p.role === "preview");
	if (holder) return holder.pane;
	return newPoolWindow("holder", { options: { "@pi_fleet_role": "preview" }, command: ["sh", "-c", HOLDER_CMD] }, env);
}

/** The holder's tty, for the list to write preview frames to. */
export async function holderTty(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	return (await deckPanes(env)).find((p) => p.role === "preview" && !p.gone)?.tty || undefined;
}

/**
 * The list process's setup: mark `listPane` as the list, record @deck_tui_pid/@deck_bin, create the
 * pool (anchor + holder), give the deck window its slot, and apply the sizes.
 */
export async function initDeck(listPane: string, env: NodeJS.ProcessEnv = process.env, pid = process.pid): Promise<void> {
	await deckTmux(
		[
			"set-option", "-p", "-t", listPane, "@pi_fleet_role", "list", ";",
			"set-option", "-g", "@deck_tui_pid", String(pid), ";",
			"set-option", "-g", "@deck_bin", env.PI_FLEET_BIN || "pi-fleet", ";",
			// The config makes every window manual (pool windows start at the slot size); the deck window follows its clients.
			"set-option", "-w", "-t", DECK_WINDOW_TARGET, "window-size", "latest",
		],
		env,
	);
	await ensurePool(await currentSlotSize(env), env);
	await ensureLayout(env);
	await ensureHolder(env);
	await applySizes(env);
}

// ---------------------------------------------------------------- slot

/**
 * Swap `pane` into the slot (`swap-pane -d`, no resize: pool panes are slot-sized). Before it moves
 * on, the slot's session remembers whether its nvim was shown (@pi_fleet_shown on the pi pane).
 */
export async function showPane(pane: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const panes = await deckPanes(env);
	const slot = panes.find((p) => p.inSlot);
	if (slot?.pane === pane) return;
	const args: string[] = [];
	if (slot?.role === "nvim") {
		const pi = livePeerIn(panes, slot);
		if (pi) args.push("set-option", "-p", "-t", pi.pane, "@pi_fleet_shown", "nvim", ";");
	} else if (slot?.role === "pi" && slot.shown) {
		args.push("set-option", "-pu", "-t", slot.pane, "@pi_fleet_shown", ";");
	}
	args.push("swap-pane", "-d", "-s", pane, "-t", SLOT_TARGET);
	await deckTmux(args, env);
}

/** Show a deck session in the slot: its nvim if that was shown last, else its pi. Returns the shown pane. */
export async function showSession(sessionId: string, opts: { focus?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const panes = await deckPanes(env);
	const pi = sessionPiPane(panes, sessionId);
	if (!pi) throw new Error(`deck: no pane for session ${sessionId.slice(0, 8)}`);
	const nvim = livePeerIn(panes, pi);
	const slot = panes.find((p) => p.inSlot);
	let shown: string;
	if (slot && (slot.pane === pi.pane || slot.pane === nvim?.pane)) shown = slot.pane;
	else {
		shown = pi.shown === "nvim" && nvim ? nvim.pane : pi.pane;
		await showPane(shown, env);
	}
	if (opts.focus) await focusSlot(env);
	return shown;
}

/** Show the preview holder in the slot. */
export async function showHolder(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const holder = await ensureHolder(env);
	await showPane(holder, env);
	return holder;
}

export function focusSlot(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	return deckTmux(["select-pane", "-t", SLOT_TARGET], env);
}
export function focusList(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	return deckTmux(["select-pane", "-t", LIST_TARGET], env);
}

// ---------------------------------------------------------------- sessions in the pool

/** A new pi (run-pi) in the pool at the slot size, with PI_FLEET_SESSION and PI_FLEET_DECK=1. Returns the pane. */
export async function createPoolPi(
	opts: { sessionId: string; cwd: string; piArgs: string[] },
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const self = env.PI_FLEET_BIN || "pi-fleet";
	return newPoolWindow(
		"pi",
		{
			cwd: opts.cwd,
			envArgs: ["-e", `PI_FLEET_SESSION=${opts.sessionId}`, "-e", "PI_FLEET_DECK=1", ...deckPaneEnv(env)],
			options: { "@pi_fleet_role": "pi", "@pi_fleet_session": opts.sessionId },
			command: ["sh", "-c", POOL_WRAP, "pi-fleet-pi", self, "run-pi", ...opts.piArgs],
		},
		env,
	);
}

export interface DeckOpenRequest {
	cwd?: string;
	session?: string;
	piArgs?: string[];
	focus?: boolean;
}
export interface DeckOpenResult {
	session: string;
	pane: string;
	created: boolean;
}
/** `open` refused: the session runs elsewhere. `outside` is set when it runs in the user's tmux. */
export class DeckOpenError extends Error {
	outside?: { socket?: string; pane?: string; windowIndex?: number };
	constructor(message: string, outside?: DeckOpenError["outside"]) {
		super(message);
		this.outside = outside;
	}
}

/**
 * deck.sock `open`: a session (resume, or select if it is in the deck already) or a new one in
 * `cwd`; shown in the slot and (default) focused. Refuses sessions live elsewhere.
 */
export async function deckOpen(req: DeckOpenRequest, env: NodeJS.ProcessEnv = process.env): Promise<DeckOpenResult> {
	const focus = req.focus !== false;
	let sessionId: string;
	let piArgs: string[];
	let cwd = req.cwd ? resolve(req.cwd) : undefined;
	if (req.session) {
		const found = resolveSession(req.session, env);
		sessionId = found.id;
		const panes = await deckPanes(env);
		const mine = panes.find((p) => p.role === "pi" && p.session === sessionId && !p.gone);
		if (mine) {
			const pane = await showSession(sessionId, { focus }, env);
			return { session: sessionId, pane, created: false };
		}
		const entry = readStatus(sessionId, env);
		if (entry) {
			const { status, live } = entry;
			if (live === "remote") throw new DeckOpenError(`runs on ${status.host}`);
			if (live === "live") {
				const socket = status.tmux?.socket;
				if (socket && resolve(socket) !== deckSocketPath(env)) {
					const where = status.tmux?.windowIndex !== undefined ? ` (window ${status.tmux.windowIndex})` : "";
					throw new DeckOpenError(`runs in your tmux${where}`, { socket, pane: status.tmux?.piPane, windowIndex: status.tmux?.windowIndex });
				}
				throw new DeckOpenError(`running as pid ${status.pid}`);
			}
		}
		cwd ??= found.cwd;
		piArgs = ["--session", found.file ?? req.session];
	} else {
		sessionId = randomUUID();
		piArgs = ["--session-id", sessionId];
	}
	if (!cwd || !existsSync(cwd)) cwd = homedir();
	piArgs.push(...(req.piArgs ?? []));
	const pane = await createPoolPi({ sessionId, cwd, piArgs }, env);
	await showPane(pane, env);
	if (focus) await focusSlot(env);
	return { session: sessionId, pane, created: true };
}

// ---------------------------------------------------------------- nvim (lazy)

export interface DeckPairResult {
	piPane: string;
	nvimPane: string;
	nvimSock: string;
	created: boolean;
	/** The pane now in the toggled position (with show: the slot). */
	shown?: string;
}

/**
 * `pair --deck PANE [--show]` / `prefix e`: give a deck pi its nvim (a pool pane at slot size,
 * created on first use) and, with `show`, swap the other half of the pair into PANE's place. PANE
 * may be the pi or its nvim (then the pi comes back).
 */
export async function deckPair(pane: string, opts: { show?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Promise<DeckPairResult> {
	const panes = await deckPanes(env);
	const me = panes.find((p) => p.pane === pane);
	if (!me) throw new Error(`no deck pane ${pane}`);
	if (me.role === "nvim") {
		const pi = livePeerIn(panes, me);
		if (!pi) throw new Error("the pi pane is gone");
		if (opts.show) await deckTmux(["swap-pane", "-d", "-s", pi.pane, "-t", me.pane], env);
		return { piPane: pi.pane, nvimPane: me.pane, nvimSock: me.nvimSock, created: false, shown: opts.show ? pi.pane : undefined };
	}
	if (me.role !== "pi" || !me.session) throw new Error("no pi session here");
	const peer = livePeerIn(panes, me);
	if (peer) {
		if (opts.show) await deckTmux(["swap-pane", "-d", "-s", peer.pane, "-t", me.pane], env);
		return { piPane: me.pane, nvimPane: peer.pane, nvimSock: peer.nvimSock, created: false, shown: opts.show ? peer.pane : undefined };
	}
	const session = me.session;
	const nvimCmd = words(env.PI_FLEET_NVIM_CMD, "nvim");
	const nvimBin = which(nvimCmd[0], env);
	if (!nvimBin) throw new Error(`${nvimCmd[0]} not found on PATH`);
	let sock = nvimSockPath(session, env);
	if (!(await clearStaleSocket(sock))) sock = join(runtimeDir(env), `${session}.${Date.now()}.nvim.sock`);
	const stale = me.peer ? panes.find((p) => p.pane === me.peer && p.role === "nvim") : undefined;
	const nvimPane = await newPoolWindow(
		"nvim",
		{
			cwd: me.cwd || homedir(),
			envArgs: [
				"-e", `PI_FLEET_SESSION=${session}`,
				"-e", `PI_FLEET_CTL_SOCK=${ctlSockPath(session, env)}`,
				"-e", `PI_FLEET_PI_PANE=${me.pane}`,
				"-e", "PI_FLEET_DECK=1",
				...deckPaneEnv(env),
			],
			options: { "@pi_fleet_role": "nvim", "@pi_fleet_session": session, "@pi_fleet_peer": me.pane, "@pi_fleet_nvim_sock": sock },
			command: ["sh", "-c", POOL_WRAP, "pi-fleet-nvim", nvimBin, ...nvimCmd.slice(1), "--listen", sock],
		},
		env,
	);
	const after: string[] = ["set-option", "-p", "-t", me.pane, "@pi_fleet_peer", nvimPane];
	if (opts.show) after.push(";", "swap-pane", "-d", "-s", nvimPane, "-t", me.pane);
	if (stale && stale.gone) after.push(";", "kill-pane", "-t", stale.pane);
	await deckTmux(after, env);
	return { piPane: me.pane, nvimPane, nvimSock: sock, created: true, shown: opts.show ? nvimPane : undefined };
}

/** What `prefix e` does, from node: toggle the slot between its session's pi and nvim. */
export async function toggleSlot(env: NodeJS.ProcessEnv = process.env): Promise<DeckPairResult> {
	const slot = await readSlot(env);
	if (!slot) throw new Error("no slot");
	return deckPair(slot.pane, { show: true }, env);
}

// ---------------------------------------------------------------- reconcile (pane-died → SIGUSR2)

export interface ReconcileResult {
	killed: string[];
	respawned: string[];
	/** The dead pane that was in the slot, and what replaced it. */
	slotReplaced?: { dead: string; session: string; by: string };
}

/**
 * Clean up dead panes: a dead slot pane is replaced (`replacement(session)` may name the pane to
 * show, else the holder) and killed; dead pool pi/nvim panes are killed (a killed nvim's pi loses
 * its peer); a dead holder or anchor is respawned. Also repairs the deck window's two panes.
 */
export async function reconcile(
	env: NodeJS.ProcessEnv = process.env,
	opts: { replacement?: (deadSession: string) => Promise<string | undefined> | string | undefined } = {},
): Promise<ReconcileResult> {
	const result: ReconcileResult = { killed: [], respawned: [] };
	await ensureLayout(env).catch(() => {});
	let panes = await deckPanes(env);
	const slot = panes.find((p) => p.inSlot);
	if (slot?.gone && slot.role !== "preview") {
		const by = (await opts.replacement?.(slot.session)) || (await ensureHolder(env));
		await showPane(by, env);
		result.slotReplaced = { dead: slot.pane, session: slot.session, by };
		panes = await deckPanes(env);
	}
	const cmds: string[][] = [];
	for (const p of panes) {
		if (!p.gone || p.isList) continue;
		if (p.role === "preview" || p.role === "anchor") {
			cmds.push(["respawn-pane", "-t", p.pane, "sh", "-c", p.role === "preview" ? HOLDER_CMD : ANCHOR_CMD]);
			result.respawned.push(p.pane);
			continue;
		}
		if (p.role === "nvim") {
			const pi = panes.find((q) => q.pane === p.peer && q.peer === p.pane);
			if (pi) cmds.push(["set-option", "-pu", "-t", pi.pane, "@pi_fleet_peer"], ["set-option", "-pu", "-t", pi.pane, "@pi_fleet_shown"]);
		}
		cmds.push(["kill-pane", "-t", p.pane]);
		result.killed.push(p.pane);
	}
	if (cmds.length) await deckTmux(cmds.flatMap((c, i) => (i ? [";", ...c] : c)), env);
	return result;
}

// ---------------------------------------------------------------- deck.sock

export type DeckMessage = Record<string, unknown>;
export type DeckHandler = (message: DeckMessage) => Promise<Record<string, unknown>>;

function inode(path: string): string | undefined {
	try {
		const st = lstatSync(path);
		return st.isSocket() ? `${st.dev}:${st.ino}` : undefined;
	} catch {
		return undefined;
	}
}

async function dispatchDeck(handler: DeckHandler, message: unknown): Promise<Record<string, unknown>> {
	if (!message || typeof message !== "object" || Array.isArray(message)) return { ok: false, error: "not a JSON object" };
	try {
		const reply = await handler(message as DeckMessage);
		return { ok: true, ...reply };
	} catch (error) {
		const out: Record<string, unknown> = { ok: false, error: (error as Error)?.message ?? String(error) };
		if (error instanceof DeckOpenError && error.outside) out.outside = error.outside;
		return out;
	}
}

function serveConn(sock: Socket, handler: DeckHandler): void {
	let buf = "";
	let chain: Promise<void> = Promise.resolve();
	sock.setEncoding("utf8");
	sock.setTimeout(DECK_SOCK_IDLE_MS, () => sock.destroy());
	sock.on("error", () => sock.destroy());
	const reply = (obj: Record<string, unknown>) => {
		if (!sock.destroyed) sock.write(`${JSON.stringify(obj)}\n`);
	};
	const handle = (line: string) => {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			chain = chain.then(() => reply({ ok: false, error: "bad JSON" }));
			return;
		}
		// A request may take longer than the idle timeout (tmux calls): no timeout while working.
		chain = chain.then(async () => {
			sock.setTimeout(0);
			reply(await dispatchDeck(handler, message));
			sock.setTimeout(DECK_SOCK_IDLE_MS);
		});
	};
	sock.on("end", () => {
		const line = buf.trim();
		buf = "";
		if (line && Buffer.byteLength(line) <= DECK_SOCK_MAX_LINE) handle(line);
		void chain.then(() => sock.end());
	});
	sock.on("data", (chunk: string) => {
		buf += chunk;
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (Buffer.byteLength(line) > DECK_SOCK_MAX_LINE) {
				reply({ ok: false, error: "line too long" });
				sock.end();
				return;
			}
			if (line.trim()) handle(line);
		}
		if (Buffer.byteLength(buf) > DECK_SOCK_MAX_LINE) {
			reply({ ok: false, error: "line too long" });
			sock.end();
			buf = "";
		}
	});
}

export interface DeckSockServer {
	path: string;
	close(): void;
}

/** Bind deck.sock (private path, chmod 0600, rename over the public path; the last starter wins). */
export async function serveDeckSock(handler: DeckHandler, env: NodeJS.ProcessEnv = process.env): Promise<DeckSockServer> {
	const path = deckSockPath(env);
	const tmp = join(dirname(path), `.deck.${process.pid}.${Date.now()}.sock`);
	const server: Server = createServer({ allowHalfOpen: true }, (sock) => serveConn(sock, handler));
	server.on("error", () => {});
	await new Promise<void>((res, rej) => {
		server.once("error", rej);
		server.listen(tmp, () => res());
	});
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
	const ino = inode(path);
	return {
		path,
		close() {
			server.close();
			// Only the owner unlinks: a later starter may have renamed its socket over ours.
			if (ino && inode(path) === ino) {
				try {
					unlinkSync(path);
				} catch {
					// gone
				}
			}
		},
	};
}

/** Send one NDJSON message to a socket and resolve with the parsed first reply line. */
export function ndjsonRequest(sock: string, message: DeckMessage, timeoutMs = 5000): Promise<Record<string, unknown>> {
	return new Promise((res, rej) => {
		const conn = createConnection(sock);
		let buf = "";
		let done = false;
		const finish = (error: Error | undefined, value?: Record<string, unknown>) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			conn.destroy();
			if (error) rej(error);
			else res(value!);
		};
		const timer = setTimeout(() => finish(new Error(`no reply from ${sock}`)), timeoutMs);
		conn.setEncoding("utf8");
		conn.on("connect", () => conn.write(`${JSON.stringify(message)}\n`));
		conn.on("data", (d: string) => {
			buf += d;
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			try {
				finish(undefined, JSON.parse(buf.slice(0, nl)));
			} catch {
				finish(new Error("bad reply"));
			}
		});
		conn.on("error", (e) => finish(e));
		conn.on("close", () => finish(new Error(`${sock} closed`)));
	});
}

/** A request to the deck list over deck.sock. */
export function deckRequest(message: DeckMessage, env: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000): Promise<Record<string, unknown>> {
	return ndjsonRequest(deckSockPath(env), message, timeoutMs);
}

/** Wait until deck.sock answers a ping. */
export async function waitDeckSock(env: NodeJS.ProcessEnv = process.env, timeoutMs = 3000): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			const r = await ndjsonRequest(deckSockPath(env), { type: "ping" }, 1000);
			if (r.ok) return true;
		} catch {
			// not yet
		}
		if (Date.now() > end) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** The default deck.sock handler (ping, open, select). The list TUI wraps it to follow the selection. */
export function defaultDeckHandler(env: NodeJS.ProcessEnv = process.env): DeckHandler {
	return async (m) => {
		const type = typeof m.type === "string" ? m.type : typeof m.cmd === "string" ? m.cmd : undefined;
		switch (type) {
			case "ping":
				return { pid: process.pid };
			case "open": {
				const piArgs = Array.isArray(m.piArgs) ? m.piArgs.filter((a): a is string => typeof a === "string") : undefined;
				const r = await deckOpen(
					{
						cwd: typeof m.cwd === "string" ? m.cwd : undefined,
						session: typeof m.session === "string" ? m.session : undefined,
						piArgs,
						focus: m.focus !== false,
					},
					env,
				);
				return { ...r };
			}
			case "select": {
				if (typeof m.session !== "string") throw new Error("select: no session");
				const pane = await showSession(m.session, { focus: m.focus === true }, env);
				return { session: m.session, pane };
			}
			default:
				throw new Error(type ? `unknown type ${type}` : "missing type");
		}
	};
}

// ---------------------------------------------------------------- the list process

export interface DeckListHooks {
	/** deck.sock handler; default: defaultDeckHandler. */
	handler?: DeckHandler;
	/** Called after a deck.sock request, a reconcile or a resize changed something. */
	onChange?: (what: "open" | "select" | "reconcile" | "resize") => void;
	/** For reconcile: the pane to show instead of a dead slot pane (default: the holder). */
	replacement?: (deadSession: string) => Promise<string | undefined> | string | undefined;
}

export interface DeckList {
	sock: DeckSockServer;
	/** Run tmux work one at a time (deck.sock requests, resize, reconcile share this queue). */
	serial<T>(fn: () => Promise<T>): Promise<T>;
	resize(): Promise<void>;
	reconcile(): Promise<ReconcileResult | undefined>;
	/** Stop listening, unbind deck.sock, clear @deck_tui_pid if it is still ours. */
	close(): Promise<void>;
}

/**
 * Everything the list process needs from the server layer: initDeck, deck.sock, SIGWINCH →
 * applySizes (coalesced), SIGUSR2 → reconcile. `pi-fleet deck` (phase 2: deck-view.ts) calls this
 * once at start, from inside the deck's list pane ($TMUX_PANE).
 */
export async function startDeckList(hooks: DeckListHooks = {}, env: NodeJS.ProcessEnv = process.env): Promise<DeckList> {
	const listPane = env.TMUX_PANE;
	if (!listPane) throw new Error("deck: not in a tmux pane");
	await initDeck(listPane, env);
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = queue.then(fn, fn);
		queue = run.catch(() => {});
		return run;
	};
	const base = hooks.handler ?? defaultDeckHandler(env);
	const handler: DeckHandler = (m) =>
		serial(async () => {
			const r = await base(m);
			if (m.type === "open" || m.type === "select") hooks.onChange?.(m.type);
			return r;
		});
	const sock = await serveDeckSock(handler, env);
	const resize = () =>
		serial(async () => {
			const r = await applySizes(env);
			if (r?.changed) hooks.onChange?.("resize");
		});
	const doReconcile = () =>
		serial(async () => {
			const r = await reconcile(env, { replacement: hooks.replacement });
			hooks.onChange?.("reconcile");
			return r;
		}).catch(() => undefined);
	let winchTimer: NodeJS.Timeout | undefined;
	const onWinch = () => {
		if (winchTimer) clearTimeout(winchTimer);
		winchTimer = setTimeout(() => {
			winchTimer = undefined;
			void resize().catch(() => {});
		}, 30);
	};
	const onUsr2 = () => void doReconcile();
	process.on("SIGWINCH", onWinch);
	process.on("SIGUSR2", onUsr2);
	// Panes that died while no list was running (a respawn after a crash).
	void doReconcile();
	return {
		sock,
		serial,
		resize,
		reconcile: doReconcile,
		async close() {
			process.off("SIGWINCH", onWinch);
			process.off("SIGUSR2", onUsr2);
			if (winchTimer) clearTimeout(winchTimer);
			sock.close();
			const pid = await deckTmux(["show-options", "-gqv", "@deck_tui_pid"], env).catch(() => "");
			if (pid === String(process.pid)) await deckTmux(["set-option", "-gu", "@deck_tui_pid"], env).catch(() => "");
		},
	};
}

// ---------------------------------------------------------------- start, attach, kill

/** The deck window size for a new server: the popup's inner size over the outer client, else the terminal. */
export async function initialDeckSize(env: NodeJS.ProcessEnv, outerClientSize?: SlotSize): Promise<SlotSize> {
	if (outerClientSize) {
		// display-popup -w 95% -h 90% with a border on each side (tmux 3.2a: 160x48 → 150x41).
		return { width: Math.max(20, Math.floor(outerClientSize.width * 0.95) - 2), height: Math.max(5, Math.floor(outerClientSize.height * 0.9) - 2) };
	}
	if (process.stdout.isTTY && process.stdout.columns && process.stdout.rows) return { width: process.stdout.columns, height: process.stdout.rows };
	return { width: 200, height: 50 };
}

/**
 * `deck-start`: start the deck server unless its `deck` session exists (`new-session -d … 'pi-fleet
 * deck'` with deckServerEnv and the deck config), then wait ≤ timeoutMs for deck.sock.
 */
export async function startDeck(
	opts: { size?: SlotSize; timeoutMs?: number } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ started: boolean }> {
	let started = false;
	if (!(await deckRunning(env))) {
		const size = opts.size ?? (await initialDeckSize(env));
		try {
			await deckTmux(
				[
					"-f", deckConfPath(env), "new-session", "-d", "-s", DECK_SESSION, "-n", DECK_SESSION, "-x", String(size.width), "-y", String(size.height), ...listCommand(env), ";",
					"set-option", "-w", "-t", DECK_WINDOW_TARGET, "window-size", "latest",
				],
				env,
			);
			started = true;
		} catch (error) {
			if (!(await deckRunning(env))) throw error;
		}
	}
	if (!(await waitDeckSock(env, opts.timeoutMs ?? 3000))) throw new Error(`deck: the list did not answer on ${deckSockPath(env)}`);
	return { started };
}

/** bin/pi-deck-attach next to $PI_FLEET_BIN, else on PATH. */
export function deckAttachBin(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_FLEET_BIN) {
		const p = join(dirname(env.PI_FLEET_BIN), "pi-deck-attach");
		if (existsSync(p)) return p;
	}
	return "pi-deck-attach";
}

/** The sh command a popup runs: pi-deck-attach with the deck variables (the popup gets the outer server's env). */
export function deckPopupCommand(env: NodeJS.ProcessEnv = process.env): string {
	const vars: string[] = [];
	for (const name of PASS_ENV) {
		if (name === "PI_FLEET_TMUX_SOCKET") continue;
		if (env[name] !== undefined) vars.push(shQuote(`${name}=${env[name]}`));
	}
	return `${vars.length ? `env ${vars.join(" ")} ` : ""}${shQuote(deckAttachBin(env))}`;
}

/** display-popup argv (outer server) that attaches the deck over the client showing `pane`. */
export function deckPopupArgs(pane: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
	return ["display-popup", "-E", "-w", "95%", "-h", "90%", ...(pane ? ["-t", pane] : []), deckPopupCommand(env)];
}

export interface KillDeckResult {
	sessions: string[];
	asked: string[];
	stillAlive: string[];
	killedServer: boolean;
}

/**
 * `kill-deck`: send `kill {confirmed, scancel:false}` to each live deck pi's control socket, wait
 * ≤ waitMs for their panes to die, then kill-server (only the deck server).
 */
export async function killDeck(opts: { waitMs?: number } = {}, env: NodeJS.ProcessEnv = process.env): Promise<KillDeckResult> {
	const live = (await deckPanes(env)).filter((p) => p.role === "pi" && !p.gone && p.session);
	const asked: string[] = [];
	for (const p of live) {
		const sock = readStatus(p.session, env)?.status.ctlSock || ctlSockPath(p.session, env);
		try {
			const r = await ndjsonRequest(sock, { type: "kill", confirmed: true, scancel: false }, 2000);
			if (r.ok) asked.push(p.session);
		} catch {
			// no control socket (not a pi-fleet pi, or gone)
		}
	}
	const end = Date.now() + (opts.waitMs ?? 10_000);
	let stillAlive = live.map((p) => p.pane);
	while (asked.length && stillAlive.length && Date.now() < end) {
		await new Promise((r) => setTimeout(r, 100));
		const now = await deckPanes(env);
		stillAlive = stillAlive.filter((pane) => now.some((p) => p.pane === pane && !p.gone));
	}
	const killedServer = await deckTmuxOk(["kill-server"], env);
	return { sessions: live.map((p) => p.session), asked, stillAlive, killedServer };
}

// ---------------------------------------------------------------- phase-1 stand-in list

/**
 * `pi-fleet deck` until phase 2's list TUI replaces it: startDeckList plus a plain list of the deck's
 * sessions. j/k (↓/↑) show the next/previous session, Enter/C-l focus the slot, q detaches.
 */
export async function runDeckStub(env: NodeJS.ProcessEnv = process.env): Promise<number> {
	let selected = 0;
	const draw = async () => {
		const panes = await deckPanes(env);
		const pis = panes.filter((p) => p.role === "pi");
		const slot = panes.find((p) => p.inSlot);
		const lines = ["pi-deck (stand-in list)  j/k move · ⏎ focus · q detach", ""];
		pis.forEach((p, i) => {
			const here = slot && (slot.pane === p.pane || (slot.role === "nvim" && slot.peer === p.pane)) ? "▶" : " ";
			lines.push(`${i === selected ? "›" : " "}${here} ${p.session.slice(0, 8)} ${p.dead ? "(dead) " : ""}${p.cwd}`);
		});
		if (!pis.length) lines.push("  (no sessions)");
		process.stdout.write(`\x1b[2J\x1b[H${lines.join("\r\n")}\r\n`);
	};
	const list = await startDeckList({ onChange: () => void draw() }, env);
	await draw();
	const move = async (delta: number) => {
		const pis = (await deckPanes(env)).filter((p) => p.role === "pi" && !p.dead);
		if (!pis.length) return;
		selected = (selected + delta + pis.length) % pis.length;
		await list.serial(() => showSession(pis[selected].session, {}, env)).catch(() => {});
		await draw();
	};
	let finish: (code: number) => void = () => {};
	const finished = new Promise<number>((r) => (finish = r));
	const stdin = process.stdin;
	if (stdin.isTTY) stdin.setRawMode(true);
	stdin.resume();
	stdin.on("data", (d: Buffer) => {
		const key = d.toString("utf8");
		if (key === "j" || key === "\x1b[B" || key === "\x0e") void move(1);
		else if (key === "k" || key === "\x1b[A" || key === "\x10") void move(-1);
		else if (key === "\r" || key === "\x0c") void focusSlot(env).catch(() => {});
		else if (key === "q") void deckTmux(["detach-client", "-s", `=${DECK_SESSION}`], env).catch(() => {});
		else if (key === "\x03") finish(0);
	});
	const quit = () => finish(0);
	process.once("SIGTERM", quit);
	process.once("SIGHUP", quit);
	const code = await finished;
	await list.close();
	return code;
}
