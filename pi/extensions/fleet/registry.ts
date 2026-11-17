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
 * Phase 4 adds the session index scan (`~/.pi/agent/sessions/*\/*.jsonl`, §6) here.
 *
 * The registry format is private to pi-subagent-manager. The fold never throws: unknown or
 * malformed entries set `formatError` and unknown states count as `unknown` ("?" in the UI).
 *
 * Pure module (type-only imports) so node can import it directly in tests and the CLI.
 */

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

	reset(): void {
		this.threads = new Map();
		this.rootSessionId = undefined;
		this.formatError = false;
		this.foldedCount = 0;
		this.lastId = undefined;
	}

	update(branch: readonly EntryLike[]): this {
		const prefixKept =
			this.foldedCount > 0 &&
			branch.length >= this.foldedCount &&
			branch[this.foldedCount - 1]?.id === this.lastId;
		if (!prefixKept) this.reset();
		for (let i = this.foldedCount; i < branch.length; i++) this.apply(branch[i]!);
		this.foldedCount = branch.length;
		this.lastId = branch.at(-1)?.id;
		return this;
	}

	private apply(entry: EntryLike): void {
		if (entry.type !== "custom") return;
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

export function register(_pi: ExtensionAPI): void {
	// Phase 4: session index scan. The fold above is used by status.ts.
}
