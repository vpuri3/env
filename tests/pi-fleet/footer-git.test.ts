// pi/extensions/footer/git.ts: parsing, and readGit/formatGit on throwaway repositories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatGit, parseStatus, parseWorktrees, readGit, type GitState } from "../../pi/extensions/footer/git.ts";

const text = (g: GitState) => formatGit(g).map((group) => group.map((p) => p.text).join(" ")).join(" · ");

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function tempDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "footer-git-")));
}

test("parseStatus: staged, modified, untracked, conflicts, ahead/behind, detached", () => {
	const c = parseStatus(
		["# branch.oid abc", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1", "1 M. N... a", "1 .M N... b", "1 MM N... c", "2 R. N... d", "u UU N... e", "? f", "? g", "! ignored"].join("\n"),
	);
	assert.deepEqual(c, { staged: 3, modified: 2, untracked: 2, conflicts: 1, ahead: 2, behind: 1, detached: false });
	assert.equal(parseStatus("# branch.head (detached)\n").detached, true);
	assert.equal(parseStatus("# branch.head main\n").ahead, undefined, "no upstream: no arrows");
});

test("parseWorktrees: branch, detached, prunable", () => {
	const w = parseWorktrees("worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r/.worktrees/a\nHEAD 2\ndetached\n\nworktree /gone\nHEAD 3\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n");
	assert.deepEqual(w, [
		{ path: "/r", branch: "main", detached: false, prunable: false },
		{ path: "/r/.worktrees/a", branch: undefined, detached: true, prunable: false },
		{ path: "/gone", branch: "x", detached: false, prunable: true },
	]);
});

test("formatGit: clean repo says so; nothing but git outside lanes", () => {
	const g: GitState = { repo: "r", staged: 0, modified: 0, untracked: 0, conflicts: 0, detached: false, stash: 0, lanes: [], otherWorktrees: 0, strayLaneBranches: 0 };
	assert.equal(text(g), "git clean");
	assert.deepEqual(formatGit(g)[0]!.map((p) => p.tone), ["dim", "success"]);
});

test("formatGit: colors say what needs attention", () => {
	const g: GitState = {
		repo: "r", op: "REBASE 2/5", conflicts: 1, staged: 1, modified: 2, untracked: 3, ahead: 4, behind: 5, detached: false, stash: 1,
		lanes: [{ name: "a", state: "conflict" }, { name: "b", state: "missing" }, { name: "c", state: "working" }, { name: "d", state: "to merge" }, { name: "e", state: "merged" }],
		otherWorktrees: 1, strayLaneBranches: 2,
	};
	const tones = formatGit(g).map((group) => group.map((p) => `${p.text}=${p.tone}`));
	assert.deepEqual(tones, [
		["git=dim", "REBASE 2/5=warning", "!1=error", "+1=success", "~2=warning", "?3=error", "↑4=accent", "↓5=warning", "≡1=muted"],
		["lanes:=dim", "1 conflict,=error", "1 missing,=warning", "1 working,=accent", "1 to merge,=success", "1 merged=muted"],
		["1 other worktree=muted"],
		["2 unmerged lane branches=warning"],
	]);
});

test("readGit: dirty checkout, upstream, stash, lanes in every state, other worktree, stray lane branch", async (t) => {
	const root = tempDir();
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const origin = join(root, "origin");
	const repo = join(root, "env");
	git(root, "init", "-q", "--bare", origin);
	git(root, "clone", "-q", origin, repo);
	writeFileSync(join(repo, "a"), "1\n");
	git(repo, "add", "a");
	git(repo, "commit", "-qm", "a");
	git(repo, "push", "-q", "-u", "origin", "main");
	git(repo, "commit", "-q", "--allow-empty", "-m", "ahead");
	// Stash one change, then leave a staged, a modified and an untracked file.
	writeFileSync(join(repo, "a"), "stashed\n");
	git(repo, "stash", "-q");
	writeFileSync(join(repo, "b"), "staged\n");
	git(repo, "add", "b");
	writeFileSync(join(repo, "a"), "2\n");
	writeFileSync(join(repo, "c"), "untracked\n");
	writeFileSync(join(repo, ".git", "info", "exclude"), "/.worktrees/\n");
	// Lanes: working (dirty), to merge (a commit), merged (nothing new), conflict (detached).
	for (const lane of ["working", "tomerge", "merged", "conflict"]) git(repo, "worktree", "add", "-q", "-b", `lane/${lane}`, join(repo, ".worktrees", lane));
	writeFileSync(join(repo, ".worktrees", "working", "x"), "wip\n");
	git(join(repo, ".worktrees", "tomerge"), "commit", "-q", "--allow-empty", "-m", "lane work");
	git(join(repo, ".worktrees", "conflict"), "checkout", "-q", "--detach");
	// Another worktree outside .worktrees/, and an unmerged lane branch with no worktree.
	git(repo, "worktree", "add", "-q", "-b", "side", join(root, "side"));
	git(repo, "branch", "lane/stray", "main");
	git(repo, "update-ref", "refs/heads/lane/stray", git(join(repo, ".worktrees", "tomerge"), "rev-parse", "HEAD").trim());

	const g = (await readGit(repo))!;
	assert.equal(g.repo, "env");
	assert.equal(text(g), "git +1 ~1 ?1 ↑1 ≡1 · lanes: 1 conflict, 1 working, 1 to merge, 1 merged · 1 other worktree · 1 unmerged lane branch");

	// From inside a lane: the repo is still env, the lane itself is not listed.
	const fromLane = (await readGit(join(repo, ".worktrees", "working")))!;
	assert.equal(fromLane.repo, "env");
	assert.equal(fromLane.lanes.length, 3);

	// A stopped merge in the checkout shows the operation and the conflict.
	writeFileSync(join(repo, "a"), "2\n");
	git(repo, "checkout", "-q", "--", "a");
	git(repo, "checkout", "-q", "-b", "other", "HEAD~1");
	writeFileSync(join(repo, "a"), "theirs\n");
	git(repo, "commit", "-qam", "theirs");
	git(repo, "checkout", "-q", "main");
	writeFileSync(join(repo, "a"), "ours\n");
	git(repo, "reset", "-q");
	git(repo, "commit", "-qam", "ours");
	try {
		git(repo, "merge", "-q", "other");
	} catch {
		// conflict expected
	}
	const merging = (await readGit(repo))!;
	assert.equal(merging.op, "MERGE");
	assert.equal(merging.conflicts, 1);
	assert.match(text(merging), /^git MERGE !1 /);
});

test("readGit: outside a repository is undefined", async (t) => {
	const dir = tempDir();
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	assert.equal(await readGit(dir), undefined);
});
