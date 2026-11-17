/**
 * fleet/files: file candidates for /view and the leader keys (design §11, §12; phase 6).
 *
 * Two tiers, ranked separately (tier 1 always wins):
 *   1. files touched in this session: read/edit/write tool calls (successful ones, seeded from
 *      the session branch on session_start) and the user's saves from the paired nvim
 *      (USER_EDIT_EVENT), most recent first;
 *   2. the repo: `git ls-files --cached` (tracked files first) then, with what is left of the
 *      cap and a short timeout, `git ls-files --others --exclude-standard`, in the session cwd;
 *      outside a git repo `fd -t f`, then `rg --files`; capped at 50k paths. Cached per cwd for 30 s,
 *      marked stale on agent_settled, and refreshed in the background (stale results are served
 *      meanwhile), so a lookup never waits for the listing longer than its caller allows.
 *
 * The ranker (rankTiers) is a pure function over pre-lowercased paths; it keeps only the top
 * `limit` per tier, so 50k paths rank in a few ms. grep() runs `rg --vimgrep` for `Space f s`.
 *
 * Per-session state lives in a WeakMap keyed by the `pi` object (as shared.ts does), never in
 * module globals: subagents load this extension in the same process with their own `pi`.
 * Tracking only runs when fleetOf(pi).main is true.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { toolPath, USER_EDIT_EVENT } from "./nvim.ts";
import { fleetOf } from "./shared.ts";

export const REPO_CAP = 50_000;
export const REPO_TTL_MS = 30_000;
const LIST_TIMEOUT_MS = 15_000;
const UNTRACKED_TIMEOUT_MS = 3_000;
const TOUCHED_CAP = 500;

// ---------------------------------------------------------------- ranking (pure)

/**
 * A list of candidate paths with their lowercase forms and basename offsets (computed once per
 * listing). `memo` caches the matches of the last query, so typing more narrows that set
 * instead of rescanning every path.
 */
export interface PathList {
	paths: string[];
	lower: string[];
	base: Int32Array;
	memo?: { tokens: string[]; idx: Int32Array };
}

export function pathList(paths: string[]): PathList {
	const lower = paths.map((p) => p.toLowerCase());
	const base = new Int32Array(lower.length);
	for (let i = 0; i < lower.length; i++) base[i] = lower[i].lastIndexOf("/") + 1;
	return { paths, lower, base };
}

/** True if every path matching `next` also matches `prev` (each old token a prefix of a new one). */
function narrows(prev: string[], next: string[]): boolean {
	if (!prev.length || prev.length > next.length) return false;
	for (let i = 0; i < prev.length; i++) {
		if (i < prev.length - 1 ? next[i] !== prev[i] : !next[i].startsWith(prev[i])) return false;
	}
	return true;
}

const MEMO_MIN = 1000;

export interface Ranked {
	path: string;
	/** 0-based index of the tier the path came from. */
	tier: number;
	score: number;
}

function isBoundary(code: number): boolean {
	// space - _ . / :
	return code === 32 || code === 45 || code === 95 || code === 46 || code === 47 || code === 58;
}

/** pi-tui's fuzzy scoring (lower is better), without regexes; `pos` are indices into `s`. */
function scorePositions(s: string, pos: Int32Array, n: number, from: number): number {
	let score = 0;
	let last = -1;
	let run = 0;
	for (let k = 0; k < n; k++) {
		const i = pos[k];
		if (last === i - 1) {
			run++;
			score -= run * 5;
		} else {
			run = 0;
			if (last >= 0) score += (i - last - 1) * 2;
		}
		if (i === from || isBoundary(s.charCodeAt(i - 1))) score -= 10;
		score += (i - from) * 0.1;
		last = i;
	}
	return score;
}

/** Score `q` (lowercase) as a subsequence of s[from..]; undefined if it does not match. */
function matchFrom(q: string, s: string, from: number, pos: Int32Array): number | undefined {
	const n = q.length;
	if (n === 0) return 0;
	if (n > s.length - from) return undefined;
	let at = from - 1;
	for (let k = 0; k < n; k++) {
		at = s.indexOf(q[k], at + 1);
		if (at < 0) return undefined;
		pos[k] = at;
	}
	let best = scorePositions(s, pos, n, from);
	// A contiguous occurrence may score better than the greedy alignment.
	for (let start = s.indexOf(q, from); start >= 0; start = s.indexOf(q, start + 1)) {
		for (let k = 0; k < n; k++) pos[k] = start + k;
		best = Math.min(best, scorePositions(s, pos, n, from));
	}
	if (from === 0 ? s === q : s.length - from === n) best -= 100;
	return best;
}

const BASENAME_BONUS = 40;

/**
 * Score one lowercase path against lowercase query tokens (all must match). A token without
 * `/` that matches inside the basename scores against the basename only, with a bonus, so
 * `view` prefers `fleet/view.ts` over `docs/overview/x.md`; other tokens score against the
 * full path. Undefined when a token does not match.
 */
export function scorePath(tokens: string[], s: string, pos: Int32Array = new Int32Array(256), base = s.lastIndexOf("/") + 1): number | undefined {
	let total = 0;
	for (const t of tokens) if (t.length > pos.length) pos = new Int32Array(t.length);
	for (const t of tokens) {
		let best: number | undefined;
		if (!t.includes("/")) {
			const b = matchFrom(t, s, base, pos);
			if (b !== undefined) best = b - BASENAME_BONUS;
		}
		if (best === undefined) {
			const f = matchFrom(t, s, 0, pos);
			if (f === undefined) return undefined;
			best = f;
		}
		total += best;
	}
	return total;
}

export function queryTokens(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The best `limit` paths of each tier for `query`, tier by tier (tier 1 first), skipping
 * paths already listed by an earlier tier. Ties go to the shorter path, then the earlier one
 * (MRU order in the touched tier). An empty query keeps each tier's own order.
 */
export function rankTiers(query: string, tiers: PathList[], limit = 20): Ranked[] {
	const tokens = queryTokens(query);
	const seen = new Set<string>();
	const out: Ranked[] = [];
	let pos = new Int32Array(256);
	for (const t of tokens) if (t.length > pos.length) pos = new Int32Array(t.length);
	for (let t = 0; t < tiers.length && out.length < limit; t++) {
		const { paths, lower } = tiers[t];
		const want = limit - out.length;
		if (!tokens.length) {
			for (let i = 0; i < paths.length && out.length < limit; i++) {
				if (seen.has(paths[i])) continue;
				out.push({ path: paths[i], tier: t, score: 0 });
			}
			if (t < tiers.length - 1) for (const p of paths) seen.add(p);
			continue;
		}
		// Only the previous query's matches can match a narrower one.
		const memo = tiers[t].memo;
		const from = memo && narrows(memo.tokens, tokens) ? memo.idx : undefined;
		const count = from ? from.length : lower.length;
		const matched = new Int32Array(count);
		let nMatched = 0;
		// Bounded top-k by (score, length, index), kept sorted; worst at the end.
		const top: { i: number; score: number; len: number }[] = [];
		for (let k = 0; k < count; k++) {
			const i = from ? from[k] : k;
			const score = scorePath(tokens, lower[i], pos, tiers[t].base[i]);
			if (score === undefined) continue;
			matched[nMatched++] = i;
			const len = lower[i].length;
			if (top.length >= want) {
				const worst = top[top.length - 1];
				if (score > worst.score || (score === worst.score && len >= worst.len)) continue;
			}
			if (seen.size && seen.has(paths[i])) continue;
			let j = top.length;
			while (j > 0 && (top[j - 1].score > score || (top[j - 1].score === score && top[j - 1].len > len))) j--;
			top.splice(j, 0, { i, score, len });
			if (top.length > want) top.pop();
		}
		if (lower.length >= MEMO_MIN) tiers[t].memo = { tokens, idx: matched.slice(0, nMatched) };
		for (const r of top) out.push({ path: paths[r.i], tier: t, score: r.score });
		if (t < tiers.length - 1) for (const p of paths) seen.add(p);
	}
	return out;
}

/**
 * Text safe to show in the TUI: C0/C1 control characters (ESC, CR, …) in file names or grep
 * hits must not reach the terminal. Tabs become spaces, the rest `?`.
 */
export function displayText(s: string): string {
	return s.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => (c === "\t" ? " " : "?"));
}

/** `path`, `path:LINE` or `path:LINE:COL` → path and 1-based line. */
export function parseTarget(arg: string): { path: string; line?: number } {
	const s = arg.trim();
	const m = /^(.*?):(\d+)(?::\d+)?$/.exec(s);
	if (m && m[1]) return { path: m[1], line: Math.max(1, Number.parseInt(m[2], 10)) };
	return { path: s };
}

/** How a path is shown and completed: relative to cwd inside it, ~/… under home, else absolute. */
export function displayPath(abs: string, cwd: string): string {
	if (abs === cwd) return ".";
	if (abs.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)) return relative(cwd, abs);
	const home = homedir();
	if (abs.startsWith(home + sep)) return "~" + abs.slice(home.length);
	return abs;
}

/** Inverse of displayPath (also accepts @path, ~/path, absolute and relative paths). */
export function absPath(p: string, cwd: string): string {
	return toolPath(p, cwd) ?? (isAbsolute(p) ? p : resolve(cwd, p));
}

// ---------------------------------------------------------------- touched files

/** Most-recent-first list of absolute paths, capped. */
export class TouchedFiles {
	private order: string[] = [];

	touch(abs: string): void {
		const i = this.order.indexOf(abs);
		if (i >= 0) this.order.splice(i, 1);
		this.order.unshift(abs);
		if (this.order.length > TOUCHED_CAP) this.order.length = TOUCHED_CAP;
	}

	list(): readonly string[] {
		return this.order;
	}

	clear(): void {
		this.order = [];
	}
}

export const TOUCH_TOOLS = new Set(["read", "edit", "write"]);

/** Paths of successful read/edit/write calls on a session branch, oldest first. */
export function touchedFromEntries(entries: readonly any[], cwd: string): string[] {
	const calls: { id: string; path: string }[] = [];
	const failed = new Set<string>();
	const done = new Set<string>();
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const m = entry.message;
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b?.type !== "toolCall" || !TOUCH_TOOLS.has(b.name)) continue;
				const p = toolPath(b.arguments?.path, cwd);
				if (p) calls.push({ id: b.id, path: p });
			}
		} else if (m?.role === "toolResult") {
			done.add(m.toolCallId);
			if (m.isError) failed.add(m.toolCallId);
		}
	}
	return calls.filter((c) => done.has(c.id) && !failed.has(c.id)).map((c) => c.path);
}

// ---------------------------------------------------------------- repo listing

type ListStatus = "ok" | "capped" | "timeout" | "failed";

/** Run a NUL-separated lister; `failed` means it did not run or exited non-zero. */
function run0(cmd: string, args: string[], cwd: string, cap: number, timeoutMs: number): Promise<{ paths: string[]; status: ListStatus }> {
	return new Promise((resolvePromise) => {
		const out: string[] = [];
		let child;
		try {
			child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			return resolvePromise({ paths: out, status: "failed" });
		}
		let rest = "";
		let capped = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		timer.unref?.();
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d: string) => {
			if (capped) return;
			const parts = (rest + d).split("\0");
			rest = parts.pop() ?? "";
			for (const p of parts) {
				if (!p) continue;
				out.push(p);
				if (out.length >= cap) {
					capped = true;
					child.kill("SIGTERM");
					break;
				}
			}
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolvePromise({ paths: out, status: "failed" });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			// Killed by the timeout: keep what arrived.
			const status: ListStatus = capped ? "capped" : code === 0 ? "ok" : timedOut ? "timeout" : "failed";
			resolvePromise({ paths: out, status });
		});
	});
}

/**
 * Files under `cwd`, relative to it. In a git repo: tracked files first, then untracked
 * (not ignored) ones with the rest of the cap and `untrackedTimeoutMs` (on timeout the tracked
 * list stands). Outside one: fd/fdfind, else rg --files. Never throws.
 */
export async function listRepoFiles(
	cwd: string,
	cap = REPO_CAP,
	timeoutMs = LIST_TIMEOUT_MS,
	untrackedTimeoutMs = UNTRACKED_TIMEOUT_MS,
): Promise<string[]> {
	const tracked = await run0("git", ["ls-files", "-z", "--cached"], cwd, cap, timeoutMs);
	if (tracked.status !== "failed") {
		// git lists a path once per stage during a merge.
		const paths = [...new Set(tracked.paths)];
		if (tracked.status === "ok" && paths.length < cap) {
			const others = await run0("git", ["ls-files", "-z", "--others", "--exclude-standard"], cwd, cap - paths.length, untrackedTimeoutMs);
			paths.push(...others.paths);
		}
		return paths;
	}
	const listers: [string, string[]][] = [
		["fd", ["--type", "f", "--print0", "--color", "never"]],
		["fdfind", ["--type", "f", "--print0", "--color", "never"]],
		["rg", ["--files", "--null"]],
	];
	for (const [cmd, args] of listers) {
		const { paths, status } = await run0(cmd, args, cwd, cap, timeoutMs);
		// Not installed, an error exit or a timeout with nothing listed: try the next lister.
		if (status === "ok" || paths.length) return paths.map((p) => (p.startsWith("./") ? p.slice(2) : p));
	}
	return [];
}

interface RepoEntry {
	list?: PathList;
	at: number;
	stale: boolean;
	loading?: Promise<PathList>;
}

/** The repo listing per cwd: TTL + stale-while-revalidate. */
export class RepoFiles {
	private entries = new Map<string, RepoEntry>();
	private readonly lister: (cwd: string) => Promise<string[]>;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(lister: (cwd: string) => Promise<string[]> = (cwd) => listRepoFiles(cwd), ttlMs = REPO_TTL_MS, now = Date.now) {
		this.lister = lister;
		this.ttlMs = ttlMs;
		this.now = now;
	}

	/** The cached list (possibly stale) without waiting; starts a refresh when needed. */
	peek(cwd: string): PathList | undefined {
		const e = this.entries.get(cwd);
		if (!e || e.stale || this.now() - e.at > this.ttlMs) void this.refresh(cwd);
		return e?.list;
	}

	/** The list, waiting at most `maxWaitMs` for a first load (stale data is returned at once). */
	async get(cwd: string, maxWaitMs = Infinity): Promise<PathList | undefined> {
		const cached = this.peek(cwd);
		if (cached) return cached;
		const loading = this.entries.get(cwd)?.loading;
		if (!loading) return undefined;
		if (maxWaitMs === Infinity) return loading;
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<undefined>((r) => {
			timer = setTimeout(() => r(undefined), maxWaitMs);
		});
		try {
			return await Promise.race([loading, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Resolves when the running (or a new) load of `cwd` finishes. */
	refresh(cwd: string): Promise<PathList> {
		let e = this.entries.get(cwd);
		if (!e) {
			e = { at: 0, stale: true };
			this.entries.set(cwd, e);
		}
		if (e.loading) return e.loading;
		const entry = e;
		entry.loading = this.lister(cwd)
			.catch(() => [] as string[])
			.then((paths) => {
				const list = pathList(paths);
				entry.list = list;
				entry.at = this.now();
				entry.stale = false;
				return list;
			})
			.finally(() => {
				entry.loading = undefined;
			});
		return entry.loading;
	}

	invalidate(): void {
		for (const e of this.entries.values()) e.stale = true;
	}
}

// ---------------------------------------------------------------- grep

export interface GrepHit {
	path: string;
	line: number;
	col: number;
	text: string;
}

/**
 * `rg --vimgrep --smart-case PATTERN` (a regex) in `cwd`, at most `limit` hits. `--null` ends
 * each path with NUL, so a file named `a 12:30:45.txt` parses correctly.
 */
export function grep(cwd: string, pattern: string, limit = 500, timeoutMs = 10_000): Promise<GrepHit[]> {
	return new Promise((resolvePromise) => {
		const hits: GrepHit[] = [];
		let child;
		try {
			child = spawn("rg", ["--vimgrep", "--null", "--no-heading", "--color", "never", "--smart-case", "--max-columns", "300", "-e", pattern], {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			return resolvePromise(hits);
		}
		let rest = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		timer.unref?.();
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d: string) => {
			if (hits.length >= limit) return;
			const lines = (rest + d).split("\n");
			rest = lines.pop() ?? "";
			for (const l of lines) {
				const nul = l.indexOf("\0");
				if (nul <= 0) continue;
				const m = /^(\d+):(\d+):(.*)$/s.exec(l.slice(nul + 1));
				if (!m) continue;
				hits.push({ path: l.slice(0, nul), line: Number(m[1]), col: Number(m[2]), text: m[3] });
				if (hits.length >= limit) {
					child.kill("SIGTERM");
					break;
				}
			}
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolvePromise(hits);
		});
		child.on("close", () => {
			clearTimeout(timer);
			resolvePromise(hits);
		});
	});
}

// ---------------------------------------------------------------- per-session state

export interface FilesState {
	touched: TouchedFiles;
	repo: RepoFiles;
	/** cwd of the current session (set on session_start). */
	cwd: string;
}

const states = new WeakMap<object, FilesState>();

export function filesOf(pi: ExtensionAPI): FilesState {
	let s = states.get(pi);
	if (!s) {
		s = { touched: new TouchedFiles(), repo: new RepoFiles(), cwd: process.cwd() };
		states.set(pi, s);
	}
	return s;
}

/** Tier 1 (touched files, existing or not) and tier 2 (repo, possibly undefined while loading). */
export function tiersFor(state: FilesState, cwd: string, scope: "all" | "git" | "session"): { touched?: PathList; repo?: PathList } {
	const touched = scope === "git" ? undefined : pathList(state.touched.list().map((p) => displayPath(p, cwd)));
	const repo = scope === "session" ? undefined : state.repo.peek(cwd);
	return { touched, repo };
}

export function register(pi: ExtensionAPI): void {
	const shared = fleetOf(pi);
	const state = filesOf(pi);

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		state.touched.clear();
		state.cwd = ctx.cwd;
		if (!shared.main) return;
		try {
			for (const p of touchedFromEntries(ctx.sessionManager.getBranch() as any[], ctx.cwd)) state.touched.touch(p);
		} catch {
			// an unreadable branch only means an empty tier 1
		}
		// Warm the repo listing in the background so the first /view completes at once.
		state.repo.peek(ctx.cwd);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!shared.main || event.isError || !TOUCH_TOOLS.has(event.toolName)) return;
		const p = toolPath((event.input as { path?: unknown } | undefined)?.path, ctx.cwd);
		if (p) state.touched.touch(p);
	});

	pi.on("agent_settled", async () => {
		if (shared.main) state.repo.invalidate();
	});

	pi.events.on(USER_EDIT_EVENT, (msg: unknown) => {
		const p = (msg as { path?: unknown } | undefined)?.path;
		if (shared.main && typeof p === "string" && isAbsolute(p)) state.touched.touch(p);
	});
}
