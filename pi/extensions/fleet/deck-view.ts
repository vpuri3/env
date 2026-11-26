/**
 * pi-deck list (docs/pi-deck-design.md §6, §15, §17): `pi-fleet deck`, the top-left pane of the deck
 * window. A telescope-like list of every pi session of this login node, grouped by repo; the
 * highlighted row's session is in the slots (its real pi pane in the right half, its nvim and its shell
 * below the list, swapped in by deck.ts; nvim and shell are created on the session's first show), or,
 * for rows without a deck pane, a preview frame written into the preview holder's tty (and below the
 * list the nvim and shell holders: one default nvim and one shell in $HOME, shared by those rows). The order of the rows is fixed when the list starts (the sort
 * rules below); later changes update rows in place, new sessions go last in their group; `r` sorts
 * again.
 *
 * Layout (top to bottom): the list, the selected row's status line, the search bar in a box
 * (mode badge and `4/12` on its top border, the color legend on its bottom one), key hints.
 * `A` (or `a` with no repo highlighted) turns the box into a PATH prompt: a directory with Tab
 * completion and suggestions in the list's lower part (git repos not in the deck first); Enter opens
 * a new session there.
 * Groups: one per repo (deck sessions, crashed ones,
 * sessions running outside tmux, other hosts' greyed, then that repo's closed sessions: grey, ◌, the
 * newest CLOSED_SHOWN, the rest behind a `+N closed` row), then `outside (your tmux)` (pis started
 * by hand in the user's tmux), then repos with only closed sessions (folded until opened). A search
 * shows every match, folded or not. Glyph, name and detail take their state's color (sessions-view
 * TONE_COLOR: active blue, working purple, done green, needs input orange, error red, closed grey).
 *
 * Right slot per row: a deck session → its pi (its nvim in the nvim slot); a subagent of a deck
 * session (§16) → that session's pi showing pi-subagent-manager's agent view of it: the list asks the
 * pi over its control socket (`agents-view`, the pane marked @pi_fleet_agents_view, latest request
 * wins), then swaps it in; Enter/C-l focus it; moving to another row sends `agents-close` while the
 * mark is still there (focusing that pi clears it: deck.tmux.conf's after-select-pane hook); a refused
 * view (reaped/unknown agent) falls back to the holder like below. Any other subagent
 * (Space expands; unfinished ones first, see orderThreads) → the tail of its transcript (registry.ts TranscriptTails), re-read on fs.watch of
 * its JSONL while selected; an outside session → a summary card plus one `capture-pane` taken on
 * highlight and on that session's status change (≤ 1/s); closed/crashed → a summary card, then the
 * end of its conversation (deck-pager.ts previewLines: user and assistant messages, one-line tool
 * calls); remote → a summary card. C-l on a closed/crashed/subagent row runs `less` on its whole
 * transcript in the holder (deck-pager.ts openPager), focused; while it runs the list writes no
 * frames, and moving to another row gives the holder its `sleep` back first (closePager).
 * Highlight changes are coalesced: the slot follows SWAP_COALESCE_MS after the last move, so a
 * key repeat is one swap. A session shown for ACK_MS while a client is attached is acknowledged
 * (`<id>.seen`).
 *
 * Updates (DeckController): fs.watch on the status dir, debounced STATUS_DEBOUNCE_MS, re-reads only
 * the named files; LIVENESS_MS re-derives liveness (and relative times), RESCAN_MS re-scans the
 * sessions dir (closed list, other hosts). No 1 s timers. deck.ts's startDeckList brings deck.sock
 * (open/select move the selection here too), SIGWINCH sizes and SIGUSR2 reconcile (a dead slot
 * pane is replaced by the next deck row; a transcript pager that ended signals it too:
 * checkPager). The outer tmux's `@pi_deck_bar` (`π 1? 2◐ 1✕`, set via
 * `@deck_outer`'s socket, else the default socket) is written BAR_DEBOUNCE_MS after a change, only
 * when it differs, and cleared on exit; entering waiting/question/error rings the deck client's bell.
 *
 * Keys: NORMAL j/k ↓/↑ C-n/C-p PgUp/PgDn move · Enter/C-l open (deck row: focus the slot; closed or
 * crashed: Enter resumes into the pool, C-l reads the transcript in less (q or C-h back; Enter in
 * less resumes); outside: close the popup and jump the outer client there via @deck_jump; subagent:
 * Enter its main, C-l its transcript; header: fold; `+N closed`: unfold) · Space subagents / fold · a new
 * session in the row's repo · d kill (inline: y or Enter kill · s kill + scancel · n or Esc no) · i or / INSERT · ! @ # & / 0
 * status filters · ? help · Esc clears the query · C-c detach (as prefix d) · C-d kill every deck
 * session and the deck (inline confirm; NORMAL and INSERT). INSERT: letters are fuzzy terms
 * (space-separated, all must match), C-n/C-p ↑/↓ move, Enter opens, Esc back to NORMAL.
 *
 * Runs as its own process (cli.ts registers pi-tui's resolve hook first), so process-level state
 * is fine here; DeckView and DeckController take their tmux side as DeckOps (tests use fakes).
 */

import { execFile } from "node:child_process";
import { constants as fsc, existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { open as fsOpen, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { ctlSockPath, guardedSocket, readStatus } from "./cli.ts";
import {
	DeckOpenError,
	defaultDeckHandler,
	deckPanes,
	deckSocketPath,
	deckTmux,
	ensureHolder,
	ensureNvimHolder,
	ensureTermHolder,
	focusSlot,
	killDeck,
	sessionPiPane,
	showSessionDetail,
	slotArgs,
	startDeckList,
	deckOpen,
	type DeckList,
	type DeckOpenRequest,
	type DeckOpenResult,
	type DeckPane,
} from "./deck.ts";
import {
	ConversationTails,
	PAGER_RESUME,
	closePager as closePagerPane,
	openPager as openPagerPane,
	pagerExit as readPagerExit,
	previewLines,
	removePagerFiles,
	type PagerRequest,
	type Turn,
} from "./deck-pager.ts";
import { queuedJobs, type SlurmJob } from "./lifecycle.ts";

export { PAGER_RESUME } from "./deck-pager.ts";
import { SessionIndex, TranscriptTails, countSubagents, type FoldedThread, type IndexEntry, type TranscriptItem } from "./registry.ts";
import {
	LEGEND,
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
	sendControl,
	stateWord,
	threadGlyph,
	tilde,
	toned,
	wrapped,
	type Group,
	type PreviewResult,
	type SessionRow,
	type StatusFilter,
	type Tone,
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
/** Closed sessions shown per repo; older ones fold behind a `+N closed` row (a search shows all). */
export const CLOSED_SHOWN = 3;

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
/** What a row shows: a slot target, or (§16) a deck session's pi showing one of its subagents. */
type ViewTarget = SlotTarget | { session: string; agent: string };
function targetKey(t: ViewTarget): string {
	return "agent" in t ? `a:${t.session}:${t.agent}` : "session" in t ? `s:${t.session}` : "h";
}

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
	/**
	 * C-d: deck.ts killDeck (as `pi-fleet kill-deck`, without --yes's force): every deck pi is asked to
	 * quit, then the server goes (this list with it). Server left up: nvims with unsaved buffers, listed.
	 */
	killDeck(): Promise<{ killedServer: boolean; nvims: { session: string; cwd: string }[] }>;
	/** A client is attached to the deck. */
	attached(): Promise<boolean>;
	ack(sessionId: string, runId: string): Promise<void>;
	capture(row: SessionRow, rows: number): Promise<PreviewResult>;
	transcript(file: string): Promise<TranscriptItem[] | undefined>;
	/** The end of a session's conversation (user messages too), for a closed row's preview. */
	conversation(file: string): Promise<Turn[] | undefined>;
	/** Show a transcript in `less` in the holder (the slot) and focus it (deck-pager.ts). */
	openPager(req: PagerRequest): Promise<void>;
	/** The holder runs a pager: restore it. */
	closePager(): Promise<void>;
	/** How the last pager ended (read and cleared). */
	pagerExit(): Promise<{ token: string; status: number } | undefined>;
	/** Focus the slot (whatever it shows). */
	focusSlot(): Promise<void>;
	/**
	 * §16: ask a deck session's pi to show its subagent `path` (the package's LiveAgentView) and mark its
	 * pane deck-opened (@pi_fleet_agents_view). ok:false: it cannot (reaped/unknown path, no tree, timeout).
	 */
	agentsView(sessionId: string, path: string): Promise<{ ok: boolean; error?: string }>;
	/** §16: close what agentsView opened, unless the user focused that pi since (the mark is gone then). */
	agentsClose(sessionId: string): Promise<void>;
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
export type Mode = "normal" | "insert" | "path";

type Item =
	| { kind: "group"; key: string; group: Group; collapsed: boolean; special?: "outside"; live: number; closed: number }
	| { kind: "main"; key: string; row: SessionRow; rowKind: RowKind; expanded: boolean }
	/** A repo's older closed sessions: folded (`+N closed`) or shown (`− hide N closed`). */
	| { kind: "more"; key: string; groupKey: string; group: Group; hidden: SessionRow[]; open: boolean }
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

const HELP_LINES = [
	"NORMAL",
	"  j/k ↓/↑ C-n/C-p   move (the right pane follows)    PgUp/PgDn  page",
	"  Enter, C-l        open: focus the session (outside: jump there;",
	"                    subagent of a deck session: its agent view, in its",
	"                    pi; other subagents: Enter its main)",
	"  Enter             closed/crashed: resume it as a pi in the deck",
	"  C-l               closed/crashed/other subagent: read its transcript in the",
	"                    right pane (less: j/k C-d/C-u C-f/C-b g/G / ? n/N;",
	"                    q or C-h back here; Enter resumes it)",
	"  Space             subagents of a session / fold a group",
	"                    (on +N closed: a repo's older closed sessions)",
	"  a                 new session in the row's repo",
	"  A                 new session in a directory (path prompt: Tab completes,",
	"                    Enter opens, Esc cancels)",
	"  r                 refresh: sort the list again (rows otherwise keep their",
	"                    place as their state changes; new sessions go last)",
	"  d                 kill: y/⏎ kill · s kill + scancel Slurm · n/Esc no",
	"  i  /              search (INSERT)    Esc  clear the search",
	"  ! @ # &   0       only working / waiting / idle / error;  all",
	"  C-c (prefix d)    detach    C-j  the nvim below    C-l  the pi",
	"  C-d               kill every deck session and the deck (asks; C-d again or y)",
	"  panes: C-h/C-j/C-k/C-l move: list, nvim, shell down the left, pi right",
	"         (pi: C-h back here)   prefix e  pi ↔ nvim   prefix z  zoom",
	"INSERT",
	"  letters           fuzzy terms (all must match name, repo, cwd, message)",
	"  C-n/C-p ↑/↓       move    Enter  open    Esc  back to NORMAL",
	"PATH",
	"  letters           a directory (~ is home)   C-u clear   C-w drop a component",
	"  Tab               complete (or take the highlighted suggestion)",
	"  C-n/C-p ↑/↓       move among suggestions (git: a repo not in the deck yet)",
	"  Enter             new session there    Esc  back to NORMAL",
];

/** Suggestion lines under the PATH prompt (at most). */
const PATH_SUGGESTIONS = 8;

/** `~` and `~/x` → home; anything else as typed (relative → under home). */
function expandPath(text: string, home: string): string {
	const t = text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text;
	return resolve(home, t);
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function commonPrefix(names: string[]): string {
	let p = names[0] ?? "";
	for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
	return p;
}

/** The legend on the search box's border, most important first (as many as fit). */
const BOX_LEGEND: Tone[] = ["active", "working", "done", "input", "error", "auto", "closed", "remote"];

/** What each color means, for the help screen. */
const LEGEND_WORDS: Record<Tone, string> = {
	active: "open, idle: ready for you",
	working: "the agent is running a turn (or its subagents are)",
	auto: "working under /run-autonomously",
	done: "finished, not looked at yet (selecting it for 1 s marks it seen)",
	input: "needs your input: a question or dialog is waiting",
	error: "the last run failed, or the pi crashed",
	closed: "not running (⏎ resumes it)",
	remote: "running on another host",
};

const FINISHED = new Set(["completed", "stopped", "failed"]);

/**
 * Subagents as the list shows them: unfinished ones (running, starting, waiting, paused, anything
 * not finished) first, then completed/stopped/failed; each bucket most recently updated first,
 * ties in their original order.
 */
export function orderThreads(threads: FoldedThread[]): FoldedThread[] {
	const rank = (t: FoldedThread) => (FINISHED.has(t.state) ? 1 : 0);
	return [...threads].sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

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
	/** The PATH prompt's text (kept apart from the search query). */
	pathText = "";
	/** Highlighted suggestion in PATH mode, -1 for none. */
	private pathSel = -1;
	private pathCache: { text: string; list: { name: string; git: boolean }[] } | undefined;
	statusFilter: StatusFilter | undefined;
	private items: Item[] = [];
	private selected = 0;
	private selectedKey: string | undefined;
	private top = 0;
	/** Folded groups with live sessions (unfolded by default). */
	private collapsed = new Set<string>();
	/** Unfolded groups with only closed sessions (folded by default). */
	private opened = new Set<string>();
	/** Groups whose older closed sessions are shown. */
	private allClosed = new Set<string>();
	private expanded = new Set<string>();
	/**
	 * The fixed order (§6, user 2026-11-17): taken from the sort rules when the list first has rows and on
	 * `r`; status changes update rows in place. Groups by key, rows by id (with `live`: the row was in its
	 * group's live part then, so a session that closes since stays where it was).
	 */
	private order:
		| { groups: Map<string, { rank: number; closedOnly: boolean }>; rows: Map<string, { rank: number; live: boolean }>; liveGroups: number; next: number; nextGroup: number }
		| undefined;
	private threadCache = new Map<string, FoldedThread[] | undefined>();
	private help = false;
	private message: { text: string; until: number } | undefined;
	private messageTimer: unknown;
	private confirm: KillConfirm | undefined;
	/** C-d: the "kill everything" confirm (count of live deck sessions), and a kill-deck under way. */
	private confirmAll: { count: number } | undefined;
	private killingAll = false;
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
	/** §16: the session last sent agents-view (agents-close goes there when the selection moves on). */
	private agentsOpen: string | undefined;
	/** §16: the subagent row whose agents-view failed: it falls back to the holder preview. */
	private agentFallbackKey: string | undefined;
	private lastFrame = "";
	// previews
	private transcripts = new Map<string, { file?: string; items?: TranscriptItem[]; failed?: boolean }>();
	/** Closed/crashed rows: the end of their conversation (by session id). */
	private conversations = new Map<string, Turn[] | null>();
	/** The transcript pager (less in the holder) of this item; the holder shows it, no frames. */
	private pager: { key: string; token: string; seq: number } | undefined;
	private pagerSeq = 0;
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
				const key = this.groupKeyOf(row);
				this.collapsed.delete(key);
				this.opened.add(key);
				if (this.rowKind(row) === "closed") this.allClosed.add(key);
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

	flash(text: string, ms = MESSAGE_MS): void {
		this.message = { text: oneLine(text), until: this.now() + ms };
		if (this.messageTimer) this.timers.clearTimeout(this.messageTimer);
		this.messageTimer = this.timers.setTimeout(() => {
			this.messageTimer = undefined;
			if (this.message && this.message.until <= this.now()) this.message = undefined;
			this.opts.requestRender();
		}, ms);
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
		return this.rowKind(row) === "outside" ? OUTSIDE_KEY : `g:${row.repo}`;
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

	/** `r`: sort everything again with the current rules (the selection stays on its row). */
	resort(): void {
		this.order = undefined;
		this.rebuild();
	}

	/** The groups of `rows` in the sort rules' order: live repo groups, outside, closed-only repos. */
	private groupsOf(rows: SessionRow[], kinds: Map<string, RowKind>): { key: string; group: Group; special?: "outside"; closedOnly: boolean }[] {
		const repoRows: SessionRow[] = [];
		const outside: SessionRow[] = [];
		for (const row of rows) (kinds.get(row.id) === "outside" ? outside : repoRows).push(row);
		const isClosed = (r: SessionRow) => kinds.get(r.id) === "closed";
		// Closed sessions sit in their repo's group (one groupRows call: same-named repos get paths),
		// after its live rows; repos with only closed sessions come after every live group.
		type G = { key: string; group: Group; special?: "outside"; closedOnly: boolean };
		const byRepo: G[] = groupRows(repoRows).map((g) => ({ key: `g:${g.repo}`, group: g, closedOnly: g.rows.every(isClosed) }));
		const groups: G[] = byRepo.filter((g) => !g.closedOnly);
		if (outside.length) {
			const g = groupRows(outside).flatMap((x) => x.rows);
			groups.push({ key: OUTSIDE_KEY, group: { repo: "", label: "outside (your tmux)", rows: g }, special: "outside", closedOnly: false });
		}
		groups.push(...byRepo.filter((g) => g.closedOnly));
		return groups;
	}

	/** Fix the order of every row (search or not) as the sort rules have it now. */
	private freezeOrder(kinds: Map<string, RowKind>): void {
		const groups = this.groupsOf(this.rows, kinds);
		const order = { groups: new Map<string, { rank: number; closedOnly: boolean }>(), rows: new Map<string, { rank: number; live: boolean }>(), liveGroups: 0, next: 0, nextGroup: 0 };
		let rank = 0;
		groups.forEach((g, i) => {
			order.groups.set(g.key, { rank: i, closedOnly: g.closedOnly });
			if (!g.closedOnly && !g.special) order.liveGroups = i + 1;
			const live = g.group.rows.filter((r) => kinds.get(r.id) !== "closed");
			const closed = g.group.rows.filter((r) => kinds.get(r.id) === "closed").sort((a, b) => b.at - a.at);
			for (const r of live) order.rows.set(r.id, { rank: rank++, live: true });
			for (const r of closed) order.rows.set(r.id, { rank: rank++, live: false });
		});
		order.next = rank;
		this.order = order;
	}

	private rebuild(): void {
		const searching = !!(this.query.trim() || this.statusFilter);
		const shown = this.rows.filter((r) => this.matches(r));
		const kinds = new Map<string, RowKind>();
		for (const row of this.rows) kinds.set(row.id, this.rowKind(row));
		if (!this.order && this.rows.length) this.freezeOrder(kinds);
		const isClosed = (r: SessionRow) => kinds.get(r.id) === "closed";
		const groups = this.groupsOf(shown, kinds);
		// The fixed order: known groups where they were (a repo whose sessions all closed since stays among
		// the live ones), new live groups after the known live ones, new closed-only repos at the end.
		const order = this.order;
		if (order) {
			// What appeared since the order was fixed gets its place the first time it is seen (over all rows,
			// search or not), and keeps it: new live groups after the known live ones, a repo that came back
			// from closed-only among them too, new closed-only repos at the end; new live rows last in their group.
			for (const g of this.groupsOf(this.rows, kinds)) {
				const known = order.groups.get(g.key);
				if (!known || (known.closedOnly && !g.closedOnly)) {
					const n = ++order.nextGroup;
					const rank = g.closedOnly ? 1e6 + n : g.special ? order.liveGroups - 0.25 : order.liveGroups - 0.5 + n * 1e-6;
					order.groups.set(g.key, { rank, closedOnly: g.closedOnly });
				}
				for (const r of g.group.rows) {
					const knownRow = order.rows.get(r.id);
					if (!isClosed(r) && !knownRow?.live) order.rows.set(r.id, { rank: order.next++, live: true });
				}
			}
			const rankOf = (g: (typeof groups)[number]) => order.groups.get(g.key)?.rank ?? 1e9;
			const ranked = groups.map((g) => ({ g, r: rankOf(g) }));
			ranked.sort((a, b) => a.r - b.r);
			groups.splice(0, groups.length, ...ranked.map((x) => x.g));
		}
		/** A row's place in its group's live part: known rows by their rank, new ones after them (as sorted now). */
		const liveRank = (r: SessionRow, i: number) => {
			const known = order?.rows.get(r.id);
			return known?.live ? known.rank : 1e9 + i;
		};
		/** Shown in the live part: running now, or live when the order was fixed (it stays until `r`). */
		const inLive = (r: SessionRow) => !isClosed(r) || !!order?.rows.get(r.id)?.live;
		const items: Item[] = [];
		const pushRow = (row: SessionRow) => {
			const expanded = this.expanded.has(row.id);
			items.push({ kind: "main", key: `m:${row.id}`, row, rowKind: kinds.get(row.id)!, expanded });
			if (!expanded) return;
			const threads = this.threadsOf(row);
			if (!threads?.length) {
				items.push({ kind: "note", key: `n:${row.id}`, text: threads ? "no subagents" : "no session file yet" });
				return;
			}
			for (const thread of threads) items.push({ kind: "sub", key: `s:${row.id}:${thread.path}`, row, thread });
		};
		for (const { key, group, special, closedOnly } of groups) {
			const live = group.rows
				.filter(inLive)
				.map((r, i) => ({ r, k: liveRank(r, i) }))
				.sort((a, b) => a.k - b.k)
				.map((x) => x.r);
			const closed = group.rows.filter((r) => !inLive(r)).sort((a, b) => b.at - a.at);
			const collapsed = !searching && (closedOnly ? !this.opened.has(key) : this.collapsed.has(key));
			items.push({ kind: "group", key, group, collapsed, special, live: live.filter((r) => !isClosed(r)).length, closed: group.rows.filter(isClosed).length });
			if (collapsed) continue;
			for (const row of live) pushRow(row);
			const folds = !searching && closed.length > CLOSED_SHOWN;
			const open = !folds || this.allClosed.has(key);
			for (const row of open ? closed : closed.slice(0, CLOSED_SHOWN)) pushRow(row);
			if (folds) items.push({ kind: "more", key: `c:${key}`, groupKey: key, group, hidden: closed.slice(CLOSED_SHOWN), open });
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
		if (!this.threadCache.has(row.id)) {
			const threads = this.opts.source.threads(row);
			this.threadCache.set(row.id, threads && orderThreads(threads));
		}
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

	/**
	 * What the slot shows for the selected item: a session, a deck session showing one of its subagents
	 * (§16: its pi with the package's agent view, unless that failed for this row), or the holder.
	 */
	private targetOf(item: Item | undefined): ViewTarget {
		if (item?.kind === "main" && item.rowKind === "deck") return { session: item.row.id };
		if (this.liveAgent(item)) return { session: item.row.id, agent: item.thread.path };
		return { holder: true };
	}

	/** A subagent row of a live deck session whose agent view has not failed (§16). */
	private liveAgent(item: Item | undefined): item is Extract<Item, { kind: "sub" }> {
		return item?.kind === "sub" && this.deckPanesById.has(item.row.id) && this.agentFallbackKey !== item.key && !!item.thread.path;
	}

	/** After a refresh: re-apply if the selected item's target changed, or refresh its holder frame. */
	private followSlot(): void {
		const item = this.items[this.selected];
		const t = targetKey(this.targetOf(item));
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
		if (this.agentFallbackKey !== undefined && this.agentFallbackKey !== key) this.agentFallbackKey = undefined;
		const target = this.targetOf(item);
		let t = targetKey(target);
		if (this.watchedKey !== key) this.stopWatching();
		try {
			// §16: another row: the agent view the deck opened goes (unless the user took it over).
			if (this.agentsOpen && !("agent" in target && target.session === this.agentsOpen)) {
				const id = this.agentsOpen;
				this.agentsOpen = undefined;
				await this.opts.ops.agentsClose(id).catch(() => {});
			}
			// The slot moves on from a transcript pager: the holder gets its `sleep` back first.
			if (this.pager && (this.pager.key !== key || "session" in target)) await this.closePager();
			if (this.pager) {
				// This item's pager is in the slot (the user came back with C-h): leave it.
			} else if ("agent" in target) {
				if (this.appliedKey !== key || this.appliedTarget !== t) {
					// Ask first, swap after: a refused view falls back to the holder without showing the pi.
					this.agentsOpen = target.session;
					const r = await this.opts.ops.agentsView(target.session, target.agent).catch((error) => ({ ok: false, error: (error as Error).message }));
					// The selection moved on meanwhile: the next apply (already scheduled) takes over, and must
					// ask again even for the row it showed before (this stale request may have moved the pi's view).
					if (this.disposed || this.selectedKey !== key) {
						this.appliedKey = undefined;
						return;
					}
					if (r.ok) {
						this.shows++;
						if (!(await this.opts.ops.show({ session: target.session }))) await this.showHolderFor(item);
					} else {
						this.agentsOpen = undefined;
						this.agentFallbackKey = key;
						t = "h";
						await this.showHolderFor(item);
						this.startPreview(item);
					}
				}
			} else if ("session" in target) {
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
		if (this.disposed || key !== this.selectedKey || this.appliedTarget !== "h" || this.pager) return;
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
		if (item.kind === "main" && (item.rowKind === "closed" || item.rowKind === "crashed")) this.readConversation(item.row, item.key);
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

	/** A closed/crashed row's preview: the end of its conversation under the card (read once per file change). */
	private readConversation(row: SessionRow, key: string): void {
		const file = row.file;
		if (!file) return;
		void this.opts.ops
			.conversation(file)
			.catch(() => undefined)
			.then((turns) => {
				const before = this.conversations.get(row.id);
				this.conversations.set(row.id, turns ?? null);
				if (before !== (turns ?? null)) this.redrawHolder(key);
			});
	}

	// ------------------------------------------------------------ the transcript pager (deck-pager.ts)

	/** The JSONL C-l pages for this item: closed/crashed rows and subagents; undefined for the rest. */
	private pagerFile(item: Item | undefined): string | undefined {
		if (item?.kind === "main" && (item.rowKind === "closed" || item.rowKind === "crashed")) return item.row.file;
		if (item?.kind === "sub") return this.opts.source.subagentFile(item.row, item.thread);
		return undefined;
	}

	/** C-l on a closed/crashed/subagent row: its transcript in less in the slot, focused. */
	private openPager(item: Extract<Item, { kind: "main" | "sub" }>): void {
		const file = this.pagerFile(item);
		if (!file) return this.flash(`${item.row.name}: no transcript file`);
		if (this.pager?.key === item.key) {
			// Still open (the user came back with C-h): just go there again.
			void this.opts.ops.focusSlot().catch((error) => this.flash(`pi-fleet: ${(error as Error).message}`));
			return;
		}
		const seq = ++this.pagerSeq;
		const pager = { key: item.key, token: `${process.pid}-${seq}`, seq };
		const sub = item.kind === "sub" ? item.thread : undefined;
		const title = sub ? `${sub.type ?? "?"} ${sub.path} of ${item.row.name}` : item.row.name;
		const facts: string[] = [];
		if (sub?.task) facts.push(`task: ${sub.task}`);
		if (item.row.cwd) facts.push(tilde(item.row.cwd));
		const req: PagerRequest = { file, title, enter: sub ? "its session" : "resume", facts, width: this.slotSize.width, token: pager.token };
		void (async () => {
			// An earlier pager (another row) gives the holder back first.
			if (this.pager) await this.closePager();
			this.pager = pager;
			this.appliedKey = item.key;
			this.appliedTarget = "h";
			try {
				await this.opts.ops.openPager(req);
			} catch (error) {
				if (this.pager === pager) this.pager = undefined;
				this.flash(`pi-fleet: ${(error as Error).message}`);
				this.lastFrame = "";
				this.scheduleApply(0);
			}
			this.opts.requestRender();
		})();
	}

	/** Give the holder back its `sleep` (the pager is killed); the next frame is written in full. */
	private async closePager(): Promise<void> {
		if (!this.pager) return;
		this.pager = undefined;
		this.lastFrame = "";
		await this.opts.ops.closePager().catch(() => {});
	}

	/** The pager may have ended (SIGUSR2): q/C-h-less exits back to the card; Enter (PAGER_RESUME) is Enter on the row. */
	async checkPager(): Promise<void> {
		const pager = this.pager;
		if (!pager) return;
		const exit = await this.opts.ops.pagerExit().catch(() => undefined);
		if (!exit || exit.token !== pager.token || this.pager !== pager) return;
		this.pager = undefined;
		this.lastFrame = "";
		if (exit.status === PAGER_RESUME && this.selectedKey === pager.key) this.activate();
		else {
			if (exit.status !== 0) this.flash(exit.status === 127 ? "pi-fleet: less not found" : `pi-fleet: less exited with ${exit.status}`);
			this.appliedKey = undefined;
			this.scheduleApply(0);
		}
		this.opts.requestRender();
	}

	/** The pager shown (tests). */
	pagerKey(): string | undefined {
		return this.pager?.key;
	}

	// ------------------------------------------------------------ input

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		this.message = undefined;
		if (this.confirmAll) this.handleConfirmAll(data);
		else if (this.confirm) this.handleConfirm(data);
		else if (matchesKey(data, "ctrl+d")) this.askKillAll();
		else if (this.mode === "insert") this.handleInsert(data);
		else if (this.mode === "path") this.handlePath(data);
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
			if (matchesKey(data, "ctrl+l")) this.focusOrRead();
			else this.activate();
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
		if (matchesKey(data, "enter")) return this.activate();
		if (matchesKey(data, "ctrl+l")) return this.focusOrRead();
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
				// Not detach (C-c and prefix d do that): q only closes the help.
				this.help = false;
				return;
			case "r":
				this.resort();
				this.scheduleApply();
				return;
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
			case "A":
				return this.openPathPrompt();
		}
		if (ch && STATUS_FILTER_KEYS[ch]) {
			const f = STATUS_FILTER_KEYS[ch];
			this.statusFilter = this.statusFilter === f ? undefined : f;
			this.rebuild();
			this.scheduleApply();
		}
	}

	private home(): string {
		return this.opts.home ?? homedir();
	}

	/** The highlighted row's repo (a header's, a session's repo or cwd); undefined for special/none. */
	private rowRepo(): string | undefined {
		const item = this.items[this.selected];
		if (item?.kind === "group") return item.special ? undefined : item.group.repo;
		if (item?.kind === "more") return item.group.repo;
		if (item && item.kind !== "note") return item.row.repo || item.row.cwd || undefined;
		return undefined;
	}

	private newSession(): void {
		const cwd = this.rowRepo();
		if (!cwd) return this.openPathPrompt();
		this.openIn(cwd);
	}

	/** `a` and the PATH prompt's Enter: a new session in `cwd`, shown and focused. */
	private openIn(cwd: string): void {
		this.flash(`new session in ${tilde(oneLine(cwd))}…`);
		void this.run(async () => {
			const r = await this.opts.ops.open({ cwd, focus: true });
			return r.session;
		});
	}

	/** PATH mode, starting at the highlighted repo's parent dir (`~/` without one). */
	private openPathPrompt(): void {
		const repo = this.rowRepo();
		const parent = repo ? tilde(dirname(repo)) : "~";
		this.pathText = parent.endsWith("/") ? parent : `${parent}/`;
		this.pathSel = -1;
		this.mode = "path";
		this.help = false;
	}

	/** The typed path split into its directory (resolved) and the last component's prefix. */
	private pathParts(text = this.pathText): { dirText: string; dir: string; prefix: string } {
		const cut = text.lastIndexOf("/") + 1;
		const dirText = text.slice(0, cut);
		const prefix = text.slice(cut);
		if (!cut && prefix === "~") return { dirText: "~/", dir: this.home(), prefix: "" };
		return { dirText, dir: expandPath(dirText || ".", this.home()), prefix };
	}

	/** Directories in the typed dir matching the prefix: git repos not in the deck first, then by name. */
	private pathSuggestions(): { name: string; git: boolean }[] {
		if (this.pathCache?.text === this.pathText) return this.pathCache.list;
		const { dir, prefix } = this.pathParts();
		let list: { name: string; git: boolean }[] = [];
		try {
			const known = new Set(this.rows.map((r) => r.repo).filter(Boolean));
			list = readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.name.startsWith(prefix) && (prefix.startsWith(".") || !e.name.startsWith(".")))
				.filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name))))
				.map((e) => {
					const full = join(dir, e.name);
					return { name: e.name, git: existsSync(join(full, ".git")) && !known.has(full) };
				})
				.sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name));
		} catch {}
		this.pathCache = { text: this.pathText, list };
		return list;
	}

	private setPath(text: string): void {
		this.pathText = text;
		this.pathSel = -1;
	}

	private handlePath(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.mode = "normal";
			return;
		}
		const list = this.pathSuggestions();
		if (matchesKey(data, "enter")) {
			const { dirText } = this.pathParts();
			const text = this.pathSel >= 0 && list[this.pathSel] ? `${dirText}${list[this.pathSel]!.name}` : this.pathText;
			const cwd = expandPath(text.trim() || "~", this.home());
			if (!isDir(cwd)) return this.flash(`no such directory: ${tilde(oneLine(cwd))}`);
			this.mode = "normal";
			return this.openIn(cwd);
		}
		if (matchesKey(data, "tab")) {
			const { dirText, prefix } = this.pathParts();
			if (this.pathSel >= 0 && list[this.pathSel]) return this.setPath(`${dirText}${list[this.pathSel]!.name}/`);
			if (list.length === 1) return this.setPath(`${dirText}${list[0]!.name}/`);
			const common = commonPrefix(list.map((c) => c.name));
			if (list.length > 1 && common.length > prefix.length) this.setPath(`${dirText}${common}`);
			return;
		}
		const shown = Math.min(list.length, PATH_SUGGESTIONS, this.listHeight() - 2);
		if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
			if (shown) this.pathSel = this.pathSel + 1 >= shown ? 0 : this.pathSel + 1;
		} else if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
			if (shown) this.pathSel = this.pathSel <= 0 ? shown - 1 : this.pathSel - 1;
		} else if (matchesKey(data, "backspace")) this.setPath(this.pathText.slice(0, -1));
		else if (matchesKey(data, "ctrl+u")) this.setPath("");
		else if (matchesKey(data, "ctrl+w")) this.setPath(this.pathText.replace(/[^/]*\/?$/, ""));
		else {
			const text = printable(data);
			if (text) this.setPath(this.pathText + text);
		}
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

	/** C-d: confirm killing every deck session and the deck itself. */
	private askKillAll(): void {
		if (this.killingAll) return this.flash("killing the deck…");
		this.help = false;
		this.confirmAll = { count: this.deckPanesById.size };
	}

	private handleConfirmAll(data: string): void {
		const ch = printable(data);
		// C-d again confirms, so C-d C-d kills like y.
		if (ch === "y" || matchesKey(data, "enter") || matchesKey(data, "ctrl+d")) {
			this.confirmAll = undefined;
			this.killingAll = true;
			this.flash("killing every deck session and the deck…");
			void this.opts.ops
				.killDeck()
				.then((r) => {
					// Killed: this list goes with the server (SIGHUP). Still here: nvims with unsaved changes.
					this.killingAll = false;
					if (r.killedServer) return;
					const names = r.nvims.map((n) => oneLine(this.rows.find((row) => row.id === n.session)?.name ?? n.session.slice(0, 8)));
					this.flash(
						names.length
							? `unsaved changes in nvim (${names.join(", ")}): save and quit them (:wqa), then C-d again`
							: "pi-fleet: the deck is still up (kill-server failed)",
						30_000,
					);
				})
				.catch((error) => {
					this.killingAll = false;
					this.flash(`pi-fleet: ${(error as Error).message}`);
				});
		} else if (ch === "n" || ch === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.confirmAll = undefined;
		}
	}

	private confirmJobs(c: KillConfirm): string[] {
		const ids = c.row.status?.slurmJobs ?? [];
		return Array.isArray(c.jobs) ? c.jobs.map((j) => j.id) : ids;
	}

	private handleConfirm(data: string): void {
		const c = this.confirm!;
		const ch = printable(data);
		if (ch === "y" || ch === "s" || matchesKey(data, "enter")) {
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

	/** C-l: closed/crashed/subagent rows read their transcript (the pager); every other row is Enter. */
	private focusOrRead(): void {
		const item = this.items[this.selected];
		if (this.liveAgent(item)) return this.activate();
		if ((item?.kind === "main" || item?.kind === "sub") && (item.kind === "sub" || item.rowKind === "closed" || item.rowKind === "crashed")) return this.openPager(item);
		this.activate();
	}

	private activate(): void {
		const item = this.items[this.selected];
		if (!item || item.kind === "note") return;
		if (item.kind === "group" || item.kind === "more") return this.toggle();
		if (item.kind === "sub") {
			// §16: a live deck session's subagent: into its pi, where the agent view is (or opens).
			if (this.liveAgent(item)) {
				const row = item.row;
				void this.opts.ops.focusSession(row.id).then(
					(ok) => (ok ? undefined : this.flash(`${row.name}: its pane is gone`)),
					(error) => this.flash(`pi-fleet: ${(error as Error).message}`),
				);
				return;
			}
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
					// Its pager (if open) goes: the holder leaves the slot for the pi.
					await this.closePager();
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
			const set = item.live || item.special ? this.collapsed : this.opened;
			if (set.has(item.key)) set.delete(item.key);
			else set.add(item.key);
		} else if (item.kind === "more") {
			// Unfolding lands on the first row it shows; folding stays on the toggle row.
			if (item.open) this.allClosed.delete(item.groupKey);
			else {
				this.allClosed.add(item.groupKey);
				if (item.hidden[0]) this.selectedKey = `m:${item.hidden[0].id}`;
			}
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

	/** Lines below the list: status line, the boxed search bar (3), key hints. */
	static readonly CHROME = 5;

	private listHeight(): number {
		return Math.max(1, this.opts.height() - DeckView.CHROME);
	}

	render(width: number): string[] {
		const style = this.opts.style;
		const height = Math.max(DeckView.CHROME + 1, this.opts.height());
		if (this.message && this.message.until < this.now()) this.message = undefined;
		const bodyH = height - DeckView.CHROME;
		const sugg = this.mode === "path" ? this.pathLines(width, Math.min(PATH_SUGGESTIONS + 1, bodyH - 1)) : [];
		const listH = bodyH - sugg.length;
		const body = this.help ? this.helpLines(width) : this.listLines(width, listH);
		while (body.length < listH) body.push("");
		body.length = listH;
		body.push(...sugg);
		return [...body.slice(0, bodyH), this.statusLine(width), ...this.searchBox(width), this.hintLine(width)].map((l) => fit(l, width));
	}

	/** PATH mode: a rule, then matching directories (the highlighted one selected), in `height` lines. */
	private pathLines(width: number, height: number): string[] {
		if (height < 2) return [];
		const style = this.opts.style;
		const list = this.pathSuggestions().slice(0, height - 1);
		const { dirText } = this.pathParts();
		const lines = [fit(style.fg("border", `${"─".repeat(2)} ${list.length ? "directories" : "no matching directories"} ${"─".repeat(width)}`), width)];
		list.forEach((c, i) => {
			const text = ` ${dirText}${c.name}/${c.git ? `  ${style.fg("dim", "git")}` : ""}`;
			const sel = i === this.pathSel;
			lines.push(sel && style.selected ? style.selected(pad(text, width)) : fit(sel ? `›${text.slice(1)}` : text, width));
		});
		return lines;
	}

	private helpLines(width: number): string[] {
		const style = this.opts.style;
		const colors = LEGEND.map(([tone, text]) => fit(`  ${pad(toned(tone, text, style), 15)}${style.fg("muted", LEGEND_WORDS[tone])}`, width));
		return [...HELP_LINES.map((l) => fit(style.fg("muted", ` ${l}`), width)), fit(style.fg("muted", " COLORS"), width), ...colors];
	}

	/**
	 * The search bar, boxed so it stands out: mode badge and match count on the top border, the
	 * query inside, the color legend on the bottom border (as many entries as fit). The border is
	 * light grey in NORMAL, bold cyan in INSERT.
	 */
	private searchBox(width: number): string[] {
		const style = this.opts.style;
		const path = this.mode === "path";
		const insert = this.mode === "insert" || path;
		const line = (t: string) => (insert ? style.bold(style.fg("accent", t)) : style.fg("muted", t));
		const badge = path ? style.bold(style.fg("warning", " PATH ")) : insert ? style.bold(style.fg("success", " INSERT ")) : style.bold(style.fg("accent", " NORMAL "));
		const total = this.rows.length;
		const matched = this.query.trim() || this.statusFilter ? this.rows.filter((r) => this.matches(r)).length : total;
		const count = style.fg("text", ` ${matched}/${total} `);
		const inner = Math.max(0, width - 2);
		// ╭─ NORMAL ───── 4/12 ─╮
		const topFill = inner - 1 - visibleWidth(badge) - visibleWidth(count) - 1;
		const top = topFill >= 1 ? `${line("╭─")}${badge}${line("─".repeat(topFill))}${count}${line("─╮")}` : `${line("╭")}${fit(badge, inner)}${line("─".repeat(Math.max(0, inner - visibleWidth(fit(badge, inner)))))}${line("╮")}`;
		// │ ⌕ query▏ [filter] │
		const cursor = insert ? style.fg("accent", "▏") : "";
		const filter = this.statusFilter ? ` ${style.fg("accent", `[${this.statusFilter}]`)}` : "";
		const query = path
			? fit(` ${style.fg("accent", "▸")} ${style.fg("text", oneLine(this.pathText))}${cursor}`, inner)
			: fit(` ${style.fg(insert ? "accent" : "muted", "⌕")} ${style.fg("text", oneLine(this.query))}${cursor}${filter}`, inner);
		const mid = `${line("│")}${query}${" ".repeat(Math.max(0, inner - visibleWidth(query)))}${line("│")}`;
		// ╰─ ○ active  ● working … ─╯
		let legendText = "";
		for (const tone of BOX_LEGEND) {
			const text = LEGEND.find(([t]) => t === tone)![1];
			const next = `${legendText}${legendText ? "  " : " "}${toned(tone, text, style)}`;
			if (visibleWidth(next) + 1 > inner - 2) break;
			legendText = next;
		}
		if (legendText) legendText += " ";
		const bottom = `${line("╰─")}${legendText}${line("─".repeat(Math.max(0, inner - 1 - visibleWidth(legendText))))}${line("╯")}`;
		return [top, mid, bottom];
	}

	/** What Enter and C-l do on the selected row, for the hints. */
	private openHints(): string[] {
		const item = this.items[this.selected];
		if (this.liveAgent(item)) return ["⏎/C-l its agent view"];
		if (item?.kind === "sub") return ["⏎ its session", "C-l read"];
		if (item?.kind === "main" && (item.rowKind === "closed" || item.rowKind === "crashed")) return ["⏎ resume", "C-l read"];
		return ["⏎/C-l open"];
	}

	private hintLine(width: number): string {
		const style = this.opts.style;
		if (this.confirmAll) return fit(` ${style.bold(style.fg("warning", "y/⏎/C-d kill · n/Esc cancel"))}`, width);
		if (this.confirm) {
			const scancel = this.confirmJobs(this.confirm).length ? " · s kill+scancel" : "";
			return fit(` ${style.bold(style.fg("warning", `y/⏎ kill${scancel} · n/Esc cancel`))}`, width);
		}
		if (this.message) return fit(` ${style.fg("warning", this.message.text)}`, width);
		const chunks =
			this.mode === "path"
				? ["type a directory", "Tab complete", "⏎ new session", "C-n/C-p pick", "Esc cancel"]
				: this.mode === "insert"
				? ["type to search", "⏎ open", "C-n/C-p move", "Esc normal"]
				: ["j/k move", ...this.openHints(), "a new", "d kill", "i / search", "? help", "C-c detach", "A new in…", "r refresh", "C-d kill all", "␣ subagents"];
		// As many hints as fit, in order (detach before the rarer ones).
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
		const sep = style.fg("border", " · ");
		if (this.confirmAll) {
			const n = this.confirmAll.count;
			return fit(` ${style.fg("warning", style.bold(`Kill all ${n} deck session${n === 1 ? "" : "s"} and the deck?`))}`, width);
		}
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
		if (item.kind === "more") {
			const n = item.hidden.length;
			const what = `${n} older closed session${n === 1 ? "" : "s"} in ${oneLine(item.group.label)}`;
			return fit(` ${what}${sep}${style.fg("dim", item.open ? "⏎/␣ hide them" : "⏎/␣ show them")}`, width);
		}
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
			if (item.thread.costUsd) parts.push(`$${item.thread.costUsd.toFixed(2)}`);
			if (item.thread.task) parts.push(style.fg("dim", oneLine(item.thread.task)));
			return fit(` ${parts.join(sep)}`, width);
		}
		const s = row.status;
		const since = s ? Date.parse(s.since) || row.at : row.at;
		// The name is already in the selected row above: only the facts the row lacks.
		const parts = [toned(rowTone(row), `${glyphChar(row)} ${stateWord(row)}`, style)];
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
		// The subagent counts column: as wide as the widest counts of any row (so columns line up while
		// scrolling), right-aligned to the pane's edge; the name takes the rest.
		let countsW = 0;
		for (const i of this.items) if (i.kind === "main") countsW = Math.max(countsW, visibleWidth(countsText(i.row.counts, style)));
		for (let i = this.top; i < Math.min(this.items.length, this.top + height); i++) lines.push(this.itemLine(this.items[i]!, i === this.selected, width, now, countsW));
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

	private itemLine(item: Item, selected: boolean, width: number, now: number, countsW = 0): string {
		const style = this.opts.style;
		const marker = selected ? style.bold(style.fg("accent", "›")) : " ";
		if (item.kind === "group") {
			const { live, closed } = item;
			const n = closed ? (live ? `(${live}, ${closed} closed)` : `(${closed} closed)`) : `(${live})`;
			const label = style.bold(style.fg("accent", item.group.label));
			// The repo's full path after the count (not for special groups, or when the label is the path).
			const path = item.special || !item.group.repo ? "" : tilde(oneLine(item.group.repo));
			const where = path && path !== item.group.label ? `  ${style.fg("dim", path)}` : "";
			return fit(`${marker}${style.fg("dim", item.collapsed ? "▸" : "▾")} ${label} ${style.fg("dim", n)}${where}`, width);
		}
		if (item.kind === "note") return fit(`       ${style.fg("dim", item.text)}`, width);
		if (item.kind === "more") {
			const n = item.hidden.length;
			const text = item.open ? `− hide ${n} older closed` : `+${n} closed`;
			return fit(`${marker} ${style.fg("dim", "⋯")} ${selected ? style.bold(style.fg("dim", text)) : style.fg("dim", text)}`, width);
		}
		const row = item.row;
		if (item.kind === "sub") {
			const live = row.live === "live" || row.live === "remote";
			const { glyph: g, tone: subTone } = threadGlyph(item.thread, live, style);
			const label = oneLine(`${item.thread.type ?? "?"} ${item.thread.path}`);
			const tone = rowTone(row);
			const avail = Math.max(10, width - 4);
			const wide = avail >= 60;
			const detailW = wide ? 16 : 13;
			const room = avail - detailW - 1 - (wide ? 8 : 0);
			const minName = Math.min(wide ? 30 : 16, Math.max(8, room - 8));
			const countsFit = Math.max(0, Math.min(countsW, room - minName - 1));
			const countsCol = countsFit ? countsFit + 1 : 0;
			const cost = item.thread.costUsd ? `$${item.thread.costUsd.toFixed(2)}` : "";
			const costCol = wide ? 8 : 0;
			// Everything before the cost column (same right edge as the main rows' cost).
			const body = Math.max(10, width - countsCol - costCol - 7);
			const labelW = Math.min(Math.max(30, Math.floor(body / 2)), Math.max(10, body - 24));
			// Glyph and label in the thread's state color, as main rows; no state word (the glyph says it).
			let labelText = toned(subTone, label, style);
			if (selected && subTone !== "input") labelText = style.bold(labelText);
			let text = pad(labelText, labelW);
			if (item.thread.task) text += ` ${style.fg("dim", oneLine(item.thread.task))}`;
			const head = `${marker}    ${g} ${wide ? pad(fit(text, body), body) : text}`;
			const costText = wide ? ` ${padRight(style.fg(tone === "closed" || tone === "remote" ? "dim" : "muted", cost), 7)}` : "";
			return fit(`${head}${costText}`, width);
		}
		const tone = rowTone(row);
		const avail = Math.max(10, width - 4);
		const wide = avail >= 60;
		const detailW = wide ? 16 : 13;
		// The row spans the pane: name | detail | cost | counts (right-aligned at the edge, countsW as
		// measured over the rows). The name takes every column the others leave; a narrow list keeps a
		// readable name and lets the counts be cut at the edge.
		const room = avail - detailW - 1 - (wide ? 8 : 0);
		const minName = Math.min(wide ? 30 : 16, Math.max(8, room - 8));
		const countsFit = Math.max(0, Math.min(countsW, room - minName - 1));
		const countsCol = countsFit ? countsFit + 1 : 0;
		const nameW = room - countsCol;
		let name = oneLine(row.name);
		let suffix = "";
		if (item.rowKind === "outside") {
			const w = row.status?.tmux?.windowIndex;
			suffix = ` ⇱${w !== undefined ? ` win ${w}` : ""}`;
		}
		const nameRoom = Math.max(4, nameW - visibleWidth(suffix));
		name = fit(name, nameRoom);
		// Glyph, name and detail in the state's color (sessions-view TONE_COLOR); bold when selected.
		let nameText = toned(tone, name, style);
		if (selected && tone !== "input") nameText = style.bold(nameText);
		if (suffix) nameText += style.fg("accent", suffix);
		const detailText = toned(tone, rowDetail(row, now), style);
		const cost = row.costUsd ? `$${row.costUsd.toFixed(2)}` : "";
		const costText = wide ? ` ${padRight(style.fg(tone === "closed" || tone === "remote" ? "dim" : "muted", cost), 7)}` : "";
		const counts = countsCol ? ` ${padRight(fit(countsText(row.counts, style), countsFit), countsFit)}` : "";
		return fit(`${marker} ${glyph(row, style)} ${pad(nameText, nameW)} ${pad(detailText, detailW)}${costText}${counts}`, width);
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
		if (item.kind === "group" || item.kind === "more") {
			const g = item.group;
			const lines = [rule(oneLine(item.kind === "more" ? `closed in ${g.label}` : g.label))];
			if (item.kind === "more" || !item.special) lines.push(` ${style.fg("dim", tilde(oneLine(g.repo)))}`);
			lines.push("");
			for (const r of item.kind === "more" ? item.hidden : g.rows) lines.push(` ${glyph(r, style)} ${oneLine(r.name)}  ${style.fg("dim", rowDetail(r, this.now()))}`);
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
				lines.push(style.fg("dim", " ⏎ resume it in the deck · C-l read the transcript"));
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
		const turns = kind === "closed" || kind === "crashed" ? this.conversations.get(row.id) : undefined;
		if (turns?.length) {
			// The end of the conversation under the card (deck-pager.ts previewLines).
			lines.push("", rule("transcript"));
			lines.push(...previewLines(turns, width, Math.max(0, height - lines.length), style));
			return lines;
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

/** The row palette (sessions-view ANSI_FG) in tmux styles: needs input orange, done green, error red. */
const BAR_STYLE: Record<string, string> = { question: "#[fg=colour208,bold]", waiting: "#[fg=colour78]", error: "#[fg=colour196]" };

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

/** §16: the pane option marking a deck-opened agent view (its subagent path) on the main's pi pane. */
export const AGENTS_VIEW_OPTION = "@pi_fleet_agents_view";
/** How long the list waits for agents-view (the pi waits ≤ 1 s for the view itself). */
export const AGENTS_VIEW_REPLY_MS = 2500;

/** DeckOps against the deck server; every slot change goes through the list's serial queue. */
export function tmuxOps(env: NodeJS.ProcessEnv, list: Pick<DeckList, "serial">, opts: { flash?: (message: string) => void } = {}): DeckOps & { close(): Promise<void> } {
	let holder: { tty: string; fh: FileHandle } | undefined;
	let holderTty: string | undefined;
	const tails = new TranscriptTails();
	const conversations = new ConversationTails();
	/** A session's control socket (its status file's, else the default path). */
	const controlSock = (id: string) => readStatus(id, env)?.status.ctlSock || ctlSockPath(id, env);
	/** The holder was respawned (pager in or out): it has a new tty. */
	const holderRespawned = async () => {
		await holder?.fh.close().catch(() => {});
		holder = undefined;
		holderTty = undefined;
	};
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
		if ("session" in target) {
			const pi = sessionPiPane(panes, target.session);
			if (!pi || pi.gone) return false;
			// Its pi in the pi slot, its nvim (created on the first show) in the nvim slot: one swap call.
			const r = await showSessionDetail(target.session, { panes }, env);
			if (r.nvimError) opts.flash?.(`pi-fleet: no nvim: ${r.nvimError}`);
			if (r.termError) opts.flash?.(`pi-fleet: no terminal: ${r.termError}`);
			return true;
		}
		const holder = panes.find((p) => p.role === "preview" && !p.gone)?.pane ?? (await ensureHolder(env));
		const nvimHolder = panes.find((p) => p.role === "nvim-holder" && !p.gone)?.pane ?? (await ensureNvimHolder(env));
		const termHolder = panes.find((p) => p.role === "term-holder" && !p.gone)?.pane ?? (await ensureTermHolder(env));
		const args = slotArgs(panes, { pi: holder, nvim: nvimHolder, term: termHolder });
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
		async killDeck() {
			const r = await killDeck({}, env);
			return { killedServer: r.killedServer, nvims: r.nvims.map((n) => ({ session: n.session, cwd: n.cwd })) };
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
		conversation(file) {
			return conversations.get(file);
		},
		openPager(req) {
			return list.serial(async () => {
				await openPagerPane(req, ansiStyle, env);
				await holderRespawned();
			});
		},
		closePager() {
			return list.serial(async () => {
				if (await closePagerPane(env)) await holderRespawned();
			});
		},
		pagerExit() {
			return readPagerExit(env);
		},
		async focusSlot() {
			await focusSlot(env);
		},
		async agentsView(id, path) {
			const pi = sessionPiPane(await deckPanes(env), id);
			if (!pi || pi.gone) return { ok: false, error: "no pane" };
			// Deck-opened (§16); the deck config's after-select-pane hook clears it once the user focuses that pi.
			await deckTmux(["set-option", "-p", "-t", pi.pane, AGENTS_VIEW_OPTION, path], env);
			let reply: { ok?: boolean; error?: string } = {};
			try {
				reply = JSON.parse(await sendControl(controlSock(id), { type: "agents-view", path }, AGENTS_VIEW_REPLY_MS));
			} catch (error) {
				reply = { ok: false, error: (error as Error).message };
			}
			if (reply.ok === true) return { ok: true };
			await deckTmux(["set-option", "-pu", "-t", pi.pane, AGENTS_VIEW_OPTION], env).catch(() => "");
			return { ok: false, error: reply.error ?? "agents-view failed" };
		},
		async agentsClose(id) {
			const pi = sessionPiPane(await deckPanes(env), id);
			if (!pi || pi.gone) return;
			const mark = await deckTmux(["show-options", "-pqv", "-t", pi.pane, AGENTS_VIEW_OPTION], env).catch(() => "");
			// Unmarked: the user focused that pi since (the view is theirs now), or nothing was opened.
			if (!mark) return;
			await deckTmux(["set-option", "-pu", "-t", pi.pane, AGENTS_VIEW_OPTION], env).catch(() => "");
			await sendControl(controlSock(id), { type: "agents-close" }, AGENTS_VIEW_REPLY_MS).catch(() => "");
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
		// A transcript pager that ended signals like pane-died (deck-pager.ts PAGER_SH).
		if (what === "reconcile") await view.checkPager();
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
	const ops = tmuxOps(env, list, { flash: (message) => view?.flash(message) });
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
	// C-d kills the server under this list: its tty goes away mid-write, which is no error worth a trace.
	process.stdout.on("error", () => {});
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
	// A pager left by the previous list (a restart) gives the holder back.
	await ops.closePager().catch(() => {});
	// Agent views a previous list opened and nobody took over (a restart, /reload): close them (§16;
	// agentsClose acts only on a pi still marked @pi_fleet_agents_view).
	for (const p of panes) if (p.role === "pi" && p.session && !p.gone) void ops.agentsClose(p.session).catch(() => {});
	view.scheduleApply(0);
	tui.requestRender();
	const code = await finished;
	process.off("SIGTERM", quit);
	process.off("SIGHUP", quit);
	view.dispose();
	await controller.stop();
	await ops.close();
	await removePagerFiles(env);
	await list.close();
	tui.stop();
	process.stdout.write("\x1b[?1049l");
	return code;
}
