/**
 * pi-fleet CLI (design §7, §10): tmux windows for pi sessions. Run through bin/pi-fleet, which
 * picks a node >= 22.18 (type stripping) and sets $PI_FLEET_BIN to its own absolute path.
 * Not an extension module: index.ts does not load it, but extension modules may import its
 * exported helpers (runtimeDir, nvimSockPath, ctlSockPath, windowName, tmux, pairPane, ...);
 * main() only runs when this file is the process entry point.
 *
 *   open [--session FILE|ID] [--cwd DIR] [--target PANE] [-- PI_ARGS]
 *        Live on this host with its pane present → jump there. Live on another host → refuse.
 *        Otherwise a new window: pi (run-pi) on the left, nvim --listen on the right.
 *        Prints the pi pane id.
 *   pair [PANE] [--session ID] [--cwd DIR] [--json]
 *        Give a pi pane (default $TMUX_PANE) a paired nvim pane unless its peer is alive.
 *        Prints the nvim pane id, or {"piPane","nvimPane","nvimSock","created"} with --json.
 *   peer [PANE] [--select]
 *        Print the paired pane of PANE (exit 1 if none/gone). --select focuses it; from a pi
 *        pane whose nvim is gone it re-pairs first.
 *   bar [--pane PANE]
 *        tmux status-left: `π [3]? flare [5]◐ ckpt ` (waiting/question/error/crashed fleet
 *        sessions, newest first, real window indices; glyphs colored with #[fg=…]: waiting
 *        yellow, question magenta bold, error/crashed red). Also keeps the names of windows opened
 *        by `open` as `<glyph> <name>`.
 *   seen [--window W | --pane P | ID...]
 *        Acknowledge waiting/question sessions (writes <id>.seen with the runId). The tmux
 *        session-window-changed hook calls it with the window you switched to.
 *   ls [--json]   status files of this login node (and others, dimmed state)
 *   run-pi [PI_ARGS]
 *        The pi wrapper inside a session pane. Exit 0 → closes the peer nvim with :qa unless
 *        it has modified buffers. Non-zero → `pi exited (N). r restart · q close`. A SIGTERM
 *        to run-pi is forwarded to pi and run-pi exits 143 (no prompt).
 *   dashboard [--window [--pane P]]
 *        The sessions dashboard (sessions-view.ts, full-screen with a live preview; pi-tui
 *        from pi's install, see locatePiPackages). --window: toggle/create the `fleet` window.
 *
 * Pairing is by pane id, stored in pane options (they move with the pane on swap/move):
 *   pi pane:   @pi_fleet_role=pi   @pi_fleet_session=ID @pi_fleet_peer=%nvim
 *   nvim pane: @pi_fleet_role=nvim @pi_fleet_session=ID @pi_fleet_peer=%pi @pi_fleet_nvim_sock=SOCK
 *   window:    @pi_fleet_named=1 (opened by `open`: `bar` keeps its name) / @pi_fleet_dashboard=1
 *
 * Environment:
 *   PI_FLEET_PI_CMD      pi command for run-pi (words split on spaces; tests use a stub)
 *   PI_FLEET_NVIM_CMD    nvim command for pair (default `nvim`)
 *   PI_FLEET_TMUX_SOCKET tmux socket (-S); otherwise the one in $TMUX, otherwise tmux's default
 *   PI_FLEET_TMUX_GUARD  if set, refuse any tmux call that would reach the default socket (tests)
 *   PI_FLEET_RUNTIME_DIR node-local socket dir (default /tmp/pi-fleet-$UID, 0700, checked)
 *   PI_FLEET_STATE_DIR   status files (status.ts)
 * Every tmux/nvim call uses execFile with an argument array.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GLYPHS, liveness, statusDir, statusPath, writeSeen, type Liveness, type StatusFile } from "./status.ts";

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
function which(cmd: string, env: NodeJS.ProcessEnv): string | undefined {
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

function words(cmd: string | undefined, fallback: string): string[] {
	const w = (cmd ?? "").trim().split(/\s+/).filter(Boolean);
	return w.length ? w : [fallback];
}

// ---------------------------------------------------------------- tmux

export function isDefaultSocket(socket: string): boolean {
	return basename(socket) === "default";
}

/** `-S socket` for this process: $PI_FLEET_TMUX_SOCKET, else $TMUX, else tmux's default. */
export function tmuxBaseArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	const socket = env.PI_FLEET_TMUX_SOCKET || env.TMUX?.split(",")[0] || "";
	if (env.PI_FLEET_TMUX_GUARD && (!socket || isDefaultSocket(socket))) {
		throw new Error("pi-fleet: PI_FLEET_TMUX_GUARD refuses the default tmux server");
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
	"#{window_name}",
	"#{@pi_fleet_named}",
].join("\t");

interface PaneRow extends PaneInfo {
	windowName: string;
	named: boolean;
}

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
		windowName: f[11],
		named: f[12] === "1",
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
const PASS_ENV = [
	"PATH",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"PI_FLEET_BIN",
	"PI_FLEET_NODE",
	"PI_FLEET_PI_CMD",
	"PI_FLEET_NVIM_CMD",
	"PI_FLEET_RUNTIME_DIR",
	"PI_FLEET_STATE_DIR",
	"PI_FLEET_TMUX_GUARD",
	"PI_FLEET_TMUX_SOCKET",
];
function passEnv(env: NodeJS.ProcessEnv): string[] {
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

function readStatus(sessionId: string, env: NodeJS.ProcessEnv): StatusEntry | undefined {
	try {
		const status = JSON.parse(readFileSync(statusPath(sessionId, env), "utf8")) as StatusFile;
		return { status, live: liveness(status) };
	} catch {
		return undefined;
	}
}

/** `<glyph> <name>` for a session window: the name, else the repo or cwd basename. */
export function windowLabel(status: Pick<StatusFile, "name" | "repo" | "cwd">): string {
	return (status.name || basename(status.repo || status.cwd || "") || "pi").replace(/[\x00-\x1f\x7f]/g, " ");
}
export function windowName(status: StatusFile, live: Liveness = "live"): string {
	return `${live === "crashed" ? GLYPHS.crashed : GLYPHS[status.state] ?? "?"} ${windowLabel(status)}`;
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
function resolveSession(arg: string, env: NodeJS.ProcessEnv): { id: string; file?: string; cwd?: string } {
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
async function clearStaleSocket(path: string): Promise<boolean> {
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

// ---------------------------------------------------------------- open

export type OpenResult =
	| { action: "jump"; piPane: string; sessionId: string }
	| { action: "new"; piPane: string; nvimPane?: string; window: string; sessionId: string }
	| { action: "refused"; reason: string; sessionId: string };

function gitRoot(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

export async function openSession(
	opts: { session?: string; cwd?: string; target?: string; piArgs?: string[] },
	env: NodeJS.ProcessEnv = process.env,
): Promise<OpenResult> {
	if (!inTmux(env)) throw new Error("open: not inside tmux");
	let sessionId: string;
	let piArgs: string[];
	let cwd = opts.cwd ? resolve(opts.cwd) : undefined;
	let label: string | undefined;
	if (opts.session) {
		const found = resolveSession(opts.session, env);
		sessionId = found.id;
		cwd ??= found.cwd;
		piArgs = ["--session", found.file ?? opts.session];
		const entry = readStatus(sessionId, env);
		if (entry) {
			const { status, live } = entry;
			label = windowLabel(status);
			if (live === "remote") return { action: "refused", reason: `running on ${status.host}`, sessionId };
			if (live === "live" || live === "crashed") {
				const pane = status.tmux?.piPane;
				const info = pane ? await paneInfo(pane, env) : undefined;
				if (info && pane && (!status.tmux?.socket || status.tmux.socket === info.socket)) {
					await focusPane(pane, env);
					return { action: "jump", piPane: pane, sessionId };
				}
				if (live === "live") {
					return {
						action: "refused",
						reason: `running as pid ${status.pid} outside this tmux server${pane ? ` (pane ${pane} not found)` : ""}`,
						sessionId,
					};
				}
			}
		}
	} else {
		sessionId = randomUUID();
		piArgs = ["--session-id", sessionId];
	}
	cwd ??= process.cwd();
	if (!existsSync(cwd)) cwd = homedir();
	label ??= basename(gitRoot(cwd) || cwd);
	piArgs.push(...(opts.piArgs ?? []));

	const self = env.PI_FLEET_BIN || "pi-fleet";
	const targetArgs: string[] = [];
	if (opts.target) {
		const info = await paneInfo(opts.target, env);
		if (info) targetArgs.push("-t", `${info.session}:`);
	}
	const [piPane, window] = (
		await tmux(
			[
				"new-window", "-P", "-F", "#{pane_id}\t#{window_id}", ...targetArgs,
				"-n", fmtLiteral(`${GLYPHS.starting} ${label}`), "-c", fmtLiteral(cwd),
				"-e", `PI_FLEET_SESSION=${sessionId}`,
				"-e", "PI_FLEET_OPENING=1",
				...passEnv(env),
				"--", self, "run-pi", ...piArgs,
			],
			env,
		)
	).split("\t");
	let nvimPane: string | undefined;
	try {
		nvimPane = (await pairPane(piPane, { session: sessionId, cwd }, env)).nvimPane;
	} catch (error) {
		process.stderr.write(`pi-fleet: ${(error as Error).message}\n`);
	}
	// role/session also mark the pane as set up, which run-pi waits for (PI_FLEET_OPENING).
	await tmux(
		[
			"set-option", "-p", "-t", piPane, "@pi_fleet_role", "pi", ";",
			"set-option", "-p", "-t", piPane, "@pi_fleet_session", sessionId, ";",
			"set-option", "-w", "-t", window, "@pi_fleet_named", "1",
		],
		env,
	);
	await focusPane(piPane, env);
	return { action: "new", piPane, nvimPane, window, sessionId };
}

// ---------------------------------------------------------------- bar and seen

const BAR_STATES = new Set(["waiting", "question", "error"]);
/** Glyph colors in the bar, as in the dashboard: needs you yellow, question magenta, error red. */
const BAR_STYLES: Record<string, string> = { waiting: "#[fg=yellow]", question: "#[fg=magenta,bold]", error: "#[fg=red]", crashed: "#[fg=red]" };
const barEscape = (text: string) => text.replace(/#/g, "##");
const BAR_MAX = 5;
const BAR_LABEL = 12;

/** Fleet sessions on this host whose pi pane is in this tmux server. */
async function sessionsInServer(env: NodeJS.ProcessEnv): Promise<{ entry: StatusEntry; pane: PaneRow }[]> {
	const panes = await allPanes(env);
	const byId = new Map(panes.map((p) => [p.pane, p]));
	const out: { entry: StatusEntry; pane: PaneRow }[] = [];
	for (const entry of readStatuses(env)) {
		const { status, live } = entry;
		if (live !== "live" && live !== "crashed") continue;
		const pane = status.tmux?.piPane ? byId.get(status.tmux.piPane) : undefined;
		if (!pane) continue;
		if (status.tmux?.socket && status.tmux.socket !== pane.socket) continue;
		out.push({ entry, pane });
	}
	return out;
}

/** The status-bar text (already escaped for tmux formats). Renames fleet-opened windows. */
export async function bar(opts: { pane?: string }, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const sessions = await sessionsInServer(env);
	const panes = opts.pane ? await paneInfo(opts.pane, env) : undefined;
	const mySession = panes?.session;
	const renames: string[] = [];
	const items: { since: number; text: string }[] = [];
	for (const { entry, pane } of sessions) {
		const { status, live } = entry;
		const name = windowName(status, live);
		// window_name is the literal name; rename-window format-expands its argument.
		if (pane.named && pane.windowName !== name) {
			if (renames.length) renames.push(";");
			renames.push("rename-window", "-t", pane.window, fmtLiteral(name));
		}
		if (live !== "crashed" && !BAR_STATES.has(status.state)) continue;
		if (status.state !== "question" && status.acked && live !== "crashed") continue;
		const shown = live === "crashed" ? "crashed" : status.state;
		const glyph = `${BAR_STYLES[shown] ?? ""}${GLYPHS[shown as keyof typeof GLYPHS]}${BAR_STYLES[shown] ? "#[default]" : ""}`;
		let label = windowLabel(status);
		if (label.length > BAR_LABEL) label = `${label.slice(0, BAR_LABEL - 1)}…`;
		const where = mySession && pane.session !== mySession ? `${pane.sessionName}:${pane.windowIndex}` : `${pane.windowIndex}`;
		const since = Date.parse(live === "crashed" ? status.heartbeat : status.since) || 0;
		items.push({ since, text: `[${barEscape(where)}]${glyph} ${barEscape(label)}` });
	}
	if (renames.length) await tmuxOk(renames, env);
	if (!items.length) return "";
	items.sort((a, b) => b.since - a.since);
	const shown = items.slice(0, BAR_MAX).map((i) => i.text);
	if (items.length > BAR_MAX) shown.push(`+${items.length - BAR_MAX}`);
	return `π ${shown.join(" ")} `;
}

/** States `seen` acknowledges (never running/idle: a .seen file must not outlive its run). */
const SEEN_STATES = new Set(["waiting", "question"]);

export async function seen(
	opts: { window?: string; pane?: string; ids?: string[] },
	env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
	let targets: StatusFile[] = [];
	if (opts.ids?.length) {
		for (const id of opts.ids) {
			const entry = readStatus(id, env);
			if (entry && entry.live === "live") targets.push(entry.status);
		}
	} else if (opts.window || opts.pane) {
		let panes: string[] = [];
		try {
			const out = opts.window
				? await tmux(["list-panes", "-t", opts.window, "-F", "#{pane_id}"], env)
				: await tmux(["display-message", "-p", "-t", opts.pane!, "#{pane_id}"], env);
			panes = out.split("\n").filter(Boolean);
		} catch {
			return [];
		}
		const set = new Set(panes);
		targets = (await sessionsInServer(env)).filter((s) => s.entry.live === "live" && set.has(s.pane.pane)).map((s) => s.entry.status);
	}
	const acked: string[] = [];
	for (const status of targets) {
		if (status.acked || !SEEN_STATES.has(status.state) || !status.runId) continue;
		await writeSeen(status.sessionId, status.runId, env);
		acked.push(status.sessionId);
	}
	return acked;
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

/** `:qa` the paired nvim unless a file buffer is modified. Returns true if asked to quit. */
export async function closePeerNvim(pane: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	const peer = await livePeer(pane, env);
	if (!peer || peer.role !== "nvim" || !peer.nvimSock) return false;
	const bin = which(words(env.PI_FLEET_NVIM_CMD, "nvim")[0], env);
	if (!bin) return false;
	const modified = await runNvim(bin, [
		"--server", peer.nvimSock, "--remote-expr",
		"len(filter(getbufinfo({'bufmodified': 1}), {_, b -> getbufvar(b.bufnr, '&buftype') ==# ''}))",
	]);
	if (modified !== "0") return false;
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

// ---------------------------------------------------------------- peer, dashboard

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

async function dashboardWindow(pane: string | undefined, env: NodeJS.ProcessEnv): Promise<void> {
	const me = pane ? await paneInfo(pane, env) : undefined;
	const panes = await allPanes(env);
	const mine = panes.filter((p) => !me || p.session === me.session);
	let dash: string | undefined;
	for (const p of mine) {
		if ((await tmux(["show-options", "-wqv", "-t", p.window, "@pi_fleet_dashboard"], env).catch(() => "")) === "1") {
			dash = p.window;
			break;
		}
	}
	if (dash && me?.window === dash) {
		await tmuxOk(["last-window", "-t", me.session], env);
		return;
	}
	if (dash) {
		await tmux(["select-window", "-t", dash], env);
		return;
	}
	const self = env.PI_FLEET_BIN || "pi-fleet";
	const window = await tmux(
		["new-window", "-P", "-F", "#{window_id}", ...(me ? ["-t", `${me.session}:`] : []), "-n", "fleet", ...passEnv(env), "--", self, "dashboard"],
		env,
	);
	await tmux(["set-option", "-w", "-t", window, "@pi_fleet_dashboard", "1"], env);
}

/*
 * The dashboard TUI (design §9) is SessionsView (sessions-view.ts) full-screen with a preview,
 * rendered by pi's own pi-tui (TuiMainScreen + ProcessTerminal on the alternate screen). pi-tui
 * is plain JS under pi's install, so node imports it without type stripping; a module resolve
 * hook maps `@earendil-works/*` to that install, which lets sessions-view.ts import pi-tui the
 * same way inside pi and here. Without a pi install the dashboard falls back to `ls` output.
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

async function inDashboardWindow(env: NodeJS.ProcessEnv): Promise<boolean> {
	if (!env.TMUX_PANE) return false;
	return (await tmux(["show-options", "-wqv", "-t", env.TMUX_PANE, "@pi_fleet_dashboard"], env).catch(() => "")) === "1";
}

/**
 * The dashboard TUI. q/Esc: in the `fleet` window back to the last window (the dashboard keeps
 * running), elsewhere (the `prefix G` popup) quit. ctrl+c always quits. A popup also quits once
 * Enter/a moved focus to another window (`d` kills without leaving the dashboard).
 */
async function dashboardTui(env: NodeJS.ProcessEnv): Promise<number> {
	const packages = locatePiPackages(env);
	if (!packages) {
		process.stderr.write("pi-fleet: pi's pi-tui not found (set PI_FLEET_PI_PACKAGES); showing `ls`\n");
		return dashboardPlain(env);
	}
	let piTui: typeof import("@earendil-works/pi-tui");
	let sv: typeof import("./sessions-view.ts");
	try {
		await usePiPackages(packages);
		piTui = await import("@earendil-works/pi-tui");
		sv = await import("./sessions-view.ts");
	} catch (error) {
		// A broken or incompatible pi install: the plain list still works.
		const message = String((error as Error)?.message ?? error).split("\n")[0];
		process.stderr.write(`pi-fleet: pi-tui unusable (${message}); showing ls\n`);
		return dashboardPlain(env);
	}
	const terminal = new piTui.ProcessTerminal();
	const tui = new piTui.TuiMainScreen(terminal);
	let finish: (code: number) => void = () => {};
	const finished = new Promise<number>((res) => (finish = res));
	let view: InstanceType<typeof sv.SessionsView>;
	const onAction = async (action: import("./sessions-view.ts").SessionsAction) => {
		const popup = !(await inDashboardWindow(env));
		if (action.type === "close") {
			if (popup) finish(0);
			else {
				const me = await paneInfo(env.TMUX_PANE ?? "", env);
				await tmuxOk(["last-window", ...(me ? ["-t", me.session] : [])], env);
			}
			return;
		}
		const moved = await sv.runAction(action, (message) => view.flash(message), { env, target: env.TMUX_PANE });
		if (moved && popup) finish(0);
		view.refresh();
		tui.requestRender();
	};
	view = new sv.SessionsView({
		source: sv.fleetSource(env),
		style: sv.ansiStyle,
		mode: "dashboard",
		height: () => terminal.rows,
		preview: sv.panePreview(env),
		requestRender: () => tui.requestRender(),
		onAction: (action) => void onAction(action),
	});
	tui.addInputListener((data: string) => {
		if (data !== "\x03") return undefined;
		finish(0);
		return { consume: true };
	});
	const quit = () => finish(0);
	process.once("SIGTERM", quit);
	process.once("SIGHUP", quit);
	process.stdout.write("\x1b[?1049h\x1b[H");
	tui.addChild(view);
	tui.setFocus(view);
	tui.start();
	view.start();
	const code = await finished;
	view.dispose();
	tui.stop();
	process.stdout.write("\x1b[?1049l");
	process.off("SIGTERM", quit);
	process.off("SIGHUP", quit);
	return code;
}

/** Fallback without pi-tui: `ls` every second, q quits. */
async function dashboardPlain(env: NodeJS.ProcessEnv): Promise<number> {
	const draw = async () => {
		const text = await ls(false, env);
		process.stdout.write(`\x1b[2J\x1b[H pi-fleet  ${hostname()}   (no pi-tui: plain list; q quits)\r\n\r\n${text.replace(/\n/g, "\r\n")}\r\n`);
	};
	await draw();
	const timer = setInterval(() => void draw(), 1000);
	for (;;) {
		const key = await readKey();
		if (key === "q" || key === "\x1b" || key === "\x03") break;
	}
	clearInterval(timer);
	return 0;
}

// ---------------------------------------------------------------- main

const HELP = `usage: pi-fleet <command>
  open [--session FILE|ID] [--cwd DIR] [--target PANE] [-- PI_ARGS]
  pair [PANE] [--session ID] [--cwd DIR] [--json]
  peer [PANE] [--select]
  bar [--pane PANE]
  seen [--window W | --pane P | ID...]
  ls [--json]
  run-pi [PI_ARGS]
  dashboard [--window [--pane PANE]]
`;

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const [cmd, ...rest] = argv;
	// Fail loudly on the tmux guard (helpers that probe panes would otherwise read it as "gone").
	if (["open", "pair", "peer", "dashboard"].includes(cmd ?? "")) tmuxBaseArgs(env);
	const parse = (options: Record<string, { type: "string" | "boolean" }>) =>
		parseArgs({ args: rest, options, allowPositionals: true, strict: true });
	switch (cmd) {
		case "open": {
			const { values, positionals } = parse({ session: { type: "string" }, cwd: { type: "string" }, target: { type: "string" } });
			const result = await openSession(
				{ session: values.session as string | undefined, cwd: values.cwd as string | undefined, target: (values.target as string | undefined) ?? env.TMUX_PANE, piArgs: positionals },
				env,
			);
			if (result.action === "refused") {
				process.stderr.write(`pi-fleet: session ${result.sessionId.slice(0, 8)} ${result.reason}\n`);
				if (env.TMUX) await tmuxOk(["display-message", `pi-fleet: ${result.reason}`], env);
				return 1;
			}
			process.stdout.write(`${result.piPane}\n`);
			return 0;
		}
		case "pair": {
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
		case "bar": {
			const { values } = parse({ pane: { type: "string" } });
			try {
				process.stdout.write(await bar({ pane: values.pane as string | undefined }, env));
			} catch {
				// the status bar shows nothing rather than an error
			}
			return 0;
		}
		case "seen": {
			const { values, positionals } = parse({ window: { type: "string" }, pane: { type: "string" } });
			await seen({ window: values.window as string | undefined, pane: values.pane as string | undefined, ids: positionals }, env);
			return 0;
		}
		case "ls": {
			const { values } = parse({ json: { type: "boolean" } });
			const out = await ls(!!values.json, env);
			if (out) process.stdout.write(`${out}\n`);
			return 0;
		}
		case "run-pi":
			return runPi(rest[0] === "--" ? rest.slice(1) : rest, env);
		case "dashboard": {
			const { values } = parse({ window: { type: "boolean" }, pane: { type: "string" } });
			if (values.window) {
				await dashboardWindow((values.pane as string | undefined) ?? env.TMUX_PANE, env);
				return 0;
			}
			return dashboardTui(env);
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
