/**
 * fleet/registry: what pi-fleet knows about sessions on disk.
 *
 * Phase 1 (this file so far): the subagent fold and session classification.
 *   - RegistryFold folds pi-subagent-manager's `pi-subagent:registry:v1` (full) and
 *     `pi-subagent:registry-delta:v1` (changes) entries into per-thread states, incrementally.
 *     Deltas DO carry state changes: a change is either `{thread}` (full record) or
 *     `{path, view, cleared?}` where `view` is any changed subset of the thread view, including
 *     `state` (pi-subagent-manager 1.7.1 src/orch/registry.ts, RegistryWriter.threadChange).
 *   - countSubagents() maps thread states to the status file's `subagents` counts.
 *   - isSubagentSession() recognises a subagent pi (skipped by status.ts).
 *   - markInterrupted(): after a crash + resume, threads the dead process left starting/running
 *     are not running. pi-subagent-manager marks them paused in memory only (nothing persisted),
 *     so status.ts calls this once at session_start; later deltas still override.
 *
 * Phase 4: the session index (§6), SessionIndex below.
 *   - scan() lists `<sessions dir>/*\/*.jsonl` and classifies each file from its first 16 KB
 *     (classifyHead): id, cwd, parentSession, name, first user message, and whether it is a
 *     subagent (thread entry, or `parentSession` + a `<type> /<path>` name) or a main (forks are
 *     mains). Results are cached by (path, size, mtime) in `<cache dir>/index.json`.
 *   - detail() folds a whole file (sessionDetail): current name, subagent threads (the same
 *     RegistryFold over the active branch), last assistant text. Cached the same way.
 *   - repoOf(cwd): `git -C cwd rev-parse --show-toplevel`, else cwd; cached per cwd.
 *   The sessions dir is $PI_CODING_AGENT_SESSION_DIR, else $PI_CODING_AGENT_DIR/sessions, else
 *   ~/.pi/agent/sessions; the cache dir is $PI_FLEET_CACHE_DIR, else $XDG_CACHE_HOME/pi-fleet,
 *   else ~/.cache/pi-fleet. Readers merge live status files over this (sessions-view.ts).
 *
 * The registry format is private to pi-subagent-manager. The fold never throws: unknown or
 * malformed entries set `formatError` and unknown states count as `unknown` ("?" in the UI).
 *
 * Only node: imports at runtime (pi types are type-only), so node can import it directly in
 * tests and the CLI.
 */

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REGISTRY_ENTRY = "pi-subagent:registry:v1";
export const REGISTRY_DELTA_ENTRY = "pi-subagent:registry-delta:v1";
export const THREAD_ENTRY = "pi-subagent:thread:v1";

/** pi-subagent-manager ThreadState (src/types.ts). */
export const THREAD_STATES = ["starting", "running", "paused", "completed", "failed", "stopped"];

/** The subset of a session entry the fold reads. */
export interface EntryLike {
	type: string;
	id?: string;
	parentId?: string | null;
	customType?: string;
	data?: unknown;
	[key: string]: unknown;
}

export interface FoldedThread {
	path: string;
	type?: string;
	state: string;
	task?: string;
	updatedAt?: number;
}

export interface SubagentCounts {
	working: number;
	waiting: number;
	done: number;
	error: number;
	/** Not live (the reader folded a JSONL of a session that is not running): starting/running threads. */
	interrupted?: number;
	/** Threads whose state this version does not know. */
	unknown?: number;
}

function isObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function threadFrom(record: unknown): FoldedThread | undefined {
	if (!isObject(record) || !isObject(record.view)) return undefined;
	const view = record.view;
	if (typeof view.path !== "string") return undefined;
	return {
		path: view.path,
		type: typeof view.type === "string" ? view.type : undefined,
		state: typeof view.state === "string" ? view.state : "?",
		task: typeof view.task === "string" ? view.task : undefined,
		updatedAt: typeof view.updatedAt === "number" ? view.updatedAt : undefined,
	};
}

/**
 * Incremental fold over the current branch (`ctx.sessionManager.getBranch()`). Registry entries
 * are branch-scoped, so a branch (not `getEntries()`) is the right input: entries of an
 * abandoned `/tree` branch must not apply. If the branch still starts with what was folded last
 * time, only the new tail is applied; otherwise it refolds from scratch.
 */
export class RegistryFold {
	threads = new Map<string, FoldedThread>();
	rootSessionId: string | undefined;
	formatError = false;
	private foldedCount = 0;
	private lastId: string | undefined;
	/** Ids of the registry entries applied in the current fold, in order. */
	private registryIds: string[] = [];
	/** Ids of the registry entries folded when markInterrupted() was called. */
	private interruptedIds: Set<string> | undefined;
	/** Refolding: pause live threads before the first registry entry not in interruptedIds. */
	private pausePending = false;

	reset(): void {
		this.refold();
		this.interruptedIds = undefined;
		this.pausePending = false;
	}

	private refold(): void {
		this.threads = new Map();
		this.rootSessionId = undefined;
		this.formatError = false;
		this.foldedCount = 0;
		this.lastId = undefined;
		this.registryIds = [];
	}

	update(branch: readonly EntryLike[]): this {
		const prefixKept =
			this.foldedCount > 0 &&
			branch.length >= this.foldedCount &&
			branch[this.foldedCount - 1]?.id === this.lastId;
		if (!prefixKept) {
			this.refold();
			// The pre-interruption registry entries are a prefix of the registry entries of any
			// branch (an entry's ancestors are older), so re-pause where the branch leaves them.
			this.pausePending = this.interruptedIds !== undefined;
		}
		for (let i = this.foldedCount; i < branch.length; i++) this.apply(branch[i]!);
		if (this.pausePending) this.pauseLive();
		this.foldedCount = branch.length;
		this.lastId = branch.at(-1)?.id;
		return this;
	}

	/**
	 * The process that ran the threads folded so far is gone: their starting/running threads
	 * are `paused` (what pi-subagent-manager shows after a resume). Deltas folded later still
	 * override, and the mark survives a refold (e.g. /tree) until reset().
	 */
	markInterrupted(): this {
		this.interruptedIds = new Set(this.registryIds);
		this.pausePending = false;
		this.pauseLive();
		return this;
	}

	private pauseLive(): void {
		this.pausePending = false;
		for (const [path, thread] of this.threads) {
			if (thread.state === "starting" || thread.state === "running") this.threads.set(path, { ...thread, state: "paused" });
		}
	}

	private apply(entry: EntryLike): void {
		if (entry.type !== "custom") return;
		if (entry.customType !== REGISTRY_ENTRY && entry.customType !== REGISTRY_DELTA_ENTRY) return;
		const id = typeof entry.id === "string" ? entry.id : "";
		if (this.pausePending && !this.interruptedIds?.has(id)) this.pauseLive();
		this.registryIds.push(id);
		if (entry.customType === REGISTRY_ENTRY) {
			const data = entry.data;
			if (!isObject(data) || data.version !== 1 || !Array.isArray(data.threads)) {
				this.formatError = true;
				return;
			}
			const threads = new Map<string, FoldedThread>();
			for (const record of data.threads) {
				const thread = threadFrom(record);
				if (thread) threads.set(thread.path, thread);
				else this.formatError = true;
			}
			this.threads = threads;
			this.rootSessionId = typeof data.rootSessionId === "string" ? data.rootSessionId : undefined;
		} else if (entry.customType === REGISTRY_DELTA_ENTRY) {
			const data = entry.data;
			if (!isObject(data) || data.version !== 1 || !Array.isArray(data.changes)) {
				this.formatError = true;
				return;
			}
			// A delta for another root belongs to a registry we did not see (pi rejects it too).
			if (this.rootSessionId !== undefined && data.rootSessionId !== this.rootSessionId) {
				this.formatError = true;
				return;
			}
			for (const change of data.changes) {
				if (!isObject(change)) {
					this.formatError = true;
					continue;
				}
				if ("thread" in change) {
					const thread = threadFrom(change.thread);
					if (thread) this.threads.set(thread.path, thread);
					else this.formatError = true;
					continue;
				}
				const current = typeof change.path === "string" ? this.threads.get(change.path) : undefined;
				if (!current || !isObject(change.view)) {
					this.formatError = true;
					continue;
				}
				const next = { ...current };
				const view = change.view;
				if (typeof view.state === "string") next.state = view.state;
				if (typeof view.type === "string") next.type = view.type;
				if (typeof view.task === "string") next.task = view.task;
				if (typeof view.updatedAt === "number") next.updatedAt = view.updatedAt;
				this.threads.set(current.path, next);
			}
		}
	}

	counts(live = true): SubagentCounts {
		return countSubagents(this.threads.values(), live);
	}
}

/** starting/running→working, paused→waiting, completed/stopped→done, failed→error (§5). */
export function countSubagents(threads: Iterable<FoldedThread>, live = true): SubagentCounts {
	const counts: SubagentCounts = { working: 0, waiting: 0, done: 0, error: 0 };
	for (const { state } of threads) {
		if (state === "starting" || state === "running") {
			if (live) counts.working++;
			else counts.interrupted = (counts.interrupted ?? 0) + 1;
		} else if (state === "paused") counts.waiting++;
		else if (state === "completed" || state === "stopped") counts.done++;
		else if (state === "failed") counts.error++;
		else counts.unknown = (counts.unknown ?? 0) + 1;
	}
	return counts;
}

/** The active branch of a parsed JSONL file: the chain from the last entry back to the root. */
export function branchOf(entries: readonly EntryLike[]): EntryLike[] {
	const byId = new Map<string, EntryLike>();
	for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
	const branch: EntryLike[] = [];
	let entry: EntryLike | undefined = [...entries].reverse().find((e) => typeof e.id === "string");
	const seen = new Set<string>();
	while (entry && typeof entry.id === "string" && !seen.has(entry.id)) {
		seen.add(entry.id);
		branch.push(entry);
		entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined;
	}
	return branch.reverse();
}

/** Parse JSONL text, skipping lines that are not JSON (e.g. a partial last line on NFS). */
export function parseJsonl(text: string): EntryLike[] {
	const entries: EntryLike[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (isObject(value) && typeof value.type === "string") entries.push(value as EntryLike);
		} catch {
			// skip
		}
	}
	return entries;
}

/** The subset of SessionManager that isSubagentSession() reads. */
export interface SessionLike {
	getHeader(): { parentSession?: string } | null | undefined;
	getEntries(): readonly EntryLike[];
	getSessionName?(): string | undefined;
}

/** `session_info` name pi-subagent-manager gives its children: `<type> /<path>`. */
const SUBAGENT_NAME = /^\S+ \/\S*$/;

/**
 * A subagent pi has a `pi-subagent:thread:v1` entry, or `parentSession` plus a subagent-style
 * name (§5, §6). A fork has `parentSession` but neither, and counts as a main session.
 */
export function isSubagentSession(session: SessionLike): boolean {
	const entries = session.getEntries();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === THREAD_ENTRY) return true;
	}
	if (!session.getHeader()?.parentSession) return false;
	let name = session.getSessionName?.();
	if (name === undefined) {
		for (const entry of entries) {
			if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
		}
	}
	return typeof name === "string" && SUBAGENT_NAME.test(name);
}

// ---------------------------------------------------------------- session index (§6)

export const HEAD_BYTES = 16 * 1024;
const INDEX_VERSION = 1;
const TASK_CHARS = 200;
const LAST_ASSISTANT_CHARS = 2000;

export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR;
	return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_FLEET_CACHE_DIR) return env.PI_FLEET_CACHE_DIR;
	return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-fleet");
}

/** What the first 16 KB of a session file tell. */
export interface SessionHead {
	id?: string;
	cwd?: string;
	parentSession?: string;
	/** Header timestamp (creation), ms. */
	created?: number;
	name?: string;
	firstMessage?: string;
	subagent: boolean;
	/** Thread entry of a subagent: the main session id and the thread path. */
	rootId?: string;
	threadPath?: string;
}

/** What a whole session file tells. */
export interface SessionDetail {
	name?: string;
	threads: FoldedThread[];
	formatError: boolean;
	lastAssistant?: string;
}

export interface IndexEntry extends SessionHead {
	path: string;
	size: number;
	mtimeMs: number;
	detail?: SessionDetail & { size: number; mtimeMs: number };
}

function textOf(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts = content.filter((c) => isObject(c) && c.type === "text" && typeof c.text === "string").map((c) => c.text as string);
	return parts.length ? parts.join("\n") : undefined;
}

function oneLine(text: string, max: number): string {
	// Whitespace and C0/C1 control characters (ESC included) become one space.
	const s = text.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Classify a session from the start of its file (§6). `complete` says the text is the whole
 * file; otherwise the last (possibly cut) line is ignored.
 */
export function classifyHead(text: string, complete = false): SessionHead {
	const lines = text.split("\n");
	if (!complete) lines.pop();
	const entries = parseJsonl(lines.join("\n"));
	const header = entries[0]?.type === "session" ? entries[0] : undefined;
	const head: SessionHead = { subagent: false };
	if (header) {
		if (typeof header.id === "string") head.id = header.id;
		if (typeof header.cwd === "string") head.cwd = header.cwd;
		if (typeof header.parentSession === "string") head.parentSession = header.parentSession;
		const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
		if (Number.isFinite(created)) head.created = created;
	}
	for (const entry of entries) {
		if (entry.type === "session_info" && typeof entry.name === "string") head.name = entry.name;
		else if (entry.type === "custom" && entry.customType === THREAD_ENTRY && isObject(entry.data)) {
			if (typeof entry.data.rootId === "string") head.rootId = entry.data.rootId;
			if (typeof entry.data.threadPath === "string") head.threadPath = entry.data.threadPath;
		} else if (head.firstMessage === undefined && entry.type === "message" && isObject(entry.message) && entry.message.role === "user") {
			const text = textOf(entry.message.content);
			if (text?.trim()) head.firstMessage = oneLine(text, 120);
		}
	}
	head.subagent = isSubagentSession({
		getHeader: () => (head.parentSession ? { parentSession: head.parentSession } : {}),
		getEntries: () => entries,
		getSessionName: () => head.name,
	});
	return head;
}

/** Fold a whole session file: name, subagent threads of the active branch, last assistant text. */
export function sessionDetail(text: string): SessionDetail {
	const entries = parseJsonl(text);
	const branch = branchOf(entries);
	const fold = new RegistryFold().update(branch);
	let name: string | undefined;
	for (const entry of entries) if (entry.type === "session_info" && typeof entry.name === "string") name = entry.name;
	let lastAssistant: string | undefined;
	for (let i = branch.length - 1; i >= 0 && lastAssistant === undefined; i--) {
		const entry = branch[i]!;
		if (entry.type !== "message" || !isObject(entry.message) || entry.message.role !== "assistant") continue;
		const text = textOf(entry.message.content)?.trim();
		if (text) lastAssistant = text.length > LAST_ASSISTANT_CHARS ? `…${text.slice(-LAST_ASSISTANT_CHARS)}` : text;
	}
	const threads = [...fold.threads.values()].map((t) => (t.task && t.task.length > TASK_CHARS ? { ...t, task: oneLine(t.task, TASK_CHARS) } : t));
	return { name, threads, formatError: fold.formatError, lastAssistant };
}

function readHead(path: string): { text: string; complete: boolean } {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(HEAD_BYTES);
		const n = readSync(fd, buf, 0, buf.length, 0);
		return { text: buf.subarray(0, n).toString("utf8"), complete: n < HEAD_BYTES };
	} finally {
		closeSync(fd);
	}
}

const FIRST_MESSAGE_BYTES = 1024 * 1024;

/** The first user message within the first 1 MB of a session file. */
function firstUserMessage(path: string): string | undefined {
	let text: string;
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(FIRST_MESSAGE_BYTES);
		const n = readSync(fd, buf, 0, buf.length, 0);
		text = buf.subarray(0, n).toString("utf8");
	} finally {
		closeSync(fd);
	}
	for (const line of text.split("\n")) {
		if (!line.includes('"user"')) continue;
		const [entry] = parseJsonl(line);
		if (entry?.type !== "message" || !isObject(entry.message) || entry.message.role !== "user") continue;
		const t = textOf(entry.message.content);
		if (t?.trim()) return oneLine(t, 120);
	}
	return undefined;
}

interface IndexFile {
	v: number;
	files: Record<string, IndexEntry>;
	repos: Record<string, string>;
}

/** save() writes at most this often unless a detail changed. */
export const SAVE_INTERVAL_MS = 30_000;

const HEAD_FIELDS = ["id", "cwd", "parentSession", "created", "name", "firstMessage", "subagent", "rootId", "threadPath"] as const;

function sameHead(a: SessionHead, b: SessionHead): boolean {
	return HEAD_FIELDS.every((k) => a[k] === b[k]);
}

/**
 * The session index of one process (the dashboard, or one /sessions picker). scan() is cheap
 * when nothing changed: one readdir per project dir and one stat per file.
 */
export class SessionIndex {
	readonly root: string;
	readonly cachePath: string;
	private files = new Map<string, IndexEntry>();
	private repos = new Map<string, string>();
	/** Something worth writing changed (new or vanished files, head fields, repos). */
	private dirty = false;
	/** A detail changed: written by the next save() regardless of the interval. */
	private detailDirty = false;
	private lastSave = 0;
	private env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.env = env;
		this.root = sessionsRoot(env);
		this.cachePath = join(cacheDir(env), "index.json");
		try {
			const cached = JSON.parse(readFileSync(this.cachePath, "utf8")) as IndexFile;
			if (cached?.v === INDEX_VERSION) {
				for (const [path, entry] of Object.entries(cached.files ?? {})) this.files.set(path, entry);
				for (const [cwd, repo] of Object.entries(cached.repos ?? {})) this.repos.set(cwd, repo);
			}
		} catch {
			// no or unreadable cache: rebuild
		}
	}

	/** All session files, classified. Files that vanished are dropped. */
	scan(): IndexEntry[] {
		const seen = new Set<string>();
		let dirs: string[];
		try {
			dirs = readdirSync(this.root);
		} catch {
			dirs = [];
		}
		for (const dir of dirs) {
			let names: string[];
			try {
				names = readdirSync(join(this.root, dir));
			} catch {
				continue;
			}
			for (const name of names) {
				if (!name.endsWith(".jsonl")) continue;
				const path = join(this.root, dir, name);
				let st;
				try {
					st = statSync(path);
				} catch {
					continue;
				}
				if (!st.isFile()) continue;
				seen.add(path);
				const cached = this.files.get(path);
				if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) continue;
				let head: SessionHead;
				try {
					const { text, complete } = readHead(path);
					head = classifyHead(text, complete);
				} catch {
					continue;
				}
				// The first user message can sit behind a large system entry: look further, once.
				if (!head.firstMessage) head.firstMessage = cached?.firstMessage ?? (st.size > HEAD_BYTES ? firstUserMessage(path) : undefined);
				// Keep the old detail: detail() refreshes it when asked, by its own size/mtime.
				this.files.set(path, { ...head, path, size: st.size, mtimeMs: st.mtimeMs, detail: cached?.detail });
				// A file that only grew is not worth a write: the next scan re-reads its head anyway.
				if (!cached || !sameHead(cached, head)) this.dirty = true;
			}
		}
		for (const path of [...this.files.keys()]) {
			if (!seen.has(path)) {
				this.files.delete(path);
				this.dirty = true;
			}
		}
		return [...this.files.values()];
	}

	get(path: string): IndexEntry | undefined {
		return this.files.get(path);
	}

	/**
	 * The folded detail of a scanned file, recomputed only when its size or mtime changed.
	 * `settleMs`: a file written to within that long keeps its existing detail (a session being
	 * written without a status file is not re-folded on every scan); refolded once it settles.
	 */
	detail(entry: IndexEntry, opts: { settleMs?: number; now?: number } = {}): SessionDetail | undefined {
		const current = this.files.get(entry.path) ?? entry;
		const d = current.detail;
		if (d && d.size === current.size && d.mtimeMs === current.mtimeMs) return d;
		if (d && opts.settleMs && (opts.now ?? Date.now()) - current.mtimeMs < opts.settleMs) return d;
		let text: string;
		try {
			text = readFileSync(current.path, "utf8");
		} catch {
			return d;
		}
		current.detail = { ...sessionDetail(text), size: current.size, mtimeMs: current.mtimeMs };
		this.files.set(current.path, current);
		this.detailDirty = true;
		return current.detail;
	}

	/**
	 * `git rev-parse --show-toplevel` of cwd, else cwd. Cached per cwd; the cwd fallback only
	 * when git said "not a repo" (exited non-zero), not on a timeout, signal or missing git/cwd.
	 */
	repoOf(cwd: string): string {
		const cached = this.repos.get(cwd);
		if (cached !== undefined) return cached;
		if (!existsSync(cwd)) return cwd;
		let repo: string;
		try {
			repo =
				execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
					encoding: "utf8",
					timeout: 3000,
					stdio: ["ignore", "pipe", "ignore"],
					env: this.env,
				}).trim() || cwd;
		} catch (error) {
			// Not a repo: cache that. Timed out, killed, or no git: try again next time.
			if (typeof (error as { status?: unknown }).status !== "number") return cwd;
			repo = cwd;
		}
		this.repos.set(cwd, repo);
		this.dirty = true;
		return repo;
	}

	/**
	 * Write the cache (atomically, 0600 in a 0700 dir) if anything changed: at once if a detail
	 * changed, else at most every SAVE_INTERVAL_MS. Never throws.
	 */
	save(now: number = Date.now()): void {
		if (!this.detailDirty && (!this.dirty || now - this.lastSave < SAVE_INTERVAL_MS)) return;
		try {
			mkdirSync(cacheDir(this.env), { recursive: true, mode: 0o700 });
			const data: IndexFile = { v: INDEX_VERSION, files: Object.fromEntries(this.files), repos: Object.fromEntries(this.repos) };
			const tmp = `${this.cachePath}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
			renameSync(tmp, this.cachePath);
			this.dirty = false;
			this.detailDirty = false;
			this.lastSave = now;
		} catch {
			// a cache only
		}
	}
}

export function register(_pi: ExtensionAPI): void {
	// Nothing to register: status.ts uses the fold, sessions-view.ts and the CLI the index.
}
