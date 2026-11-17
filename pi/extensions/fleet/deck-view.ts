/**
 * pi-deck list (docs/pi-deck-design.md §6, phase 2): `pi-fleet deck`, the left pane of the deck
 * window. A telescope-like list of every pi session of this login node, grouped by repo; the
 * highlighted row's session is in the right slot (its real pi pane, swapped in by deck.ts), or,
 * for rows without a deck pane, a preview frame written into the preview holder's tty.
 *
 * Layout (top to bottom): the list, the selected row's status line, the search bar
 * (`NORMAL ⌕ query   4/12`), key hints. Groups: one per repo (deck sessions, crashed ones,
 * sessions running outside tmux, other hosts' dimmed), then `outside (your tmux)` (pis started by
 * hand in the user's tmux), then `closed (N)` (collapsed until opened or searched).
 *
 * Right slot per row: a deck session → its pi (or its nvim, if that was shown last); a subagent
 * (Space expands) → the tail of its transcript (registry.ts TranscriptTails), re-read on fs.watch of
 * its JSONL while selected; an outside session → a summary card plus one `capture-pane` taken on
 * highlight and on that session's status change (≤ 1/s); closed/crashed/remote → a summary card.
 * Highlight changes are coalesced: the slot follows SWAP_COALESCE_MS after the last move, so a
 * key repeat is one swap. A session shown for ACK_MS while a client is attached is acknowledged
 * (`<id>.seen`, as `pi-fleet seen` did).
 *
 * Updates (DeckController): fs.watch on the status dir, debounced STATUS_DEBOUNCE_MS, re-reads only
 * the named files; LIVENESS_MS re-derives liveness (and relative times), RESCAN_MS re-scans the
 * sessions dir (closed list, other hosts). No 1 s timers. deck.ts's startDeckList brings deck.sock
 * (open/select move the selection here too), SIGWINCH sizes and SIGUSR2 reconcile (a dead slot
 * pane is replaced by the next deck row). The outer tmux's `@pi_deck_bar` (`π 1? 2◐ 1✕`, set via
 * `@deck_outer`'s socket, else the default socket) is written BAR_DEBOUNCE_MS after a change, only
 * when it differs, and cleared on exit; entering waiting/question/error rings the deck client's bell.
 *
 * Keys: NORMAL j/k ↓/↑ C-n/C-p PgUp/PgDn move · Enter/C-l open (deck row: focus the slot; closed or
 * crashed: resume into the pool; outside: close the popup and jump the outer client there via
 * @deck_jump; subagent: its main; header: fold) · Space subagents / fold · a new session in the
 * row's repo · d kill (inline: y kill · s kill + scancel · n/Esc no) · i or / INSERT · ! @ # & / 0
 * status filters · ? help · Esc clears the query · q detach. INSERT: letters are fuzzy terms
 * (space-separated, all must match), C-n/C-p ↑/↓ move, Enter opens, Esc back to NORMAL.
 *
 * Runs as its own process (cli.ts registers pi-tui's resolve hook first), so process-level state
 * is fine here; DeckView and DeckController take their tmux side as DeckOps (tests use fakes).
 */

import { execFile } from "node:child_process";
import { constants as fsc, existsSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { open as fsOpen, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { guardedSocket } from "./cli.ts";
import {
	DeckOpenError,
	defaultDeckHandler,
	deckPanes,
	deckSocketPath,
	deckTmux,
	ensureHolder,
	focusSlot,
	livePeerIn,
	sessionPiPane,
	showPaneArgs,
	startDeckList,
	deckOpen,
	type DeckList,
	type DeckOpenRequest,
	type DeckOpenResult,
	type DeckPane,
} from "./deck.ts";
import { queuedJobs, type SlurmJob } from "./lifecycle.ts";
import { SessionIndex, TranscriptTails, countSubagents, type FoldedThread, type IndexEntry, type TranscriptItem } from "./registry.ts";
import {
	RECENT_CLOSED,
	STATUS_FILTER_KEYS,
	THINKING_LINES,
	ansiStyle,
	capturePane,
	category,
	countsText,
	duration,
	glyph,
	glyphChar,
	groupRows,
	humanizeSince,
	killSession,
	oneLine,
	printable,
	rowDetail,
	rowTone,
	stateWord,
	threadGlyph,
	tilde,
	toned,
	wrapped,
	type Group,
	type PreviewResult,
	type SessionRow,
	type StatusFilter,
	type ViewStyle,
} from "./sessions-view.ts";
import { GLYPHS, STALE_MS, ensureStatusDir, liveness, statusDir, writeSeen, type StatusFile } from "./status.ts";

// ---------------------------------------------------------------- constants

/** Highlight moves closer together than this become one swap (the slot follows the last). */
export const SWAP_COALESCE_MS = 30;
/** A session shown this long (with a client attached) is acknowledged. */
export const ACK_MS = 1000;
/** fs.watch events on the status dir are batched this long. */
export const STATUS_DEBOUNCE_MS = 100;
/** fs.watch events on a previewed subagent transcript are batched this long. */
export const TRANSCRIPT_DEBOUNCE_MS = 100;
/** The outer status bar is written this long after the last change. */
export const BAR_DEBOUNCE_MS = 500;
/** Liveness (dead pids, stale heartbeats) and relative times are re-derived this often. */
export const LIVENESS_MS = 15_000;
/** The sessions dir is re-scanned this often (closed list; NFS gives no events for other hosts). */
export const RESCAN_MS = 60_000;
/** An outside session's capture-pane is taken at most this often. */
export const CAPTURE_MIN_MS = 1000;
const MESSAGE_MS = 4000;

// ---------------------------------------------------------------- rows from status files + the index

export interface RowSource {
	rows(): SessionRow[];
	threads(row: SessionRow): FoldedThread[] | undefined;
	subagentFile(row: SessionRow, thread: FoldedThread): string | undefined;
	repoOf(cwd: string): string;
}

const ZERO = { working: 0, waiting: 0, done: 0, error: 0 };

/**
 * The status files (cached per file, re-read by name on fs.watch events) merged over the session
 * index (re-scanned on start, every RESCAN_MS and when a status file goes away). fleetSource
 * (sessions-view.ts) re-reads everything on each load; this one re-reads only what changed.
 */
export class DeckSource implements RowSource {
	readonly index: SessionIndex;
	private statuses = new Map<string, StatusFile>();
	private mains = new Map<string, IndexEntry>();
	private env: NodeJS.ProcessEnv;
	private recent: number;

	constructor(env: NodeJS.ProcessEnv = process.env, opts: { recent?: number } = {}) {
		this.env = env;
		this.recent = opts.recent ?? RECENT_CLOSED;
		this.index = new SessionIndex(env);
	}

	/** Read every status file (start, or an fs.watch event without a name). */
	readAllStatuses(): void {
		this.statuses.clear();
		let names: string[] = [];
		try {
			names = readdirSync(statusDir(this.env));
		} catch {
			names = [];
		}
		this.readStatusFiles(names);
	}

	/**
	 * Re-read the named files of the status dir (other names are ignored). Returns the session ids
	 * whose status file appeared or went away.
	 */
	readStatusFiles(names: Iterable<string>): { added: string[]; removed: string[] } {
		const added: string[] = [];
		const removed: string[] = [];
		for (const name of names) {
			if (!/^[^.][^/]*\.json$/.test(name)) continue;
			const had = this.statuses.has(name);
			const status = readJson(join(statusDir(this.env), name));
			if (status?.sessionId) {
				this.statuses.set(name, status);
				if (!had) added.push(status.sessionId);
			} else if (had && !existsSync(join(statusDir(this.env), name))) {
				removed.push(this.statuses.get(name)!.sessionId);
				this.statuses.delete(name);
			}
			// A partial write keeps the last good copy.
		}
		return { added, removed };
	}

	/** Re-scan the sessions dir (the closed list and session files of new sessions). */
	rescan(): void {
		this.mains.clear();
		for (const entry of this.index.scan()) {
			if (entry.subagent || !entry.id) continue;
			const other = this.mains.get(entry.id);
			if (!other || other.mtimeMs < entry.mtimeMs) this.mains.set(entry.id, entry);
		}
		this.index.save();
	}

	rows(): SessionRow[] {
		const rows: SessionRow[] = [];
		const shown = new Set<string>();
		for (const status of this.statuses.values()) {
			const live = liveness(status);
			if (live === "stale") continue;
			const entry = this.mains.get(status.sessionId) ?? (status.sessionFile ? this.index.get(status.sessionFile) : undefined);
			shown.add(status.sessionId);
			let counts = status.subagents ?? ZERO;
			if (live === "crashed" && entry) {
				const detail = this.index.detail(entry);
				if (detail) counts = countSubagents(detail.threads, false);
			}
			const name = status.name || entry?.detail?.name || entry?.name;
			rows.push({
				id: status.sessionId,
				file: status.sessionFile || entry?.path,
				name: name || entry?.firstMessage || "new session",
				unnamed: !name,
				cwd: status.cwd,
				repo: status.repo || this.index.repoOf(status.cwd),
				state: live === "crashed" ? "crashed" : live === "remote" ? "remote" : status.state,
				status,
				live,
				at: Date.parse(live === "crashed" ? status.heartbeat : status.since) || 0,
				counts,
				costUsd: status.costUsd,
				lastAssistant: status.lastAssistant,
			});
		}
		const closed = [...this.mains.values()].filter((e) => !shown.has(e.id!)).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, this.recent);
		for (const entry of closed) {
			const detail = this.index.detail(entry, { settleMs: STALE_MS });
			const name = detail?.name || entry.name;
			const cwd = entry.cwd ?? "";
			rows.push({
				id: entry.id!,
				file: entry.path,
				name: name || entry.firstMessage || entry.id!.slice(0, 8),
				unnamed: !name,
				cwd,
				repo: cwd ? this.index.repoOf(cwd) : "",
				state: "closed",
				at: entry.mtimeMs,
				counts: detail ? countSubagents(detail.threads, false) : ZERO,
				lastAssistant: detail?.lastAssistant,
			});
		}
		this.index.save();
		return rows;
	}

	threads(row: SessionRow): FoldedThread[] | undefined {
		let entry = row.file ? this.index.get(row.file) : undefined;
		if (!entry && row.file) {
			// A session newer than the last scan.
			this.rescan();
			entry = this.index.get(row.file);
		}
		const threads = entry ? this.index.detail(entry, row.status ? {} : { settleMs: STALE_MS })?.threads : undefined;
		this.index.save();
		return threads;
	}

	subagentFile(row: SessionRow, thread: FoldedThread): string | undefined {
		return thread.sessionFile || this.index.subagentFile(row.id, thread.path);
	}

	repoOf(cwd: string): string {
		return this.index.repoOf(cwd);
	}
}

function readJson(path: string): StatusFile | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as StatusFile;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------- what the list asks of tmux

/** The slot: a deck session's pane, or the preview holder. */
export type SlotTarget = { session: string } | { holder: true };

export interface DeckOps {
	/** Every deck pane (read from tmux). */
	panes(): Promise<DeckPane[]>;
	/** Show the target in the slot (no swap if it is there already). False: the session has no pane. */
	show(target: SlotTarget): Promise<boolean>;
	/** Write a frame into the preview holder. */
	writeHolder(lines: string[]): Promise<void>;
	/** Show a deck session and focus the slot. */
	focusSession(id: string): Promise<boolean>;
	/** deckOpen (resume or new), shown and focused. */
	open(req: DeckOpenRequest): Promise<DeckOpenResult>;
	/** Kill over the session's control socket; a message if it did not happen. */
	kill(row: SessionRow, scancel: boolean): Promise<string | undefined>;
	/** An outside session: jump the popup's outer client there (closes the popup). A message if not possible. */
	jump(row: SessionRow): Promise<string | undefined>;
	/** Detach the deck client (closes the popup). */
	detach(): Promise<void>;
	/** A client is attached to the deck. */
	attached(): Promise<boolean>;
	ack(sessionId: string, runId: string): Promise<void>;
	capture(row: SessionRow, rows: number): Promise<PreviewResult>;
	transcript(file: string): Promise<TranscriptItem[] | undefined>;
	/** fs.watch a file; returns the unwatch function. */
	watchFile(file: string, onChange: () => void): () => void;
	squeue(ids: string[]): Promise<SlurmJob[] | undefined>;
}

/** setTimeout/clearTimeout, replaceable by tests. */
export interface Timers {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}
const realTimers: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// ---------------------------------------------------------------- the view

export type RowKind = "deck" | "outside" | "local" | "remote" | "crashed" | "closed";
export type Mode = "normal" | "insert";

type Item =
	| { kind: "group"; key: string; group: Group; collapsed: boolean; special?: "outside" | "closed" }
	| { kind: "main"; key: string; row: SessionRow; rowKind: RowKind; expanded: boolean }
	| { kind: "sub"; key: string; row: SessionRow; thread: FoldedThread }
	| { kind: "note"; key: string; text: string };

interface KillConfirm {
	row: SessionRow;
	jobs: SlurmJob[] | undefined | "checking";
}

export interface DeckViewOptions {
	source: RowSource;
	ops: DeckOps;
	style: ViewStyle;
	height: () => number;
	requestRender: () => void;
	/** The deck's tmux socket path (rows whose pane is elsewhere are `outside`). */
	deckSocket: string;
	now?: () => number;
	timers?: Timers;
	/** Where `a` opens a session when no repo is highlighted. */
	home?: string;
}

const OUTSIDE_KEY = "g:@outside";
const CLOSED_KEY = "g:@closed";

const HELP_LINES = [
	"NORMAL",
	"  j/k ↓/↑ C-n/C-p   move (the right pane follows)    PgUp/PgDn  page",
	"  Enter, C-l        open: focus the session (closed: resume it;",
	"                    outside: jump there; subagent: its main)",
	"  Space             subagents of a session / fold a group",
	"  a                 new session in the row's repo",
	"  d                 kill: y kill · s kill + scancel Slurm · n/Esc no",
	"  i  /              search (INSERT)    Esc  clear the search",
	"  ! @ # &   0       only working / waiting / idle / error;  all",
	"  q  (prefix g)     detach    C-h (anywhere)  back to this list",
	"INSERT",
	"  letters           fuzzy terms (all must match name, repo, cwd, message)",
	"  C-n/C-p ↑/↓       move    Enter  open    Esc  back to NORMAL",
];

/** Every char of `needle` in order in `hay`. */
function subsequence(needle: string, hay: string): boolean {
	let i = 0;
	for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
	return needle.length === 0;
}

/** `%12` → 12 (tmux pane ids grow with creation). */
function paneNumber(pane: string): number {
	return Number(pane.slice(1)) || 0;
}

function pad(text: string, width: number): string {
	const t = truncateToWidth(text, Math.max(0, width), "…");
	return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
}
function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "…");
}
function padRight(text: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

export class DeckView implements Component {
	rows: SessionRow[] = [];
	mode: Mode = "normal";
	query = "";
	statusFilter: StatusFilter | undefined;
	private items: Item[] = [];
	private selected = 0;
	private selectedKey: string | undefined;
	private top = 0;
	private collapsed = new Set<string>([CLOSED_KEY]);
	private expanded = new Set<string>();
	private threadCache = new Map<string, FoldedThread[] | undefined>();
	private help = false;
	private message: { text: string; until: number } | undefined;
	private messageTimer: unknown;
	private confirm: KillConfirm | undefined;
	/** Session id → its live pi pane in the deck. */
	private deckPanesById = new Map<string, DeckPane>();
	private slotSize = { width: 80, height: 24 };
	private opts: DeckViewOptions;
	private timers: Timers;
	private loaded = false;
	private disposed = false;
	// slot following
	private swapTimer: unknown;
	private applying = false;
	private applyAgain = false;
	/** The key last shown in the slot (and its target), so refreshes do not re-swap. */
	private appliedKey: string | undefined;
	private appliedTarget: string | undefined;
	private lastFrame = "";
	// previews
	private transcripts = new Map<string, { file?: string; items?: TranscriptItem[]; failed?: boolean }>();
	private unwatch: (() => void) | undefined;
	private watchedKey: string | undefined;
	private transcriptTimer: unknown;
	private captures = new Map<string, { lines?: string[]; gone?: string; at: number; since?: string }>();
	private captureTimer: unknown;
	// ack
	private ackTimer: unknown;
	private ackFor: string | undefined;
	/** Shows (swaps and frames) carried out; tests count them. */
	shows = 0;

	constructor(opts: DeckViewOptions) {
		this.opts = opts;
		this.timers = opts.timers ?? realTimers;
	}

	private now(): number {
		return this.opts.now?.() ?? Date.now();
	}

	dispose(): void {
		this.disposed = true;
		for (const t of [this.swapTimer, this.transcriptTimer, this.captureTimer, this.ackTimer, this.messageTimer]) if (t) this.timers.clearTimeout(t);
		this.unwatch?.();
		this.unwatch = undefined;
	}

	// ------------------------------------------------------------ state from outside

	/** The deck's panes as tmux has them: which sessions have a pane here, and the slot's size. */
	setPanes(panes: DeckPane[]): void {
		this.deckPanesById.clear();
		for (const p of panes) {
			if (p.role !== "pi" || !p.session || p.gone) continue;
			this.deckPanesById.set(p.session, p);
		}
		const slot = panes.find((p) => p.inSlot);
		if (slot) this.slotSize = { width: slot.width, height: slot.height };
	}

	/** Reload rows from the source, keeping the selection; the slot follows if what it should show changed. */
	refresh(): void {
		try {
			this.rows = this.opts.source.rows();
		} catch (error) {
			this.flash(`pi-fleet: ${(error as Error).message}`);
		}
		// Deck panes without a status file yet (a pi starting) are rows too.
		const ids = new Set(this.rows.map((r) => r.id));
		// Newest pane first, by pane id: tmux's pane order changes as panes swap in and out of the slot.
		const starting = [...this.deckPanesById].sort((x, y) => paneNumber(y[1].pane) - paneNumber(x[1].pane));
		for (const [id, p] of starting) {
			if (ids.has(id)) continue;
			const cwd = p.cwd || "";
			let repo = cwd;
			try {
				repo = cwd ? this.opts.source.repoOf(cwd) : "";
			} catch {
				// keep cwd
			}
			// at 0: after the rows with a status (a stable sort keeps the order above).
			this.rows.push({ id, name: "new session", unnamed: true, cwd, repo, state: "starting", at: 0, counts: { ...ZERO } });
		}
		this.threadCache.clear();
		const asked = this.confirm?.row;
		if (asked && !this.rows.some((r) => r.id === asked.id && r.live === "live")) {
			this.confirm = undefined;
			this.flash(`${asked.name} is not running`);
		}
		this.rebuild();
		this.followSlot();
	}

	/** Select a session's row (deck.sock open/select, a new session). */
	selectSession(id: string): void {
		const key = `m:${id}`;
		if (!this.items.some((i) => i.key === key)) {
			// Maybe folded away: unfold its group.
			const row = this.rows.find((r) => r.id === id);
			if (row) {
				this.collapsed.delete(this.groupKeyOf(row));
				this.rebuild();
			}
		}
		const index = this.items.findIndex((i) => i.key === key);
		if (index >= 0) this.select(index, 1);
	}

	/** The slot changed size (SIGWINCH): redraw a holder frame; a client may have attached: re-arm the ack. */
	resized(): void {
		this.lastFrame = "";
		this.appliedKey = undefined;
		this.scheduleApply(0);
	}

	flash(text: string): void {
		this.message = { text: oneLine(text), until: this.now() + MESSAGE_MS };
		if (this.messageTimer) this.timers.clearTimeout(this.messageTimer);
		this.messageTimer = this.timers.setTimeout(() => {
			this.messageTimer = undefined;
			if (this.message && this.message.until <= this.now()) this.message = undefined;
			this.opts.requestRender();
		}, MESSAGE_MS);
	}

	// ------------------------------------------------------------ rows, groups, items

	rowKind(row: SessionRow): RowKind {
		if (this.deckPanesById.has(row.id)) return "deck";
		if (row.state === "remote") return "remote";
		if (row.state === "crashed") return "crashed";
		if (row.state === "closed") return "closed";
		const t = row.status?.tmux;
		if (row.live === "live" && t?.piPane && t.socket && resolve(t.socket) !== resolve(this.opts.deckSocket)) return "outside";
		return "local";
	}

	private groupKeyOf(row: SessionRow): string {
		const kind = this.rowKind(row);
		if (kind === "outside") return OUTSIDE_KEY;
		if (kind === "closed") return CLOSED_KEY;
		return `g:${row.repo}`;
	}

	private matches(row: SessionRow): boolean {
		if (this.statusFilter && category(row) !== this.statusFilter) return false;
		const q = this.query.trim().toLowerCase();
		if (!q) return true;
		const name = row.name.toLowerCase();
		const label = basename(row.repo || "").toLowerCase();
		const hay = `${name}\n${row.repo}\n${row.cwd}\n${row.lastAssistant ?? ""}`.toLowerCase();
		return q.split(/\s+/).every((t) => hay.includes(t) || subsequence(t, name) || subsequence(t, label));
	}

	private rebuild(): void {
		const searching = !!(this.query.trim() || this.statusFilter);
		const shown = this.rows.filter((r) => this.matches(r));
		const repoRows: SessionRow[] = [];
		const outside: SessionRow[] = [];
		const closed: SessionRow[] = [];
		const kinds = new Map<string, RowKind>();
		for (const row of shown) {
			const kind = this.rowKind(row);
			kinds.set(row.id, kind);
			if (kind === "outside") outside.push(row);
			else if (kind === "closed") closed.push(row);
			else repoRows.push(row);
		}
		const groups: { key: string; group: Group; special?: "outside" | "closed" }[] = groupRows(repoRows).map((g) => ({ key: `g:${g.repo}`, group: g }));
		if (outside.length) {
			const g = groupRows(outside).flatMap((x) => x.rows);
			groups.push({ key: OUTSIDE_KEY, group: { repo: "", label: "outside (your tmux)", rows: g }, special: "outside" });
		}
		if (closed.length) {
			closed.sort((a, b) => b.at - a.at);
			groups.push({ key: CLOSED_KEY, group: { repo: "", label: "closed", rows: closed }, special: "closed" });
		}
		const items: Item[] = [];
		for (const { key, group, special } of groups) {
			const collapsed = !searching && this.collapsed.has(key);
			items.push({ kind: "group", key, group, collapsed, special });
			if (collapsed) continue;
			for (const row of group.rows) {
				const expanded = this.expanded.has(row.id);
				items.push({ kind: "main", key: `m:${row.id}`, row, rowKind: kinds.get(row.id)!, expanded });
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
			if (!this.loaded) index = items.findIndex((i) => i.kind === "main");
			else index = Math.min(this.selected, items.length - 1);
		}
		if (items.length) this.loaded = true;
		this.select(Math.max(0, index), 1, false);
	}

	private threadsOf(row: SessionRow): FoldedThread[] | undefined {
		if (!this.threadCache.has(row.id)) this.threadCache.set(row.id, this.opts.source.threads(row));
		return this.threadCache.get(row.id);
	}

	private select(index: number, direction: 1 | -1, notify = true): void {
		const n = this.items.length;
		if (!n) {
			this.selected = 0;
			this.selectedKey = undefined;
			return;
		}
		let i = Math.max(0, Math.min(n - 1, index));
		while (this.items[i]?.kind === "note" && i + direction >= 0 && i + direction < n) i += direction;
		if (this.items[i]?.kind === "note") while (i > 0 && this.items[i]?.kind === "note") i--;
		const before = this.selectedKey;
		this.selected = i;
		this.selectedKey = this.items[i]?.key;
		if (notify && before !== this.selectedKey) this.scheduleApply();
	}

	selectedItemKey(): string | undefined {
		return this.selectedKey;
	}

	/** The selected main row (a subagent's main), if any. */
	selectedRow(): SessionRow | undefined {
		const item = this.items[this.selected];
		return item && (item.kind === "main" || item.kind === "sub") ? item.row : undefined;
	}

	/** The kill confirm being shown (tests). */
	confirming(): KillConfirm | undefined {
		return this.confirm;
	}

	/** reconcile's replacement: the dead pane's session's pi if it lives (its nvim died), else the next deck row's. */
	replacementFor(deadSession: string): string | undefined {
		const own = this.deckPanesById.get(deadSession);
		if (own && !own.gone) return own.pane;
		const at = this.items.findIndex((i) => i.kind === "main" && i.row.id === deadSession);
		const order = at < 0 ? this.items : [...this.items.slice(at + 1), ...this.items.slice(0, at).reverse()];
		for (const item of order) {
			if (item.kind !== "main" || item.row.id === deadSession) continue;
			const p = this.deckPanesById.get(item.row.id);
			if (p && !p.gone) {
				this.selectedKey = item.key;
				this.selected = this.items.indexOf(item);
				this.appliedKey = item.key;
				this.appliedTarget = `s:${item.row.id}`;
				return p.pane;
			}
		}
		return undefined;
	}

	// ------------------------------------------------------------ the slot follows the selection

	/** What the slot shows for the selected item: a session, or the holder. */
	private targetOf(item: Item | undefined): SlotTarget {
		if (item?.kind === "main" && item.rowKind === "deck") return { session: item.row.id };
		return { holder: true };
	}

	/** After a refresh: re-apply if the selected item's target changed, or refresh its holder frame. */
	private followSlot(): void {
		const item = this.items[this.selected];
		const target = this.targetOf(item);
		const t = "session" in target ? `s:${target.session}` : "h";
		if (this.appliedKey !== this.selectedKey || this.appliedTarget !== t) this.scheduleApply();
		else if (t === "h") this.scheduleApply(0);
		else this.armAck();
	}

	/** Apply the selection to the slot `delay` ms from now (coalescing every earlier request). */
	scheduleApply(delay = SWAP_COALESCE_MS): void {
		if (this.disposed) return;
		if (this.swapTimer) this.timers.clearTimeout(this.swapTimer);
		this.swapTimer = this.timers.setTimeout(() => {
			this.swapTimer = undefined;
			void this.apply();
		}, delay);
	}

	/** Show the selected item in the slot now (one at a time; a request while busy runs once after). */
	async apply(): Promise<void> {
		if (this.applying) {
			this.applyAgain = true;
			return;
		}
		this.applying = true;
		try {
			do {
				this.applyAgain = false;
				await this.applyOnce();
			} while (this.applyAgain && !this.disposed);
		} finally {
			this.applying = false;
		}
	}

	private async applyOnce(): Promise<void> {
		const item = this.items[this.selected];
		const key = this.selectedKey;
		const target = this.targetOf(item);
		const t = "session" in target ? `s:${target.session}` : "h";
		if (this.watchedKey !== key) this.stopWatching();
		try {
			if ("session" in target) {
				if (this.appliedKey !== key || this.appliedTarget !== t) {
					this.shows++;
					const ok = await this.opts.ops.show(target);
					if (!ok) {
						// The pane went away: show the holder instead; the next refresh catches up.
						await this.showHolderFor(item);
					}
				}
			} else {
				await this.showHolderFor(item);
				this.startPreview(item);
			}
			this.appliedKey = key;
			this.appliedTarget = t;
		} catch (error) {
			this.flash(`pi-fleet: ${(error as Error).message}`);
		}
		this.armAck();
	}

	private async showHolderFor(item: Item | undefined): Promise<void> {
		const lines = this.holderLines(item);
		const frame = lines.join("\n");
		const swap = this.appliedTarget !== "h" || this.appliedKey === undefined;
		if (frame !== this.lastFrame || swap) {
			this.lastFrame = frame;
			this.shows++;
			await this.opts.ops.writeHolder(lines);
		}
		// The holder is in the slot already (the last apply showed it): just the frame.
		if (swap) await this.opts.ops.show({ holder: true });
	}

	/** Re-render the holder frame of the selected item if it still is the one shown. */
	private redrawHolder(key: string | undefined): void {
		if (this.disposed || key !== this.selectedKey || this.appliedTarget !== "h") return;
		const lines = this.holderLines(this.items[this.selected]);
		const frame = lines.join("\n");
		if (frame === this.lastFrame) return;
		this.lastFrame = frame;
		this.shows++;
		void this.opts.ops.writeHolder(lines).catch(() => {});
	}

	// ------------------------------------------------------------ acknowledging what is watched

	private armAck(): void {
		const row = this.selectedRow();
		const item = this.items[this.selected];
		const id = item?.kind === "main" ? row?.id : undefined;
		const s = row?.status;
		const wants = !!(id && row && row.live === "live" && s && !s.acked && s.runId && (s.state === "waiting" || s.state === "question"));
		const key = wants ? `${id}:${s!.runId}:${s!.state}` : undefined;
		if (key === this.ackFor) return;
		if (this.ackTimer) this.timers.clearTimeout(this.ackTimer);
		this.ackTimer = undefined;
		this.ackFor = key;
		if (!wants) return;
		this.ackTimer = this.timers.setTimeout(() => {
			this.ackTimer = undefined;
			void (async () => {
				const now = this.selectedRow();
				if (this.disposed || now?.id !== id || now.status?.runId !== s!.runId || now.status?.acked) return;
				if (!(await this.opts.ops.attached().catch(() => false))) {
					this.ackFor = undefined; // try again on the next resize/refresh
					return;
				}
				await this.opts.ops.ack(id!, s!.runId!).catch(() => {});
			})();
		}, ACK_MS);
	}

	// ------------------------------------------------------------ previews in the holder

	private stopWatching(): void {
		this.unwatch?.();
		this.unwatch = undefined;
		this.watchedKey = undefined;
		if (this.transcriptTimer) this.timers.clearTimeout(this.transcriptTimer);
		this.transcriptTimer = undefined;
	}

	private startPreview(item: Item | undefined): void {
		if (!item) return;
		if (item.kind === "sub") {
			const file = this.opts.source.subagentFile(item.row, item.thread);
			const key = item.key;
			if (!file) {
				this.transcripts.set(key, {});
				this.redrawHolder(key);
				return;
			}
			const read = async () => {
				const items = await this.opts.ops.transcript(file).catch(() => undefined);
				const prev = this.transcripts.get(key);
				this.transcripts.set(key, items ? { file, items } : { file, failed: true, items: prev?.items });
				this.redrawHolder(key);
			};
			if (this.watchedKey !== key) {
				this.stopWatching();
				this.watchedKey = key;
				this.unwatch = this.opts.ops.watchFile(file, () => {
					if (this.transcriptTimer) this.timers.clearTimeout(this.transcriptTimer);
					this.transcriptTimer = this.timers.setTimeout(() => {
						this.transcriptTimer = undefined;
						if (this.watchedKey === key) void read();
					}, TRANSCRIPT_DEBOUNCE_MS);
				});
				void read();
			}
			return;
		}
		if (item.kind === "main" && item.rowKind === "outside") this.captureOutside(item.row, item.key);
	}

	/** One capture of an outside session: on highlight, and on its status change (≤ 1/s). */
	private captureOutside(row: SessionRow, key: string): void {
		const prev = this.captures.get(row.id);
		const since = `${row.status?.state}|${row.status?.since}|${row.status?.sub ?? ""}`;
		const fresh = prev && prev.since === since && this.appliedKey === key;
		if (fresh) return;
		const wait = prev ? CAPTURE_MIN_MS - (this.now() - prev.at) : 0;
		if (this.captureTimer) this.timers.clearTimeout(this.captureTimer);
		this.captureTimer = this.timers.setTimeout(
			() => {
				this.captureTimer = undefined;
				if (this.selectedKey !== key) return;
				const rows = Math.max(1, this.slotSize.height - 6);
				this.captures.set(row.id, { ...this.captures.get(row.id), at: this.now(), since });
				void this.opts.ops
					.capture(row, rows)
					.then((r) => {
						const c = this.captures.get(row.id) ?? { at: this.now() };
						if (r.kind === "frame") this.captures.set(row.id, { ...c, lines: r.lines, gone: undefined });
						else if (r.kind === "gone") this.captures.set(row.id, { ...c, gone: r.reason });
						this.redrawHolder(key);
					})
					.catch(() => {});
			},
			Math.max(0, wait),
		);
	}

	// ------------------------------------------------------------ input

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		this.message = undefined;
		if (this.confirm) this.handleConfirm(data);
		else if (this.mode === "insert") this.handleInsert(data);
		else this.handleNormal(data);
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

	private handleInsert(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.mode = "normal";
		else if (matchesKey(data, "enter") || matchesKey(data, "ctrl+l")) {
			this.mode = "normal";
			this.activate();
		} else if (matchesKey(data, "backspace")) {
			this.query = this.query.slice(0, -1);
			this.rebuild();
			this.scheduleApply();
		} else if (matchesKey(data, "ctrl+u")) {
			this.query = "";
			this.rebuild();
			this.scheduleApply();
		} else if (!this.navigate(data)) {
			const text = printable(data);
			if (text) {
				this.query += text;
				this.rebuild();
				this.select(this.items.findIndex((i) => i.kind === "main"), 1);
				this.scheduleApply();
			}
		}
	}

	private handleNormal(data: string): void {
		if (this.navigate(data)) return;
		if (matchesKey(data, "enter") || matchesKey(data, "ctrl+l")) return this.activate();
		if (matchesKey(data, "space")) return this.toggle();
		if (matchesKey(data, "escape")) {
			if (this.help) this.help = false;
			else if (this.query || this.statusFilter) {
				this.query = "";
				this.statusFilter = undefined;
				this.rebuild();
				this.scheduleApply();
			}
			return;
		}
		if (matchesKey(data, "ctrl+c")) return void this.opts.ops.detach().catch(() => {});
		const ch = printable(data);
		switch (ch) {
			case "j":
				return this.move(1);
			case "k":
				return this.move(-1);
			case "q":
				this.help = false;
				return void this.opts.ops.detach().catch(() => {});
			case "i":
			case "/":
				this.mode = "insert";
				this.help = false;
				return;
			case "?":
				this.help = !this.help;
				return;
			case "0":
				this.statusFilter = undefined;
				this.rebuild();
				this.scheduleApply();
				return;
			case "d":
				return this.askKill();
			case "a":
				return this.newSession();
		}
		if (ch && STATUS_FILTER_KEYS[ch]) {
			const f = STATUS_FILTER_KEYS[ch];
			this.statusFilter = this.statusFilter === f ? undefined : f;
			this.rebuild();
			this.scheduleApply();
		}
	}

	private newSession(): void {
		const item = this.items[this.selected];
		let cwd: string | undefined;
		if (item?.kind === "group") {
			if (item.special) return this.flash("a: highlight a repo or a session");
			cwd = item.group.repo;
		} else if (item && item.kind !== "note") cwd = item.row.repo || item.row.cwd;
		cwd ||= this.opts.home ?? homedir();
		this.flash(`new session in ${tilde(oneLine(cwd))}…`);
		void this.run(async () => {
			const r = await this.opts.ops.open({ cwd, focus: true });
			return r.session;
		});
	}

	/** Run an action that may create or show a session; afterwards re-read panes and select it. */
	private async run(fn: () => Promise<string | undefined>): Promise<void> {
		try {
			const id = await fn();
			this.setPanes(await this.opts.ops.panes());
			this.refresh();
			if (id) {
				this.selectSession(id);
				this.appliedKey = this.selectedKey;
				this.appliedTarget = `s:${id}`;
			}
		} catch (error) {
			this.flash(`pi-fleet: ${(error as Error).message}`);
		}
		this.opts.requestRender();
	}

	private askKill(): void {
		const item = this.items[this.selected];
		if (!item || item.kind !== "main") return this.flash("d kills a session: highlight its row");
		const row = item.row;
		if (row.state === "remote") return this.flash(`${row.name} runs on ${row.status?.host ?? "another node"}: kill it there`);
		if (row.live !== "live") return this.flash(`${row.name} is not running`);
		const ids = row.status?.slurmJobs ?? [];
		const confirm: KillConfirm = { row, jobs: ids.length ? "checking" : [] };
		this.confirm = confirm;
		if (!ids.length) return;
		void this.opts.ops
			.squeue(ids)
			.catch(() => undefined)
			.then((jobs) => {
				if (this.confirm !== confirm || this.disposed) return;
				confirm.jobs = jobs;
				this.opts.requestRender();
			});
	}

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
			void this.opts.ops
				.kill(c.row, scancel)
				.then((message) => {
					if (message) this.flash(message);
					this.opts.requestRender();
				})
				.catch((error) => this.flash(`pi-fleet: ${(error as Error).message}`));
		} else if (ch === "n" || ch === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.confirm = undefined;
		}
	}

	private activate(): void {
		const item = this.items[this.selected];
		if (!item || item.kind === "note") return;
		if (item.kind === "group") return this.toggle();
		if (item.kind === "sub") {
			this.selectSession(item.row.id);
			return;
		}
		const row = item.row;
		switch (item.rowKind) {
			case "deck":
				void this.opts.ops.focusSession(row.id).then(
					(ok) => {
						if (!ok) this.flash(`${row.name}: its pane is gone`);
						else {
							this.appliedKey = item.key;
							this.appliedTarget = `s:${row.id}`;
						}
					},
					(error) => this.flash(`pi-fleet: ${(error as Error).message}`),
				);
				return;
			case "outside":
				void this.jump(row);
				return;
			case "remote":
				return this.flash(`${row.name} runs on ${row.status?.host ?? "another node"}`);
			case "local":
				return this.flash(`${row.name} runs outside tmux (pid ${row.status?.pid ?? "?"})`);
			default:
				this.flash(`resuming ${row.name}…`);
				void this.run(async () => {
					try {
						return (await this.opts.ops.open({ session: row.file || row.id, focus: true })).session;
					} catch (error) {
						if (error instanceof DeckOpenError && error.outside?.pane) {
							await this.jump({ ...row, status: { ...(row.status as StatusFile), tmux: { ...error.outside, piPane: error.outside.pane } } });
							return undefined;
						}
						throw error;
					}
				});
		}
	}

	private async jump(row: SessionRow): Promise<void> {
		try {
			const message = await this.opts.ops.jump(row);
			if (message) this.flash(message);
		} catch (error) {
			this.flash(`pi-fleet: ${(error as Error).message}`);
		}
		this.opts.requestRender();
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
		this.scheduleApply();
	}

	// ------------------------------------------------------------ render

	invalidate(): void {}

	/** Lines below the list: status line, search bar, key hints. */
	static readonly CHROME = 3;

	private listHeight(): number {
		return Math.max(1, this.opts.height() - DeckView.CHROME);
	}

	render(width: number): string[] {
		const style = this.opts.style;
		const height = Math.max(DeckView.CHROME + 1, this.opts.height());
		if (this.message && this.message.until < this.now()) this.message = undefined;
		const bodyH = height - DeckView.CHROME;
		const body = this.help ? HELP_LINES.map((l) => fit(style.fg("muted", ` ${l}`), width)) : this.listLines(width, bodyH);
		while (body.length < bodyH) body.push("");
		return [...body.slice(0, bodyH), this.statusLine(width), this.searchLine(width), this.hintLine(width)].map((l) => fit(l, width));
	}

	private searchLine(width: number): string {
		const style = this.opts.style;
		const badge = this.mode === "insert" ? style.bold(style.fg("success", "INSERT")) : style.bold(style.fg("accent", "NORMAL"));
		const cursor = this.mode === "insert" ? style.fg("accent", "▏") : "";
		const filter = this.statusFilter ? ` ${style.fg("accent", `[${this.statusFilter}]`)}` : "";
		const left = ` ${badge}  ${style.fg("dim", "⌕")} ${oneLine(this.query)}${cursor}${filter}`;
		const total = this.rows.length;
		const matched = this.query.trim() || this.statusFilter ? this.rows.filter((r) => this.matches(r)).length : total;
		const right = style.fg("dim", `${matched}/${total}`);
		const gap = width - visibleWidth(left) - visibleWidth(right) - 1;
		return gap >= 1 ? `${left}${" ".repeat(gap)}${right} ` : fit(left, width);
	}

	private hintLine(width: number): string {
		const style = this.opts.style;
		if (this.confirm) {
			const scancel = this.confirmJobs(this.confirm).length ? " · s kill+scancel" : "";
			return fit(` ${style.bold(style.fg("warning", `y kill${scancel} · n/Esc cancel`))}`, width);
		}
		if (this.message) return fit(` ${style.fg("warning", this.message.text)}`, width);
		const chunks =
			this.mode === "insert"
				? ["type to search", "⏎ open", "C-n/C-p move", "Esc normal"]
				: ["j/k move", "⏎/C-l open", "a new", "d kill", "i / search", "? help", "q detach", "␣ subagents"];
		// As many hints as fit, in order (q detach before the rarer ones).
		let hint = "";
		for (const c of chunks) {
			const next = hint ? `${hint}  ${c}` : c;
			if (visibleWidth(next) + 1 > width) break;
			hint = next;
		}
		return fit(style.fg("dim", ` ${hint}`), width);
	}

	/** The selected row in one line, or the kill question. */
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
			return fit(` ${style.fg("warning", `Kill ${style.bold(oneLine(row.name))}?${parts.length ? ` ${parts.join(" · ")}` : ""}`)}`, width);
		}
		const item = this.items[this.selected];
		if (!item || item.kind === "note") return "";
		const now = this.now();
		if (item.kind === "group") {
			const g = item.group;
			const live = g.rows.filter((r) => r.live === "live" || this.deckPanesById.has(r.id)).length;
			const where = item.special ? "" : `${sep}${style.fg("dim", tilde(oneLine(g.repo)))}`;
			const hint = item.special ? "" : `${sep}${style.fg("dim", "a: new session here")}`;
			return fit(` ${oneLine(g.label)}${where}${sep}${g.rows.length} session${g.rows.length === 1 ? "" : "s"}, ${live} live${hint}`, width);
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
		const since = s ? Date.parse(s.since) || row.at : row.at;
		const parts = [style.bold(oneLine(row.name)), toned(rowTone(row), `${glyphChar(row)} ${stateWord(row)}`, style)];
		if (row.state === "running") {
			const sub = s?.sub ?? "";
			parts.push(sub.startsWith("tool:") ? `tool ${oneLine(sub.slice(5))}` : sub.startsWith("bg") ? "subagents in the background" : "thinking");
		}
		if (row.live === "live" || row.live === "remote") parts.push(`for ${duration(now - since)}`);
		else if (row.state !== "starting") parts.push(row.state === "crashed" ? `died ${humanizeSince(row.at, now)}` : `last active ${humanizeSince(row.at, now)}`);
		if (item.rowKind === "outside") parts.push(style.fg("accent", `in your tmux${s?.tmux?.windowIndex !== undefined ? ` (window ${s.tmux.windowIndex})` : ""}`));
		if (row.costUsd) parts.push(`$${row.costUsd.toFixed(2)}`);
		const counts = countsText(row.counts, style);
		if (counts) parts.push(`subagents ${counts}`);
		if (row.cwd) parts.push(style.fg("dim", tilde(oneLine(row.cwd))));
		return fit(` ${parts.join(sep)}`, width);
	}

	private listLines(width: number, height: number): string[] {
		const style = this.opts.style;
		if (!this.items.length) {
			const empty = this.query || this.statusFilter ? "no sessions match (Esc clears the search)" : "no pi sessions yet · a: new session";
			return [fit(style.fg("dim", `   ${empty}`), width)];
		}
		if (this.selected < this.top) this.top = this.selected;
		if (this.selected >= this.top + height) this.top = this.selected - height + 1;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, this.items.length - height)));
		const lines: string[] = [];
		const now = this.now();
		for (let i = this.top; i < Math.min(this.items.length, this.top + height); i++) lines.push(this.itemLine(this.items[i]!, i === this.selected, width, now));
		if (this.top > 0) lines[0] = this.withMore(lines[0]!, "↑", width);
		if (this.top + height < this.items.length) lines[lines.length - 1] = this.withMore(lines[lines.length - 1]!, "↓", width);
		const at = this.selected - this.top;
		if (style.selected && lines[at] !== undefined) lines[at] = style.selected(pad(lines[at]!, width));
		return lines;
	}

	private withMore(line: string, arrow: string, width: number): string {
		const l = fit(line, width - 2);
		return `${l}${" ".repeat(Math.max(0, width - 2 - visibleWidth(l)))} ${this.opts.style.fg("dim", arrow)}`;
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
			const labelW = Math.min(30, Math.max(10, width - 24));
			let text = `${pad(selected ? style.bold(label) : label, labelW)} ${pad(style.fg("muted", word), 11)}`;
			if (item.thread.task) text += ` ${style.fg("dim", oneLine(item.thread.task))}`;
			return fit(`${marker}    ${g} ${text}`, width);
		}
		const dimRow = row.state === "remote" || row.state === "closed";
		const avail = Math.max(10, width - 4);
		const wide = avail >= 60;
		const detailW = wide ? 16 : 13;
		const nameW = Math.min(wide ? 30 : 22, Math.max(8, avail - detailW - 1 - (wide ? 8 : 0) - 1 - 8));
		let name = oneLine(row.name);
		let suffix = "";
		if (item.rowKind === "outside") {
			const w = row.status?.tmux?.windowIndex;
			suffix = ` ⇱${w !== undefined ? ` win ${w}` : ""}`;
		}
		const nameRoom = Math.max(4, nameW - visibleWidth(suffix));
		name = fit(name, nameRoom);
		let nameText = row.unnamed ? style.fg("muted", name) : name;
		if (selected) nameText = style.bold(nameText);
		else if (dimRow) nameText = style.fg("dim", name);
		if (suffix) nameText += style.fg("accent", suffix);
		const detailText = toned(rowTone(row), rowDetail(row, now), style);
		const cost = row.costUsd ? `$${row.costUsd.toFixed(2)}` : "";
		const costText = wide ? ` ${padRight(style.fg("dim", cost), 7)}` : "";
		const counts = countsText(row.counts, style);
		return fit(`${marker} ${glyph(row, style)} ${pad(nameText, nameW)} ${pad(detailText, detailW)}${costText} ${counts}`, width);
	}

	// ------------------------------------------------------------ holder frames

	/** The preview frame of an item without a deck pane, sized to the slot. */
	holderLines(item: Item | undefined): string[] {
		const style = this.opts.style;
		const { width, height } = this.slotSize;
		const rule = (title: string) => {
			const t = ` ${title} `;
			const w = visibleWidth(fit(t, Math.max(0, width - 2)));
			return style.fg("border", "──") + fit(t, Math.max(0, width - 2)) + style.fg("border", "─".repeat(Math.max(0, width - 2 - w)));
		};
		const out = (lines: string[]) => lines.slice(0, height).map((l) => fit(l, width));
		if (!item || item.kind === "note") return out([rule("pi deck"), style.fg("dim", " no session selected · a: new session")]);
		if (item.kind === "group") {
			const g = item.group;
			const lines = [rule(oneLine(g.label))];
			if (!item.special) lines.push(` ${style.fg("dim", tilde(oneLine(g.repo)))}`);
			lines.push("");
			for (const r of g.rows) lines.push(` ${glyph(r, style)} ${oneLine(r.name)}  ${style.fg("dim", rowDetail(r, this.now()))}`);
			return out(lines);
		}
		if (item.kind === "sub") return out(this.transcriptLines(item, width, height, rule));
		return out(this.cardLines(item.row, item.rowKind, width, height, rule));
	}

	private cardLines(row: SessionRow, kind: RowKind, width: number, height: number, rule: (t: string) => string): string[] {
		const style = this.opts.style;
		const now = this.now();
		const s = row.status;
		const lines: string[] = [rule(oneLine(row.name))];
		const state = toned(rowTone(row), `${glyphChar(row)} ${stateWord(row)}`, style);
		const since = s ? Date.parse(s.since) || row.at : row.at;
		const when = row.live === "live" || row.live === "remote" ? `for ${duration(now - since)}` : row.state === "crashed" ? `died ${humanizeSince(row.at, now)}` : `last active ${humanizeSince(row.at, now)}`;
		lines.push(` ${state}  ${style.fg("dim", when)}`);
		switch (kind) {
			case "outside": {
				const w = s?.tmux?.windowIndex;
				lines.push(` ${style.fg("accent", `runs in your tmux${w !== undefined ? ` (window ${w})` : ""}`)}${style.fg("dim", " · ⏎ jump there")}`);
				break;
			}
			case "closed":
			case "crashed":
				lines.push(style.fg("dim", " ⏎ resume it in the deck"));
				break;
			case "remote":
				lines.push(style.fg("dim", ` runs on ${oneLine(s?.host ?? "?")}: no preview from this node`));
				break;
			case "local":
				lines.push(style.fg("dim", ` runs outside tmux (pid ${s?.pid ?? "?"})`));
				break;
		}
		if (row.cwd) lines.push(style.fg("dim", ` ${tilde(oneLine(row.cwd))}`));
		const facts: string[] = [];
		if (row.costUsd) facts.push(`$${row.costUsd.toFixed(2)}`);
		if (s?.model) facts.push(oneLine(s.model));
		if (s?.contextPct !== undefined) facts.push(`context ${Math.round(s.contextPct)}%`);
		const counts = countsText(row.counts, style);
		if (counts) facts.push(`subagents ${counts}`);
		if (s?.slurmJobs?.length) facts.push(`Slurm ${s.slurmJobs.map(oneLine).join(" ")}`);
		if (facts.length) lines.push(` ${facts.join(style.fg("dim", " · "))}`);
		if (kind === "outside") {
			const c = this.captures.get(row.id);
			lines.push("", rule(`pane ${oneLine(s?.tmux?.piPane ?? "?")}`));
			if (c?.gone) lines.push(style.fg("error", ` pane gone (${oneLine(c.gone)})`));
			else if (c?.lines) {
				const room = Math.max(0, height - lines.length);
				lines.push(...c.lines.slice(-room).map((l) => `${l}\x1b[0m`));
				return lines;
			} else lines.push(style.fg("dim", " capturing…"));
		}
		if (row.lastAssistant) {
			lines.push("", style.fg("dim", " last message:"));
			const body = wrapped(row.lastAssistant, Math.max(10, width - 1), " ");
			const room = Math.max(0, height - lines.length);
			lines.push(...body.slice(0, room));
		}
		return lines;
	}

	private transcriptLines(item: Extract<Item, { kind: "sub" }>, width: number, height: number, rule: (t: string) => string): string[] {
		const style = this.opts.style;
		const { row, thread } = item;
		const live = row.live === "live" || row.live === "remote";
		const { word } = threadGlyph(thread, live, style);
		const head = [rule(oneLine(`${thread.type ?? "?"} ${thread.path} · ${word}`))];
		if (thread.task) head.push(fit(style.fg("dim", ` task: ${oneLine(thread.task)}`), width));
		const state = this.transcripts.get(item.key);
		const note = (text: string) => [...head, style.fg("dim", ` ${text}`)];
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
			} else if (it.kind === "thinking") body.push(...wrapped(it.text, w, " ").slice(-THINKING_LINES).map((l) => style.fg("dim", l)));
			else body.push(...wrapped(it.text, w, " "));
		}
		const room = Math.max(0, height - head.length);
		return [...head, ...body.slice(-room)];
	}
}

// ---------------------------------------------------------------- the outer status bar

const BAR_STYLE: Record<string, string> = { question: "#[fg=magenta,bold]", waiting: "#[fg=yellow]", error: "#[fg=red]" };

/**
 * `π 1? 2◐ 1✕`: live sessions of this node that need the user (questions, unacknowledged
 * waiting, errors and crashes), colored with tmux `#[…]` styles. Empty when none.
 */
export function barText(rows: SessionRow[]): string {
	let q = 0;
	let w = 0;
	let e = 0;
	for (const r of rows) {
		if (r.state === "crashed") e++;
		else if (r.live !== "live" || !r.status) continue;
		else if (r.state === "question") q++;
		else if (r.state === "waiting" && !r.status.acked) w++;
		else if (r.state === "error" && !r.status.acked) e++;
	}
	const parts: string[] = [];
	if (q) parts.push(`${BAR_STYLE.question}${q}${GLYPHS.question}#[default]`);
	if (w) parts.push(`${BAR_STYLE.waiting}${w}${GLYPHS.waiting}#[default]`);
	if (e) parts.push(`${BAR_STYLE.error}${e}${GLYPHS.error}#[default]`);
	return parts.length ? `π ${parts.join(" ")} ` : "";
}

/** The states that ring the deck client's bell when a session enters them. */
const BELL_STATES = new Set(["waiting", "question", "error"]);

// ---------------------------------------------------------------- the controller

export interface ControllerHooks {
	/** Write the outer bar (empty: unset it). */
	setBar(text: string): Promise<void>;
	/** Ring the deck client's bell. */
	bell(): void;
	/** fs.watch the status dir; returns the close function. */
	watchDir(dir: string, onEvent: (name: string | null) => void): () => void;
	/** Set and clear intervals (tests count them). */
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

/**
 * The list's update loop: status-dir events (debounced) → re-read the named files → refresh the
 * view, the outer bar (debounced, only on change) and the bell; LIVENESS_MS / RESCAN_MS timers.
 */
export class DeckController {
	private source: DeckSource;
	private view: DeckView;
	private hooks: ControllerHooks;
	private timers: Timers;
	private env: NodeJS.ProcessEnv;
	private pending = new Set<string>();
	private pendingAll = false;
	private statusTimer: unknown;
	private barTimer: unknown;
	private intervals: unknown[] = [];
	private closeWatch: (() => void) | undefined;
	private lastBar: string | undefined;
	private states = new Map<string, string>();
	private requestRender: () => void;
	stopped = false;

	constructor(opts: { source: DeckSource; view: DeckView; hooks: ControllerHooks; timers?: Timers; env?: NodeJS.ProcessEnv; requestRender: () => void }) {
		this.source = opts.source;
		this.view = opts.view;
		this.hooks = opts.hooks;
		this.timers = opts.timers ?? realTimers;
		this.env = opts.env ?? process.env;
		this.requestRender = opts.requestRender;
	}

	start(): void {
		try {
			ensureStatusDir(this.env);
		} catch {
			// unwritable state dir: the watch fails below and the timers still refresh
		}
		this.source.readAllStatuses();
		this.source.rescan();
		this.view.refresh();
		this.afterRefresh(true);
		this.watch();
		this.intervals.push(
			this.hooks.setInterval(() => {
				this.view.refresh();
				this.afterRefresh();
				this.requestRender();
			}, LIVENESS_MS),
			this.hooks.setInterval(() => {
				this.source.rescan();
				if (!this.closeWatch) this.watch();
				this.view.refresh();
				this.afterRefresh();
				this.requestRender();
			}, RESCAN_MS),
		);
	}

	private watch(): void {
		try {
			this.closeWatch = this.hooks.watchDir(statusDir(this.env), (name) => this.onEvent(name));
		} catch {
			this.closeWatch = undefined;
		}
	}

	/** A status-dir event: batch it for STATUS_DEBOUNCE_MS. */
	onEvent(name: string | null): void {
		if (this.stopped) return;
		if (name === null) this.pendingAll = true;
		else if (name.endsWith(".json")) this.pending.add(name);
		else return;
		if (this.statusTimer) return;
		this.statusTimer = this.timers.setTimeout(() => {
			this.statusTimer = undefined;
			this.flushStatus();
		}, STATUS_DEBOUNCE_MS);
	}

	/** Re-read what changed and refresh everything that depends on it. */
	flushStatus(): void {
		const names = [...this.pending];
		this.pending.clear();
		let removed: string[] = [];
		if (this.pendingAll) {
			this.pendingAll = false;
			this.source.readAllStatuses();
			removed = ["*"];
		} else removed = this.source.readStatusFiles(names).removed;
		// A session that ended is now a closed row.
		if (removed.length) this.source.rescan();
		this.view.refresh();
		this.afterRefresh();
		this.requestRender();
	}

	/** The outer bar (debounced, only on change) and the bell (state entered, not at start). */
	afterRefresh(initial = false): void {
		let ring = false;
		const seen = new Set<string>();
		for (const r of this.view.rows) {
			if (r.live !== "live" || !r.status) continue;
			seen.add(r.id);
			const key = `${r.state}|${r.status.runId ?? ""}`;
			const before = this.states.get(r.id);
			if (!initial && before !== key && BELL_STATES.has(r.state) && !r.status.acked) ring = true;
			this.states.set(r.id, key);
		}
		for (const id of [...this.states.keys()]) if (!seen.has(id)) this.states.delete(id);
		if (ring) this.hooks.bell();
		this.scheduleBar();
	}

	/** Write the bar BAR_DEBOUNCE_MS from now if it changed (force: write even if unchanged, e.g. a new outer server). */
	scheduleBar(force = false): void {
		if (force) this.lastBar = undefined;
		if (this.barTimer) this.timers.clearTimeout(this.barTimer);
		this.barTimer = this.timers.setTimeout(() => {
			this.barTimer = undefined;
			const text = barText(this.view.rows);
			if (text === this.lastBar || this.stopped) return;
			this.lastBar = text;
			void this.hooks.setBar(text).catch(() => {});
		}, BAR_DEBOUNCE_MS);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const t of [this.statusTimer, this.barTimer]) if (t) this.timers.clearTimeout(t);
		for (const i of this.intervals) this.hooks.clearInterval(i);
		this.intervals = [];
		this.closeWatch?.();
		this.closeWatch = undefined;
		await this.hooks.setBar("").catch(() => {});
	}
}

// ---------------------------------------------------------------- the real tmux side

/** Most recently active deck client, or undefined. */
function newestClient(out: string): string | undefined {
	let best: { at: number; name: string } | undefined;
	for (const line of out.split("\n")) {
		const [at, name] = line.split(" ");
		if (!name) continue;
		const n = Number(at) || 0;
		if (!best || n > best.at) best = { at: n, name };
	}
	return best?.name;
}

/** `socket|client` of @deck_outer. */
export function parseOuter(value: string): { socket: string; client: string } | undefined {
	const bar = value.lastIndexOf("|");
	if (bar <= 0) return undefined;
	return { socket: value.slice(0, bar), client: value.slice(bar + 1) };
}

/** The outer tmux to put the bar on: @deck_outer's socket, else the default socket if it exists. */
export function outerBarSocket(outer: string, env: NodeJS.ProcessEnv): string | undefined {
	const parsed = parseOuter(outer);
	let socket = parsed?.socket;
	if (!socket) {
		const d = join(env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, "default");
		socket = existsSync(d) ? d : undefined;
	}
	if (!socket) return undefined;
	if (env.PI_FLEET_TMUX_GUARD && guardedSocket(socket)) return undefined;
	return socket;
}

function tmuxOn(socket: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((res, rej) => {
		execFile("tmux", ["-S", socket, ...args], { timeout: 5000, env }, (error, stdout, stderr) => {
			if (error) rej(new Error(String(stderr).trim() || error.message));
			else res(String(stdout).replace(/\n$/, ""));
		});
	});
}

/** DeckOps against the deck server; every slot change goes through the list's serial queue. */
export function tmuxOps(env: NodeJS.ProcessEnv, list: Pick<DeckList, "serial">): DeckOps & { close(): Promise<void> } {
	let holder: { tty: string; fh: FileHandle } | undefined;
	let holderTty: string | undefined;
	const tails = new TranscriptTails();
	const notePanes = (panes: DeckPane[]) => {
		holderTty = panes.find((p) => p.role === "preview" && !p.gone)?.tty || holderTty;
	};
	const writeTty = async (tty: string, data: string) => {
		if (holder?.tty !== tty) {
			await holder?.fh.close().catch(() => {});
			holder = { tty, fh: await fsOpen(tty, fsc.O_WRONLY | fsc.O_NOCTTY) };
		}
		try {
			await holder.fh.write(data);
		} catch (error) {
			await holder.fh.close().catch(() => {});
			holder = undefined;
			throw error;
		}
	};
	const showIn = async (panes: DeckPane[], target: SlotTarget): Promise<boolean> => {
		let pane: string;
		if ("session" in target) {
			const pi = sessionPiPane(panes, target.session);
			if (!pi || pi.gone) return false;
			const nvim = livePeerIn(panes, pi);
			const slot = panes.find((p) => p.inSlot);
			if (slot && (slot.pane === pi.pane || slot.pane === nvim?.pane)) return true;
			pane = pi.shown === "nvim" && nvim ? nvim.pane : pi.pane;
		} else {
			pane = panes.find((p) => p.role === "preview" && !p.gone)?.pane ?? (await ensureHolder(env));
		}
		const args = showPaneArgs(panes, pane);
		if (args) await deckTmux(args, env);
		return true;
	};
	return {
		async panes() {
			const panes = await deckPanes(env);
			notePanes(panes);
			return panes;
		},
		show(target) {
			return list.serial(async () => {
				const panes = await deckPanes(env);
				notePanes(panes);
				return showIn(panes, target);
			});
		},
		async writeHolder(lines) {
			if (!holderTty) notePanes(await deckPanes(env));
			if (!holderTty) return;
			const frame = `\x1b[?25l\x1b[H${lines.map((l) => `${l}\x1b[0m\x1b[K`).join("\r\n")}\x1b[0m\x1b[J`;
			await writeTty(holderTty, frame).catch(async () => {
				// The holder was respawned (new tty): look again once.
				notePanes(await deckPanes(env));
				if (holderTty) await writeTty(holderTty, frame).catch(() => {});
			});
		},
		focusSession(id) {
			return list.serial(async () => {
				const panes = await deckPanes(env);
				notePanes(panes);
				if (!(await showIn(panes, { session: id }))) return false;
				await focusSlot(env);
				return true;
			});
		},
		open(req) {
			return list.serial(() => deckOpen(req, env));
		},
		async kill(row, scancel) {
			let message: string | undefined;
			await killSession(row, scancel, (m) => (message = m.replace(/^pi-fleet: /, "")), env);
			return message;
		},
		async jump(row) {
			const t = row.status?.tmux;
			const where = t?.windowIndex !== undefined ? ` (window ${t.windowIndex})` : "";
			if (!t?.piPane) return `${row.name} has no tmux pane`;
			const out = await deckTmux(["show-options", "-gqv", "@deck_outer", ";", "list-clients", "-t", "=deck", "-F", "#{client_activity} #{client_name}"], env).catch(() => "");
			const [outerLine, ...clients] = out.split("\n");
			const outer = parseOuter(outerLine ?? "");
			if (!outer) return `${row.name} runs in your tmux${where}`;
			if (t.socket && resolve(t.socket) !== resolve(outer.socket)) return `${row.name} runs in another tmux server${where}`;
			const client = newestClient(clients.join("\n"));
			await deckTmux(["set-option", "-g", "@deck_jump", t.piPane, ";", "detach-client", ...(client ? ["-t", client] : ["-s", "=deck"])], env);
			return undefined;
		},
		async detach() {
			const out = await deckTmux(["list-clients", "-t", "=deck", "-F", "#{client_activity} #{client_name}"], env).catch(() => "");
			const client = newestClient(out);
			if (client) await deckTmux(["detach-client", "-t", client], env);
		},
		async attached() {
			const out = await deckTmux(["list-clients", "-t", "=deck", "-F", "#{client_name}"], env).catch(() => "");
			return out.trim() !== "";
		},
		ack(id, runId) {
			return writeSeen(id, runId, env);
		},
		capture(row, rows) {
			const t = row.status?.tmux;
			if (!t?.piPane) return Promise.resolve({ kind: "gone", reason: "no pane" } as PreviewResult);
			return capturePane(t.piPane, rows, { socket: t.socket, env });
		},
		transcript(file) {
			return tails.get(file);
		},
		watchFile(file, onChange) {
			let w: FSWatcher | undefined;
			try {
				w = watch(file, { persistent: false }, () => onChange());
				w.on("error", () => {});
			} catch {
				return () => {};
			}
			return () => w?.close();
		},
		squeue(ids) {
			return queuedJobs(ids);
		},
		async close() {
			await holder?.fh.close().catch(() => {});
			holder = undefined;
		},
	};
}

/** Write (or unset) @pi_deck_bar on the outer tmux. */
async function writeOuterBar(text: string, env: NodeJS.ProcessEnv, lastOuter: { socket?: string }): Promise<void> {
	const outer = await deckTmux(["show-options", "-gqv", "@deck_outer"], env).catch(() => "");
	const socket = outerBarSocket(outer, env);
	const targets = new Set<string>();
	if (socket) targets.add(socket);
	// Clearing: also the server the bar was last written to.
	if (!text && lastOuter.socket) targets.add(lastOuter.socket);
	for (const s of targets) {
		await tmuxOn(s, text ? ["set-option", "-g", "@pi_deck_bar", text] : ["set-option", "-gu", "@pi_deck_bar"], env).catch(() => "");
	}
	if (text && socket) lastOuter.socket = socket;
}

/** `pi-fleet deck`: the list TUI in the deck's left pane. Resolves with the exit code. */
export async function runDeckView(env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const piTui = await import("@earendil-works/pi-tui");
	const terminal = new piTui.ProcessTerminal();
	const tui = new piTui.TuiMainScreen(terminal);
	const source = new DeckSource(env);
	let view: DeckView | undefined;
	let controller: DeckController | undefined;
	let selectNext: string | undefined;
	const base = defaultDeckHandler(env);
	const sync = async (what: string) => {
		if (!view) return;
		view.setPanes(await ops.panes().catch(() => [] as DeckPane[]));
		view.refresh();
		if (selectNext) {
			view.selectSession(selectNext);
			selectNext = undefined;
		}
		if (what === "resize") {
			view.resized();
			controller?.scheduleBar(true);
		}
		tui.requestRender();
	};
	const list = await startDeckList(
		{
			handler: async (m) => {
				const r = await base(m);
				if (typeof r.session === "string") selectNext = r.session;
				return r;
			},
			onChange: (what) => void sync(what),
			replacement: (dead) => view?.replacementFor(dead),
		},
		env,
	);
	const ops = tmuxOps(env, list);
	const lastOuter: { socket?: string } = {};
	view = new DeckView({
		source,
		ops,
		style: ansiStyle,
		height: () => terminal.rows,
		requestRender: () => tui.requestRender(),
		deckSocket: deckSocketPath(env),
	});
	controller = new DeckController({
		source,
		view,
		env,
		requestRender: () => tui.requestRender(),
		hooks: {
			setBar: (text) => writeOuterBar(text, env, lastOuter),
			bell: () => process.stdout.write("\x07"),
			watchDir: (dir, onEvent) => {
				const w = watch(dir, { persistent: false }, (_event, name) => onEvent(name ? String(name) : null));
				w.on("error", () => {});
				return () => w.close();
			},
			setInterval: (fn, ms) => setInterval(fn, ms),
			clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
		},
	});
	let finish: (code: number) => void = () => {};
	const finished = new Promise<number>((r) => (finish = r));
	const quit = () => finish(0);
	process.once("SIGTERM", quit);
	process.once("SIGHUP", quit);
	process.stdout.write("\x1b[?1049h\x1b[H");
	tui.addChild(view);
	tui.setFocus(view);
	tui.start();
	// Start where the slot is: a list restarted over a shown session keeps it.
	const panes = await ops.panes().catch(() => [] as DeckPane[]);
	view.setPanes(panes);
	controller.start();
	const slot = panes.find((p) => p.inSlot);
	if (slot?.session && (slot.role === "pi" || slot.role === "nvim")) view.selectSession(slot.session);
	view.scheduleApply(0);
	tui.requestRender();
	const code = await finished;
	process.off("SIGTERM", quit);
	process.off("SIGHUP", quit);
	view.dispose();
	await controller.stop();
	await ops.close();
	await list.close();
	tui.stop();
	process.stdout.write("\x1b[?1049l");
	return code;
}
