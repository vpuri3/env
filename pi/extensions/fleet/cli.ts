/**
 * pi-fleet CLI (docs/pi-deck-design.md §8, §15): pi sessions in the pi deck, a private tmux server
 * (`tmux -L pifleet`, deck.ts) with three panes: the session list (top-left), the selected
 * session's nvim (bottom-left) and its pi (right half). Run through bin/pi-fleet, which picks a
 * node >= 22.18 (type stripping) and sets $PI_FLEET_BIN to its own absolute path. Not an extension
 * module: index.ts does not load it, but extension modules may import its exported helpers
 * (runtimeDir, nvimSockPath, ctlSockPath, tmux, pairPane, ...); main() only runs when this file is
 * the process entry point.
 *
 *   open [--session FILE|ID] [--cwd DIR] [--no-focus] [--json] [-- PI_ARGS]
 *        ensure the deck, then `open` over deck.sock: a new pool pi in DIR, or the session
 *        (selected if it is in the deck already); shown (pi and its nvim) and its pi focused.
 *        Prints the pi pane (the deck.sock reply with --json). `--deck` is accepted and ignored.
 *   pair [PANE] [--session ID] [--cwd DIR] [--json]
 *        A pi started by hand in your tmux: give its pane (default $TMUX_PANE) an nvim split
 *        beside it unless its peer is alive (view.ts does this on first use).
 *        Prints the nvim pane id, or {"piPane","nvimPane","nvimSock","created"} with --json.
 *   peer [PANE] [--select]
 *        Print the paired pane of PANE (exit 1 if none/gone). --select focuses it; from a pi
 *        pane whose nvim is gone it re-pairs first (your tmux's prefix e).
 *   ls [--json]   status files of this login node (and others, dimmed state)
 *   run-pi [PI_ARGS]
 *        The pi wrapper inside a session pane. Exit 0 → closes the peer nvim with :qa unless
 *        it has modified buffers. Non-zero → `pi exited (N). r restart · q close`. A SIGTERM
 *        to run-pi is forwarded to pi and run-pi exits 143 (no prompt).
 *   deck-start   start the deck server unless its `deck` session exists; wait for deck.sock.
 *   attach       ensure the deck; in a pane of your tmux: the popup (bin/pi-deck-attach) over that
 *                client; otherwise pi-deck-attach in this terminal.
 *   kill-deck [--yes]  ask once, `kill` every deck pi over its control socket (≤ 10 s), kill-server.
 *   deck-reload [--debounce MS]  pick up repo changes in the running deck: re-source deck.tmux.conf, restart
 *                the list (respawn its pane if it runs an older LIST_LOOP); pool panes and the slots stay. No
 *                deck: a message, exit 0. --debounce: skip if a reload ran within MS (pi's /reload uses it).
 *   pair --deck PANE [--show] [--json]  the deck pi's nvim (a pool pane; normally made when the session
 *                is first shown); --show shows the session and focuses the nvim.
 *   deck         the deck's list process: the list TUI (deck-view.ts); deck.ts runDeckStub without pi-tui.
 *
 * Pairing is by pane id, stored in pane options (they move with the pane on swap/move):
 *   pi pane:   @pi_fleet_role=pi   @pi_fleet_session=ID @pi_fleet_peer=%nvim
 *   nvim pane: @pi_fleet_role=nvim @pi_fleet_session=ID @pi_fleet_peer=%pi @pi_fleet_nvim_sock=SOCK
 *
 * Environment:
 *   PI_FLEET_PI_CMD      pi command for run-pi (words split on spaces; tests use a stub)
 *   PI_FLEET_NVIM_CMD    nvim command for pair (default `nvim`)
 *   PI_FLEET_TMUX_SOCKET tmux socket (-S); otherwise the one in $TMUX, otherwise tmux's default
 *   PI_FLEET_TMUX_GUARD  if set, refuse any tmux call that would reach the default or pifleet socket (tests)
 *   PI_FLEET_DECK_SOCKET the deck's tmux socket name or path (default pifleet); PI_FLEET_DECK_CONF its config
 *   PI_FLEET_RUNTIME_DIR node-local socket dir (default /tmp/pi-fleet-$UID, 0700, checked)
 *   PI_FLEET_STATE_DIR   status files (status.ts)
 * Every tmux/nvim call uses execFile with an argument array.
 */

import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GLYPHS, liveness, statusDir, statusPath, type Liveness, type StatusFile } from "./status.ts";

// ---------------------------------------------------------------- paths

function uid(): number {
	return process.getuid?.() ?? 0;
}

/**
 * Node-local dir for sockets: $PI_FLEET_RUNTIME_DIR or /tmp/pi-fleet-$UID, created 0700. If the
 * default exists but is a symlink, not ours, or not 0700, fall back to a fresh mkdtemp dir and
 * cache it in env.PI_FLEET_RUNTIME_DIR (passed on to new panes), so every socket path agrees and
 * no further dirs are made. `tmp` is a test-only override of /tmp.
 */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env, tmp = "/tmp"): string {
	if (env.PI_FLEET_RUNTIME_DIR) {
		mkdirSync(env.PI_FLEET_RUNTIME_DIR, { recursive: true, mode: 0o700 });
		return env.PI_FLEET_RUNTIME_DIR;
	}
	const dir = join(tmp, `pi-fleet-${uid()}`);
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch {
		// exists (checked below)
	}
	try {
		const st = lstatSync(dir);
		if (st.isDirectory() && !st.isSymbolicLink() && st.uid === uid() && (st.mode & 0o777) === 0o700) return dir;
	} catch {
		// fall through
	}
	const fallback = mkdtempSync(`${dir}-`);
	env.PI_FLEET_RUNTIME_DIR = fallback;
	return fallback;
}
export function nvimSockPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(runtimeDir(env), `${sessionId}.nvim.sock`);
}
export function ctlSockPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(runtimeDir(env), `${sessionId}.pi.sock`);
}

function sessionsRoot(env: NodeJS.ProcessEnv): string {
	if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR;
	return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");
}

/** Find a binary on PATH (or accept a path). */
export function which(cmd: string, env: NodeJS.ProcessEnv): string | undefined {
	if (cmd.includes("/")) return existsSync(cmd) ? resolve(cmd) : undefined;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const p = join(dir, cmd);
		try {
			if (statSync(p).isFile()) return p;
		} catch {
			// next
		}
	}
	return undefined;
}

export function words(cmd: string | undefined, fallback: string): string[] {
	const w = (cmd ?? "").trim().split(/\s+/).filter(Boolean);
	return w.length ? w : [fallback];
}

// ---------------------------------------------------------------- tmux

export function isDefaultSocket(socket: string): boolean {
	return basename(socket) === "default";
}

/** Sockets PI_FLEET_TMUX_GUARD (tests) never lets a tmux call reach: the user's and the real deck. */
export function guardedSocket(socket: string): boolean {
	return !socket || isDefaultSocket(socket) || basename(socket) === "pifleet";
}

/** `-S socket` for this process: $PI_FLEET_TMUX_SOCKET, else $TMUX, else tmux's default. */
export function tmuxBaseArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	const socket = env.PI_FLEET_TMUX_SOCKET || env.TMUX?.split(",")[0] || "";
	if (env.PI_FLEET_TMUX_GUARD && guardedSocket(socket)) {
		throw new Error("pi-fleet: PI_FLEET_TMUX_GUARD refuses the default tmux server (and pifleet)");
	}
	return socket ? ["-S", socket] : [];
}

/** Escape `#` for tmux arguments that are format-expanded (-c, -n, rename-window). */
export function fmtLiteral(s: string): string {
	return s.replace(/#/g, "##");
}

export function inTmux(env: NodeJS.ProcessEnv = process.env): boolean {
	return !!(env.PI_FLEET_TMUX_SOCKET || env.TMUX);
}

/** Run tmux with an argument array (`";"` separates commands). Rejects with tmux's stderr. */
export function tmux(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
	let base: string[];
	try {
		base = tmuxBaseArgs(env);
	} catch (error) {
		return Promise.reject(error);
	}
	return new Promise((res, rej) => {
		execFile("tmux", [...base, ...args], { timeout: 5000, env }, (error, stdout, stderr) => {
			if (error) rej(new Error(String(stderr).trim() || error.message));
			else res(String(stdout).replace(/\n$/, ""));
		});
	});
}

async function tmuxOk(args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
	try {
		await tmux(args, env);
		return true;
	} catch {
		return false;
	}
}

/** One pane's fleet options and placement; undefined if the pane is gone. */
export interface PaneInfo {
	pane: string;
	window: string;
	windowIndex: number;
	session: string;
	sessionName: string;
	role: string;
	fleetSession: string;
	peer: string;
	nvimSock: string;
	cwd: string;
	socket: string;
}
const PANE_FORMAT = [
	"#{pane_id}",
	"#{window_id}",
	"#{window_index}",
	"#{session_id}",
	"#{session_name}",
	"#{@pi_fleet_role}",
	"#{@pi_fleet_session}",
	"#{@pi_fleet_peer}",
	"#{@pi_fleet_nvim_sock}",
	"#{pane_current_path}",
	"#{socket_path}",
].join("\t");

type PaneRow = PaneInfo;

function parsePaneRow(line: string): PaneRow {
	const f = line.split("\t");
	return {
		pane: f[0],
		window: f[1],
		windowIndex: Number(f[2]),
		session: f[3],
		sessionName: f[4],
		role: f[5],
		fleetSession: f[6],
		peer: f[7],
		nvimSock: f[8],
		cwd: f[9],
		socket: f[10],
	};
}

export async function paneInfo(pane: string, env: NodeJS.ProcessEnv = process.env): Promise<PaneRow | undefined> {
	if (!/^%\d+$/.test(pane)) return undefined;
	try {
		const row = parsePaneRow(await tmux(["display-message", "-p", "-t", pane, PANE_FORMAT], env));
		return row.pane === pane ? row : undefined;
	} catch {
		return undefined;
	}
}

async function allPanes(env: NodeJS.ProcessEnv): Promise<PaneRow[]> {
	try {
		const out = await tmux(["list-panes", "-a", "-F", PANE_FORMAT], env);
		return out ? out.split("\n").map(parsePaneRow) : [];
	} catch {
		return [];
	}
}

/** The live peer of a pane: its @pi_fleet_peer if that pane exists and points back. */
export async function livePeer(pane: string, env: NodeJS.ProcessEnv = process.env): Promise<PaneRow | undefined> {
	const me = await paneInfo(pane, env);
	if (!me?.peer) return undefined;
	const peer = await paneInfo(me.peer, env);
	return peer && peer.peer === pane ? peer : undefined;
}

/** Focus a pane: its window, the pane, and the client (best effort; fails without a client). */
export async function focusPane(pane: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	await tmux(["select-window", "-t", pane, ";", "select-pane", "-t", pane], env);
	if (env.TMUX) await tmuxOk(["switch-client", "-t", pane], env);
}

// Variables the new window gets from the caller (the tmux server's environment may be older).
export const PASS_ENV = [
	"PATH",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PI_FLEET_BIN",
	"PI_FLEET_DECK_CONF",
	"PI_FLEET_DECK_SOCKET",
	"PI_FLEET_NODE",
	"PI_FLEET_PI_CMD",
	"PI_FLEET_NVIM_CMD",
	"PI_FLEET_RUNTIME_DIR",
	"PI_FLEET_STATE_DIR",
	"PI_FLEET_TMUX_GUARD",
	"PI_FLEET_TMUX_SOCKET",
];
export function passEnv(env: NodeJS.ProcessEnv): string[] {
	const out: string[] = [];
	for (const name of PASS_ENV) if (env[name] !== undefined) out.push("-e", `${name}=${env[name]}`);
	// tmux.conf starts shells with SSH_AUTH_SOCK on this stable link; do the same for pi.
	const link = join(homedir(), ".ssh", "ssh_auth_sock");
	if (existsSync(link)) out.push("-e", `SSH_AUTH_SOCK=${link}`);
	return out;
}

// ---------------------------------------------------------------- status files

export interface StatusEntry {
	status: StatusFile;
	live: Liveness;
}

export function readStatuses(env: NodeJS.ProcessEnv = process.env): StatusEntry[] {
	let names: string[];
	try {
		names = readdirSync(statusDir(env));
	} catch {
		return [];
	}
	const out: StatusEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const status = JSON.parse(readFileSync(join(statusDir(env), name), "utf8")) as StatusFile;
			if (!status?.sessionId) continue;
			out.push({ status, live: liveness(status) });
		} catch {
			// partial write or junk: skip
		}
	}
	return out;
}

export function readStatus(sessionId: string, env: NodeJS.ProcessEnv = process.env): StatusEntry | undefined {
	try {
		const status = JSON.parse(readFileSync(statusPath(sessionId, env), "utf8")) as StatusFile;
		return { status, live: liveness(status) };
	} catch {
		return undefined;
	}
}

/** A session's label (ls, kill-deck): the name, else the repo or cwd basename. */
export function windowLabel(status: Pick<StatusFile, "name" | "repo" | "cwd">): string {
	return (status.name || basename(status.repo || status.cwd || "") || "pi").replace(/[\x00-\x1f\x7f]/g, " ");
}

/** First line of a session file: `{"type":"session","id",cwd,...}`. */
function sessionHeader(file: string): { id?: string; cwd?: string } {
	try {
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.alloc(16384);
			const n = readSync(fd, buf, 0, buf.length, 0);
			const first = buf.subarray(0, n).toString("utf8").split("\n")[0];
			const header = JSON.parse(first);
			return header?.type === "session" ? { id: header.id, cwd: header.cwd } : {};
		} finally {
			closeSync(fd);
		}
	} catch {
		return {};
	}
}

/** Resolve `--session FILE|ID` to a full id, file and cwd where possible. */
export function resolveSession(arg: string, env: NodeJS.ProcessEnv = process.env): { id: string; file?: string; cwd?: string } {
	if (arg.endsWith(".jsonl") || arg.includes("/")) {
		const file = resolve(arg);
		const h = sessionHeader(file);
		if (h.id) return { id: h.id, file, cwd: h.cwd };
	}
	const live = readStatuses(env).filter((e) => e.status.sessionId.startsWith(arg));
	if (live.length === 1) {
		const s = live[0].status;
		return { id: s.sessionId, file: s.sessionFile, cwd: s.cwd };
	}
	const root = sessionsRoot(env);
	const matches: string[] = [];
	try {
		for (const dir of readdirSync(root)) {
			let files: string[];
			try {
				files = readdirSync(join(root, dir));
			} catch {
				continue;
			}
			for (const f of files) {
				if (!f.endsWith(".jsonl")) continue;
				const id = f.slice(f.indexOf("_") + 1, -".jsonl".length);
				if (id.startsWith(arg)) matches.push(join(root, dir, f));
			}
		}
	} catch {
		// no sessions dir
	}
	if (matches.length === 1) {
		const h = sessionHeader(matches[0]);
		if (h.id) return { id: h.id, file: matches[0], cwd: h.cwd };
	}
	return { id: arg };
}

// ---------------------------------------------------------------- pair

export interface PairResult {
	piPane: string;
	nvimPane: string;
	nvimSock: string;
	created: boolean;
}

/** Unlink a socket path nobody listens on (only if it is a socket we own). */
export async function clearStaleSocket(path: string): Promise<boolean> {
	let st;
	try {
		st = lstatSync(path);
	} catch {
		return true;
	}
	if (!st.isSocket() || st.uid !== uid()) return false;
	const listening = await new Promise<boolean>((res) => {
		const sock = createConnection(path);
		const done = (v: boolean) => {
			sock.destroy();
			res(v);
		};
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
		setTimeout(() => done(true), 1000).unref();
	});
	if (listening) return false;
	try {
		unlinkSync(path);
	} catch {
		// gone
	}
	return true;
}

/**
 * Pair a pi pane with an nvim pane on its right (split 50%), unless its peer is alive.
 * Sets the pane options on both panes in one tmux call.
 */
export async function pairPane(
	piPane: string,
	opts: { session?: string; cwd?: string } = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<PairResult> {
	const me = await paneInfo(piPane, env);
	if (!me) throw new Error(`pair: no pane ${piPane}`);
	const session = opts.session || me.fleetSession || env.PI_FLEET_SESSION;
	if (!session) throw new Error("pair: no session id (--session, @pi_fleet_session or $PI_FLEET_SESSION)");
	const peer = await livePeer(piPane, env);
	if (peer && me.role !== "nvim") return { piPane, nvimPane: peer.pane, nvimSock: peer.nvimSock, created: false };
	if (me.role === "nvim") throw new Error(`pair: ${piPane} is an nvim pane`);
	const nvimCmd = words(env.PI_FLEET_NVIM_CMD, "nvim");
	const nvimBin = which(nvimCmd[0], env);
	if (!nvimBin) throw new Error(`pair: ${nvimCmd[0]} not found on PATH`);
	let sock = nvimSockPath(session, env);
	if (!(await clearStaleSocket(sock))) sock = join(runtimeDir(env), `${session}.${Date.now()}.nvim.sock`);
	const nvimPane = await tmux(
		[
			"split-window", "-h", "-l", "50%", "-d", "-t", piPane, "-c", fmtLiteral(opts.cwd || me.cwd || homedir()),
			"-P", "-F", "#{pane_id}",
			"-e", `PI_FLEET_SESSION=${session}`,
			"-e", `PI_FLEET_CTL_SOCK=${ctlSockPath(session, env)}`,
			"-e", `PI_FLEET_PI_PANE=${piPane}`,
			...passEnv(env),
			"--", nvimBin, ...nvimCmd.slice(1), "--listen", sock,
		],
		env,
	);
	await tmux(
		[
			"set-option", "-p", "-t", piPane, "@pi_fleet_role", "pi", ";",
			"set-option", "-p", "-t", piPane, "@pi_fleet_session", session, ";",
			"set-option", "-p", "-t", piPane, "@pi_fleet_peer", nvimPane, ";",
			"set-option", "-p", "-t", nvimPane, "@pi_fleet_role", "nvim", ";",
			"set-option", "-p", "-t", nvimPane, "@pi_fleet_session", session, ";",
			"set-option", "-p", "-t", nvimPane, "@pi_fleet_peer", piPane, ";",
			"set-option", "-p", "-t", nvimPane, "@pi_fleet_nvim_sock", sock,
		],
		env,
	);
	return { piPane, nvimPane, nvimSock: sock, created: true };
}

// ---------------------------------------------------------------- ls

async function ls(json: boolean, env: NodeJS.ProcessEnv): Promise<string> {
	const entries = readStatuses(env);
	const panes = inTmux(env) ? await allPanes(env) : [];
	const byId = new Map(panes.map((p) => [p.pane, p]));
	entries.sort((a, b) => Date.parse(b.status.since) - Date.parse(a.status.since));
	if (json) {
		return JSON.stringify(
			entries.map(({ status, live }) => ({ ...status, liveness: live, windowIndex: byId.get(status.tmux?.piPane ?? "")?.windowIndex })),
			null,
			2,
		);
	}
	const host = hostname();
	return entries
		.map(({ status, live }) => {
			const glyph = live === "crashed" || live === "stale" ? GLYPHS.crashed : GLYPHS[status.state] ?? "?";
			const state = live === "live" ? status.state + (status.sub ? ` ${status.sub}` : "") : live;
			const pane = byId.get(status.tmux?.piPane ?? "");
			const where = status.host !== host ? status.host : pane ? `[${pane.windowIndex}]` : "-";
			return [glyph, state.padEnd(14), where.padEnd(6), windowLabel(status).padEnd(24), status.sessionId.slice(0, 8), status.cwd].join(" ");
		})
		.join("\n");
}

// ---------------------------------------------------------------- run-pi

async function waitForSetup(env: NodeJS.ProcessEnv): Promise<void> {
	const pane = env.TMUX_PANE;
	if (!pane) return;
	const end = Date.now() + 3000;
	while (Date.now() < end) {
		const info = await paneInfo(pane, env);
		if (!info || info.role) return;
		await new Promise((r) => setTimeout(r, 50));
	}
}

function runNvim(bin: string, args: string[]): Promise<string | undefined> {
	return new Promise((res) => {
		execFile(bin, args, { timeout: 3000 }, (error, stdout) => res(error ? undefined : String(stdout).trim()));
	});
}

/** An nvim (its --listen socket) has modified file buffers: true/false, undefined if it does not answer. */
export async function nvimModified(sock: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean | undefined> {
	const bin = which(words(env.PI_FLEET_NVIM_CMD, "nvim")[0], env);
	if (!bin || !sock) return undefined;
	const n = await runNvim(bin, ["--server", sock, "--remote-expr", MODIFIED_EXPR]);
	return n === undefined || !/^\d+$/.test(n) ? undefined : n !== "0";
}
const MODIFIED_EXPR = "len(filter(getbufinfo({'bufmodified': 1}), {_, b -> getbufvar(b.bufnr, '&buftype') ==# ''}))";

/** `:qa` the paired nvim unless a file buffer is modified. Returns true if asked to quit. */
export async function closePeerNvim(pane: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	const peer = await livePeer(pane, env);
	if (!peer || peer.role !== "nvim" || !peer.nvimSock) return false;
	const bin = which(words(env.PI_FLEET_NVIM_CMD, "nvim")[0], env);
	if (!bin) return false;
	const modified = await runNvim(bin, ["--server", peer.nvimSock, "--remote-expr", MODIFIED_EXPR]);
	if (modified !== "0") return false;
	// The deck's reconcile replaces an nvim quit by hand with a new one; not this one.
	await tmux(["set-option", "-p", "-t", peer.pane, "@pi_fleet_closing", "1"], env).catch(() => "");
	await runNvim(bin, ["--server", peer.nvimSock, "--remote-send", "<C-\\><C-N>:qa<CR>"]);
	return true;
}

function readKey(): Promise<string> {
	return new Promise((res) => {
		const stdin = process.stdin;
		if (!stdin.isTTY) {
			res("q");
			return;
		}
		stdin.setRawMode(true);
		stdin.resume();
		stdin.once("data", (d) => {
			stdin.setRawMode(false);
			stdin.pause();
			res(d.toString("utf8"));
		});
	});
}

async function runPi(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
	if (env.PI_FLEET_OPENING) {
		await waitForSetup(env);
		delete env.PI_FLEET_OPENING;
	}
	const cmd = words(env.PI_FLEET_PI_CMD, "pi");
	// Like a shell: the terminal's ^C/^\ belong to pi.
	const ignore = () => {};
	process.on("SIGINT", ignore);
	process.on("SIGQUIT", ignore);
	for (;;) {
		const child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: "inherit", env });
		let terminated = false;
		const forward = () => {
			terminated = true;
			child.kill("SIGTERM");
		};
		process.on("SIGTERM", forward);
		const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
			child.once("exit", (c, s) => res([c, s]));
			child.once("error", (e) => {
				process.stderr.write(`pi-fleet: ${cmd[0]}: ${e.message}\n`);
				res([127, null]);
			});
		});
		process.off("SIGTERM", forward);
		if (code === 0) {
			if (env.TMUX_PANE) await closePeerNvim(env.TMUX_PANE, env);
			return 0;
		}
		// We were told to stop (pane or server going away): no crash prompt.
		if (terminated) return 143;
		const why = signal ? `killed by ${signal}` : `exited (${code})`;
		process.stdout.write(`\r\n\x1b[1mpi ${why}.\x1b[0m r restart · q close\r\n`);
		let key = "";
		while (key !== "r" && key !== "q") {
			key = (await readKey()).toLowerCase();
			if (key === "\x03" || key === "\x04") key = "q";
		}
		if (key === "q") {
			if (env.TMUX_PANE) await closePeerNvim(env.TMUX_PANE, env);
			return code ?? 1;
		}
		process.stdout.write("\x1b[2J\x1b[H");
	}
}

// ---------------------------------------------------------------- peer

async function peerCmd(pane: string, select: boolean, env: NodeJS.ProcessEnv): Promise<number> {
	let peer = (await livePeer(pane, env))?.pane;
	if (!peer && select) {
		const me = await paneInfo(pane, env);
		if (me?.role === "pi" || (me && !me.role && (me.fleetSession || env.PI_FLEET_SESSION))) {
			try {
				peer = (await pairPane(pane, {}, env)).nvimPane;
			} catch (error) {
				await tmuxOk(["display-message", `pi-fleet: ${(error as Error).message}`], env);
				return 1;
			}
		} else {
			await tmuxOk(["display-message", me?.role === "nvim" ? "pi-fleet: the pi pane is gone" : "pi-fleet: no paired pane here"], env);
			return 1;
		}
	}
	if (!peer) return 1;
	if (select) await focusPane(peer, env);
	else process.stdout.write(`${peer}\n`);
	return 0;
}

/** Quote a word for sh. */
export function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/*
 * The deck's list (deck-view.ts) and title-backfill run on pi's own pi-tui/pi-ai. They are plain
 * JS under pi's install, so node imports them without type stripping; a module resolve hook maps
 * `@earendil-works/*` to that install, which lets the fleet modules import them the same way inside
 * pi and here. Without a pi install the deck falls back to the plain stand-in list.
 */

/**
 * The node_modules dir holding pi's `@earendil-works/pi-tui`: $PI_FLEET_PI_PACKAGES, else from
 * `realpath(which pi)`: the managed launcher (<agent>/bin/pi → <agent>/install/current-version
 * → install/releases/<v>/node_modules), or the node_modules above an npm-installed pi.
 */
export function locatePiPackages(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const has = (dir: string) => existsSync(join(dir, "@earendil-works", "pi-tui", "package.json"));
	if (env.PI_FLEET_PI_PACKAGES) return has(env.PI_FLEET_PI_PACKAGES) ? env.PI_FLEET_PI_PACKAGES : undefined;
	const pi = which("pi", env);
	if (!pi) return undefined;
	let real: string;
	try {
		real = realpathSync(pi);
	} catch {
		return undefined;
	}
	const agent = resolve(real, "..", "..");
	try {
		const version = readFileSync(join(agent, "install", "current-version"), "utf8").trim();
		const dir = join(agent, "install", "releases", version, "node_modules");
		if (/^[\w.+-]+$/.test(version) && has(dir)) return dir;
	} catch {
		// not the managed launcher
	}
	for (let dir = resolve(real, ".."); ; dir = resolve(dir, "..")) {
		if (basename(dir) === "node_modules" && has(dir)) return dir;
		if (has(join(dir, "node_modules"))) return join(dir, "node_modules");
		if (dir === resolve(dir, "..")) return undefined;
	}
}

/** Resolve `@earendil-works/*` imports from `packages` (a node_modules dir) in this process. */
export async function usePiPackages(packages: string): Promise<void> {
	const { registerHooks } = await import("node:module");
	const { pathToFileURL } = await import("node:url");
	const parentURL = pathToFileURL(join(packages, "pi-fleet-resolve.js")).href;
	registerHooks({
		resolve(specifier, context, next) {
			if (specifier.startsWith("@earendil-works/")) return next(specifier, { ...context, parentURL });
			return next(specifier, context);
		},
	});
}

// ---------------------------------------------------------------- main

const HELP = `usage: pi-fleet <command>
  open [--session FILE|ID] [--cwd DIR] [--no-focus] [--json] [-- PI_ARGS]
                                     a session in the deck (started if needed), selected
  pair [PANE] [--session ID] [--cwd DIR] [--json]
                                     an nvim beside a pi started by hand in your tmux
  peer [PANE] [--select]
  ls [--json]
  run-pi [PI_ARGS]
  deck-start                         start the deck server (tmux -L pifleet) unless it runs
  attach                             the deck: popup in tmux, else attach this terminal
  kill-deck [--yes]                  kill every deck pi (after asking), then the deck server
  deck-reload [--debounce MS]        re-read deck.tmux.conf and restart the deck's list (new code)
  pair --deck PANE [--show] [--json] the deck pi's nvim (created on first use); --show shows and focuses it
  deck                               the deck's list process (run by the deck server)
  title-backfill [--limit N] [--dry-run] [--model PROVIDER/ID]
                                     LLM titles for the N (20) newest closed sessions without a name
`;

// ---------------------------------------------------------------- deck (deck.ts; docs/pi-deck-design.md)

/** `open --deck`: ensure the deck, then `open` over deck.sock. Prints the shown pane (or the reply with --json). */
async function deckOpenCmd(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { session: { type: "string" }, cwd: { type: "string" }, "no-focus": { type: "boolean" }, json: { type: "boolean" } },
		allowPositionals: true,
		strict: true,
	});
	const deck = await import("./deck.ts");
	await deck.startDeck({ size: await outerPopupSize(env) }, env);
	const message: Record<string, unknown> = { type: "open", focus: !values["no-focus"], piArgs: positionals };
	if (values.session) message.session = values.session;
	else message.cwd = resolve((values.cwd as string | undefined) ?? process.cwd());
	const reply = await deck.deckRequest(message, env);
	if (values.json) process.stdout.write(`${JSON.stringify(reply)}\n`);
	if (!reply.ok) {
		if (!values.json) process.stderr.write(`pi-fleet: ${String(reply.error)}\n`);
		return 1;
	}
	if (!values.json) process.stdout.write(`${String(reply.pane)}\n`);
	return 0;
}

/** In a pane of some tmux (not the deck): that client's size, which the popup's size derives from. */
async function outerPopupSize(env: NodeJS.ProcessEnv): Promise<{ width: number; height: number } | undefined> {
	if (!env.TMUX || !env.TMUX_PANE) return undefined;
	const deck = await import("./deck.ts");
	if (deck.inDeck(env)) return undefined;
	const out = await tmux(["display-message", "-p", "-t", env.TMUX_PANE, "#{client_width} #{client_height}"], env).catch(() => "");
	const [w, h] = out.split(" ").map(Number);
	return w && h ? deck.initialDeckSize(env, { width: w, height: h }) : undefined;
}

/**
 * `attach`: ensure the deck; in a pane of the user's tmux open the popup (bin/pi-deck-attach) over
 * that client; otherwise (a terminal, or already in a popup) run pi-deck-attach here.
 */
async function deckAttachCmd(env: NodeJS.ProcessEnv): Promise<number> {
	const deck = await import("./deck.ts");
	if (deck.inDeck(env)) {
		await deck.focusList(env).catch(() => "");
		return 0;
	}
	await deck.startDeck({ size: await outerPopupSize(env) }, env);
	if (env.TMUX && env.TMUX_PANE) {
		await spawnPopup(deck.deckPopupArgs(env.TMUX_PANE, env), env);
		return 0;
	}
	const child = spawn(deck.deckAttachBin(env), [], { stdio: "inherit", env });
	return new Promise((res) => {
		child.once("exit", (code) => res(code ?? 1));
		child.once("error", (e) => {
			process.stderr.write(`pi-fleet: ${e.message}\n`);
			res(127);
		});
	});
}

/** Run a display-popup on the outer server without waiting for it to close (immediate failures are reported). */
function spawnPopup(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise<void>((res, rej) => {
		let base: string[];
		try {
			base = tmuxBaseArgs(env);
		} catch (error) {
			rej(error);
			return;
		}
		const child = spawn("tmux", [...base, ...args], { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
		let err = "";
		child.stderr?.on("data", (d) => (err += d.toString("utf8")));
		const timer = setTimeout(() => {
			child.stderr?.destroy();
			child.unref();
			res();
		}, 300);
		child.once("error", (e) => {
			clearTimeout(timer);
			rej(e);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code) rej(new Error(err.trim() || `display-popup exited ${code}`));
			else res();
		});
	});
}

/** One line from the terminal (for kill-deck's question). */
function readLine(): Promise<string> {
	return new Promise((res) => {
		const stdin = process.stdin;
		let buf = "";
		const onData = (d: Buffer) => {
			buf += d.toString("utf8");
			if (buf.includes("\n")) {
				stdin.off("data", onData);
				stdin.pause();
				res(buf.split("\n")[0]);
			}
		};
		stdin.on("data", onData);
		stdin.once("end", () => res(buf));
		stdin.resume();
	});
}

async function killDeckCmd(yes: boolean, env: NodeJS.ProcessEnv): Promise<number> {
	const deck = await import("./deck.ts");
	if (!(await deck.deckRunning(env)) && !(await deck.deckPanes(env)).length) {
		process.stdout.write("pi-fleet: no deck running\n");
		return 0;
	}
	const live = (await deck.deckPanes(env)).filter((p) => p.role === "pi" && !p.dead && p.session);
	for (const p of live) {
		const entry = readStatus(p.session, env);
		process.stdout.write(`  ${p.session.slice(0, 8)}  ${entry ? windowLabel(entry.status) : "?"}  ${p.cwd}\n`);
	}
	if (!yes) {
		if (!process.stdin.isTTY) {
			process.stderr.write("pi-fleet: kill-deck needs --yes when stdin is not a terminal\n");
			return 1;
		}
		process.stdout.write(`Kill the deck and its ${live.length} session(s)? [y/N] `);
		if (!/^y(es)?$/i.test((await readLine()).trim())) return 1;
	}
	let r = await deck.killDeck({ force: yes }, env);
	if (r.nvims.length) {
		// nvims the exiting pis left open: they may have unsaved buffers.
		process.stderr.write(`pi-fleet: ${r.nvims.length} nvim(s) still open with unsaved changes:\n`);
		for (const n of r.nvims) process.stderr.write(`  ${n.session.slice(0, 8)}  ${n.cwd}  (nvim --server ${n.nvimSock})\n`);
		if (!r.killedServer) {
			process.stdout.write("Kill them too (unsaved changes are lost)? [y/N] ");
			if (!/^y(es)?$/i.test((await readLine()).trim())) {
				process.stderr.write("pi-fleet: the deck keeps running; save them (nvim --server SOCK --remote-send '<C-\\><C-N>:wa<CR>'), then kill-deck again\n");
				return 1;
			}
			r = await deck.killDeck({ force: true }, env);
		}
	}
	if (r.stillAlive.length) process.stderr.write(`pi-fleet: ${r.stillAlive.length} pi(s) did not exit in time; killed with the server\n`);
	return r.killedServer ? 0 : 1;
}

/** `deck-reload [--debounce MS]`: deck.ts deckReload, with a one-line report. */
async function deckReloadCmd(debounceMs: number | undefined, env: NodeJS.ProcessEnv): Promise<number> {
	const deck = await import("./deck.ts");
	const r = await deck.deckReload({ debounceMs, waitMs: 5000 }, env);
	if (!r.running) {
		process.stdout.write("pi-fleet: no deck running\n");
		return 0;
	}
	if (r.skipped) {
		process.stdout.write("pi-fleet: the deck was just reloaded\n");
		return 0;
	}
	if (r.sourceError) process.stderr.write(`pi-fleet: ${deck.deckConfPath(env)}: ${r.sourceError}\n`);
	const pids = r.newPid ? ` (pid ${r.oldPid ? `${r.oldPid} → ` : ""}${r.newPid})` : " (the new list is not up yet)";
	const list =
		r.list === "none"
			? "no list process right now (its loop starts the current code)"
			: `list ${r.list === "respawned" ? "pane respawned with the current loop" : "restarted"}${pids}`;
	process.stdout.write(`deck reloaded: ${r.sourceError ? "config NOT re-read" : "config re-read"}, ${list}\n`);
	return r.sourceError ? 1 : 0;
}

/** `pair --deck PANE [--show] [--json]`; with --show errors also go to the deck's message line. */
async function deckPairCmd(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
	const { values, positionals } = parseArgs({ args, options: { show: { type: "boolean" }, json: { type: "boolean" } }, allowPositionals: true, strict: true });
	const deck = await import("./deck.ts");
	const pane = positionals[0] ?? env.TMUX_PANE;
	if (!pane) throw new Error("pair --deck: no pane");
	try {
		const r = await deck.deckPair(pane, { show: !!values.show }, env);
		process.stdout.write(values.json ? `${JSON.stringify(r)}\n` : `${r.nvimPane}\n`);
		return 0;
	} catch (error) {
		const message = `pi-fleet: ${(error as Error).message}`;
		if (values.show) {
			const clients = (await deck.deckTmux(["list-clients", "-F", "#{client_name}"], env).catch(() => "")).split("\n").filter(Boolean);
			for (const c of clients) await deck.deckTmux(["display-message", "-c", c, message], env).catch(() => "");
		}
		process.stderr.write(`${message}\n`);
		return 1;
	}
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const [cmd, ...rest] = argv;
	// Fail loudly on the tmux guard (helpers that probe panes would otherwise read it as "gone").
	if (["pair", "peer"].includes(cmd ?? "") && !rest.includes("--deck")) tmuxBaseArgs(env);
	const parse = (options: Record<string, { type: "string" | "boolean" }>) =>
		parseArgs({ args: rest, options, allowPositionals: true, strict: true });
	switch (cmd) {
		case "open":
			// Every session opens in the deck (--deck is accepted for older callers).
			return deckOpenCmd(rest.filter((a) => a !== "--deck"), env);
		case "pair": {
			if (rest.includes("--deck")) return deckPairCmd(rest.filter((a) => a !== "--deck"), env);
			const { values, positionals } = parse({ session: { type: "string" }, cwd: { type: "string" }, json: { type: "boolean" } });
			const pane = positionals[0] ?? env.TMUX_PANE;
			if (!pane) throw new Error("pair: no pane (not inside tmux)");
			const result = await pairPane(pane, { session: values.session as string | undefined, cwd: values.cwd as string | undefined }, env);
			process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : `${result.nvimPane}\n`);
			return 0;
		}
		case "peer": {
			const { values, positionals } = parse({ select: { type: "boolean" } });
			const pane = positionals[0] ?? env.TMUX_PANE;
			if (!pane) return 1;
			return peerCmd(pane, !!values.select, env);
		}
		case "ls": {
			const { values } = parse({ json: { type: "boolean" } });
			const out = await ls(!!values.json, env);
			if (out) process.stdout.write(`${out}\n`);
			return 0;
		}
		case "run-pi":
			return runPi(rest[0] === "--" ? rest.slice(1) : rest, env);
		case "deck-start": {
			const deck = await import("./deck.ts");
			const r = await deck.startDeck({}, env);
			process.stdout.write(`${r.started ? "started" : "running"} ${deck.deckSocketPath(env)}\n`);
			return 0;
		}
		case "attach":
			return deckAttachCmd(env);
		case "kill-deck": {
			const { values } = parse({ yes: { type: "boolean" } });
			return killDeckCmd(!!values.yes, env);
		}
		case "deck-reload": {
			const { values } = parse({ debounce: { type: "string" } });
			const debounceMs = values.debounce === undefined ? undefined : Number(values.debounce);
			if (debounceMs !== undefined && !(Number.isFinite(debounceMs) && debounceMs >= 0)) throw new Error("deck-reload: --debounce must be a number of ms");
			return deckReloadCmd(debounceMs, env);
		}
		case "deck": {
			// The list owns stdin, signals and sockets: leave once it is done.
			const packages = locatePiPackages(env);
			if (packages) {
				let view: typeof import("./deck-view.ts") | undefined;
				try {
					await usePiPackages(packages);
					view = await import("./deck-view.ts");
				} catch (error) {
					process.stderr.write(`pi-fleet: pi-tui unusable (${String((error as Error)?.message ?? error).split("\n")[0]}); plain list\n`);
				}
				if (view) process.exit(await view.runDeckView(env));
			} else process.stderr.write("pi-fleet: pi's pi-tui not found (set PI_FLEET_PI_PACKAGES); plain list\n");
			const deck = await import("./deck.ts");
			process.exit(await deck.runDeckStub(env));
		}
		case "title-backfill": {
			const { values } = parse({ limit: { type: "string" }, "dry-run": { type: "boolean" }, model: { type: "string" } });
			const limit = values.limit === undefined ? undefined : Number(values.limit);
			if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error("title-backfill: --limit must be a positive integer");
			const packages = locatePiPackages(env);
			if (!packages) throw new Error("title-backfill: pi's packages not found (set PI_FLEET_PI_PACKAGES)");
			await usePiPackages(packages);
			const tb = await import("./title-backfill.ts");
			const log = (line: string) => process.stdout.write(`${line}\n`);
			const r = await tb.backfill({ limit, dryRun: !!values["dry-run"], model: values.model as string | undefined }, await tb.piDeps(log), env);
			if (!values["dry-run"]) process.stdout.write(`titled ${r.titled.length}, failed ${r.failed.length}\n`);
			return r.failed.length && !r.titled.length ? 1 : 0;
		}
		case undefined:
		case "help":
		case "-h":
		case "--help":
			process.stdout.write(HELP);
			return cmd ? 0 : 2;
		default:
			process.stderr.write(`pi-fleet: unknown command ${cmd}\n${HELP}`);
			return 2;
	}
}

function isEntryPoint(): boolean {
	const arg = process.argv[1];
	if (!arg) return false;
	try {
		return realpathSync(isAbsolute(arg) ? arg : resolve(arg)) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			process.stderr.write(`pi-fleet: ${(error as Error).message}\n`);
			process.exitCode = 1;
		},
	);
}
