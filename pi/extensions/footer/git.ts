/**
 * footer/git: what the footer's line 2 says about git (pure node; tests import it directly).
 *
 * readGit(cwd) runs a handful of read-only git commands (with --no-optional-locks where git
 * would otherwise refresh the index) and returns a GitState; formatGit turns it into toned parts:
 *
 *   git REBASE 2/5 !1 +1 ~3 ?2 ↑2 ↓1 ≡1      this checkout
 *     operation in progress (REBASE n/m, MERGE, CHERRY-PICK, REVERT, BISECT), !conflicts,
 *     +staged, ~modified, ?untracked, ↑ahead/↓behind upstream (no arrows without one),
 *     ≡stash entries; `git clean` when there is nothing to report
 *   lanes: 1 conflict, 1 working, 2 to merge, 1 merged
 *     agent-lane worktrees (<main checkout>/.worktrees/*) other than this checkout:
 *     conflict = conflicted files or a detached HEAD (a stopped `agent-lane merge` rebase);
 *     working = uncommitted changes; to merge = commits not in this checkout's HEAD;
 *     merged = nothing left to merge (`agent-lane rm` it); missing = its directory is gone
 *   1 other worktree        worktrees outside .worktrees/ (not the main checkout, not this one)
 *   2 unmerged lane branches  lane/* branches with no worktree and commits not in HEAD
 *
 * Colors (pi theme tokens, so they follow the theme): REBASE/MERGE… warning, !conflicts error,
 * +staged success, ~modified warning, ?untracked error (as `git status`), ↑ahead accent (to push),
 * ↓behind warning, ≡stash muted, clean success; lanes: conflict error, missing warning, working
 * accent, to merge success, merged muted; other worktrees muted, unmerged lane branches warning.
 *
 * The repo name is the main checkout's (so a lane shows its repo, not the lane dir).
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type Run = (args: string[], cwd: string) => Promise<string | undefined>;

export const runGit: Run = (args, cwd) =>
	new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 10_000, maxBuffer: 16 << 20 }, (err, stdout) => resolve(err ? undefined : stdout));
	});

export type LaneState = "conflict" | "working" | "to merge" | "merged" | "missing";

export interface StatusCounts {
	staged: number;
	modified: number;
	untracked: number;
	conflicts: number;
	/** Undefined without an upstream. */
	ahead?: number;
	behind?: number;
	detached: boolean;
}

export interface GitState extends StatusCounts {
	repo: string;
	op?: string;
	stash: number;
	lanes: { name: string; state: LaneState }[];
	otherWorktrees: number;
	strayLaneBranches: number;
}

/** `git status --porcelain=v2 [--branch]` → counts. */
export function parseStatus(out: string): StatusCounts {
	const c: StatusCounts = { staged: 0, modified: 0, untracked: 0, conflicts: 0, detached: false };
	for (const line of out.split("\n")) {
		if (line.startsWith("# branch.ab ")) {
			const m = /\+(\d+) -(\d+)/.exec(line);
			if (m) [c.ahead, c.behind] = [Number(m[1]), Number(m[2])];
		} else if (line === "# branch.head (detached)") c.detached = true;
		else if (line.startsWith("? ")) c.untracked++;
		else if (line.startsWith("u ")) c.conflicts++;
		else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const xy = line.slice(2, 4);
			if (xy[0] !== ".") c.staged++;
			if (xy[1] !== ".") c.modified++;
		}
	}
	return c;
}

export interface Worktree {
	path: string;
	branch?: string;
	detached: boolean;
	prunable: boolean;
}

/** `git worktree list --porcelain` → worktrees (the main checkout first). */
export function parseWorktrees(out: string): Worktree[] {
	const list: Worktree[] = [];
	for (const block of out.split("\n\n")) {
		const lines = block.split("\n").filter(Boolean);
		const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
		if (!path) continue;
		const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
		list.push({ path, branch, detached: lines.includes("detached"), prunable: lines.some((l) => l === "prunable" || l.startsWith("prunable ")) });
	}
	return list;
}

/** The operation in progress in a git dir: `REBASE 2/5`, `MERGE`, ...; undefined if none. */
export function gitOp(gitDir: string): string | undefined {
	const read = (f: string) => {
		try {
			return readFileSync(join(gitDir, f), "utf8").trim();
		} catch {
			return "";
		}
	};
	for (const [dir, step, total] of [
		["rebase-merge", "msgnum", "end"],
		["rebase-apply", "next", "last"],
	]) {
		if (existsSync(join(gitDir, dir))) {
			const n = read(`${dir}/${step}`);
			const m = read(`${dir}/${total}`);
			return n && m ? `REBASE ${n}/${m}` : "REBASE";
		}
	}
	if (existsSync(join(gitDir, "MERGE_HEAD"))) return "MERGE";
	if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "CHERRY-PICK";
	if (existsSync(join(gitDir, "REVERT_HEAD"))) return "REVERT";
	if (existsSync(join(gitDir, "BISECT_LOG"))) return "BISECT";
	return undefined;
}

/** Everything line 2 shows about git for `cwd`; undefined outside a work tree. */
export async function readGit(cwd: string, run: Run = runGit): Promise<GitState | undefined> {
	const paths = (await run(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"], cwd))?.split("\n");
	const [top, gitDir, commonDir] = paths ?? [];
	if (!top || !gitDir || !commonDir) return undefined;
	const mainRoot = basename(commonDir) === ".git" ? dirname(commonDir) : top;
	const lanesDir = `${mainRoot}/.worktrees/`;

	const [status, worktreesOut, unmergedOut, stashOut] = await Promise.all([
		run(["--no-optional-locks", "status", "--porcelain=v2", "--branch"], cwd),
		run(["worktree", "list", "--porcelain"], cwd),
		run(["branch", "--no-merged", "HEAD", "--format=%(refname:short)", "--list", "lane/*"], cwd),
		run(["rev-list", "--walk-reflogs", "--count", "refs/stash"], cwd),
	]);
	const counts = parseStatus(status ?? "");
	const worktrees = parseWorktrees(worktreesOut ?? "");
	const unmerged = new Set((unmergedOut ?? "").split("\n").filter(Boolean));

	const laneTrees = worktrees.filter((w) => w.path.startsWith(lanesDir) && w.path !== top);
	const lanes = await Promise.all(
		laneTrees.map(async (w): Promise<{ name: string; state: LaneState }> => {
			const name = w.path.slice(lanesDir.length);
			if (w.prunable || !existsSync(w.path)) return { name, state: "missing" };
			if (w.detached) return { name, state: "conflict" };
			const s = parseStatus((await run(["--no-optional-locks", "status", "--porcelain=v2"], w.path)) ?? "");
			if (s.conflicts) return { name, state: "conflict" };
			if (s.staged || s.modified || s.untracked) return { name, state: "working" };
			return { name, state: w.branch && unmerged.has(w.branch) ? "to merge" : "merged" };
		}),
	);
	const checkedOut = new Set(worktrees.map((w) => w.branch).filter(Boolean));
	return {
		...counts,
		repo: basename(mainRoot),
		op: gitOp(gitDir),
		stash: Number(stashOut?.trim()) || 0,
		lanes,
		otherWorktrees: worktrees.filter((w, i) => i > 0 && w.path !== top && !w.path.startsWith(lanesDir)).length,
		strayLaneBranches: [...unmerged].filter((b) => !checkedOut.has(b)).length,
	};
}

export type PartTone = "dim" | "muted" | "accent" | "success" | "warning" | "error";
export interface Part {
	text: string;
	tone: PartTone;
}

const LANE_ORDER: LaneState[] = ["conflict", "missing", "working", "to merge", "merged"];
// Colors say what needs you: red broken, yellow to look at, green ready, accent in progress, grey done.
const LANE_TONE: Record<LaneState, PartTone> = { conflict: "error", missing: "warning", working: "accent", "to merge": "success", merged: "muted" };

/** Line 2's git items: one Part per space-separated token group (the caller joins with " · "). */
export function formatGit(g: GitState): Part[][] {
	const groups: Part[][] = [];
	const head: Part[] = [{ text: "git", tone: "dim" }];
	if (g.op) head.push({ text: g.op, tone: "warning" });
	if (g.conflicts) head.push({ text: `!${g.conflicts}`, tone: "error" });
	if (g.staged) head.push({ text: `+${g.staged}`, tone: "success" });
	if (g.modified) head.push({ text: `~${g.modified}`, tone: "warning" });
	if (g.untracked) head.push({ text: `?${g.untracked}`, tone: "error" });
	if (g.ahead) head.push({ text: `↑${g.ahead}`, tone: "accent" });
	if (g.behind) head.push({ text: `↓${g.behind}`, tone: "warning" });
	if (g.stash) head.push({ text: `≡${g.stash}`, tone: "muted" });
	if (head.length === 1) head.push({ text: "clean", tone: "success" });
	groups.push(head);
	if (g.lanes.length) {
		const by = new Map<LaneState, number>();
		for (const l of g.lanes) by.set(l.state, (by.get(l.state) ?? 0) + 1);
		const items = LANE_ORDER.filter((s) => by.has(s)).map((s, i, all) => ({ text: `${by.get(s)} ${s}${i < all.length - 1 ? "," : ""}`, tone: LANE_TONE[s] }));
		groups.push([{ text: "lanes:", tone: "dim" }, ...items]);
	}
	if (g.otherWorktrees) groups.push([{ text: `${g.otherWorktrees} other worktree${g.otherWorktrees === 1 ? "" : "s"}`, tone: "muted" }]);
	if (g.strayLaneBranches) groups.push([{ text: `${g.strayLaneBranches} unmerged lane branch${g.strayLaneBranches === 1 ? "" : "es"}`, tone: "warning" }]);
	return groups;
}
