/**
 * pi-deck server layer (docs/pi-deck-design.md §4, §5, §7, §8, §15): the private tmux server
 * `tmux -L pifleet -f ~/env/pi/deck.tmux.conf`, its `pool` of hidden panes, the two slots, slot
 * sizes, the holders, per-session nvims (created on first show), and deck.sock. Not an extension module (index.ts
 * does not load it): the CLI (cli.ts) and the list process use it, and extension modules may import
 * its functions. No module-level state: servers and list handles are returned as objects.
 *
 * Layout (tmux is the source of truth; every function re-reads it):
 *   session `deck`, window `deck` (§15), three panes by position (swap-pane keeps positions):
 *     pane 0 = the list (top-left, @pi_fleet_role=list), pane 1 = the nvim slot (bottom-left),
 *     pane 2 = the pi slot (right half). Left column @deck_list_pct (50) of the width, the list
 *     @deck_list_height_pct (50) of the left column's height.
 *   session `pool` (never attached): one window per hidden pane, window-size manual, each at the
 *     size of the slot its role is shown in: pi panes (run-pi), the preview holder (one) and the
 *     anchor at the pi-slot size; nvim panes (one per session, created on first show) and the nvim
 *     holder (one) at the nvim-slot size. The anchor keeps the session alive when every other pane
 *     is shown or gone.
 *   Pane options: @pi_fleet_role list|pi|nvim|preview|nvim-holder|anchor, @pi_fleet_session,
 *     @pi_fleet_peer (pi <-> nvim), @pi_fleet_nvim_sock. Global options: @deck_tui_pid, @deck_bin,
 *     @deck_list_pct, @deck_list_height_pct,
 *     @deck_outer (`socket|client` of the last popup, bin/pi-deck-attach), @deck_jump, @deck_sock (the
 *     list's deck.sock path; clients look it up there, deckSockLookup), @deck_reload (`<ms>:<token>` of the
 *     last deckReload, its debounce).
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
import { chmodSync, existsSync, lstatSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	PASS_ENV,
	clearStaleSocket,
	ctlSockPath,
	nvimModified,
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
/** The list pane, the nvim slot (below the list) and the pi slot (right half): exact names, by position. */
export const LIST_TARGET = "=deck:=deck.0";
export const NVIM_SLOT_TARGET = "=deck:=deck.1";
export const SLOT_TARGET = "=deck:=deck.2";
export const DECK_WINDOW_TARGET = "=deck:=deck";
/** The pool session (`=pool:` as a session target; `=pool:=NAME` for one of its windows). */
export const POOL_TARGET = "=pool:";
export const DEFAULT_LIST_PCT = 50;
export const DEFAULT_LIST_HEIGHT_PCT = 50;
export const DECK_SOCK_MAX_LINE = 64 * 1024;
export const DECK_SOCK_IDLE_MS = 2000;

const SLEEP_FOREVER = "exec sleep 2147483647";
/** The preview holder: a silent tty the list writes frames to (`#{pane_tty}`). */
export const HOLDER_CMD = `stty -echo -icanon 2>/dev/null; printf '\\033[?25l'; ${SLEEP_FOREVER}`;
/** The nvim holder: what the nvim slot shows for a row without a live deck session. */
export const NVIM_HOLDER_CMD = `stty -echo -icanon 2>/dev/null; printf '\\033[?25l\\033[2J\\033[H\\033[2m  no editor: not a live deck session\\033[0m'; ${SLEEP_FOREVER}`;
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
 * After each exit it clears @deck_tui_pid (no SIGUSR2 to a recycled pid), and after 3 runs in a row
 * shorter than 5 s it waits 10 s between starts (a list that cannot start does not spin).
 * bin/pi-deck-attach has a copy (`list_loop`); keep them identical.
 */
export const LIST_LOOP =
	'n=0; while :; do s=$(date +%s); "$0" deck; tmux set-option -gu @deck_tui_pid 2>/dev/null; ' +
	'if [ $(($(date +%s) - s)) -lt 5 ]; then n=$((n + 1)); else n=0; fi; [ "$n" -lt 3 ] || sleep 10; sleep 0.3; done';
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

/**
 * <runtime dir>/deck.sock (deck-<name>.sock for another deck socket, so tests never meet the real one):
 * where the list binds. Clients use deckSockLookup (the list publishes its path), because the runtime dir
 * may be a per-process mkdtemp fallback (cli.ts runtimeDir).
 */
export function deckSockPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(runtimeDir(env), deckSockFile(env));
}
function deckSockFile(env: NodeJS.ProcessEnv): string {
	const name = deckSocketName(env);
	return name === "pifleet" ? "deck.sock" : `deck-${basename(name).replace(/[^\w.-]/g, "_")}.sock`;
}

/** deck.sock as the running list published it (@deck_sock on the deck server), else deckSockPath. */
export async function deckSockLookup(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const published = await deckTmux(["show-options", "-gqv", "@deck_sock"], env).catch(() => "");
	return published.startsWith("/") ? published : deckSockPath(env);
}

/** A directory that is ours alone (not a symlink, our uid, mode 0700). */
function privateDir(dir: string): boolean {
	try {
		const st = lstatSync(dir);
		return st.isDirectory() && st.uid === uid() && (st.mode & 0o777) === 0o700;
	} catch {
		return false;
	}
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

export type DeckRole = "list" | "pi" | "nvim" | "preview" | "nvim-holder" | "anchor" | "";

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
	/** In the pi slot (the right half). */
	inSlot: boolean;
	/** In the nvim slot (bottom-left). */
	inNvimSlot: boolean;
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
		dead: f[9] === "1",
		deadStatus: f[10] ? Number(f[10]) : undefined,
		width: Number(f[11]),
		height: Number(f[12]),
		cwd: f[13] ?? "",
		tty: f[14] ?? "",
		pid: Number(f[15]),
		exited: f[16] ?? "",
		gone: f[9] === "1" || !!f[16],
		inSlot: inDeckWindow && f[4] === "2",
		inNvimSlot: inDeckWindow && f[4] === "1",
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

/** What the pi slot shows now (read from tmux, never cached). */
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

// ---------------------------------------------------------------- sizes (§5, §15)

export interface SlotSize {
	width: number;
	height: number;
}

/** Every pane's size in a deck window of W×H: the list (top-left), the nvim slot below it, the pi slot on the right. */
export interface DeckSizes {
	list: SlotSize;
	nvim: SlotSize;
	pi: SlotSize;
}

/**
 * Pane sizes for a deck window of W×H with the left column at pct% of the width and the list at hpct%
 * of the left column's height (resize-pane rounds down; one border column and one border line).
 */
export function deckSizesFor(windowWidth: number, windowHeight: number, pct: number, hpct = DEFAULT_LIST_HEIGHT_PCT): DeckSizes {
	const listWidth = Math.max(1, Math.floor((windowWidth * pct) / 100));
	const height = Math.max(1, windowHeight);
	const listHeight = Math.max(1, Math.min(height - 2, Math.floor((height * hpct) / 100)));
	return {
		list: { width: listWidth, height: Math.max(1, listHeight) },
		nvim: { width: listWidth, height: Math.max(1, height - listHeight - 1) },
		pi: { width: Math.max(1, windowWidth - listWidth - 1), height },
	};
}

/** The pi slot's size for a deck window of W×H with the left column at pct% (see deckSizesFor). */
export function slotSizeFor(windowWidth: number, windowHeight: number, pct: number): { listWidth: number; slot: SlotSize } {
	const s = deckSizesFor(windowWidth, windowHeight, pct);
	return { listWidth: s.list.width, slot: s.pi };
}

function parsePct(value: string | undefined, fallback = DEFAULT_LIST_PCT): number {
	const n = Number(value);
	return value && Number.isFinite(n) && n >= 10 && n <= 90 ? Math.round(n) : fallback;
}

/** Pool windows of these roles are kept at the nvim-slot size; every other one at the pi-slot size. */
export function nvimSized(role: string): boolean {
	return role === "nvim" || role === "nvim-holder";
}

export interface ApplySizesResult {
	/** A write call ran (list size, pool default-size or a pool window changed). */
	changed: boolean;
	/** The pi slot's size. */
	slot: SlotSize;
	nvim: SlotSize;
	/** Pool windows resized. */
	resized: number;
}

const SIZE_READ = "#{@deck_list_pct}\t#{@deck_list_height_pct}\t#{window_width}\t#{window_height}\t#{pane_width}\t#{pane_height}\t#{window_zoomed_flag}\t#{window_panes}";

/**
 * Keep the list at @deck_list_pct × @deck_list_height_pct and every pool window at exactly the size of
 * the slot its pane is shown in (nvim/nvim-holder: the nvim slot, the rest: the pi slot): one read, then
 * (only if something differs) ONE tmux call with `resize-pane` + `set default-size` + every
 * `resize-window`. A zoomed deck window keeps its zoom (resize-pane would undo it); pool sizes still follow.
 */
export async function applySizes(env: NodeJS.ProcessEnv = process.env): Promise<ApplySizesResult | undefined> {
	let out: string;
	try {
		out = await deckTmux(
			[
				"display-message", "-p", "-t", LIST_TARGET, SIZE_READ, ";",
				"show-options", "-v", "-t", POOL_TARGET, "default-size", ";",
				"list-windows", "-t", POOL_TARGET, "-F", "#{window_id}\t#{window_width}\t#{window_height}\t#{@pi_fleet_role}",
			],
			env,
		);
	} catch {
		return undefined;
	}
	const [head, defaultSize, ...windows] = out.split("\n");
	const [pctS, hpctS, wS, hS, listW, listH, zoomed, count] = head.split("\t");
	const sizes = deckSizesFor(Number(wS), Number(hS), parsePct(pctS), parsePct(hpctS, DEFAULT_LIST_HEIGHT_PCT));
	const cmds: string[][] = [];
	if (zoomed !== "1" && count === "3") {
		if (Number(listW) !== sizes.list.width) cmds.push(["resize-pane", "-t", LIST_TARGET, "-x", String(sizes.list.width)]);
		if (Number(listH) !== sizes.list.height) cmds.push(["resize-pane", "-t", LIST_TARGET, "-y", String(sizes.list.height)]);
	}
	const size = `${sizes.pi.width}x${sizes.pi.height}`;
	if (defaultSize !== size) cmds.push(["set-option", "-t", POOL_TARGET, "default-size", size]);
	let resized = 0;
	for (const line of windows) {
		const [id, ww, wh, role] = line.split("\t");
		const want = nvimSized(role ?? "") ? sizes.nvim : sizes.pi;
		if (!id || (Number(ww) === want.width && Number(wh) === want.height)) continue;
		cmds.push(["resize-window", "-t", id, "-x", String(want.width), "-y", String(want.height)]);
		resized++;
	}
	if (!cmds.length) return { changed: false, slot: sizes.pi, nvim: sizes.nvim, resized: 0 };
	await deckTmux(chain(cmds), env);
	return { changed: true, slot: sizes.pi, nvim: sizes.nvim, resized };
}

/** The slot sizes as the layout is now (computed from the deck window). */
export async function currentSizes(env: NodeJS.ProcessEnv = process.env): Promise<DeckSizes | undefined> {
	try {
		const [pct, hpct, w, h] = (await deckTmux(["display-message", "-p", "-t", LIST_TARGET, SIZE_READ], env)).split("\t");
		return deckSizesFor(Number(w), Number(h), parsePct(pct), parsePct(hpct, DEFAULT_LIST_HEIGHT_PCT));
	} catch {
		return undefined;
	}
}

/** The pi slot's size as the layout is now. */
export async function currentSlotSize(env: NodeJS.ProcessEnv = process.env): Promise<SlotSize | undefined> {
	return (await currentSizes(env))?.pi;
}

/** Commands joined with `;` for one tmux call. */
function chain(cmds: string[][]): string[] {
	return cmds.flatMap((c, i) => (i ? [";", ...c] : c));
}

// ---------------------------------------------------------------- pool, holders, layout

function token(): string {
	return randomBytes(4).toString("hex");
}

/**
 * `new-window` into the pool, then (same call) window-size manual and pane options. Returns the pane id.
 * New windows start at the pool's default-size (the pi slot); with `size` (an nvim) the default-size is
 * that size just for this window and `restore` again afterwards, all in the one call, so the program's
 * first frame has its final size.
 */
async function newPoolWindow(
	kind: string,
	opts: { cwd?: string; envArgs?: string[]; options: Record<string, string>; command: string[]; size?: SlotSize; restore?: SlotSize },
	env: NodeJS.ProcessEnv,
): Promise<string> {
	const name = `${kind}-${token()}`;
	const target = `${POOL_TARGET}=${name}`;
	const sized = opts.size && opts.restore;
	const args = [
		...(sized ? ["set-option", "-t", POOL_TARGET, "default-size", `${opts.size!.width}x${opts.size!.height}`, ";"] : []),
		"new-window", "-d", "-t", POOL_TARGET, "-n", name, "-P", "-F", "#{pane_id}",
		...(opts.cwd ? ["-c", fmtLiteral(opts.cwd)] : []),
		...(opts.envArgs ?? []),
		"--", ...opts.command,
		";", "set-option", "-w", "-t", target, "window-size", "manual",
	];
	if (sized) args.push(";", "set-option", "-t", POOL_TARGET, "default-size", `${opts.restore!.width}x${opts.restore!.height}`);
	for (const [k, v] of Object.entries(opts.options)) args.push(";", "set-option", "-p", "-t", target, k, v);
	return (await deckTmux(args, env)).split("\n").filter(Boolean)[0];
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
 * The deck window has exactly the list, the nvim slot and the pi slot (§15): a missing pi slot gets the
 * preview holder, a missing nvim slot the nvim holder (joined back from the pool, or new ones), extra
 * panes go to the pool. A two-pane deck (list | slot, before §15) gets its nvim slot under the list.
 * Run with the pool present.
 */
export async function ensureLayout(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const read = async () => {
		const panes = await deckPanes(env);
		const inWindow = panes.filter((p) => p.sessionName === DECK_SESSION && p.windowName === DECK_SESSION).sort((a, b) => a.index - b.index);
		return { panes, inWindow };
	};
	let { panes, inWindow } = await read();
	if (!inWindow.length) throw new Error("deck: no deck window");
	const [pctS, hpctS] = (await deckTmux(["show-options", "-gqv", "@deck_list_pct", ";", "show-options", "-gqv", "@deck_list_height_pct"], env).catch(() => "")).split("\n");
	const pct = parsePct(pctS);
	const hpct = parsePct(hpctS, DEFAULT_LIST_HEIGHT_PCT);
	for (const extra of inWindow.slice(3)) {
		await deckTmux(
			["break-pane", "-d", "-s", extra.pane, "-t", POOL_TARGET, ";", "set-option", "-w", "-t", extra.pane, "window-size", "manual"],
			env,
		);
	}
	if (inWindow.length >= 3) return;
	const list = inWindow[0].pane;
	if (inWindow.length === 2) {
		// Two panes: either a deck from before §15 (list | slot) or one whose pi slot went (list / nvim slot).
		const leftColumn = await deckTmux(["display-message", "-p", "-t", inWindow[1].pane, "#{pane_at_left}"], env).catch(() => "0");
		if (leftColumn === "1") {
			// The pi slot: a full-height column on the right, after the nvim slot (so it becomes pane 2).
			const holder = panes.find((p) => p.role === "preview" && p.sessionName === POOL_SESSION);
			if (holder) await deckTmux(["join-pane", "-d", "-h", "-f", "-l", `${100 - pct}%`, "-s", holder.pane, "-t", inWindow[1].pane], env);
			else {
				await deckTmux(
					[
						"split-window", "-d", "-h", "-f", "-l", `${100 - pct}%`, "-t", inWindow[1].pane, "sh", "-c", HOLDER_CMD, ";",
						"set-option", "-p", "-t", SLOT_TARGET, "@pi_fleet_role", "preview",
					],
					env,
				);
			}
			return;
		}
	}
	if (inWindow.length === 1) {
		const holder = panes.find((p) => p.role === "preview" && p.sessionName === POOL_SESSION);
		if (holder) await deckTmux(["join-pane", "-d", "-h", "-l", `${100 - pct}%`, "-s", holder.pane, "-t", list], env);
		else {
			await deckTmux(
				[
					"split-window", "-d", "-h", "-l", `${100 - pct}%`, "-t", list, "sh", "-c", HOLDER_CMD, ";",
					"set-option", "-p", "-t", "=deck:=deck.1", "@pi_fleet_role", "preview",
				],
				env,
			);
		}
		({ panes, inWindow } = await read());
	}
	// The nvim slot: under the list, so it becomes pane 1 and the pi slot pane 2.
	const holder = panes.find((p) => p.role === "nvim-holder" && p.sessionName === POOL_SESSION);
	if (holder) await deckTmux(["join-pane", "-d", "-v", "-l", `${100 - hpct}%`, "-s", holder.pane, "-t", list], env);
	else {
		await deckTmux(
			[
				"split-window", "-d", "-v", "-l", `${100 - hpct}%`, "-t", list, "sh", "-c", NVIM_HOLDER_CMD, ";",
				"set-option", "-p", "-t", NVIM_SLOT_TARGET, "@pi_fleet_role", "nvim-holder",
			],
			env,
		);
	}
}

/** The preview holder pane (created in the pool if there is none). */
export async function ensureHolder(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const holder = (await deckPanes(env)).find((p) => p.role === "preview");
	if (holder) return holder.pane;
	return newPoolWindow("holder", { options: { "@pi_fleet_role": "preview" }, command: ["sh", "-c", HOLDER_CMD] }, env);
}

/** The nvim holder pane (created in the pool, at the nvim-slot size, if there is none). */
export async function ensureNvimHolder(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const holder = (await deckPanes(env)).find((p) => p.role === "nvim-holder");
	if (holder) return holder.pane;
	const sizes = await currentSizes(env);
	return newPoolWindow(
		"nvim-holder",
		{ options: { "@pi_fleet_role": "nvim-holder" }, command: ["sh", "-c", NVIM_HOLDER_CMD], size: sizes?.nvim, restore: sizes?.pi },
		env,
	);
}

/** The holder's tty, for the list to write preview frames to. */
export async function holderTty(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	return (await deckPanes(env)).find((p) => p.role === "preview" && !p.gone)?.tty || undefined;
}

/**
 * The list process's setup: mark `listPane` as the list, record @deck_tui_pid/@deck_bin, create the
 * pool (anchor + holders), give the deck window its two slots, and apply the sizes.
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
	await ensurePool((await currentSizes(env))?.pi, env);
	await ensureLayout(env);
	await ensureHolder(env);
	await ensureNvimHolder(env);
	await applySizes(env);
}

// ---------------------------------------------------------------- slots

/**
 * The swaps (one tmux call's arguments) that put `want.pi` into the pi slot and `want.nvim` into the nvim
 * slot (`swap-pane -d`: no resize, pool panes have their slot's size; `-Z`: a zoomed deck window stays
 * zoomed), for `panes` as just read.
 * Undefined if both are there already.
 */
export function slotArgs(panes: DeckPane[], want: { pi?: string; nvim?: string }): string[] | undefined {
	let inPi = panes.find((p) => p.inSlot)?.pane;
	let inNvim = panes.find((p) => p.inNvimSlot)?.pane;
	const cmds: string[][] = [];
	if (want.pi && inPi !== want.pi) {
		cmds.push(["swap-pane", "-d", "-Z", "-s", want.pi, "-t", SLOT_TARGET]);
		if (inNvim === want.pi) inNvim = inPi;
		inPi = want.pi;
	}
	if (want.nvim && want.nvim !== want.pi && inNvim !== want.nvim) {
		cmds.push(["swap-pane", "-d", "-Z", "-s", want.nvim, "-t", NVIM_SLOT_TARGET]);
		if (inPi === want.nvim) inPi = inNvim;
		inNvim = want.nvim;
	}
	return cmds.length ? chain(cmds) : undefined;
}

/** Swap `pane` into the slot of its role (nvim, nvim-holder: the nvim slot; the rest: the pi slot). */
export async function showPane(pane: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const args = showPaneArgs(await deckPanes(env), pane);
	if (args) await deckTmux(args, env);
}

/** The one tmux call showPane makes for `panes` as just read. Undefined if `pane` is in its slot already. */
export function showPaneArgs(panes: DeckPane[], pane: string): string[] | undefined {
	const role = panes.find((p) => p.pane === pane)?.role ?? "";
	return slotArgs(panes, nvimSized(role) ? { nvim: pane } : { pi: pane });
}

/**
 * Show a deck session: its pi in the pi slot and its nvim in the nvim slot, in one tmux call. The nvim is
 * created on the session's first show (`nvim: false`: never create, the nvim holder stands in); if that
 * fails the nvim holder stands in too and `nvimError` says why. Returns the pi pane.
 */
export async function showSession(
	sessionId: string,
	opts: { focus?: boolean | "nvim"; nvim?: boolean } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	return (await showSessionDetail(sessionId, opts, env)).pane;
}

/** showSession's details; `panes` (as just read) saves a list-panes. */
export interface ShowSessionResult {
	/** The session's pi pane. */
	pane: string;
	nvimPane?: string;
	nvimCreated: boolean;
	nvimError?: string;
}

export async function showSessionDetail(
	sessionId: string,
	opts: { focus?: boolean | "nvim"; nvim?: boolean; panes?: DeckPane[] } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<ShowSessionResult> {
	const panes = opts.panes ?? (await deckPanes(env));
	const pi = sessionPiPane(panes, sessionId);
	if (!pi) throw new Error(`deck: no pane for session ${sessionId.slice(0, 8)}`);
	// A finished pi is about to be reconciled away (pane-died fired already): never swap it into the slot.
	if (pi.gone) throw new Error(`deck: session ${sessionId.slice(0, 8)} has exited`);
	const result: ShowSessionResult = { pane: pi.pane, nvimCreated: false };
	let nvimPane = livePeerIn(panes, pi)?.pane;
	const after: string[][] = [];
	if (!nvimPane && opts.nvim !== false) {
		try {
			const made = await createNvim(panes, pi, env);
			nvimPane = made.nvimPane;
			after.push(...made.after);
			result.nvimCreated = true;
		} catch (error) {
			result.nvimError = (error as Error).message;
		}
	}
	result.nvimPane = nvimPane;
	const nvimShown = nvimPane ?? panes.find((p) => p.role === "nvim-holder" && !p.gone)?.pane ?? (await ensureNvimHolder(env));
	const swap = slotArgs(panes, { pi: pi.pane, nvim: nvimShown });
	// Swap first: a dead old nvim in the nvim slot leaves it before `after` kills it (the window keeps 3 panes).
	const cmds: string[][] = [];
	if (swap) cmds.push(swap);
	cmds.push(...after);
	if (opts.focus) cmds.push(["select-pane", "-t", opts.focus === "nvim" ? NVIM_SLOT_TARGET : SLOT_TARGET]);
	if (cmds.length) await deckTmux(chain(cmds), env);
	return result;
}

/** Show the holders: the preview holder in the pi slot, the nvim holder in the nvim slot. Returns the preview holder. */
export async function showHolder(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const holder = await ensureHolder(env);
	const nvimHolder = await ensureNvimHolder(env);
	const args = slotArgs(await deckPanes(env), { pi: holder, nvim: nvimHolder });
	if (args) await deckTmux(args, env);
	return holder;
}

export function focusSlot(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	return deckTmux(["select-pane", "-t", SLOT_TARGET], env);
}
export function focusNvimSlot(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	return deckTmux(["select-pane", "-t", NVIM_SLOT_TARGET], env);
}
export function focusList(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	return deckTmux(["select-pane", "-t", LIST_TARGET], env);
}

// ---------------------------------------------------------------- sessions in the pool

/** A new pi (run-pi) in the pool at the pi-slot size, with PI_FLEET_SESSION and PI_FLEET_DECK=1. Returns the pane. */
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
 * `cwd`; shown (pi and nvim, the nvim created on first show) and (default) the pi focused. Refuses sessions live elsewhere.
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
	await showSessionDetail(sessionId, { focus }, env);
	return { session: sessionId, pane, created: true };
}


// ---------------------------------------------------------------- nvim (one per session, created on first show)

export interface DeckPairResult {
	piPane: string;
	nvimPane: string;
	nvimSock: string;
	created: boolean;
	/** With show: the pane focused (the nvim slot's nvim). */
	shown?: string;
}

/**
 * A new nvim for the deck pi `me` in the pool at the nvim-slot size (cwd: the pi's). Returns its pane and
 * the commands that finish the pairing (the pi's @pi_fleet_peer, killing a dead old nvim), for the
 * caller to run in its next tmux call.
 */
async function createNvim(panes: DeckPane[], me: DeckPane, env: NodeJS.ProcessEnv): Promise<{ nvimPane: string; sock: string; after: string[][] }> {
	const session = me.session;
	const nvimCmd = words(env.PI_FLEET_NVIM_CMD, "nvim");
	const nvimBin = which(nvimCmd[0], env);
	if (!nvimBin) throw new Error(`${nvimCmd[0]} not found on PATH`);
	let sock = nvimSockPath(session, env);
	if (!(await clearStaleSocket(sock))) sock = join(runtimeDir(env), `${session}.${Date.now()}.nvim.sock`);
	const stale = me.peer ? panes.find((p) => p.pane === me.peer && p.role === "nvim") : undefined;
	const sizes = await currentSizes(env);
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
			size: sizes?.nvim,
			restore: sizes?.pi,
		},
		env,
	);
	const after: string[][] = [["set-option", "-p", "-t", me.pane, "@pi_fleet_peer", nvimPane]];
	if (stale && stale.gone) after.push(["kill-pane", "-t", stale.pane]);
	return { nvimPane, sock, after };
}

/**
 * `pair --deck PANE [--show]`, `/view`, `, g s`: a deck pi's nvim (created on first use). PANE may be
 * the pi or its nvim. With `show` the session is shown (pi and nvim) and the nvim slot focused.
 */
export async function deckPair(pane: string, opts: { show?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Promise<DeckPairResult> {
	const panes = await deckPanes(env);
	const me = panes.find((p) => p.pane === pane);
	if (!me) throw new Error(`no deck pane ${pane}`);
	const pi = me.role === "nvim" ? livePeerIn(panes, me) : me;
	if (!pi) throw new Error("the pi pane is gone");
	if (pi.role !== "pi" || !pi.session) throw new Error("no pi session here");
	const peer = livePeerIn(panes, pi);
	let r: DeckPairResult;
	if (peer) r = { piPane: pi.pane, nvimPane: peer.pane, nvimSock: peer.nvimSock, created: false };
	else {
		const made = await createNvim(panes, pi, env);
		await deckTmux(chain(made.after), env);
		r = { piPane: pi.pane, nvimPane: made.nvimPane, nvimSock: made.sock, created: true };
	}
	if (opts.show) {
		await showSession(pi.session, { focus: "nvim", nvim: false }, env);
		r.shown = r.nvimPane;
	}
	return r;
}

/** `prefix e` from node: focus the nvim slot from the pi slot (or the list), the pi slot from the nvim slot. */
export async function toggleFocus(env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const index = await deckTmux(["display-message", "-p", "-t", DECK_WINDOW_TARGET, "#{pane_index}"], env).catch(() => "");
	return deckTmux(["select-pane", "-t", index === "1" ? SLOT_TARGET : NVIM_SLOT_TARGET], env);
}

// ---------------------------------------------------------------- reconcile (pane-died → SIGUSR2)

export interface ReconcileResult {
	killed: string[];
	respawned: string[];
	/** The dead pane that was in the pi slot, and what replaced it. */
	slotReplaced?: { dead: string; session: string; by: string };
	/** The dead nvim that was in the nvim slot, and what replaced it (the nvim holder). */
	nvimSlotReplaced?: { dead: string; session: string; by: string };
}

/**
 * Clean up dead panes: a dead pi-slot pane is replaced (`replacement(session)` may name the pi to show,
 * with its nvim; else the holders) and killed; a dead nvim in the nvim slot gives way to the nvim
 * holder; dead pool pi/nvim panes are killed (a killed nvim's pi loses its peer; the session's next
 * show makes a new one); a dead holder or anchor is respawned. Also repairs the deck window's panes.
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
		// The replacement must be a live pane outside the slot (a caller's stale view may name the dead pane itself).
		const want = await opts.replacement?.(slot.session);
		const byPane = want ? panes.find((p) => p.pane === want) : undefined;
		let by: string;
		if (byPane && !byPane.gone && !byPane.inSlot && byPane.role === "pi" && byPane.session) {
			by = byPane.pane;
			await showSession(byPane.session, {}, env);
		} else if (byPane && !byPane.gone && !byPane.inSlot) {
			by = byPane.pane;
			await showPane(by, env);
		} else by = await showHolder(env);
		result.slotReplaced = { dead: slot.pane, session: slot.session, by };
		panes = await deckPanes(env);
	}
	const nvimSlot = panes.find((p) => p.inNvimSlot);
	if (nvimSlot?.gone && nvimSlot.role !== "nvim-holder") {
		const by = await ensureNvimHolder(env);
		await showPane(by, env);
		result.nvimSlotReplaced = { dead: nvimSlot.pane, session: nvimSlot.session, by };
		panes = await deckPanes(env);
	}
	const cmds: string[][] = [];
	for (const p of panes) {
		if (!p.gone || p.isList) continue;
		if (p.role === "preview" || p.role === "nvim-holder" || p.role === "anchor") {
			cmds.push(["respawn-pane", "-t", p.pane, "sh", "-c", p.role === "preview" ? HOLDER_CMD : p.role === "nvim-holder" ? NVIM_HOLDER_CMD : ANCHOR_CMD]);
			result.respawned.push(p.pane);
			continue;
		}
		if (p.role === "nvim") {
			const pi = panes.find((q) => q.pane === p.peer && q.peer === p.pane);
			if (pi) cmds.push(["set-option", "-pu", "-t", pi.pane, "@pi_fleet_peer"]);
		}
		cmds.push(["kill-pane", "-t", p.pane]);
		result.killed.push(p.pane);
	}
	if (cmds.length) await deckTmux(chain(cmds), env);
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
export async function deckRequest(message: DeckMessage, env: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000): Promise<Record<string, unknown>> {
	return ndjsonRequest(await deckSockLookup(env), message, timeoutMs);
}

/** Wait until deck.sock answers a ping. */
export async function waitDeckSock(env: NodeJS.ProcessEnv = process.env, timeoutMs = 3000): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			const r = await ndjsonRequest(await deckSockLookup(env), { type: "ping" }, 1000);
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
	// SIGUSR2 (a pane died) must never kill us: initDeck publishes our pid before the setup is done.
	let onDied: (() => void) | undefined;
	const onUsr2 = () => onDied?.();
	process.on("SIGUSR2", onUsr2);
	let sock: DeckSockServer;
	try {
		await initDeck(listPane, env);
		// Bind where the previous list did if that dir is still ours (runtimeDir's fallback is per process).
		if (!env.PI_FLEET_RUNTIME_DIR) {
			const published = await deckTmux(["show-options", "-gqv", "@deck_sock"], env).catch(() => "");
			if (published.startsWith("/") && basename(published) === deckSockFile(env) && privateDir(dirname(published))) {
				env.PI_FLEET_RUNTIME_DIR = dirname(published);
			}
		}
	} catch (error) {
		process.off("SIGUSR2", onUsr2);
		throw error;
	}
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
	try {
		sock = await serveDeckSock(handler, env);
		await deckTmux(["set-option", "-g", "@deck_sock", sock.path], env);
	} catch (error) {
		process.off("SIGUSR2", onUsr2);
		throw error;
	}
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
	onDied = () => void doReconcile();
	process.on("SIGWINCH", onWinch);
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
			if (pid === String(process.pid)) await deckTmux(["set-option", "-gu", "@deck_tui_pid", ";", "set-option", "-gu", "@deck_sock"], env).catch(() => "");
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
	if (!(await waitDeckSock(env, opts.timeoutMs ?? 3000))) throw new Error(`deck: the list did not answer on ${await deckSockLookup(env)}`);
	return { started };
}

// ---------------------------------------------------------------- reload (pi's /reload, `deck-reload`)

/** Reloads within this many ms of the last one are skipped by `deck-reload --debounce` (several pis reloading at once). */
export const RELOAD_DEBOUNCE_MS = 5000;
/** How long a debounced reload waits before checking that its claim on @deck_reload survived a concurrent one. */
const RELOAD_CLAIM_SETTLE_MS = 250;

/** The loop in a pane start command (as tmux prints it: quoted, `$` sometimes escaped) is LIST_LOOP. */
export function isCurrentListLoop(startCommand: string): boolean {
	const norm = (s: string) => s.replace(/[\\"']/g, "").replace(/\s+/g, " ").trim();
	return norm(startCommand).includes(norm(LIST_LOOP));
}

export interface DeckReloadResult {
	/** The deck server runs (else nothing was done). */
	running: boolean;
	/** Another reload ran within the debounce window (or won a concurrent claim): nothing was done. */
	skipped?: boolean;
	/** `source-file` of the deck config failed with this message (the list is restarted anyway). */
	sourceError?: string;
	/**
	 * signalled: SIGTERM to the list (its loop restarts it with the current code); respawned: the list pane
	 * ran an older loop (or was dead) and runs LIST_LOOP now; none: no list process right now (its loop starts one).
	 */
	list: "signalled" | "respawned" | "none";
	oldPid?: number;
	/** The new list's pid (with waitMs, once it published @deck_tui_pid). */
	newPid?: number;
}

/** The pi-fleet the list loop runs: @deck_bin (the running list's), $PI_FLEET_BIN, this repo's bin/pi-fleet, else PATH. */
function listBin(deckBin: string, env: NodeJS.ProcessEnv): string {
	if (deckBin.startsWith("/") && existsSync(deckBin)) return deckBin;
	if (env.PI_FLEET_BIN) return env.PI_FLEET_BIN;
	try {
		const repoBin = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../../bin/pi-fleet");
		if (existsSync(repoBin)) return resolve(repoBin);
	} catch {
		// not found
	}
	return deckBin || "pi-fleet";
}

/** The parent pid of `pid` (ps), or undefined. */
function parentPid(pid: number): Promise<number | undefined> {
	return new Promise((res) => {
		execFile("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 2000 }, (error, stdout) => {
			const n = Number(String(stdout).trim());
			res(!error && Number.isInteger(n) && n > 0 ? n : undefined);
		});
	});
}

/**
 * Make the running deck pick up changes in the repo (pi's /reload runs `deck-reload --debounce`): re-source
 * the deck config, then restart the list: SIGTERM to @deck_tui_pid (its loop starts the current code; the
 * new list rebuilds from tmux and keeps the slot), or, if the list pane's loop is not the current LIST_LOOP
 * (or the pane is dead), `respawn-pane -k` it with LIST_LOOP (same pane id; respawning is no pane death, so
 * the pane-died hook stays out). Pool panes and the slot are never touched. No-op if the deck is not running.
 * `debounceMs`: skip if another reload claimed @deck_reload within that window (and settle concurrent claims).
 * `waitMs`: wait that long for the new list to publish its pid.
 */
export async function deckReload(
	opts: { debounceMs?: number; waitMs?: number } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<DeckReloadResult> {
	if (!(await deckRunning(env))) return { running: false, list: "none" };
	const claim = `${Date.now()}:${token()}`;
	if (opts.debounceMs) {
		const last = Number((await deckTmux(["show-options", "-gqv", "@deck_reload"], env).catch(() => "")).split(":")[0]);
		if (last && Date.now() - last >= 0 && Date.now() - last < opts.debounceMs) return { running: true, skipped: true, list: "none" };
		await deckTmux(["set-option", "-g", "@deck_reload", claim], env);
		await new Promise((r) => setTimeout(r, RELOAD_CLAIM_SETTLE_MS));
		if ((await deckTmux(["show-options", "-gqv", "@deck_reload"], env).catch(() => "")) !== claim) return { running: true, skipped: true, list: "none" };
	} else {
		await deckTmux(["set-option", "-g", "@deck_reload", claim], env);
	}
	const result: DeckReloadResult = { running: true, list: "none" };
	try {
		await deckTmux(["source-file", deckConfPath(env)], env);
	} catch (error) {
		result.sourceError = (error as Error).message;
	}
	const info = await deckTmux(
		[
			"display-message", "-p", "-t", LIST_TARGET, "#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{@deck_tui_pid}\t#{@deck_bin}\t#{pane_start_command}",
		],
		env,
	).catch(() => "");
	const [pane, panePidS, dead, pidS, deckBin, ...start] = info.split("\t");
	if (!pane) return result;
	const pid = Number(pidS) > 1 ? Number(pidS) : undefined;
	result.oldPid = pid;
	let respawn = dead === "1" || !isCurrentListLoop(start.join("\t"));
	if (!respawn && pid) {
		// Only the list's own process (a child of the loop): a stale @deck_tui_pid may name some other process now.
		const ppid = await parentPid(pid);
		if (ppid === Number(panePidS)) {
			try {
				process.kill(pid, "SIGTERM");
				result.list = "signalled";
			} catch {
				// gone already: its loop starts the next one
			}
		} else if (ppid !== undefined) respawn = true;
	}
	if (respawn) {
		await deckTmux(["respawn-pane", "-k", "-t", pane, "sh", "-c", LIST_LOOP, listBin(deckBin, env)], env);
		result.list = "respawned";
	}
	if (opts.waitMs && result.list !== "none") {
		const end = Date.now() + opts.waitMs;
		while (Date.now() < end) {
			const now = Number(await deckTmux(["show-options", "-gqv", "@deck_tui_pid"], env).catch(() => ""));
			if (now > 1 && now !== pid) {
				result.newPid = now;
				break;
			}
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	return result;
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
	/** nvims with unsaved changes once the pis are gone (a pi leaves its nvim open when it has modified buffers). */
	nvims: { pane: string; session: string; cwd: string; nvimSock: string }[];
	killedServer: boolean;
}

/**
 * `kill-deck`: send `kill {confirmed, scancel:false}` to each live deck pi's control socket, wait
 * ≤ waitMs for their panes to die, then kill-server (only the deck server). nvims still running
 * after that (≤ 2 s more for those quitting) that have modified file buffers: without `force` the
 * server is then left running (killedServer false) and they are returned in `nvims`.
 */
export async function killDeck(opts: { waitMs?: number; force?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Promise<KillDeckResult> {
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
	// A pi that exited asked its nvim to :qa unless it has modified buffers (cli.ts closePeerNvim).
	const nvimEnd = Date.now() + (asked.length ? 2000 : 0);
	let nvims = (await deckPanes(env)).filter((p) => p.role === "nvim" && !p.gone);
	while (nvims.length && Date.now() < nvimEnd) {
		await new Promise((r) => setTimeout(r, 100));
		nvims = (await deckPanes(env)).filter((p) => p.role === "nvim" && !p.gone);
	}
	// Only unsaved changes keep the server up: an nvim whose pi did not close it (a pi that never answered,
	// every deck session has its nvim now) or that does not answer goes with the server.
	const dirty: DeckPane[] = [];
	for (const p of nvims) if ((await nvimModified(p.nvimSock, env)) === true) dirty.push(p);
	const left = dirty.map((p) => ({ pane: p.pane, session: p.session, cwd: p.cwd, nvimSock: p.nvimSock }));
	const killedServer = left.length && !opts.force ? false : await deckTmuxOk(["kill-server"], env);
	return { sessions: live.map((p) => p.session), asked, stillAlive, nvims: left, killedServer };
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
		// No target: tmux detaches the most recently active client, the one that typed q (not every client).
		else if (key === "q") void deckTmux(["detach-client"], env).catch(() => {});
		else if (key === "\x03") finish(0);
	});
	const quit = () => finish(0);
	process.once("SIGTERM", quit);
	process.once("SIGHUP", quit);
	const code = await finished;
	await list.close();
	return code;
}
