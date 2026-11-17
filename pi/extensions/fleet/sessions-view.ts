/**
 * fleet/sessions-view: SessionsView, the one component behind `/sessions` and the dashboard
 * (design §6, §9).
 *
 * Rows: every fleet session with a status file (live on this host, crashed, or live on another
 * host, dimmed) plus the 30 most recent main sessions that are not running, grouped by repo.
 * Groups are ordered by their most urgent row; within a group ? > ✕ > ◐ > ● > ○, then recency.
 * Main sessions only: Space on a main shows its subagents (the registry fold of its JSONL),
 * Space on a repo header collapses the group. Rows of sessions that are not running fold their
 * JSONL with countSubagents(…, false), so dead-but-working threads show as "interrupted".
 *
 * `/sessions` (this module's register) renders the list through ctx.ui.custom; the dashboard
 * (`pi-fleet dashboard`, cli.ts) renders it full-screen with a live preview of the selected
 * session's pi pane: `capture-pane -p -e`, debounced 150 ms on cursor moves and refreshed every
 * second; control characters stripped, SGR kept. "can't find pane"/"no server" means gone (the
 * preview says so); anything else, including a timeout, keeps the last frame.
 *
 * Keys (no Alt, no Ctrl+Shift, no Tab): j/k, ↑/↓, ctrl+n/ctrl+p move; PgUp/PgDn page; Space
 * expands/collapses; Enter opens (jumps to a live window, else `pi-fleet open` in a new window;
 * on a subagent: its main); x kill (sends {"type":"kill"} to that pi's control socket, then
 * jumps there); n new session in the row's repo; / filter (every word a case-insensitive
 * substring of name, repo, cwd or last message; while typing, letters go to the filter, Enter
 * opens, Esc stops typing); ! @ # & only running/waiting/idle/error, 0 clears; ? help; Esc
 * clears the filters, then closes; q closes.
 *
 * Portions adapted from agent-deck (github.com/asheshgoplani/agent-deck, MIT, commit 80494e5):
 * the preview capture and control-character stripping (internal/ui/home_preview_fetch.go,
 * ui/home_view_preview.go stripControlCharsPreserveANSI), gone-vs-slow capture classification
 * (internal/tmux/tmux_capture.go captureGoneMarkers), status filter keys and humanizeSince
 * (docs/guide/sessions.md, ui/humanize_since.go). See THIRD_PARTY_LICENSES.
 *
 * pi-tui is imported normally: inside pi through pi's loader, in the dashboard through the
 * module resolve hook cli.ts registers for `@earendil-works/*` (see usePiPackages there).
 * No module-level mutable state: the extension also loads inside subagent sessions.
 */

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { homedir, hostname } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { ctlSockPath, focusPane, inTmux, isDefaultSocket, openSession, paneInfo, readStatuses, tmuxBaseArgs } from "./cli.ts";
import { SessionIndex, countSubagents, type FoldedThread, type IndexEntry, type SubagentCounts } from "./registry.ts";
import { fleetOf, ownPrompt } from "./shared.ts";
import { GLYPHS, type FleetState, type Liveness, type StatusFile } from "./status.ts";

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
				const detail = index.detail(entry);
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
			const threads = entry ? index.detail(entry)?.threads : undefined;
			index.save();
			return threads;
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
	const groups = [...byRepo.entries()].map(([repo, list]) => ({ repo, label: basename(repo) || repo || "?", rows: list.sort(rowOrder) }));
	groups.sort((a, b) => rowOrder(a.rows[0]!, b.rows[0]!) || a.label.localeCompare(b.label));
	// Two repos with the same basename: show their paths.
	const labels = new Map<string, number>();
	for (const g of groups) labels.set(g.label, (labels.get(g.label) ?? 0) + 1);
	const home = homedir();
	for (const g of groups) {
		if ((labels.get(g.label) ?? 0) > 1) g.label = g.repo.startsWith(`${home}/`) ? `~${g.repo.slice(home.length)}` : g.repo;
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
const STATUS_FILTER_KEYS: Record<string, StatusFilter> = { "!": "running", "@": "waiting", "#": "idle", "&": "error" };

function category(row: SessionRow): StatusFilter {
	const state = row.state === "remote" ? row.status?.state ?? "idle" : row.state;
	if (state === "running" || state === "starting") return "running";
	if (state === "waiting" || state === "question") return "waiting";
	if (state === "error" || state === "crashed") return "error";
	return "idle";
}

/** The styling the view needs: pi's theme inside pi, plain ANSI in the dashboard. */
export interface ViewStyle {
	fg(color: "accent" | "muted" | "dim" | "success" | "warning" | "error" | "border", text: string): string;
	bold(text: string): string;
}

const ANSI_FG: Record<string, string> = { accent: "36", muted: "37", dim: "90", success: "32", warning: "33", error: "31", border: "90" };
export const ansiStyle: ViewStyle = {
	fg: (color, text) => `\x1b[${ANSI_FG[color] ?? "39"}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

function glyph(row: SessionRow, style: ViewStyle): string {
	switch (row.state) {
		case "running":
			return style.fg("success", GLYPHS.running);
		case "starting":
			return style.fg("accent", GLYPHS.starting);
		case "question":
			return style.bold(style.fg("warning", GLYPHS.question));
		case "waiting":
			return style.fg("warning", GLYPHS.waiting);
		case "idle":
			return style.fg("muted", GLYPHS.idle);
		case "error":
		case "crashed":
			return style.fg("error", GLYPHS.error);
		case "remote":
			return style.fg("dim", "⇢");
		default:
			return style.fg("dim", GLYPHS.idle);
	}
}

/** The middle column: what the session is doing and since when. */
export function rowDetail(row: SessionRow, now: number): string {
	const s = row.status;
	const since = s ? Date.parse(s.since) || row.at : row.at;
	switch (row.state) {
		case "running": {
			const sub = s?.sub ?? "";
			const what = sub.startsWith("tool:") ? sub.slice(5) : sub || "working";
			return `${what} ${duration(now - since)}`;
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
			return `live on ${s?.host ?? "?"}`;
		default:
			return humanizeSince(row.at, now);
	}
}

/** Subagent counts: `2w 1◐ 3✓ 1✕ 2 interrupted`. */
export function countsText(c: SubagentCounts, style: ViewStyle): string {
	const parts: string[] = [];
	if (c.working) parts.push(style.fg("success", `${c.working}w`));
	if (c.waiting) parts.push(style.fg("warning", `${c.waiting}◐`));
	if (c.done) parts.push(style.fg("dim", `${c.done}✓`));
	if (c.error) parts.push(style.fg("error", `${c.error}✕`));
	if (c.interrupted) parts.push(style.fg("warning", `${c.interrupted} interrupted`));
	if (c.unknown) parts.push(style.fg("dim", `${c.unknown}?`));
	return parts.join(" ");
}

function threadGlyph(thread: FoldedThread, live: boolean, style: ViewStyle): { glyph: string; word: string } {
	switch (thread.state) {
		case "starting":
		case "running":
			return live ? { glyph: style.fg("success", "●"), word: thread.state } : { glyph: style.fg("warning", "◌"), word: "interrupted" };
		case "paused":
			return { glyph: style.fg("warning", "◐"), word: "paused" };
		case "completed":
		case "stopped":
			return { glyph: style.fg("dim", "✓"), word: thread.state };
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
function oneLine(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]+/g, " ");
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
	| { type: "kill"; row: SessionRow }
	| { type: "close" };

export interface SessionsViewOptions {
	source: SessionsSource;
	style: ViewStyle;
	/** "list" for /sessions, "dashboard" for the full-screen TUI with a preview. */
	mode: "list" | "dashboard";
	/** Lines available: the most the picker may use, or exactly the screen (dashboard). */
	height: () => number;
	onAction: (action: SessionsAction) => void;
	requestRender: () => void;
	/** Dashboard: fetch a preview of a row (undefined: the row has no pane). */
	preview?: (row: SessionRow, rows: number) => Promise<PreviewResult> | undefined;
	/** The session this view runs in (/sessions): preselected and marked. */
	currentId?: string;
	host?: string;
	now?: () => number;
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

export const REFRESH_MS = 1000;
export const PREVIEW_DEBOUNCE_MS = 150;
const MESSAGE_MS = 4000;

const HELP_LINES = [
	"j/k ↑/↓ ctrl+n/ctrl+p   move            PgUp/PgDn   page",
	"Space                   show subagents of a session / collapse a repo",
	"Enter                   jump to the session (or open it in a new window)",
	"x                       kill the session (asks in its own window)",
	"n                       new session in the row's repo",
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
	private previews = new Map<string, PreviewState>();
	private previewBusy = false;
	private timers: ReturnType<typeof setInterval>[] = [];
	private debounce: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private loaded = false;
	private opts: SessionsViewOptions;
	private host: string;

	constructor(opts: SessionsViewOptions) {
		this.opts = opts;
		this.host = opts.host ?? hostname().split(".")[0]!;
		if (opts.currentId) this.selectedKey = `m:${opts.currentId}`;
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
		if (this.opts.preview) {
			void this.updatePreview();
			this.timers.push(setInterval(() => void this.updatePreview(), REFRESH_MS));
		}
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
		this.rebuild();
	}

	flash(text: string): void {
		this.message = { text, until: this.now() + MESSAGE_MS };
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
			// First load (or the current session is not listed): the first session row.
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
		if (this.typing) this.handleTyping(data);
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
			case "x": {
				const item = this.items[this.selected];
				if (item?.kind === "main") this.opts.onAction({ type: "kill", row: item.row });
				return;
			}
			case "n": {
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
		if (!this.opts.preview || this.disposed) return;
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.updatePreview(), PREVIEW_DEBOUNCE_MS);
	}

	/** Fetch the selected row's preview once (the timers call this). */
	async updatePreview(): Promise<void> {
		const row = this.selectedRow();
		if (!row || !this.opts.preview || this.previewBusy || this.disposed) return;
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

	// ------------------------------------------------------------ render

	invalidate(): void {}

	/** Dashboard narrower than this: the preview goes below the list instead of beside it. */
	static readonly SIDE_BY_SIDE_MIN = 100;
	private stackedLast = false;

	private listHeight(): number {
		const bodyH = Math.max(1, this.opts.height() - 2);
		return this.opts.mode === "dashboard" && this.stackedLast ? Math.max(3, Math.floor(bodyH / 2)) : bodyH;
	}
	private previewBodyHeight(): number {
		const bodyH = Math.max(1, this.opts.height() - 2);
		return Math.max(1, (this.stackedLast ? bodyH - this.listHeight() : bodyH) - 1);
	}

	render(width: number): string[] {
		const style = this.opts.style;
		const height = Math.max(3, this.opts.height());
		if (this.message && this.message.until < this.now()) this.message = undefined;
		const header = this.headerLine(width);
		const footer = this.footerLine(width);
		if (this.opts.mode === "list") {
			const body = this.help ? HELP_LINES.map((l) => fit(style.fg("muted", ` ${l}`), width)) : this.listLines(width, height - 2);
			return [header, ...body, footer];
		}
		const bodyH = height - 2;
		this.stackedLast = width < SessionsView.SIDE_BY_SIDE_MIN;
		let body: string[];
		if (!this.stackedLast) {
			const listW = Math.max(50, Math.min(80, Math.floor(width * 0.5)));
			const prevW = width - listW - 1;
			const list = this.help ? HELP_LINES.map((l) => fit(` ${l}`, listW)) : this.listLines(listW, bodyH);
			const prev = this.previewPane(prevW, bodyH);
			const sep = style.fg("border", "│");
			body = [];
			for (let i = 0; i < bodyH; i++) body.push(`${pad(list[i] ?? "", listW)}${sep}${fit(prev[i] ?? "", prevW)}`);
		} else {
			const listH = this.listHeight();
			const list = this.help ? HELP_LINES.map((l) => fit(` ${l}`, width)) : this.listLines(width, listH);
			while (list.length < listH) list.push("");
			body = [...list.slice(0, listH), ...this.previewPane(width, bodyH - listH)];
		}
		while (body.length < bodyH) body.push("");
		return [header, ...body.slice(0, bodyH), footer].map((l) => fit(l, width));
	}

	private headerLine(width: number): string {
		const style = this.opts.style;
		const live = this.rows.filter((r) => r.live === "live").length;
		const waiting = this.rows.filter((r) => r.live === "live" && (r.state === "waiting" || r.state === "question")).length;
		let left = ` ${style.bold(style.fg("accent", "pi-fleet"))}  ${this.host}   ${live} live`;
		if (waiting) left += ` · ${style.fg("warning", `${waiting} waiting`)}`;
		const filters: string[] = [];
		if (this.statusFilter) filters.push(style.fg("accent", `[${this.statusFilter}]`));
		if (this.typing || this.filter) filters.push(`/${this.filter}${this.typing ? style.fg("accent", "▏") : ""}`);
		const right = filters.length ? filters.join(" ") : style.fg("dim", "/ filter   ? help");
		const gap = width - visibleWidth(left) - visibleWidth(right) - 1;
		return gap >= 2 ? `${left}${" ".repeat(gap)}${right} ` : fit(`${left}  ${right}`, width);
	}

	private footerLine(width: number): string {
		const style = this.opts.style;
		if (this.message) return fit(` ${style.fg("warning", this.message.text)}`, width);
		const hint = this.typing
			? "type to filter · enter open · esc stop typing · ↑/↓ move"
			: "enter open · space subagents · / filter · !@#& status · x kill · n new · q close";
		return fit(style.fg("dim", ` ${hint}`), width);
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
		const dimRow = row.state === "remote" || row.state === "closed";
		if (item.kind === "sub") {
			const live = row.live === "live" || row.live === "remote";
			const { glyph: g, word } = threadGlyph(item.thread, live, style);
			const label = `${item.thread.type ?? "?"} ${item.thread.path}`;
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
		let name = oneLine(row.name);
		if (row.id === this.opts.currentId) name += " (this)";
		let nameText = row.unnamed ? style.fg("muted", name) : name;
		if (selected) nameText = style.bold(nameText);
		else if (dimRow) nameText = style.fg("dim", name);
		const detail = rowDetail(row, now);
		const detailText = row.state === "question" || row.state === "waiting" ? style.fg("warning", detail) : style.fg(dimRow ? "dim" : "muted", detail);
		const cost = row.costUsd ? `$${row.costUsd.toFixed(2)}` : "";
		const counts = countsText(row.counts, style);
		const costText = wide ? ` ${padRight(style.fg("dim", cost), 7)}` : "";
		const line = `${marker}  ${glyph(row, style)} ${pad(nameText, nameW)} ${pad(detailText, detailW)}${costText} ${counts}`;
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
			const lines = [rule(g.label), ` ${style.fg("dim", g.repo)}`, ""];
			for (const r of g.rows) lines.push(` ${glyph(r, style)} ${oneLine(r.name)}  ${style.fg("dim", rowDetail(r, this.now()))}`);
			return lines.slice(0, height);
		}
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
			lines.push(rule(`${oneLine(row.name)} · ${row.status?.host ?? "?"}`), style.fg("dim", ` running on ${row.status?.host}: no preview from this node`));
			tail(row.lastAssistant, "last message:");
		} else if (!pane && row.state !== "closed") {
			lines.push(rule(oneLine(row.name)), style.fg("dim", ` running outside tmux (pid ${row.status?.pid}): no preview`));
			tail(row.lastAssistant, "last message:");
		} else if (row.state === "closed" || !pane) {
			lines.push(rule(oneLine(row.name)), style.fg("dim", ` not running · last active ${humanizeSince(row.at, this.now())}`));
			const counts = countsText(row.counts, style);
			if (counts) lines.push(` subagents: ${counts}`);
			lines.push(style.fg("dim", ` ${row.cwd}`));
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
}

/** Printable text of a key event (plain or kitty CSI-u), or undefined. */
function printable(data: string): string | undefined {
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
 * Carry out a view action. Returns true if focus moved to another window (the dashboard popup
 * then closes). `target` is the pane whose tmux session gets new windows.
 */
export async function runAction(
	action: SessionsAction,
	notify: Notify,
	opts: { env?: NodeJS.ProcessEnv; currentId?: string; target?: string } = {},
): Promise<boolean> {
	const env = opts.env ?? process.env;
	if (action.type === "close") return false;
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
		if (row.id === opts.currentId && action.type === "open") return false;
		if (row.state === "remote") {
			notify(`pi-fleet: ${row.name} is running on ${row.status?.host}`, "warning");
			return false;
		}
		if (action.type === "kill") {
			if (row.live !== "live") {
				notify(`pi-fleet: ${row.name} is not running here`, "warning");
				return false;
			}
			const sock = row.status?.ctlSock || ctlSockPath(row.id, env);
			try {
				await sendControl(sock, { type: "kill" });
			} catch (error) {
				notify(`pi-fleet: cannot reach ${row.name} (${(error as Error).message}); use /kill there`, "warning");
			}
			const pane = row.status?.tmux?.piPane;
			if (pane && (await paneInfo(pane, env))) {
				await focusPane(pane, env);
				return true;
			}
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

// ---------------------------------------------------------------- /sessions

export function register(pi: ExtensionAPI): void {
	pi.registerCommand("sessions", {
		description: "pi-fleet: sessions on this node (Enter jumps or opens, Space shows subagents)",
		handler: async (_args, ctx) => {
			if (!fleetOf(pi).main) return;
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/sessions needs the interactive TUI (try `pi-fleet ls`)", "warning");
				return;
			}
			const currentId = ctx.sessionManager.getSessionId();
			const action = await ownPrompt(pi, () =>
				ctx.ui.custom<SessionsAction | undefined>((tui, theme, _keybindings, done) => {
					const view: SessionsView = new SessionsView({
						source: fleetSource(process.env),
						style: { fg: (color, text) => theme.fg(color, text), bold: (text) => theme.bold(text) },
						mode: "list",
						height: () => Math.max(8, Math.floor(tui.terminal.rows * 0.7)),
						onAction: (a) => {
							view.dispose();
							done(a);
						},
						requestRender: () => tui.requestRender(),
						currentId,
					});
					view.start();
					return view;
				}),
			);
			if (action) await runAction(action, (message, level) => ctx.ui.notify(message, level), { currentId });
		},
	});
}
