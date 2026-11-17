/**
 * fleet/sessions-view: SessionsView, the dashboard (`pi-fleet dashboard`, cli.ts; design §6, §9).
 *
 * Rows: every fleet session with a status file (live on this host, crashed, or live on another
 * host, dimmed) plus the 30 most recent main sessions that are not running, grouped by repo.
 * Groups are ordered by their most urgent row; within a group ? > ✕ > ◐ > ● > ○, then recency.
 * Main sessions only: Space on a main shows its subagents (the registry fold of its JSONL),
 * Space on a repo header collapses the group. Rows of sessions that are not running fold their
 * JSONL with countSubagents(…, false), so dead-but-working threads show as "interrupted".
 *
 * There is one view: the dashboard renders the list full-screen with a live preview of the
 * selected session's pi pane: `capture-pane -p -e`, debounced 150 ms on cursor moves and
 * refreshed every second; control characters stripped, SGR kept. "can't find pane"/"no server"
 * means gone (the preview says so); anything else, including a timeout, keeps the last frame.
 * A selected subagent row previews that subagent's own transcript instead: the tail of its
 * session JSONL (registry.ts TranscriptTails: bounded, async, cached by size/mtime), refreshed
 * every second while it runs. While a session's pi pane is joined into the dashboard window
 * (ctrl+l, cli.ts) the list takes the whole pane and the joined pane is the preview.
 * `/sessions` (this module's register) and `Space e` open the dashboard window; `Space E` the
 * popup (openDashboard).
 *
 * Keys (no Alt, no Ctrl+Shift, no Tab): j/k, ↑/↓, ctrl+n/ctrl+p move; PgUp/PgDn page; Space
 * expands/collapses; Enter opens (jumps to a live window, else `pi-fleet open` in a new window;
 * on a subagent: its main); ctrl+l interacts with a live session ("interact": cli.ts joins its
 * pi pane beside the dashboard, or in the popup jumps to it); d kill: an inline confirm (y kill,
 * s kill + scancel its Slurm jobs, n/Esc cancel), then {"type":"kill","confirmed":true,
 * "scancel":…} to that pi's control socket (no dialog there; the view stays open and the row
 * disappears); a new session in the repo of the row or repo header; / filter (every word a case-insensitive substring of name, repo, cwd
 * or last message; while typing, letters go to the filter, Enter opens, Esc stops typing);
 * ! @ # & only running/waiting/idle/error, 0 clears; ? help; Esc clears the filters, then
 * closes; q closes.
 *
 * Colors (TONE_COLOR; glyph, name and state text): active (live, idle) blue, working purple
 * (autonomous: purple `»`), done (finished, not yet seen) green, needs input (question/dialog)
 * orange bold, error/crashed red, closed grey, remote dimmer grey. The selected row gets a
 * full-width background (grey 238) besides the `›` marker. The line above the key hints
 * describes the selected session.
 *
 * Portions adapted from agent-deck (github.com/asheshgoplani/agent-deck, MIT, commit 80494e5):
 * the preview capture and control-character stripping (internal/ui/home_preview_fetch.go,
 * ui/home_view_preview.go stripControlCharsPreserveANSI), gone-vs-slow capture classification
 * (internal/tmux/tmux_capture.go captureGoneMarkers), status filter keys and humanizeSince
 * (docs/guide/sessions.md, ui/humanize_since.go). See THIRD_PARTY_LICENSES.
 *
 * pi-tui is imported normally: in the dashboard through the module resolve hook cli.ts
 * registers for `@earendil-works/*` (see usePiPackages there), inside pi (the /sessions command)
 * through pi's loader.
 * No module-level mutable state: the extension also loads inside subagent sessions.
 */

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { homedir, hostname } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { ctlSockPath, dashboardPopup, dashboardWindow, inTmux, isDefaultSocket, openSession, readStatuses, tmuxBaseArgs } from "./cli.ts";
import { queuedJobs, type SlurmJob } from "./lifecycle.ts";
import { openDeck } from "./deck-client.ts";
import { SessionIndex, TranscriptTails, countSubagents, type FoldedThread, type IndexEntry, type SubagentCounts, type TranscriptItem } from "./registry.ts";
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

function pad(text: string, width: number): string {
	const t = truncateToWidth(text, width, "…");
	return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}
function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}
function padRight(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
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

/** The preview fetcher the dashboard uses: the pi pane of a live or crashed row. */
export function panePreview(env: NodeJS.ProcessEnv = process.env): (row: SessionRow, rows: number) => Promise<PreviewResult> | undefined {
	return (row, rows) => {
		const pane = row.status?.tmux?.piPane;
		if (!pane || (row.live !== "live" && row.live !== "crashed")) return undefined;
		return capturePane(pane, rows, { socket: row.status?.tmux?.socket, env });
	};
}

// ---------------------------------------------------------------- the view

export type SessionsAction =
	| { type: "open"; row: SessionRow }
	| { type: "new"; cwd: string }
	| { type: "kill"; row: SessionRow; scancel: boolean }
	/** ctrl+l on a live session of this host: join its pi pane (window) or jump to it (popup). */
	| { type: "interact"; row: SessionRow }
	| { type: "close" };

export interface SessionsViewOptions {
	source: SessionsSource;
	style: ViewStyle;
	/** The screen height: the view renders exactly this many lines. */
	height: () => number;
	onAction: (action: SessionsAction) => void;
	requestRender: () => void;
	/** Fetch a preview of a row (undefined: the row has no pane). */
	preview?: (row: SessionRow, rows: number) => Promise<PreviewResult> | undefined;
	/** A subagent's recent transcript from its session file (default: a TranscriptTails). */
	transcript?: (file: string) => Promise<TranscriptItem[] | undefined>;
	host?: string;
	now?: () => number;
	/** Slurm jobs among `ids` still queued (lifecycle.ts queuedJobs); for the `d` confirm. */
	squeue?: (ids: string[]) => Promise<SlurmJob[] | undefined>;
}

/** The `d` confirm: Slurm jobs "checking" until squeue answers, undefined if it failed. */
interface KillConfirm {
	row: SessionRow;
	jobs: SlurmJob[] | undefined | "checking";
}

type Item =
	| { kind: "group"; key: string; group: Group; collapsed: boolean }
	| { kind: "main"; key: string; row: SessionRow; expanded: boolean }
	| { kind: "sub"; key: string; row: SessionRow; thread: FoldedThread }
	| { kind: "note"; key: string; text: string };

interface PreviewState {
	lines?: string[];
	gone?: string;
	slow?: string;
}

/** A subagent preview: the file and its items once read (undefined items: unreadable). */
interface TranscriptState {
	file?: string;
	items?: TranscriptItem[];
	failed?: boolean;
}

export const REFRESH_MS = 1000;
export const PREVIEW_DEBOUNCE_MS = 150;
const MESSAGE_MS = 4000;

const HELP_LINES = [
	"j/k ↑/↓ ctrl+n/ctrl+p   move            PgUp/PgDn   page",
	"Space                   show subagents of a session / collapse a repo",
	"Enter                   jump to the session (or open it in a new window)",
	"ctrl+l                  type into a live session: its pi joins this window (popup: jump there)",
	"ctrl+h                  (in the joined pi) back to this list; ctrl+l again: focus it",
	"d                       kill the session: y kill · s kill + scancel its Slurm jobs · n/Esc no",
	"a                       new session in the repo of the row (or repo header)",
	"/                       filter by name, repo, cwd, last message",
	"! @ # &   0             only running / waiting / idle / error;  all",
	"Esc                     clear filters, then close     q  close",
];

export class SessionsView implements Component {
	rows: SessionRow[] = [];
	private items: Item[] = [];
	private selected = 0;
	private selectedKey: string | undefined;
	private top = 0;
	private collapsed = new Set<string>();
	private expanded = new Set<string>();
	private threadCache = new Map<string, FoldedThread[] | undefined>();
	filter = "";
	typing = false;
	statusFilter: StatusFilter | undefined;
	private help = false;
	private message: { text: string; until: number } | undefined;
	private confirm: KillConfirm | undefined;
	private previews = new Map<string, PreviewState>();
	private transcripts = new Map<string, TranscriptState>();
	private previewBusy = false;
	/** The session whose pi pane is joined into the dashboard window (cli.ts), if any. */
	private joinedId: string | undefined;
	private transcriptOf: (file: string) => Promise<TranscriptItem[] | undefined>;
	private timers: ReturnType<typeof setInterval>[] = [];
	private debounce: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private loaded = false;
	private opts: SessionsViewOptions;
	private host: string;

	constructor(opts: SessionsViewOptions) {
		this.opts = opts;
		this.host = opts.host ?? hostname().split(".")[0]!;
		if (opts.transcript) this.transcriptOf = opts.transcript;
		else {
			const tails = new TranscriptTails();
			this.transcriptOf = (file) => tails.get(file);
		}
	}

	/** The joined session (cli.ts tells the view; undefined: none). */
	setJoined(id: string | undefined): void {
		if (this.joinedId === id) return;
		this.joinedId = id;
		if (!id) this.schedulePreview();
	}

	joined(): string | undefined {
		return this.joinedId;
	}

	private now(): number {
		return this.opts.now?.() ?? Date.now();
	}

	/** Load now, then poll the index and status files every second (and the preview). */
	start(): void {
		this.refresh();
		this.timers.push(
			setInterval(() => {
				this.refresh();
				this.opts.requestRender();
			}, REFRESH_MS),
		);
		void this.updatePreview();
		this.timers.push(setInterval(() => void this.updatePreview(), REFRESH_MS));
	}

	dispose(): void {
		this.disposed = true;
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		if (this.debounce) clearTimeout(this.debounce);
	}

	/** Reload rows (and the threads of expanded mains), keeping the selection. */
	refresh(): void {
		try {
			this.rows = this.opts.source.load();
		} catch (error) {
			this.flash(`pi-fleet: ${(error as Error).message}`);
		}
		this.threadCache.clear();
		const ids = new Set(this.rows.map((r) => r.id));
		for (const id of [...this.previews.keys()]) if (!ids.has(id)) this.previews.delete(id);
		const asked = this.confirm?.row;
		if (asked && !this.rows.some((r) => r.id === asked.id && r.live === "live")) {
			this.confirm = undefined;
			this.flash(`${asked.name} is not running`);
		}
		this.rebuild();
	}

	flash(text: string): void {
		this.message = { text: oneLine(text), until: this.now() + MESSAGE_MS };
	}

	private threadsOf(row: SessionRow): FoldedThread[] | undefined {
		if (!this.threadCache.has(row.id)) this.threadCache.set(row.id, this.opts.source.threads(row));
		return this.threadCache.get(row.id);
	}

	private matches(row: SessionRow): boolean {
		if (this.statusFilter && category(row) !== this.statusFilter) return false;
		const q = this.filter.trim();
		if (!q) return true;
		const hay = `${row.name}\n${row.repo}\n${row.cwd}\n${row.lastAssistant ?? ""}`.toLowerCase();
		return q
			.toLowerCase()
			.split(/\s+/)
			.every((token) => hay.includes(token));
	}

	private rebuild(): void {
		const filtering = !!(this.filter.trim() || this.statusFilter);
		const items: Item[] = [];
		for (const group of groupRows(this.rows.filter((r) => this.matches(r)))) {
			const gkey = `g:${group.repo}`;
			const collapsed = !filtering && this.collapsed.has(gkey);
			items.push({ kind: "group", key: gkey, group, collapsed });
			if (collapsed) continue;
			for (const row of group.rows) {
				const key = `m:${row.id}`;
				const expanded = this.expanded.has(row.id);
				items.push({ kind: "main", key, row, expanded });
				if (!expanded) continue;
				const threads = this.threadsOf(row);
				if (!threads?.length) {
					items.push({ kind: "note", key: `n:${row.id}`, text: threads ? "no subagents" : "no session file yet" });
					continue;
				}
				for (const thread of threads) items.push({ kind: "sub", key: `s:${row.id}:${thread.path}`, row, thread });
			}
		}
		this.items = items;
		let index = this.selectedKey ? items.findIndex((i) => i.key === this.selectedKey) : -1;
		if (index < 0) {
			// First load: the first session row.
			if (!this.loaded) index = items.findIndex((i) => i.kind === "main");
			else index = Math.min(this.selected, items.length - 1);
		}
		if (items.length) this.loaded = true;
		this.select(Math.max(0, index), 1, false);
	}

	private select(index: number, direction: 1 | -1, notify = true): void {
		const n = this.items.length;
		if (!n) {
			this.selected = 0;
			return;
		}
		let i = Math.max(0, Math.min(n - 1, index));
		// Notes are not selectable.
		while (this.items[i]?.kind === "note" && i + direction >= 0 && i + direction < n) i += direction;
		if (this.items[i]?.kind === "note") while (i > 0 && this.items[i]?.kind === "note") i--;
		const before = this.selectedKey;
		this.selected = i;
		this.selectedKey = this.items[i]?.key;
		if (notify && before !== this.selectedKey) this.schedulePreview();
	}

	/** The selected item's main row (a subagent's main), if any. */
	selectedRow(): SessionRow | undefined {
		const item = this.items[this.selected];
		return item && (item.kind === "main" || item.kind === "sub") ? item.row : undefined;
	}

	selectedItemKey(): string | undefined {
		return this.selectedKey;
	}

	// ------------------------------------------------------------ input

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		this.message = undefined;
		if (this.confirm) this.handleConfirm(data);
		else if (this.typing) this.handleTyping(data);
		else this.handleKey(data);
		this.opts.requestRender();
	}

	private move(delta: number): void {
		this.select(this.selected + delta, delta < 0 ? -1 : 1);
	}

	private navigate(data: string): boolean {
		const page = Math.max(1, this.listHeight() - 1);
		if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) this.move(1);
		else if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) this.move(-1);
		else if (matchesKey(data, "pageDown")) this.move(page);
		else if (matchesKey(data, "pageUp")) this.move(-page);
		else return false;
		return true;
	}

	private handleTyping(data: string): void {
		if (matchesKey(data, "escape")) this.typing = false;
		else if (matchesKey(data, "enter")) {
			this.typing = false;
			this.activate();
		} else if (matchesKey(data, "backspace")) {
			if (!this.filter) this.typing = false;
			this.filter = this.filter.slice(0, -1);
			this.rebuild();
		} else if (matchesKey(data, "ctrl+c")) this.opts.onAction({ type: "close" });
		else if (matchesKey(data, "ctrl+u")) {
			this.filter = "";
			this.rebuild();
		} else if (!this.navigate(data)) {
			const text = printable(data);
			if (text) {
				this.filter += text;
				this.rebuild();
				this.select(this.items.findIndex((i) => i.kind === "main"), 1);
			}
		}
	}

	private handleKey(data: string): void {
		if (this.navigate(data)) return;
		if (matchesKey(data, "enter")) return this.activate();
		if (matchesKey(data, "space")) return this.toggle();
		if (matchesKey(data, "escape")) {
			if (this.help) this.help = false;
			else if (this.filter || this.statusFilter) {
				this.filter = "";
				this.statusFilter = undefined;
				this.rebuild();
			} else this.opts.onAction({ type: "close" });
			return;
		}
		if (matchesKey(data, "ctrl+c")) return this.opts.onAction({ type: "close" });
		if (matchesKey(data, "ctrl+l")) return this.interact();
		const ch = printable(data);
		switch (ch) {
			case "j":
				return this.move(1);
			case "k":
				return this.move(-1);
			case "q":
				return this.opts.onAction({ type: "close" });
			case "/":
				this.typing = true;
				this.help = false;
				return;
			case "?":
				this.help = !this.help;
				return;
			case "0":
				this.statusFilter = undefined;
				this.rebuild();
				return;
			case "d":
				return this.askKill();
			case "a": {
				const item = this.items[this.selected];
				const repo = item?.kind === "group" ? item.group.repo : item && item.kind !== "note" ? item.row.repo || item.row.cwd : undefined;
				this.opts.onAction({ type: "new", cwd: repo || process.cwd() });
				return;
			}
		}
		if (ch && STATUS_FILTER_KEYS[ch]) {
			const f = STATUS_FILTER_KEYS[ch];
			this.statusFilter = this.statusFilter === f ? undefined : f;
			this.rebuild();
		}
	}

	/** The confirm being shown, if any (tests). */
	confirming(): { row: SessionRow; jobs: SlurmJob[] | undefined | "checking" } | undefined {
		return this.confirm;
	}

	/** `d`: ask inline whether to kill the selected main session (never a remote or dead one). */
	private askKill(): void {
		const item = this.items[this.selected];
		if (!item || item.kind !== "main") {
			this.flash("d kills a session: select its row");
			return;
		}
		const row = item.row;
		if (row.state === "remote") {
			this.flash(`${row.name} runs on ${row.status?.host ?? "another node"}: kill it there`);
			return;
		}
		if (row.live !== "live") {
			this.flash(`${row.name} is not running`);
			return;
		}
		const ids = row.status?.slurmJobs ?? [];
		const confirm: KillConfirm = { row, jobs: ids.length ? "checking" : [] };
		this.confirm = confirm;
		if (!ids.length) return;
		void (this.opts.squeue ?? queuedJobs)(ids)
			.catch(() => undefined)
			.then((jobs) => {
				if (this.confirm !== confirm || this.disposed) return;
				confirm.jobs = jobs;
				this.opts.requestRender();
			});
	}

	/** Slurm jobs `s` would cancel: queued ones, all of them while unknown or checking. */
	private confirmJobs(c: KillConfirm): string[] {
		const ids = c.row.status?.slurmJobs ?? [];
		return Array.isArray(c.jobs) ? c.jobs.map((j) => j.id) : ids;
	}

	private handleConfirm(data: string): void {
		const c = this.confirm!;
		const ch = printable(data);
		if (ch === "y" || ch === "s") {
			const scancel = ch === "s";
			if (scancel && !this.confirmJobs(c).length) return;
			this.confirm = undefined;
			this.flash(`killing ${c.row.name}${scancel ? " and its Slurm jobs" : ""}…`);
			this.opts.onAction({ type: "kill", row: c.row, scancel });
		} else if (ch === "n" || ch === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.confirm = undefined;
		}
	}

	/** ctrl+l: a live session of this host (with a tmux pane), else say why not. */
	private interact(): void {
		const row = this.selectedRow();
		if (!row) {
			this.flash("ctrl+l: select a session");
			return;
		}
		if (row.live !== "live" || !row.status?.tmux?.piPane) {
			this.flash(`${row.name} is not live${row.state === "remote" ? ` here (on ${row.status?.host ?? "another node"})` : row.live === "live" ? " in tmux" : ""}`);
			return;
		}
		this.opts.onAction({ type: "interact", row });
	}

	private activate(): void {
		const item = this.items[this.selected];
		if (!item || item.kind === "note") return;
		if (item.kind === "group") return this.toggle();
		this.opts.onAction({ type: "open", row: item.row });
	}

	private toggle(): void {
		const item = this.items[this.selected];
		if (!item) return;
		if (item.kind === "group") {
			if (this.collapsed.has(item.key)) this.collapsed.delete(item.key);
			else this.collapsed.add(item.key);
		} else if (item.kind === "main" || item.kind === "sub") {
			const id = item.row.id;
			if (this.expanded.has(id)) {
				this.expanded.delete(id);
				this.selectedKey = `m:${id}`;
			} else this.expanded.add(id);
			this.threadCache.delete(id);
		}
		this.rebuild();
	}

	// ------------------------------------------------------------ preview

	private schedulePreview(): void {
		if (this.disposed) return;
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.updatePreview(), PREVIEW_DEBOUNCE_MS);
	}

	/** Fetch the selected row's preview once (the timers call this). Nothing while joined. */
	async updatePreview(): Promise<void> {
		const item = this.items[this.selected];
		if (item?.kind === "sub") return this.updateTranscript(item.row, item.thread, item.key);
		const row = this.selectedRow();
		if (!row || !this.opts.preview || this.previewBusy || this.disposed || this.joinedId) return;
		const pending = this.opts.preview(row, this.previewBodyHeight());
		if (!pending) return;
		this.previewBusy = true;
		try {
			const result = await pending;
			const state = this.previews.get(row.id) ?? {};
			if (result.kind === "frame") this.previews.set(row.id, { lines: result.lines });
			else if (result.kind === "gone") this.previews.set(row.id, { lines: state.lines, gone: result.reason });
			else this.previews.set(row.id, { ...state, slow: result.reason });
		} finally {
			this.previewBusy = false;
		}
		if (!this.disposed) this.opts.requestRender();
	}

	/** A subagent's transcript: read once, then every second while it runs (cached by size/mtime). */
	private async updateTranscript(row: SessionRow, thread: FoldedThread, key: string): Promise<void> {
		if (this.previewBusy || this.disposed || this.joinedId) return;
		const state = this.transcripts.get(key);
		const file = this.opts.source.subagentFile?.(row, thread);
		if (!file) {
			this.transcripts.set(key, {});
			return;
		}
		// Read once; again every second only while the thread runs (or once it names another file).
		const running = thread.state === "running" || thread.state === "starting";
		if (state?.file === file && (state.items || state.failed) && !running) return;
		this.previewBusy = true;
		try {
			const items = await this.transcriptOf(file);
			this.transcripts.set(key, items ? { file, items } : { file, failed: true, items: state?.items });
		} finally {
			this.previewBusy = false;
		}
		if (!this.disposed) this.opts.requestRender();
	}

	// ------------------------------------------------------------ render

	invalidate(): void {}

	/** Dashboard narrower than this: the preview goes below the list instead of beside it. */
	static readonly SIDE_BY_SIDE_MIN = 100;
	private stackedLast = false;

	/** Lines around the body: header, status line, key hints. */
	static readonly CHROME = 3;

	private listHeight(): number {
		const bodyH = Math.max(1, this.opts.height() - SessionsView.CHROME);
		return this.stackedLast && !this.joinedId ? Math.max(3, Math.floor(bodyH / 2)) : bodyH;
	}
	private previewBodyHeight(): number {
		const bodyH = Math.max(1, this.opts.height() - SessionsView.CHROME);
		return Math.max(1, (this.stackedLast ? bodyH - this.listHeight() : bodyH) - 1);
	}

	render(width: number): string[] {
		const style = this.opts.style;
		const height = Math.max(SessionsView.CHROME + 1, this.opts.height());
		if (this.message && this.message.until < this.now()) this.message = undefined;
		const header = this.headerLine(width);
		const footer = [this.statusLine(width), this.footerLine(width)];
		const help = (w: number) => [...HELP_LINES.map((l) => fit(style.fg("muted", ` ${l}`), w)), fit(` ${legend(style)}`, w)];
		const bodyH = height - SessionsView.CHROME;
		this.stackedLast = width < SessionsView.SIDE_BY_SIDE_MIN;
		let body: string[];
		if (this.joinedId) {
			// The joined pi pane beside this one is the preview: the list takes the whole pane.
			body = this.help ? help(width) : this.listLines(width, bodyH);
		} else if (!this.stackedLast) {
			const listW = Math.max(50, Math.min(80, Math.floor(width * 0.5)));
			const prevW = width - listW - 1;
			const list = this.help ? help(listW) : this.listLines(listW, bodyH);
			const prev = this.previewPane(prevW, bodyH);
			const sep = style.fg("border", "│");
			body = [];
			for (let i = 0; i < bodyH; i++) body.push(`${pad(list[i] ?? "", listW)}${sep}${fit(prev[i] ?? "", prevW)}`);
		} else {
			const listH = this.listHeight();
			const list = this.help ? help(width) : this.listLines(width, listH);
			while (list.length < listH) list.push("");
			body = [...list.slice(0, listH), ...this.previewPane(width, bodyH - listH)];
		}
		while (body.length < bodyH) body.push("");
		return [header, ...body.slice(0, bodyH), ...footer].map((l) => fit(l, width));
	}

	private headerLine(width: number): string {
		const style = this.opts.style;
		const live = this.rows.filter((r) => r.live === "live").length;
		const waiting = this.rows.filter((r) => r.live === "live" && (r.state === "waiting" || r.state === "question")).length;
		let left = ` ${style.bold(style.fg("accent", "pi-fleet"))}  ${oneLine(this.host)}   ${live} live`;
		if (waiting) left += ` · ${style.fg("warning", `${waiting} waiting`)}`;
		const filters: string[] = [];
		if (this.statusFilter) filters.push(style.fg("accent", `[${this.statusFilter}]`));
		if (this.typing || this.filter) filters.push(`/${this.filter}${this.typing ? style.fg("accent", "▏") : ""}`);
		const right = filters.length ? filters.join(" ") : legend(style);
		const gap = width - visibleWidth(left) - visibleWidth(right) - 1;
		return gap >= 2 ? `${left}${" ".repeat(gap)}${right} ` : fit(`${left}  ${right}`, width);
	}

	private footerLine(width: number): string {
		const style = this.opts.style;
		if (this.confirm) {
			const scancel = this.confirmJobs(this.confirm).length ? " · s kill+scancel" : "";
			return fit(` ${style.bold(style.fg("warning", `y kill${scancel} · n/Esc cancel`))}`, width);
		}
		if (this.message) return fit(` ${style.fg("warning", this.message.text)}`, width);
		const hint = this.typing
			? "type to filter · enter open · esc stop typing · ↑/↓ move"
			: this.joinedId
				? "ctrl+l focus/switch · C-h back · enter open · space subagents · d kill · / filter · ? help · q close"
				: "enter open · ctrl+l interact · space subagents · d kill · a new · / filter · !@#& status · ? help · q close";
		return fit(style.fg("dim", ` ${hint}`), width);
	}

	/** The line above the key hints: the selected session in full, or the kill confirm. */
	private statusLine(width: number): string {
		const style = this.opts.style;
		const sep = style.fg("dim", " · ");
		if (this.confirm) {
			const { row, jobs } = this.confirm;
			const parts: string[] = [];
			if (row.state === "running" && !row.status?.sub?.startsWith("bg")) parts.push("agent working");
			if (row.state === "question") parts.push("agent asking");
			const n = row.counts.working;
			if (n) parts.push(`${n} subagent${n === 1 ? "" : "s"} working`);
			const ids = row.status?.slurmJobs ?? [];
			if (jobs === "checking") parts.push(`Slurm ${ids.join(" ")} (checking)`);
			else if (jobs === undefined) parts.push(`Slurm ${ids.join(" ")} (state unknown)`);
			else if (jobs.length) parts.push(`Slurm ${jobs.map((j) => `${j.id} ${j.state.toLowerCase()}`).join(", ")}`);
			const text = `Kill ${style.bold(oneLine(row.name))}?${parts.length ? ` ${parts.join(" · ")}` : ""}`;
			return fit(` ${style.fg("warning", text)}`, width);
		}
		const item = this.items[this.selected];
		if (!item || item.kind === "note") return "";
		const now = this.now();
		if (item.kind === "group") {
			const g = item.group;
			const live = g.rows.filter((r) => r.live === "live").length;
			const text = `${oneLine(g.label)}${sep}${style.fg("dim", tilde(oneLine(g.repo)))}${sep}${g.rows.length} session${g.rows.length === 1 ? "" : "s"}, ${live} live${sep}${style.fg("dim", "a: new session here")}`;
			return fit(` ${text}`, width);
		}
		const row = item.row;
		if (item.kind === "sub") {
			const live = row.live === "live" || row.live === "remote";
			const { glyph: g, word } = threadGlyph(item.thread, live, style);
			const parts = [`${g} ${word}`, oneLine(`${item.thread.type ?? "?"} ${item.thread.path}`), `of ${oneLine(row.name)}`];
			if (item.thread.task) parts.push(style.fg("dim", oneLine(item.thread.task)));
			return fit(` ${parts.join(sep)}`, width);
		}
		const s = row.status;
		const tone = rowTone(row);
		const since = s ? Date.parse(s.since) || row.at : row.at;
		const parts = [toned(tone, `${glyphChar(row)} ${stateWord(row)}`, style)];
		if (row.state === "running") {
			const sub = s?.sub ?? "";
			parts.push(sub.startsWith("tool:") ? `tool ${oneLine(sub.slice(5))}` : sub.startsWith("bg") ? `subagents in the background` : "thinking");
		} else if (row.state === "question") {
			parts.push(s?.sub === "ask" ? "ask_user_question" : "a dialog");
		}
		if (row.live === "live" || row.live === "remote") parts.push(`for ${duration(now - since)}`);
		else parts.push(row.state === "crashed" ? `died ${humanizeSince(row.at, now)}` : `last active ${humanizeSince(row.at, now)}`);
		if (row.costUsd) parts.push(`$${row.costUsd.toFixed(2)}`);
		const counts = countsText(row.counts, style);
		if (counts) parts.push(`subagents ${counts}`);
		if (row.cwd) parts.push(style.fg("dim", tilde(oneLine(row.cwd))));
		if (row.lastAssistant) parts.push(style.fg("dim", `“${oneLine(row.lastAssistant)}”`));
		return fit(` ${parts.join(sep)}`, width);
	}

	private listLines(width: number, height: number): string[] {
		const style = this.opts.style;
		if (!this.items.length) {
			const empty = this.filter || this.statusFilter ? "no sessions match (Esc clears the filter)" : "no pi sessions yet";
			return [fit(style.fg("dim", `   ${empty}`), width)];
		}
		if (this.selected < this.top) this.top = this.selected;
		if (this.selected >= this.top + height) this.top = this.selected - height + 1;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, this.items.length - height)));
		const lines: string[] = [];
		const now = this.now();
		for (let i = this.top; i < Math.min(this.items.length, this.top + height); i++) {
			lines.push(this.itemLine(this.items[i]!, i === this.selected, width, now));
		}
		if (this.top > 0) lines[0] = this.withMore(lines[0]!, "↑", width);
		if (this.top + height < this.items.length) lines[lines.length - 1] = this.withMore(lines[lines.length - 1]!, "↓", width);
		const at = this.selected - this.top;
		if (style.selected && lines[at] !== undefined) lines[at] = style.selected(pad(lines[at]!, width));
		return lines;
	}

	private withMore(line: string, arrow: string, width: number): string {
		return `${fit(line, width - 2)}${" ".repeat(Math.max(0, width - 2 - visibleWidth(fit(line, width - 2))))} ${this.opts.style.fg("dim", arrow)}`;
	}

	private itemLine(item: Item, selected: boolean, width: number, now: number): string {
		const style = this.opts.style;
		const marker = selected ? style.bold(style.fg("accent", "›")) : " ";
		if (item.kind === "group") {
			const n = item.group.rows.length;
			const label = selected ? style.bold(item.group.label) : style.fg("accent", item.group.label);
			return fit(`${marker}${style.fg("dim", item.collapsed ? "▸" : "▾")} ${label} ${style.fg("dim", `(${n})`)}`, width);
		}
		if (item.kind === "note") return fit(`       ${style.fg("dim", item.text)}`, width);
		const row = item.row;
		if (item.kind === "sub") {
			const live = row.live === "live" || row.live === "remote";
			const { glyph: g, word } = threadGlyph(item.thread, live, style);
			const label = oneLine(`${item.thread.type ?? "?"} ${item.thread.path}`);
			const avail = width - 7;
			const labelW = Math.min(36, Math.max(10, avail - 14));
			let text = `${pad(selected ? style.bold(label) : label, labelW)} ${pad(style.fg("muted", word), 12)}`;
			if (item.thread.task) text += ` ${style.fg("dim", oneLine(item.thread.task))}`;
			return fit(`${marker}     ${g} ${text}`, width);
		}
		// main row: name | detail | cost | subagent counts
		// name | detail | cost | counts; narrow lists (the dashboard) drop the cost column.
		const avail = Math.max(10, width - 5);
		const wide = avail >= 64;
		const detailW = wide ? 18 : 15;
		const nameW = Math.min(wide ? 30 : 22, Math.max(8, avail - detailW - 1 - (wide ? 8 : 0) - 1 - 10));
		const name = oneLine(row.name);
		let nameText = toned(rowTone(row), name, style);
		if (selected) nameText = style.bold(nameText);
		const detailText = toned(rowTone(row), rowDetail(row, now), style);
		const cost = row.costUsd ? `$${row.costUsd.toFixed(2)}` : "";
		const counts = countsText(row.counts, style);
		const costText = wide ? ` ${padRight(style.fg("dim", cost), 7)}` : "";
		const joined = row.id === this.joinedId ? style.fg("accent", "⇥") : " ";
		const line = `${marker}${joined} ${glyph(row, style)} ${pad(nameText, nameW)} ${pad(detailText, detailW)}${costText} ${counts}`;
		return fit(line, width);
	}

	private previewPane(width: number, height: number): string[] {
		const style = this.opts.style;
		if (height <= 0) return [];
		const item = this.items[this.selected];
		const rule = (title: string) => {
			const t = ` ${title} `;
			const w = visibleWidth(t);
			return style.fg("border", "──") + fit(t, Math.max(0, width - 2)) + style.fg("border", "─".repeat(Math.max(0, width - 2 - w)));
		};
		if (!item || item.kind === "note") return [rule("preview"), style.fg("dim", " nothing selected")];
		if (item.kind === "group") {
			const g = item.group;
			const lines = [rule(oneLine(g.label)), ` ${style.fg("dim", oneLine(g.repo))}`, ""];
			for (const r of g.rows) lines.push(` ${glyph(r, style)} ${oneLine(r.name)}  ${style.fg("dim", rowDetail(r, this.now()))}`);
			return lines.slice(0, height);
		}
		if (item.kind === "sub") return this.transcriptPane(item, width, height, rule);
		const row = item.row;
		const pane = row.status?.tmux?.piPane;
		const state = this.previews.get(row.id);
		const lines: string[] = [];
		const tail = (text: string | undefined, label: string) => {
			if (!text) return;
			lines.push("", style.fg("dim", ` ${label}`));
			for (const l of text.split("\n")) lines.push(...wrapTextWithAnsi(` ${oneLine(l)}`, Math.max(10, width - 1)));
		};
		if (row.state === "remote") {
			const host = oneLine(row.status?.host ?? "?");
			lines.push(rule(`${oneLine(row.name)} · ${host}`), style.fg("dim", ` running on ${host}: no preview from this node`));
			tail(row.lastAssistant, "last message:");
		} else if (!pane && row.state !== "closed") {
			lines.push(rule(oneLine(row.name)), style.fg("dim", ` running outside tmux (pid ${row.status?.pid}): no preview`));
			tail(row.lastAssistant, "last message:");
		} else if (row.state === "closed" || !pane) {
			lines.push(rule(oneLine(row.name)), style.fg("dim", ` not running · last active ${humanizeSince(row.at, this.now())}`));
			const counts = countsText(row.counts, style);
			if (counts) lines.push(` subagents: ${counts}`);
			lines.push(style.fg("dim", ` ${oneLine(row.cwd)}`));
			tail(row.lastAssistant, "last message:");
		} else if (state?.gone) {
			lines.push(rule(`${oneLine(row.name)} · ${pane}`), style.fg("error", ` pane ${pane} is gone (${oneLine(state.gone)})`));
			tail(row.lastAssistant, "last message:");
		} else {
			lines.push(rule(`${oneLine(row.name)} · ${pane}${state?.slow ? " · slow, last frame" : ""}`));
			if (state?.lines) lines.push(...state.lines.slice(-(height - 1)).map((l) => `${l}\x1b[0m`));
			else lines.push(style.fg("dim", " capturing…"));
		}
		return lines.slice(0, height);
	}

	/** A subagent row: the tail of its own transcript (text, dimmed thinking, one line per tool call). */
	private transcriptPane(item: Extract<Item, { kind: "sub" }>, width: number, height: number, rule: (title: string) => string): string[] {
		const style = this.opts.style;
		const { row, thread } = item;
		const live = row.live === "live" || row.live === "remote";
		const { word } = threadGlyph(thread, live, style);
		const head = [rule(oneLine(`${thread.type ?? "?"} ${thread.path} · ${word}`))];
		if (thread.task) head.push(fit(style.fg("dim", ` task: ${oneLine(thread.task)}`), width));
		const state = this.transcripts.get(item.key);
		const note = (text: string) => [...head, style.fg("dim", ` ${text}`)].slice(0, height);
		if (!state) return note("reading…");
		if (!state.file) return note("no transcript file for this subagent yet");
		if (!state.items) return note(`cannot read ${oneLine(tilde(state.file))}`);
		if (!state.items.length) return note("no assistant output yet");
		const body: string[] = [];
		const w = Math.max(10, width - 1);
		for (const it of state.items) {
			if (it.kind === "tool") {
				const mark = it.result === "error" ? style.fg("error", "✗") : it.result === "ok" ? style.fg("success", "✓") : style.fg("dim", "…");
				body.push(fit(` ${mark} ${style.fg("muted", oneLine(it.text))}`, width));
			} else if (it.kind === "thinking") {
				const lines = wrapped(it.text, w, " ").slice(-THINKING_LINES);
				body.push(...lines.map((l) => style.fg("dim", l)));
			} else {
				body.push(...wrapped(it.text, w, " "));
			}
		}
		const room = Math.max(0, height - head.length);
		return [...head, ...body.slice(-room).map((l) => fit(l, width))].slice(0, height);
	}
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

/**
 * Carry out a view action. Returns true if focus moved to another window (the dashboard popup
 * then closes). `target` is the pane whose tmux session gets new windows. `kill` never moves.
 */
export async function runAction(
	action: SessionsAction,
	notify: Notify,
	opts: { env?: NodeJS.ProcessEnv; target?: string } = {},
): Promise<boolean> {
	const env = opts.env ?? process.env;
	if (action.type === "close" || action.type === "interact") return false;
	if (action.type === "kill") {
		await killSession(action.row, action.scancel, notify, env);
		return false;
	}
	if (!inTmux(env)) {
		const file = action.type === "new" ? undefined : action.row.file;
		notify(`pi-fleet: not inside tmux${file ? ` (pi --session ${file})` : ""}`, "warning");
		return false;
	}
	const target = opts.target ?? env.TMUX_PANE;
	try {
		if (action.type === "new") {
			await openSession({ cwd: action.cwd, target }, env);
			return true;
		}
		const row = action.row;
		if (row.state === "remote") {
			notify(`pi-fleet: ${row.name} is running on ${row.status?.host}`, "warning");
			return false;
		}
		const result = await openSession({ session: row.file || row.id, target }, env);
		if (result.action === "refused") {
			notify(`pi-fleet: ${row.name} ${result.reason}`, "warning");
			return false;
		}
		return true;
	} catch (error) {
		notify(`pi-fleet: ${(error as Error).message}`, "error");
		return false;
	}
}

// ---------------------------------------------------------------- /sessions, Space e, Space E

/**
 * Open the dashboard from pi: the `fleet` window (`/sessions`, `Space e`; like `prefix g`, it
 * toggles back from the dashboard window) or the popup (`Space E`, like `prefix G`).
 * `run` replaces the tmux side (tests).
 */
export async function openDashboard(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	how: "window" | "popup",
	run: { window?: typeof dashboardWindow; popup?: typeof dashboardPopup } = {},
): Promise<void> {
	if (!fleetOf(pi).main) return;
	const env = process.env;
	if (!inTmux(env) || !env.TMUX_PANE) {
		ctx.ui.notify("pi-fleet: the dashboard needs tmux (try `pi-fleet ls`)", "warning");
		return;
	}
	try {
		if (how === "popup") await (run.popup ?? dashboardPopup)(env.TMUX_PANE, env);
		else await (run.window ?? dashboardWindow)(env.TMUX_PANE, env);
	} catch (error) {
		ctx.ui.notify(`pi-fleet: dashboard: ${(error as Error).message}`, "error");
	}
}

export function register(pi: ExtensionAPI): void {
	// One entry story (pi-deck-design.md §7): the deck popup, or the deck's list in a deck pi.
	pi.registerCommand("sessions", {
		description: "pi-fleet: open the pi deck (its list in a deck pi; like prefix g / Space e)",
		handler: async (_args, ctx) => {
			if (fleetOf(pi).main) await openDeck(ctx);
		},
	});
}
