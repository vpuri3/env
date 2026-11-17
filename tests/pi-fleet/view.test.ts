// /view (design §11, phase 6): the file ranker and its tiers (files.ts), the repo listing cache,
// path:line parsing, tool-output documents, and /view completions — pure node, no pi, nvim or
// tmux. The completion and picker code in view.ts imports pi-tui, so those tests resolve
// `@earendil-works/*` from pi's install (skipped when pi is not on PATH).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	displayPath,
	displayText,
	filesOf,
	grep,
	listRepoFiles,
	parseTarget,
	pathList,
	rankTiers,
	RepoFiles,
	TouchedFiles,
	touchedFromEntries,
	register as registerFiles,
} from "../../pi/extensions/fleet/files.ts";
import { fleetOf } from "../../pi/extensions/fleet/shared.ts";
import { USER_EDIT_EVENT } from "../../pi/extensions/fleet/nvim.ts";
import { piPackages, usePackages } from "./support/view-support.ts";

delete process.env.TMUX;
delete process.env.TMUX_PANE;

const packages = piPackages();
let view: typeof import("../../pi/extensions/fleet/view.ts");
let toolOutput: typeof import("../../pi/extensions/fleet/tool-output.ts");

before(async () => {
	if (!packages) return;
	await usePackages(packages);
	view = await import("../../pi/extensions/fleet/view.ts");
	toolOutput = await import("../../pi/extensions/fleet/tool-output.ts");
});
const skipPkg = packages ? false : "pi's packages not found (pi not on PATH)";

// ---------------------------------------------------------------- ranker

const paths = (r: { path: string }[]) => r.map((x) => x.path);

test("rankTiers: tier 1 always before tier 2, no duplicates", () => {
	const touched = pathList(["docs/notes.md", "src/view.ts"]);
	const repo = pathList(["src/view.ts", "src/review.ts", "pi/extensions/fleet/view.ts", "docs/notes.md"]);
	const r = rankTiers("view", [touched, repo], 20);
	assert.deepEqual(paths(r), ["src/view.ts", "pi/extensions/fleet/view.ts", "src/review.ts"]);
	assert.deepEqual(r.map((x) => x.tier), [0, 1, 1]);
	// Even a weak tier-1 match beats a perfect tier-2 one.
	const r2 = rankTiers("vw", [pathList(["very/wide/thing.txt"]), pathList(["vw"])], 20);
	assert.deepEqual(paths(r2), ["very/wide/thing.txt", "vw"]);
});

test("rankTiers: basename matches and contiguous runs rank first; shorter wins ties", () => {
	const repo = pathList([
		"docs/overview/index.md",
		"pi/extensions/fleet/view.ts",
		"tests/pi-fleet/view.test.ts",
		"a/v/i/e/w.txt",
		"view.ts",
	]);
	const r = paths(rankTiers("view", [pathList([]), repo], 20));
	assert.equal(r[0], "view.ts");
	assert.equal(r[1], "pi/extensions/fleet/view.ts");
	assert.ok(r.indexOf("tests/pi-fleet/view.test.ts") < r.indexOf("a/v/i/e/w.txt"));
	assert.ok(r.indexOf("pi/extensions/fleet/view.ts") < r.indexOf("docs/overview/index.md"));
});

test("rankTiers: tokens all must match; a token with / matches the full path", () => {
	const repo = pathList(["src/a/main.py", "src/b/main.py", "lib/a/main.py", "src/a/util.py"]);
	assert.equal(paths(rankTiers("src/a main", [repo], 20))[0], "src/a/main.py");
	assert.equal(paths(rankTiers("b main", [repo], 20))[0], "src/b/main.py");
	assert.deepEqual(paths(rankTiers("MAIN.PY lib", [repo], 20)), ["lib/a/main.py"]);
	assert.deepEqual(paths(rankTiers("zzz", [repo], 20)), []);
});

test("rankTiers: empty query keeps tier order (MRU first) and honours limit", () => {
	const touched = pathList(["b", "a"]);
	const repo = pathList(["a", "c", "d", "e"]);
	assert.deepEqual(paths(rankTiers("", [touched, repo], 4)), ["b", "a", "c", "d"]);
	assert.deepEqual(paths(rankTiers("  ", [touched, repo], 1)), ["b"]);
	assert.equal(rankTiers("e", [pathList(Array.from({ length: 100 }, (_, i) => `e${i}`))], 7).length, 7);
});

/** 50k realistic repo-ish paths. */
function syntheticRepo(n: number): string[] {
	const dirs = ["src", "lib", "tests", "docs", "pi/extensions/fleet", "physicsnemo/models", "examples/cfd", "nvim/lua/nvconf"];
	const words = ["model", "train", "view", "data", "loader", "utils", "config", "mesh", "graph", "solver", "fleet", "status"];
	const exts = [".py", ".ts", ".md", ".lua", ".json", ".yaml"];
	const out: string[] = [];
	let seed = 42;
	const rnd = (k: number) => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % k;
	};
	for (let i = 0; i < n; i++) {
		const depth = 1 + rnd(3);
		const parts = [dirs[rnd(dirs.length)]];
		for (let d = 0; d < depth; d++) parts.push(`${words[rnd(words.length)]}_${rnd(50)}`);
		parts.push(`${words[rnd(words.length)]}${rnd(1000)}${exts[rnd(exts.length)]}`);
		out.push(parts.join("/"));
	}
	return out;
}

test("perf: tiered ranking of 50k paths stays under 50 ms per query", () => {
	const repo = pathList(syntheticRepo(50_000));
	// A few touched files, so tier 2 (the 50k) is always ranked to fill the 20 slots.
	const touched = pathList(repo.paths.slice(0, 5));
	const queries = ["v", "m", "view", "src model", "fleet/status", "loader.py", "xq", "train_1/da", "pi/ext flt sts", "e"];
	// Warm up the JIT, then take the worst of several runs per query.
	for (const q of queries) rankTiers(q, [touched, repo], 20);
	const worst: Record<string, number> = {};
	for (const q of queries) {
		for (let k = 0; k < 3; k++) {
			const t0 = performance.now();
			const r = rankTiers(q, [touched, repo], 20);
			const ms = performance.now() - t0;
			worst[q] = Math.max(worst[q] ?? 0, ms);
			assert.ok(r.length <= 20);
		}
	}
	const slowest = Math.max(...Object.values(worst));
	if (process.env.PI_FLEET_TEST_VERBOSE) console.log(worst);
	assert.ok(slowest < 50, `slowest query took ${slowest.toFixed(1)} ms: ${JSON.stringify(worst)}`);
});

test("perf: typing a query keystroke by keystroke over 50k paths; narrowing gives the same results", () => {
	const raw = syntheticRepo(50_000);
	const repo = pathList(raw);
	const touched = pathList(raw.slice(0, 5));
	rankTiers("warm up", [touched, pathList(raw.slice(0, 1000))], 20);
	for (const query of ["src model", "fleet/status.ts", "loader 12"]) {
		let worst = 0;
		for (let i = 1; i <= query.length; i++) {
			const q = query.slice(0, i);
			const t0 = performance.now();
			const got = rankTiers(q, [touched, repo], 20);
			worst = Math.max(worst, performance.now() - t0);
			if (i === query.length || i % 3 === 0) assert.deepEqual(got, rankTiers(q, [touched, pathList(raw)], 20), q);
		}
		assert.ok(worst < 50, `${query}: slowest keystroke ${worst.toFixed(1)} ms`);
	}
});

// ---------------------------------------------------------------- parsing, paths

test("parseTarget: path, path:line, path:line:col; odd names stay paths", () => {
	assert.deepEqual(parseTarget("src/x.py:10"), { path: "src/x.py", line: 10 });
	assert.deepEqual(parseTarget(" src/x.py:10:4 "), { path: "src/x.py", line: 10 });
	assert.deepEqual(parseTarget("src/x.py"), { path: "src/x.py" });
	assert.deepEqual(parseTarget("src/x.py:0"), { path: "src/x.py", line: 1 });
	assert.deepEqual(parseTarget("a:b"), { path: "a:b" });
	assert.deepEqual(parseTarget(":12"), { path: ":12" });
});

test("displayPath: relative inside cwd, ~ under home, else absolute", () => {
	assert.equal(displayPath("/w/repo/src/a.py", "/w/repo"), "src/a.py");
	assert.equal(displayPath("/w/repo2/a.py", "/w/repo"), "/w/repo2/a.py");
	assert.equal(displayPath(join(homedir(), "x/y.md"), "/w/repo"), "~/x/y.md");
});

// ---------------------------------------------------------------- touched tier

test("TouchedFiles: most recent first, deduped", () => {
	const t = new TouchedFiles();
	for (const p of ["/a", "/b", "/a", "/c"]) t.touch(p);
	assert.deepEqual(t.list(), ["/c", "/a", "/b"]);
});

const msg = (message: object) => ({ type: "message", message });
const call = (id: string, name: string, args: object) =>
	msg({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (id: string, isError = false, text = "ok") =>
	msg({ role: "toolResult", toolCallId: id, isError, content: [{ type: "text", text }] });

test("touchedFromEntries: successful read/edit/write only, resolved against cwd", () => {
	const entries = [
		call("1", "read", { path: "src/a.py" }),
		result("1"),
		call("2", "bash", { command: "ls" }),
		result("2"),
		call("3", "read", { path: "missing.py" }),
		result("3", true),
		call("4", "edit", { path: "@/abs/b.ts" }),
		result("4"),
		call("5", "write", { path: "pending.txt" }), // no result yet
	];
	assert.deepEqual(touchedFromEntries(entries, "/w"), ["/w/src/a.py", "/abs/b.ts"]);
});

/** A minimal ExtensionAPI stand-in: handlers by event name and a shared event bus. */
function fakePi() {
	const handlers = new Map<string, ((...a: any[]) => any)[]>();
	const bus = new Map<string, ((d: unknown) => void)[]>();
	const commands = new Map<string, any>();
	const pi: any = {
		on: (ev: string, h: (...a: any[]) => any) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
		registerCommand: (name: string, opts: any) => commands.set(name, opts),
		events: {
			on: (ev: string, h: (d: unknown) => void) => bus.set(ev, [...(bus.get(ev) ?? []), h]),
			emit: (ev: string, d: unknown) => (bus.get(ev) ?? []).forEach((h) => h(d)),
		},
	};
	const fire = async (ev: string, ...args: any[]) => {
		for (const h of handlers.get(ev) ?? []) await h(...args);
	};
	return { pi, fire, commands };
}

function fakeCtx(cwd: string, entries: any[] = []): any {
	return {
		cwd,
		hasUI: true,
		mode: "rpc",
		sessionManager: { getBranch: () => entries, getSessionId: () => "sid" },
		ui: { notify() {}, select: async () => undefined },
	};
}

test("files register: seeds from the branch, tracks tool results and user saves, main only", async () => {
	const { pi, fire } = fakePi();
	registerFiles(pi);
	const state = filesOf(pi);
	state.repo = new RepoFiles(async () => []);
	const ctx = fakeCtx("/w", [call("1", "read", { path: "a.py" }), result("1"), call("2", "write", { path: "b.py" }), result("2")]);

	fleetOf(pi).main = false;
	await fire("session_start", { reason: "startup" }, ctx);
	assert.deepEqual(state.touched.list(), []);

	fleetOf(pi).main = true;
	await fire("session_start", { reason: "startup" }, ctx);
	assert.deepEqual(state.touched.list(), ["/w/b.py", "/w/a.py"]);
	await fire("tool_result", { toolName: "edit", isError: false, input: { path: "c.py" } }, ctx);
	await fire("tool_result", { toolName: "read", isError: true, input: { path: "bad.py" } }, ctx);
	await fire("tool_result", { toolName: "bash", isError: false, input: { command: "x" } }, ctx);
	pi.events.emit(USER_EDIT_EVENT, { path: "/w/saved.md" });
	assert.deepEqual(state.touched.list(), ["/w/saved.md", "/w/c.py", "/w/b.py", "/w/a.py"]);
});

// ---------------------------------------------------------------- repo listing

test("RepoFiles: TTL, stale-while-revalidate, invalidate, bounded wait", async () => {
	let now = 0;
	let calls = 0;
	let release: (() => void) | undefined;
	const lister = async (cwd: string) => {
		calls++;
		await new Promise<void>((r) => (release = r));
		return [`${cwd}/f${calls}`];
	};
	const repo = new RepoFiles(lister, 1000, () => now);
	assert.equal(repo.peek("/r"), undefined); // starts a load, never waits
	assert.equal(calls, 1);
	assert.equal(await repo.get("/r", 20), undefined); // still loading: bounded wait gives up
	release!();
	const first = await repo.get("/r");
	assert.deepEqual(first?.paths, ["/r/f1"]);
	assert.equal(repo.peek("/r"), first); // fresh: no reload
	assert.equal(calls, 1);
	now = 2000; // past the TTL: stale data now, refresh in the background
	assert.equal(repo.peek("/r"), first);
	assert.equal(calls, 2);
	assert.equal(repo.peek("/r"), first); // one refresh at a time
	assert.equal(calls, 2);
	release!();
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(repo.peek("/r")?.paths, ["/r/f2"]);
	repo.invalidate();
	repo.peek("/r");
	assert.equal(calls, 3);
	release!();
});

test("listRepoFiles: git ls-files (tracked + untracked, not ignored), fallback outside git, cap", async () => {
	const root = mkdtempSync(join(tmpdir(), "pfv-"));
	try {
		const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src/a.py"), "");
		writeFileSync(join(root, "b.md"), "");
		writeFileSync(join(root, ".gitignore"), "ignored.log\n");
		writeFileSync(join(root, "ignored.log"), "");
		git("init", "-q");
		git("add", "src/a.py", ".gitignore");
		writeFileSync(join(root, "space name.txt"), "");
		const listed = (await listRepoFiles(root)).sort();
		assert.deepEqual(listed, [".gitignore", "b.md", "space name.txt", "src/a.py"]);
		assert.equal((await listRepoFiles(root, 2)).length, 2);
		// From a subdirectory: paths relative to it.
		assert.deepEqual(await listRepoFiles(join(root, "src")), ["a.py"]);
		rmSync(join(root, ".git"), { recursive: true });
		const plain = await listRepoFiles(root);
		// fd/rg fallback (if either is installed): ignores nothing tracked-wise but finds files.
		if (plain.length) assert.ok(plain.includes("src/a.py"), JSON.stringify(plain));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listRepoFiles: tracked files first, so untracked ones cannot crowd them out of the cap", async () => {
	const root = mkdtempSync(join(tmpdir(), "pfv-"));
	try {
		const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
		git("init", "-q");
		writeFileSync(join(root, "zz-tracked.txt"), "");
		git("add", "zz-tracked.txt");
		for (let i = 0; i < 60; i++) writeFileSync(join(root, `a${String(i).padStart(2, "0")}.tmp`), "");
		const capped = await listRepoFiles(root, 10);
		assert.equal(capped.length, 10);
		assert.equal(capped[0], "zz-tracked.txt");
		// Room left: untracked ones fill it after the tracked list.
		const all = await listRepoFiles(root);
		assert.equal(all.length, 61);
		assert.equal(all[0], "zz-tracked.txt");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listRepoFiles: a hanging untracked listing keeps the tracked list (no fd/rg fallback)", async () => {
	const root = mkdtempSync(join(tmpdir(), "pfv-"));
	const bin = mkdtempSync(join(tmpdir(), "pfv-bin-"));
	const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const oldPath = process.env.PATH;
	try {
		const git = (...a: string[]) => execFileSync(realGit, a, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
		git("init", "-q");
		writeFileSync(join(root, "tracked.txt"), "");
		git("add", "tracked.txt");
		writeFileSync(join(root, "untracked.txt"), "");
		// git whose `--others` listing hangs; fd/fdfind/rg that would list everything.
		writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" --others "*) exec sleep 30;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`);
		for (const f of ["fd", "fdfind", "rg"]) writeFileSync(join(bin, f), "#!/bin/sh\nprintf 'tracked.txt\\0untracked.txt\\0fallback\\0'\n");
		for (const f of ["git", "fd", "fdfind", "rg"]) chmodSync(join(bin, f), 0o755);
		process.env.PATH = `${bin}:${oldPath}`;
		const t0 = Date.now();
		assert.deepEqual(await listRepoFiles(root, 100, 5_000, 300), ["tracked.txt"]);
		assert.ok(Date.now() - t0 < 3_000);
	} finally {
		process.env.PATH = oldPath;
		rmSync(root, { recursive: true, force: true });
		rmSync(bin, { recursive: true, force: true });
	}
});

test("displayText: control characters never reach the terminal", () => {
	assert.equal(displayText("a\x1b[31mb\rc\td\x07e\x9bf\x7f"), "a?[31mb?c d?e?f?");
	assert.equal(displayText("plain/path ✓.ts"), "plain/path ✓.ts");
});

test("grep: paths containing `:LINE:COL:`-like text parse via --null", { skip: !hasRg() && "rg not found" }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pfv-"));
	try {
		writeFileSync(join(root, "log 12:30:45.txt"), "one\nneedle: 7:8 here\n");
		const hits = await grep(root, "needle");
		assert.deepEqual(hits, [{ path: "log 12:30:45.txt", line: 2, col: 1, text: "needle: 7:8 here" }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function hasRg(): boolean {
	try {
		execFileSync("rg", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------- tool output, completions

const entries = [
	msg({ role: "user", content: [{ type: "text", text: "hi" }] }),
	call("c1", "read", { path: "src/x.py" }),
	result("c1", false, "print(1)\nprint(2)\n"),
	call("c2", "bash", { command: "echo hi" }),
	result("c2", false, "hi\n"),
	call("c3", "edit", { path: "src/x.py", edits: [] }),
	msg({ role: "toolResult", toolCallId: "c3", isError: false, content: [{ type: "text", text: "ok" }], details: { patch: "@@ -1 +1 @@\n-a\n+b" } }),
];

test("tool-output: numbering newest first, documents and labels as compact-tools had them", { skip: skipPkg }, () => {
	const calls = toolOutput.recentCalls(entries);
	assert.deepEqual(calls.map((c) => c.id), ["c3", "c2", "c1"]);
	assert.deepEqual(toolOutput.toolDocument(calls[0], "/w"), { name: "x.py.diff", text: "# src/x.py\n@@ -1 +1 @@\n-a\n+b" });
	assert.deepEqual(toolOutput.toolDocument(calls[1], "/w"), { name: "bash.log", text: "$ echo hi\n\nhi\n" });
	assert.deepEqual(toolOutput.toolDocument(calls[2], "/w"), { name: "x.py", text: "print(1)\nprint(2)\n" });
	assert.equal(toolOutput.callLabel(calls[1], 2, "/w"), " 2. ✓ bash  echo hi  · exit 0 · 1 line");
	assert.equal(toolOutput.parseToolRef("tool:3"), 3);
	assert.equal(toolOutput.parseToolRef("tool:x"), undefined);
	assert.equal(toolOutput.parseToolRef("3"), undefined);
});

test("view completions: tool:N items; tiered files keeping :LINE; first call waits briefly", { skip: skipPkg }, async () => {
	const { pi } = fakePi();
	fleetOf(pi).main = true;
	const state = filesOf(pi);
	state.repo = new RepoFiles(async () => ["src/x.py", "src/y.py", "README.md", "docs/x-notes.md"]);
	state.touched.touch("/w/docs/x-notes.md");
	const ctx = fakeCtx("/w", entries);

	const tools = await view.viewCompletions(pi, ctx, "tool:");
	assert.deepEqual(tools?.map((t) => t.value), ["tool:1", "tool:2", "tool:3"]);
	assert.match(tools![1].description!, /bash {2}echo hi/);
	assert.deepEqual((await view.viewCompletions(pi, ctx, "tool:2"))?.map((t) => t.value), ["tool:2"]);
	assert.deepEqual((await view.viewCompletions(pi, ctx, "tool:echo"))?.map((t) => t.value), ["tool:2"]);

	const files = await view.viewCompletions(pi, ctx, "x");
	assert.deepEqual(files?.map((f) => f.value), ["docs/x-notes.md", "src/x.py"]);
	assert.equal(files![0].description, "session");
	assert.deepEqual((await view.viewCompletions(pi, ctx, "y.py:12"))?.map((f) => f.value), ["src/y.py:12"]);
	assert.equal(await view.viewCompletions(pi, ctx, "qqq"), null);

	// A lister that never finishes: completion gives up after waitMs with tier 1 only.
	const { pi: pi2 } = fakePi();
	filesOf(pi2).repo = new RepoFiles(() => new Promise(() => {}));
	filesOf(pi2).touched.touch("/w/a.ts");
	const t0 = Date.now();
	assert.deepEqual((await view.viewCompletions(pi2, ctx, "", 50))?.map((f) => f.value), ["a.ts"]);
	assert.ok(Date.now() - t0 < 1000);
});

test("view completions: tool: offers only the 200 most recent calls; numbers filter before summarising", { skip: skipPkg }, async () => {
	const { pi } = fakePi();
	const many: any[] = [];
	for (let i = 0; i < 300; i++) many.push(call(`k${i}`, "bash", { command: `echo ${i}` }), result(`k${i}`));
	const ctx = fakeCtx("/w", many);
	assert.deepEqual((await view.viewCompletions(pi, ctx, "tool:25"))?.map((t) => t.value), ["tool:25"]);
	assert.equal(await view.viewCompletions(pi, ctx, "tool:250"), null);
	// Tool labels are TUI text: control characters from the call never reach the terminal.
	const esc = fakeCtx("/w", [call("e1", "bash", { command: "printf '\x1b[2J\rgone'" }), result("e1")]);
	const [escItem] = (await view.viewCompletions(pi, esc, "tool:")) ?? [];
	assert.ok(escItem && !/[\x00-\x1f\x7f-\x9f]/.test(escItem.description!), JSON.stringify(escItem));
	const ones = await view.viewCompletions(pi, ctx, "tool:1");
	assert.deepEqual(ones?.slice(0, 3).map((t) => t.value), ["tool:1", "tool:10", "tool:11"]);
	assert.equal(ones?.length, 20);
	assert.match(ones![0].description!, /echo 299/);
	// Text queries only see the recent 200 (tool:1 = echo 299 … tool:200 = echo 100).
	assert.deepEqual((await view.viewCompletions(pi, ctx, "tool:echo 99"))?.some((t) => /echo 99\b/.test(t.description!)), false);
});

test("pickers: file labels and grep descriptions are stripped of control characters", { skip: skipPkg }, async () => {
	const { pi } = fakePi();
	filesOf(pi).repo = new RepoFiles(async () => []);
	filesOf(pi).touched.touch("/w/evil\x1b]0;pwned\x07.txt");
	const items = view.fileItems(pi, "/w", "session", "");
	assert.equal(items[0].value, "evil\x1b]0;pwned\x07.txt");
	assert.equal(items[0].label, "evil?]0;pwned?.txt");

	if (!hasRg()) return;
	const root = mkdtempSync(join(tmpdir(), "pfv-"));
	try {
		writeFileSync(join(root, "a.txt"), "needle \x1b[2J\rgone\n");
		let labels: string[] = [];
		const ctx = { ...fakeCtx(root), ui: { notify() {}, select: async (_t: string, l: string[]) => ((labels = l), undefined) } };
		await view.openGrepPicker(pi, ctx, "needle");
		assert.deepEqual(labels, ["a.txt:1  · needle ?[2J?gone"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("FuzzyPicker: typing filters, arrows move, enter picks, esc cancels", { skip: skipPkg }, () => {
	const keys = { matches: (d: string, id: string) => ({ "\x1b[A": "tui.select.up", "\x1b[B": "tui.select.down", "\r": "tui.select.confirm", "\x1b": "tui.select.cancel" } as Record<string, string>)[d] === id };
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const all = ["src/x.py", "src/y.py", "README.md"].map((p) => ({ value: p, label: p }));
	let picked: unknown = "pending";
	const p = new view.FuzzyPicker({
		title: "Open file",
		source: (q) => view.filterItems(all, q, (i) => i.label),
		theme,
		keys,
		done: (i) => (picked = i),
		requestRender() {},
	});
	assert.ok(p.render(60).some((l) => l.includes("→ src/x.py")));
	for (const ch of "y.p") p.handleInput(ch);
	const lines = p.render(60);
	assert.ok(lines.some((l) => l.includes("→ src/y.py")), lines.join("\n"));
	assert.ok(!lines.some((l) => l.includes("README")));
	p.handleInput("\r");
	assert.deepEqual(picked, { value: "src/y.py", label: "src/y.py" });
	picked = "pending";
	const q = new view.FuzzyPicker({ title: "t", source: () => all, theme, keys, done: (i) => (picked = i), requestRender() {} });
	q.handleInput("\x1b[B");
	q.handleInput("\x1b[B");
	q.handleInput("\x1b[B");
	assert.equal(q.selectedItem()?.value, "README.md");
	q.handleInput("\x1b");
	assert.equal(picked, undefined);
});
