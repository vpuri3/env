// Subagent fold tests for pi/extensions/fleet/registry.ts.
// fixtures/registry-session.jsonl is the registry part of a real main session (pi-subagent-manager
// 1.7.1), anonymised: ids, paths, types and every free-text field replaced, other entries dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	REGISTRY_DELTA_ENTRY,
	REGISTRY_ENTRY,
	RegistryFold,
	THREAD_ENTRY,
	TranscriptTails,
	branchOf,
	countSubagents,
	isSubagentSession,
	parseJsonl,
	transcriptItems,
	type EntryLike,
} from "../../pi/extensions/fleet/registry.ts";

const fixture = parseJsonl(readFileSync(new URL("./fixtures/registry-session.jsonl", import.meta.url), "utf8"));
const branch = branchOf(fixture);
const states = (fold: RegistryFold) => [...fold.threads.values()].map((t) => `${t.path}:${t.state}`);

test("fixture: fold matches pi-subagent-manager's readRegistry result", () => {
	assert.equal(branch.length, fixture.length - 1); // everything but the header
	const fold = new RegistryFold().update(branch);
	// Expected values computed with pi-subagent-manager 1.7.1 readRegistry() on the same branch.
	assert.deepEqual(states(fold), [
		"/agent-1:completed",
		"/agent-2:completed",
		"/agent-3:completed",
		"/agent-4:completed",
		"/agent-5:completed",
		"/agent-6:running",
	]);
	assert.equal(fold.formatError, false);
	assert.deepEqual(fold.counts(), { working: 1, waiting: 0, done: 5, error: 0 });
	assert.deepEqual(fold.counts(false), { working: 0, waiting: 0, done: 5, error: 0, interrupted: 1 });
});

test("fixture: deltas carry state changes", () => {
	const deltaStates = branch
		.filter((e) => e.customType === REGISTRY_DELTA_ENTRY)
		.flatMap((e: any) => e.data.changes)
		.filter((c: any) => !("thread" in c) && typeof c.view?.state === "string");
	assert.ok(deltaStates.length > 0);
});

test("incremental folding gives the same result as one fold, at every prefix", () => {
	const inc = new RegistryFold();
	for (let n = 1; n <= branch.length; n += 37) {
		inc.update(branch.slice(0, n));
		assert.deepEqual(states(inc), states(new RegistryFold().update(branch.slice(0, n))), `prefix ${n}`);
	}
	inc.update(branch);
	assert.deepEqual(states(inc), states(new RegistryFold().update(branch)));
});

test("a different branch (e.g. /tree) refolds from scratch", () => {
	const fold = new RegistryFold().update(branch);
	const other = branch.slice(0, 10);
	other.push({ ...branch[10]!, id: "fffffff0" });
	assert.deepEqual(states(fold.update(other)), states(new RegistryFold().update(other)));
});

const full = (threads: [string, string][], root = "R"): EntryLike => ({
	type: "custom",
	customType: REGISTRY_ENTRY,
	id: `f${Math.random()}`,
	data: { version: 1, rootSessionId: root, threads: threads.map(([path, state]) => ({ view: { path, state, type: "coder" } })) },
});
const delta = (changes: unknown[], root = "R"): EntryLike => ({
	type: "custom",
	customType: REGISTRY_DELTA_ENTRY,
	id: `d${Math.random()}`,
	data: { version: 1, rootSessionId: root, changes },
});

test("state mapping and unknown states", () => {
	const fold = new RegistryFold().update([
		full([
			["/a", "starting"],
			["/b", "running"],
			["/c", "paused"],
			["/d", "completed"],
			["/e", "stopped"],
			["/f", "failed"],
		]),
		delta([{ path: "/d", view: { state: "zombie" } }]),
	]);
	assert.deepEqual(fold.counts(), { working: 2, waiting: 1, done: 1, error: 1, unknown: 1 });
});

test("malformed entries and foreign-root deltas are skipped and flagged, never thrown", () => {
	const fold = new RegistryFold().update([
		full([["/a", "running"]]),
		{ type: "custom", customType: REGISTRY_DELTA_ENTRY, id: "x", data: { version: 2 } },
		delta([{ path: "/a", view: { state: "completed" } }], "OTHER"),
		delta([{ path: "/missing", view: { state: "completed" } }]),
		delta(["junk", { thread: { view: { path: "/b", state: "paused" } } }]),
	]);
	assert.equal(fold.formatError, true);
	assert.deepEqual(states(fold), ["/a:running", "/b:paused"]);
	// A later full registry replaces everything.
	fold.update([...[], full([["/z", "completed"]])]);
	assert.deepEqual(states(fold), ["/z:completed"]);
});

test("markInterrupted: running threads of a dead process become paused; later deltas override", () => {
	const pre = [full([["/a", "running"], ["/b", "starting"], ["/c", "completed"]])];
	const fold = new RegistryFold().update(pre).markInterrupted();
	assert.deepEqual(states(fold), ["/a:paused", "/b:paused", "/c:completed"]);
	assert.deepEqual(fold.counts(), { working: 0, waiting: 2, done: 1, error: 0 });
	const resumed = [...pre, delta([{ path: "/a", view: { state: "running" } }])];
	fold.update(resumed);
	assert.deepEqual(states(fold), ["/a:running", "/b:paused", "/c:completed"]);
	// A refold (e.g. /tree) keeps the mark for the pre-interruption entries only.
	const other = [...pre, { ...delta([{ path: "/b", view: { state: "running" } }]), id: "other" }];
	assert.deepEqual(states(fold.update(other)), ["/a:paused", "/b:running", "/c:completed"]);
	assert.deepEqual(states(fold.update(pre)), ["/a:paused", "/b:paused", "/c:completed"]);
	// reset() (a new session) forgets it.
	fold.reset();
	assert.deepEqual(states(fold.update(pre)), ["/a:running", "/b:starting", "/c:completed"]);
});

test("countSubagents with no threads", () => {
	assert.deepEqual(countSubagents([]), { working: 0, waiting: 0, done: 0, error: 0 });
});

const session = (header: object, entries: EntryLike[], name?: string) => ({
	getHeader: () => header as any,
	getEntries: () => entries,
	getSessionName: () => name,
});

test("isSubagentSession: thread entry or parentSession + subagent name; forks are mains", () => {
	const thread: EntryLike = { type: "custom", customType: THREAD_ENTRY, data: { rootId: "R", threadPath: "/x" } };
	assert.equal(isSubagentSession(session({}, [thread])), true);
	assert.equal(isSubagentSession(session({ parentSession: "/p.jsonl" }, [], "coder /fix-bug")), true);
	assert.equal(isSubagentSession(session({ parentSession: "/p.jsonl" }, [{ type: "session_info", name: "coder /fix-bug" }])), true);
	assert.equal(isSubagentSession(session({ parentSession: "/p.jsonl" }, [], "my fork")), false);
	assert.equal(isSubagentSession(session({ parentSession: "/p.jsonl" }, [])), false);
	assert.equal(isSubagentSession(session({}, [], "coder /fix-bug")), false);
});

test("threads carry their session file (full records and deltas)", () => {
	const fold = new RegistryFold().update(branch);
	assert.equal(fold.threads.get("/agent-1")?.sessionFile, "<sessionFile>");
	const reg = (sessionFile?: string) => ({ type: "custom", customType: REGISTRY_ENTRY, id: "r1", parentId: null, data: { version: 1, rootSessionId: "x", threads: [{ view: { path: "/a", type: "t", state: "running", sessionFile } }] } });
	assert.equal(new RegistryFold().update([reg("/s/a.jsonl")]).threads.get("/a")?.sessionFile, "/s/a.jsonl");
	const delta = { type: "custom", customType: REGISTRY_DELTA_ENTRY, id: "r2", parentId: "r1", data: { version: 1, rootSessionId: "x", changes: [{ path: "/a", view: { sessionFile: "/s/b.jsonl" } }] } };
	assert.equal(new RegistryFold().update([reg(), delta]).threads.get("/a")?.sessionFile, "/s/b.jsonl");
});

test("threads carry costUsd (full records and deltas)", () => {
	const reg = { type: "custom", customType: REGISTRY_ENTRY, id: "r1", parentId: null, data: { version: 1, rootSessionId: "x", threads: [{ view: { path: "/a", type: "t", state: "running", costUsd: 0.5 } }] } };
	assert.equal(new RegistryFold().update([reg]).threads.get("/a")?.costUsd, 0.5);
	const delta = { type: "custom", customType: REGISTRY_DELTA_ENTRY, id: "r2", parentId: "r1", data: { version: 1, rootSessionId: "x", changes: [{ path: "/a", view: { costUsd: 1.25 } }] } };
	assert.equal(new RegistryFold().update([reg, delta]).threads.get("/a")?.costUsd, 1.25);
});

test("transcript tails: bounded read, a cut first line dropped, cached by size and mtime", async () => {
	const fixtureText = readFileSync(new URL("./fixtures/subagent-transcript.jsonl", import.meta.url), "utf8");
	const all = transcriptItems(fixtureText, false);
	assert.deepEqual(all.map((i) => `${i.kind}:${i.result ?? ""}`), ["thinking:", "text:", "tool:ok", "tool:error", "tool:", "text:"]);
	assert.equal(all[2]!.text, "bash tail -n 5 run.log");
	assert.equal(transcriptItems(fixtureText, false, 2).length, 2);
	const dir = mkdtempSync(join(tmpdir(), "pft-"));
	try {
		const file = join(dir, "s.jsonl");
		writeFileSync(file, fixtureText);
		utimesSync(file, 1_700_000_000, 1_700_000_000); // whole seconds: restorable exactly
		// Only the last 300 bytes: the line they start in is dropped, the last message survives.
		const tails = new TranscriptTails({ bytes: 300 });
		const items = (await tails.get(file))!;
		assert.ok(items.length >= 1 && items.length < all.length, `${items.length}`);
		assert.deepEqual(items.at(-1), all.at(-1));
		// Same size and mtime: the cached parse, even though the bytes changed.
		const st = statSync(file);
		writeFileSync(file, fixtureText.replace("finished", "FINISHED"));
		utimesSync(file, st.atime, st.mtime);
		assert.equal((await tails.get(file))!.at(-1)!.text, "The run finished:\nloss 0.12");
		utimesSync(file, st.atime, new Date(st.mtimeMs + 5000));
		assert.equal((await tails.get(file))!.at(-1)!.text, "The run FINISHED:\nloss 0.12");
		assert.equal(await tails.get(join(dir, "missing.jsonl")), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
