/**
 * fleet/sessions-view: the session rows and their formatting, shared by the deck's list (deck-view.ts),
 * plus the `/sessions` command (the deck: its list in a deck pi, the popup elsewhere).
 *
 * Rows (fleetSource): every fleet session with a status file (live on this host, crashed, or live on
 * another host, dimmed) plus the most recent main sessions that are not running, grouped by repo.
 * Groups are ordered by their most urgent row; within a group ? > ✕ > ◐ > ● > ○, then recency.
 * Rows of sessions that are not running fold their JSONL with countSubagents(…, false), so
 * dead-but-working threads show as "interrupted".
 *
 * Also here: the colors (TONE_COLOR; glyph, name and state text): active (live, idle) blue, working
 * purple (autonomous: purple `»`), done (finished, not yet seen) green, needs input (question/dialog)
 * orange bold, error/crashed red, closed grey, remote dimmer grey; one `capture-pane -p -e` of a pane
 * (capturePane: control characters stripped, SGR kept; "can't find pane"/"no server" means gone,
 * anything else, including a timeout, is slow); the kill over a session's control socket (killSession).
 *
 * Portions adapted from agent-deck (github.com/asheshgoplani/agent-deck, MIT, commit 80494e5):
 * the preview capture and control-character stripping (internal/ui/home_preview_fetch.go,
 * ui/home_view_preview.go stripControlCharsPreserveANSI), gone-vs-slow capture classification
 * (internal/tmux/tmux_capture.go captureGoneMarkers), status filter keys and humanizeSince
 * (docs/guide/sessions.md, ui/humanize_since.go). See THIRD_PARTY_LICENSES.
 *
 * pi-tui is imported normally: in the deck's list through the module resolve hook cli.ts
 * registers for `@earendil-works/*` (see usePiPackages there), inside pi through pi's loader.
 * No module-level mutable state: the extension also loads inside subagent sessions.
 */

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ctlSockPath, isDefaultSocket, readStatuses, tmuxBaseArgs } from "./cli.ts";
import { openDeck } from "./deck-client.ts";
import { SessionIndex, countSubagents, type FoldedThread, type IndexEntry, type SubagentCounts } from "./registry.ts";
import { fleetOf } from "./shared.ts";
import { GLYPHS, STALE_MS, type FleetState, type Liveness, type StatusFile } from "./status.ts";

// ---------------------------------------------------------------- rows

/** A row's state: the live state, or derived crashed/remote, or closed (not running). */
export type RowState = FleetState | "crashed" | "remote" | "closed";

export interface SessionRow {
	id: string;
	file?: string;
	name: string;
	/** True when the name is a fallback (first message), not a session name. */
	unnamed?: boolean;
	cwd: string;
	repo: string;
	state: RowState;
	status?: StatusFile;
	live?: Liveness;
	/** Recency in ms: `since` of a live row, heartbeat of a crashed one, file mtime otherwise. */
	at: number;
	counts: SubagentCounts;
	costUsd?: number;
	lastAssistant?: string;
}

export interface SessionsSource {
	load(): SessionRow[];
	/** The subagent threads of a main (folded from its JSONL), or undefined if unknown. */
	threads(row: SessionRow): FoldedThread[] | undefined;
	/** The session file of one of those threads, if known. */
	subagentFile?(row: SessionRow, thread: FoldedThread): string | undefined;
}

export const RECENT_CLOSED = 30;
const ZERO: SubagentCounts = { working: 0, waiting: 0, done: 0, error: 0 };

/** Urgency: ? > ✕ > ◐ > ● > ○ (§9), then remote, then not running. */
const RANK: Record<RowState, number> = {
	question: 0,
	error: 1,
	crashed: 1,
	waiting: 2,
	running: 3,
	starting: 3,
	idle: 4,
	remote: 5,
	closed: 6,
};

/** The index plus the status files of this login node (§6: live status merged over the scan). */
export function fleetSource(env: NodeJS.ProcessEnv = process.env, opts: { recent?: number } = {}): SessionsSource {
	const index = new SessionIndex(env);
	const recent = opts.recent ?? RECENT_CLOSED;
	return {
		load() {
			const mains = new Map<string, IndexEntry>();
			for (const entry of index.scan()) {
				if (entry.subagent || !entry.id) continue;
				const other = mains.get(entry.id);
				if (!other || other.mtimeMs < entry.mtimeMs) mains.set(entry.id, entry);
			}
			const rows: SessionRow[] = [];
			const shown = new Set<string>();
			for (const { status, live } of readStatuses(env)) {
				// A stale status of another host is just a session that is not running.
				if (live === "stale") continue;
				const entry = mains.get(status.sessionId) ?? (status.sessionFile ? index.get(status.sessionFile) : undefined);
				shown.add(status.sessionId);
				let counts = status.subagents ?? ZERO;
				if (live === "crashed" && entry) {
					const detail = index.detail(entry);
					if (detail) counts = countSubagents(detail.threads, false);
				}
				const name = status.name || entry?.detail?.name || entry?.name;
				rows.push({
					id: status.sessionId,
					file: status.sessionFile || entry?.path,
					name: name || entry?.firstMessage || "new session",
					unnamed: !name,
					cwd: status.cwd,
					repo: status.repo || index.repoOf(status.cwd),
					state: live === "crashed" ? "crashed" : live === "remote" ? "remote" : status.state,
					status,
					live,
					at: Date.parse(live === "crashed" ? status.heartbeat : status.since) || 0,
					counts,
					costUsd: status.costUsd,
					lastAssistant: status.lastAssistant,
				});
			}
			const closed = [...mains.values()].filter((e) => !shown.has(e.id!)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, recent);
			for (const entry of closed) {
				// No status file: a file still being written (pi outside the fleet) keeps its last fold
				// until it settles rather than being re-folded every second.
				const detail = index.detail(entry, { settleMs: STALE_MS });
				const name = detail?.name || entry.name;
				const cwd = entry.cwd ?? "";
				rows.push({
					id: entry.id!,
					file: entry.path,
					name: name || entry.firstMessage || entry.id!.slice(0, 8),
					unnamed: !name,
					cwd,
					repo: cwd ? index.repoOf(cwd) : "",
					state: "closed",
					at: entry.mtimeMs,
					counts: detail ? countSubagents(detail.threads, false) : ZERO,
					lastAssistant: detail?.lastAssistant,
				});
			}
			index.save();
			return rows;
		},
		threads(row) {
			const entry = row.file ? index.get(row.file) : undefined;
			const threads = entry ? index.detail(entry, row.status ? {} : { settleMs: STALE_MS })?.threads : undefined;
			index.save();
			return threads;
		},
		subagentFile(row, thread) {
			return thread.sessionFile || index.subagentFile(row.id, thread.path);
		},
	};
}

export interface Group {
	repo: string;
	label: string;
	rows: SessionRow[];
}

function rowOrder(a: SessionRow, b: SessionRow): number {
	return RANK[a.state] - RANK[b.state] || b.at - a.at;
}

/** Group rows by repo; groups by their most urgent row, rows by urgency then recency (§9). */
export function groupRows(rows: SessionRow[]): Group[] {
	const byRepo = new Map<string, SessionRow[]>();
	for (const row of rows) {
		const list = byRepo.get(row.repo) ?? [];
		list.push(row);
		byRepo.set(row.repo, list);
	}
	const groups = [...byRepo.entries()].map(([repo, list]) => ({ repo, label: oneLine(basename(repo) || repo || "?"), rows: list.sort(rowOrder) }));
	groups.sort((a, b) => rowOrder(a.rows[0]!, b.rows[0]!) || a.label.localeCompare(b.label));
	// Two repos with the same basename: show their paths.
	const labels = new Map<string, number>();
	for (const g of groups) labels.set(g.label, (labels.get(g.label) ?? 0) + 1);
	const home = homedir();
	for (const g of groups) {
		if ((labels.get(g.label) ?? 0) > 1) g.label = oneLine(g.repo.startsWith(`${home}/`) ? `~${g.repo.slice(home.length)}` : g.repo);
	}
	return groups;
}

// ---------------------------------------------------------------- formatting

/** "just now", "12m ago", "3h 20m ago", "2d ago" (agent-deck humanizeSince). */
export function humanizeSince(at: number, now: number = Date.now()): string {
	const s = Math.max(0, Math.floor((now - at) / 1000));
	if (s < 60) return "just now";
	return `${duration(now - at)} ago`;
}

/** "45s", "12m", "3h 20m", "2d". */
export function duration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

export type StatusFilter = "running" | "waiting" | "idle" | "error";
export const STATUS_FILTER_KEYS: Record<string, StatusFilter> = { "!": "running", "@": "waiting", "#": "idle", "&": "error" };

export function category(row: SessionRow): StatusFilter {
	const state = row.state === "remote" ? row.status?.state ?? "idle" : row.state;
	if (state === "running" || state === "starting") return "running";
	if (state === "waiting" || state === "question") return "waiting";
	if (state === "error" || state === "crashed") return "error";
	return "idle";
}

/** Semantic colors; the state colors (active … remote) are the row palette (TONE_COLOR). */
export type ViewColor =
	| "accent"
	| "text"
	| "muted"
	| "dim"
	| "success"
	| "warning"
	| "error"
	| "border"
	| "active"
	| "working"
	| "done"
	| "input"
	| "remote";

/** The styling the view needs (ansiStyle; tests use a plain one). */
export interface ViewStyle {
	fg(color: ViewColor, text: string): string;
	bold(text: string): string;
	/** The selected row, already padded to the full width: give it a background. Optional. */
	selected?(line: string): string;
}

/** Put `line` on a background (`open`, an SGR), re-opening it after every reset inside. */
export function withBackground(line: string, open: string): string {
	return `${open}${line.replace(/\x1b\[(?:0|49)?m/g, (m) => m + open)}\x1b[49m`;
}

/**
 * Readable on a dark terminal and on the selection background (grey 238). The row palette is
 * 256-color so it looks the same in every terminal theme: active blue 75, working purple 141,
 * done green 78, needs input orange 208, error red 196, closed grey 250, remote grey 244.
 * `dim` (details, hints) is grey 250 too; only `border` (rules, separators) is the dark grey 90.
 */
export const ANSI_FG: Record<ViewColor, string> = {
	accent: "36",
	text: "97",
	muted: "37",
	dim: "38;5;250",
	success: "32",
	warning: "33",
	error: "38;5;196",
	border: "90",
	active: "38;5;75",
	working: "38;5;141",
	done: "38;5;78",
	input: "38;5;208",
	remote: "38;5;244",
};
/** The selection background: grey 238 of the 256-color cube. */
export const ANSI_SELECTED_BG = "\x1b[48;5;238m";
export const ansiStyle: ViewStyle = {
	fg: (color, text) => `\x1b[${ANSI_FG[color] ?? "39"}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	selected: (line) => withBackground(line, ANSI_SELECTED_BG),
};

/**
 * How a row is colored: what it means for the user (docs/pi-fleet-design.md §9, pi-deck-design
 * §6). active: a live pi that is open but idle (or starting); working: running a turn, or its
 * subagents are (auto: the same, under /run-autonomously, glyph `»`); done: the run finished and
 * the user has not seen it yet (state `waiting`, unacked; seen/acked → idle → active); input: the
 * agent waits for an answer (`question`: ask_user_question or a dialog); error: a failed run or a
 * crashed pi; closed: not running; remote: live on another host.
 */
export type Tone = "active" | "working" | "auto" | "done" | "input" | "error" | "closed" | "remote";
export const TONE_COLOR: Record<Tone, ViewColor> = {
	active: "active",
	working: "working",
	auto: "working",
	done: "done",
	input: "input",
	error: "error",
	closed: "dim",
	remote: "remote",
};

export function rowTone(row: SessionRow): Tone {
	switch (row.state) {
		case "running":
			return row.status?.autonomous ? "auto" : "working";
		case "question":
			return "input";
		case "waiting":
			return "done";
		case "error":
		case "crashed":
			return "error";
		case "closed":
			return "closed";
		case "remote":
			return "remote";
		default:
			return "active";
	}
}

/** `text` in the tone's color; needs input is bold too. */
export function toned(tone: Tone, text: string, style: ViewStyle): string {
	const t = style.fg(TONE_COLOR[tone], text);
	return tone === "input" ? style.bold(t) : t;
}

/** A session that is not running anymore. */
export const CLOSED_GLYPH = "◌";
/** A session working under /run-autonomously. */
export const AUTO_GLYPH = "»";

export function glyphChar(row: SessionRow): string {
	if (row.state === "remote") return "⇢";
	if (row.state === "closed") return CLOSED_GLYPH;
	if (row.state === "running" && row.status?.autonomous) return AUTO_GLYPH;
	return GLYPHS[row.state];
}

export function glyph(row: SessionRow, style: ViewStyle): string {
	return toned(rowTone(row), glyphChar(row), style);
}

/** The color legend, one entry per tone. */
export const LEGEND: [Tone, string][] = [
	["active", `${GLYPHS.idle} active`],
	["working", `${GLYPHS.running} working`],
	["auto", `${AUTO_GLYPH} auto`],
	["done", `${GLYPHS.waiting} done`],
	["input", `${GLYPHS.question} needs input`],
	["error", `${GLYPHS.error} error`],
	["closed", `${CLOSED_GLYPH} closed`],
	["remote", "⇢ remote"],
];

/** The color legend in one line (`sep` between entries). */
export function legend(style: ViewStyle, sep = " "): string {
	return LEGEND.map(([tone, text]) => toned(tone, text, style)).join(sep);
}

/** The middle column: what the session is doing and since when. */
export function rowDetail(row: SessionRow, now: number): string {
	const s = row.status;
	const since = s ? Date.parse(s.since) || row.at : row.at;
	switch (row.state) {
		case "running": {
			const sub = s?.sub ?? "";
			const what = oneLine(sub.startsWith("tool:") ? sub.slice(5) : sub || "working");
			return `${s?.autonomous ? "auto " : ""}${what} ${duration(now - since)}`;
		}
		case "starting":
			return "starting";
		case "question":
			return `question ${duration(now - since)}`;
		case "waiting":
			return `done ${humanizeSince(since, now)}`;
		case "error":
			return `error ${humanizeSince(since, now)}`;
		case "idle":
			return humanizeSince(since, now);
		case "crashed":
			return `crashed ${humanizeSince(row.at, now)}`;
		case "remote":
			return `live on ${oneLine(s?.host ?? "?")}`;
		default:
			return humanizeSince(row.at, now);
	}
}

/** Subagent counts: `2w 1◐ 3✓ 1✕ 2 interrupted`. */
export function countsText(c: SubagentCounts, style: ViewStyle): string {
	const parts: string[] = [];
	if (c.working) parts.push(style.fg("working", `${c.working}w`));
	if (c.waiting) parts.push(style.fg("input", `${c.waiting}◐`));
	if (c.done) parts.push(style.fg("done", `${c.done}✓`));
	if (c.error) parts.push(style.fg("error", `${c.error}✕`));
	if (c.interrupted) parts.push(style.fg("warning", `${c.interrupted} interrupted`));
	if (c.unknown) parts.push(style.fg("dim", `${c.unknown}?`));
	return parts.join(" ");
}

export function threadGlyph(thread: FoldedThread, live: boolean, style: ViewStyle): { glyph: string; word: string } {
	switch (thread.state) {
		case "starting":
		case "running":
			return live ? { glyph: style.fg("working", "●"), word: thread.state } : { glyph: style.fg("warning", "◌"), word: "interrupted" };
		case "paused":
			return { glyph: style.fg("input", "◐"), word: "paused" };
		case "completed":
		case "stopped":
			return { glyph: style.fg("done", "✓"), word: thread.state };
		case "failed":
			return { glyph: style.fg("error", "✕"), word: "failed" };
		default:
			return { glyph: style.fg("dim", "?"), word: thread.state };
	}
}

/**
 * One line of untrusted text (names, paths, hosts, messages): escape sequences dropped, other
 * C0/C1 control characters (line breaks, tabs, a lone ESC) each run turned into one space.
 */
export function oneLine(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI (SGR included)
		.replace(/\x1b[\]P_^][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC/DCS/APC/PM up to BEL or ST
		.replace(/\x1b[ -/]*[0-~]/g, "") // other ESC sequences (`ESC ( B`, `ESC =`)
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ");
}

// ---------------------------------------------------------------- preview

export type PreviewResult = { kind: "frame"; lines: string[] } | { kind: "gone"; reason: string } | { kind: "slow"; reason: string };

/** capture-pane errors that mean the pane (or server) is gone; anything else is "slow". */
const GONE_MARKERS = ["can't find pane", "can't find session", "can't find window", "no server running", "server exited", "error connecting to", "no such file or directory"];

export function isGoneError(message: string): boolean {
	const m = message.toLowerCase();
	return GONE_MARKERS.some((marker) => m.includes(marker));
}

/** Drop control characters and non-SGR escape sequences; keep SGR (`ESC [ … m`). */
export function stripControlPreserveSgr(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === 0x1b) {
			const next = text[i + 1];
			if (next === "[") {
				let j = i + 2;
				while (j < text.length && !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e)) j++;
				if (j < text.length && text[j] === "m" && /^[0-9;:]*$/.test(text.slice(i + 2, j))) out += text.slice(i, j + 1);
				i = j;
			} else if (next === "]" || next === "P" || next === "_" || next === "^") {
				// OSC/DCS/APC/PM: up to BEL or ST
				let j = i + 2;
				while (j < text.length && text[j] !== "\x07" && !(text[j] === "\x1b" && text[j + 1] === "\\")) j++;
				i = text[j] === "\x1b" ? j + 1 : j;
			} else {
				// ESC, intermediates (0x20-0x2f), final byte: e.g. `ESC ( B`, `ESC =`
				let j = i + 1;
				while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
				i = j;
			}
			continue;
		}
		if (c === 0x09) out += " ";
		else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) continue;
		else out += text[i];
	}
	return out;
}

/** Turn capture-pane output into at most `rows` preview lines (trailing blank lines dropped). */
export function previewLines(output: string, rows: number): string[] {
	const lines = output.split("\n").map(stripControlPreserveSgr);
	while (lines.length && !lines[lines.length - 1]!.replace(/\x1b\[[0-9;:]*m/g, "").trim()) lines.pop();
	return lines.slice(-Math.max(1, rows));
}

/**
 * `capture-pane -p -e -t PANE -S -ROWS` on the session's tmux server (`socket`, else this
 * process's). A timeout is "slow", never "gone".
 */
export function capturePane(
	pane: string,
	rows: number,
	opts: { socket?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<PreviewResult> {
	const env = opts.env ?? process.env;
	let base: string[];
	try {
		if (opts.socket) {
			if (env.PI_FLEET_TMUX_GUARD && isDefaultSocket(opts.socket)) throw new Error("PI_FLEET_TMUX_GUARD refuses the default tmux server");
			base = ["-S", opts.socket];
		} else base = tmuxBaseArgs(env);
	} catch (error) {
		return Promise.resolve({ kind: "slow", reason: (error as Error).message });
	}
	return new Promise((res) => {
		execFile(
			"tmux",
			[...base, "capture-pane", "-p", "-e", "-t", pane, "-S", `-${Math.max(1, rows)}`],
			{ timeout: opts.timeoutMs ?? 2000, env, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (!error) {
					res({ kind: "frame", lines: previewLines(String(stdout), rows) });
					return;
				}
				const message = String(stderr).trim() || error.message;
				if ((error as { killed?: boolean }).killed || (error as { signal?: string }).signal) res({ kind: "slow", reason: "timeout" });
				else if (isGoneError(message)) res({ kind: "gone", reason: message });
				else res({ kind: "slow", reason: message });
			},
		);
	});
}

/** Lines a thinking block may take in a subagent preview (its end). */
export const THINKING_LINES = 4;

/** Wrap `text` (untrusted, any line breaks) into sanitized lines of at most `width` columns. */
export function wrapped(text: string, width: number, indent: string): string[] {
	const out: string[] = [];
	for (const l of text.split("\n")) {
		const clean = oneLine(l).trimEnd();
		if (!clean.trim()) continue;
		out.push(...wrapTextWithAnsi(`${indent}${clean}`, Math.max(10, width)));
	}
	return out;
}

/** The state in words, for the status line. */
export function stateWord(row: SessionRow): string {
	switch (row.state) {
		case "running":
			return row.status?.autonomous ? "working autonomously" : "working";
		case "starting":
			return "starting";
		case "question":
			return row.status?.autonomous ? "question: needs you (autonomous: times out)" : "question: needs your answer";
		case "waiting":
			return "done, needs you";
		case "idle":
			return "idle";
		case "error":
			return "error";
		case "crashed":
			return "crashed";
		case "remote":
			return `live on ${oneLine(row.status?.host ?? "?")}`;
		default:
			return "not running";
	}
}

export function tilde(path: string): string {
	const home = homedir();
	return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Printable text of a key event (plain or kitty CSI-u), or undefined. */
export function printable(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty) return kitty;
	if (!data || data.includes("\x1b")) return undefined;
	for (const ch of data) if (ch.charCodeAt(0) < 0x20 || ch === "\x7f") return undefined;
	return data;
}

// ---------------------------------------------------------------- actions

/** Send one NDJSON message to a pi's control socket; resolves with its reply line, if any. */
export function sendControl(sock: string, message: Record<string, unknown>, timeoutMs = 2000): Promise<string> {
	return new Promise((res, rej) => {
		const conn = createConnection(sock);
		let reply = "";
		const timer = setTimeout(() => {
			conn.destroy();
			res(reply);
		}, timeoutMs);
		conn.once("connect", () => conn.write(`${JSON.stringify(message)}\n`));
		conn.on("data", (d) => {
			reply += d.toString("utf8");
			if (reply.includes("\n")) {
				clearTimeout(timer);
				conn.end();
				res(reply.trim());
			}
		});
		conn.once("error", (e) => {
			clearTimeout(timer);
			rej(e);
		});
		conn.once("close", () => {
			clearTimeout(timer);
			res(reply.trim());
		});
	});
}

export type Notify = (message: string, level: "info" | "warning" | "error") => void;

/**
 * `d`, confirmed in the view: {"type":"kill","confirmed":true,"scancel":…} to the session's
 * control socket, so it ends without a dialog of its own (lifecycle.ts). Never jumps there.
 */
export async function killSession(row: SessionRow, scancel: boolean, notify: Notify, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (row.state === "remote") return notify(`pi-fleet: ${row.name} is running on ${row.status?.host}`, "warning");
	if (row.live !== "live") return notify(`pi-fleet: ${row.name} is not running`, "warning");
	const sock = row.status?.ctlSock || ctlSockPath(row.id, env);
	let reply: string;
	try {
		reply = await sendControl(sock, { type: "kill", confirmed: true, scancel });
	} catch (error) {
		return notify(`pi-fleet: cannot reach ${row.name} (${(error as Error).message}); use /kill there`, "warning");
	}
	let parsed: { ok?: boolean; error?: string } | undefined;
	try {
		parsed = JSON.parse(reply);
	} catch {
		parsed = undefined;
	}
	if (parsed?.ok === false) notify(`pi-fleet: ${row.name} refused the kill: ${parsed.error ?? "?"}`, "warning");
}

export function register(pi: ExtensionAPI): void {
	// One entry story (pi-deck-design.md §7): the deck popup, or the deck's list in a deck pi.
	pi.registerCommand("sessions", {
		description: "pi-fleet: open the pi deck (its list in a deck pi; like prefix g)",
		handler: async (_args, ctx) => {
			if (fleetOf(pi).main) await openDeck(ctx);
		},
	});
}
