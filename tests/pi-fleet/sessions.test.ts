// Session index (registry.ts scan) and the rows the deck list shows (sessions-view.ts fleetSource,
// killSession). Rows come from a fixture sessions dir + status dir (support/sessions-fixture.ts).
// pi-tui comes from pi's install through cli.ts's resolve hook, as in the deck; skipped without it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { locatePiPackages, usePiPackages } from "../../pi/extensions/fleet/cli.ts";
import { SAVE_INTERVAL_MS, SessionIndex, classifyHead, sessionDetail } from "../../pi/extensions/fleet/registry.ts";
import { IDS, buildFixture, plainStyle, type Fixture } from "./support/sessions-fixture.ts";

const packages = locatePiPackages();
const skip = packages ? false : "pi's pi-tui not found (pi not on PATH)";
let sv: typeof import("../../pi/extensions/fleet/sessions-view.ts");
let tui: typeof import("@earendil-works/pi-tui");
let fx: Fixture;

before(async () => {
	fx = buildFixture();
	if (!packages) return;
	await usePiPackages(packages);
	sv = await import("../../pi/extensions/fleet/sessions-view.ts");
	tui = await import("@earendil-works/pi-tui");
});
after(() => fx.cleanup());

// ---------------------------------------------------------------- index

test("classifyHead: mains, subagents (thread entry or parentSession + `<type> /<path>` name), forks", () => {
	const header = (extra = {}) => JSON.stringify({ type: "session", id: "s1", cwd: "/w", timestamp: "2026-11-17T10:00:00Z", ...extra });
	assert.equal(classifyHead(`${header()}\n`, true).subagent, false);
	const thread = JSON.stringify({ type: "custom", customType: "pi-subagent:thread:v1", data: { rootId: "r", threadPath: "/a" } });
	const h = classifyHead(`${header()}\n${thread}\n`, true);
	assert.deepEqual([h.subagent, h.rootId, h.threadPath], [true, "r", "/a"]);
	const named = (name: string) => `${header({ parentSession: "p.jsonl" })}\n${JSON.stringify({ type: "session_info", name })}\n`;
	assert.equal(classifyHead(named("coder /x"), true).subagent, true);
	assert.equal(classifyHead(named("my fork"), true).subagent, false); // a fork counts as a main
	// A cut last line (not complete) is ignored rather than misparsed.
	assert.equal(classifyHead(`${header()}\n{"type":"session_info","name":"cut`, false).name, undefined);
});

test("index: scans the fixture, finds first messages behind big entries, caches by size+mtime", () => {
	const index = new SessionIndex(fx.env);
	const entries = index.scan();
	const byId = new Map(entries.map((e) => [e.id, e]));
	assert.equal(entries.length, 8);
	assert.equal(byId.get(IDS.oldSub)?.subagent, true);
	assert.equal(byId.get(IDS.fork)?.subagent, false);
	assert.equal(byId.get(IDS.unnamed)?.firstMessage, "what does gamma do?");
	assert.equal(index.repoOf(join(fx.repos.alpha, "sub")), fx.repos.alpha);
	assert.equal(index.repoOf(fx.repos.beta), fx.repos.beta);
	const old = index.detail(byId.get(IDS.old)!)!;
	assert.deepEqual(old.threads.map((t) => `${t.path}:${t.state}`), ["/runner:running", "/checker:completed"]);
	assert.equal(old.lastAssistant, "the old run finished");
	index.save();
	const cache = JSON.parse(readFileSync(join(fx.env.PI_FLEET_CACHE_DIR!, "index.json"), "utf8"));
	assert.equal(cache.files[fx.files.old].detail.threads.length, 2);
	assert.equal(statSync(join(fx.env.PI_FLEET_CACHE_DIR!, "index.json")).mode & 0o777, 0o600);

	// A second index starts from the cache: an unchanged file is not re-read (prove it by
	// corrupting the cached name), a changed one is.
	cache.files[fx.files.ckpt].name = "from cache";
	writeFileSync(join(fx.env.PI_FLEET_CACHE_DIR!, "index.json"), JSON.stringify(cache));
	const again = new SessionIndex(fx.env);
	assert.equal(again.scan().find((e) => e.id === IDS.ckpt)?.name, "from cache");
	const before = statSync(fx.files.ckpt);
	appendFileSync(fx.files.ckpt, `${JSON.stringify({ type: "session_info", id: "zz", parentId: null, name: "ckpt restart" })}\n`);
	utimesSync(fx.files.ckpt, before.atime, before.mtime);
	assert.equal(again.scan().find((e) => e.id === IDS.ckpt)?.name, "ckpt restart");
});

test("sessionDetail: the latest name and last assistant text of the active branch", () => {
	const lines = [
		{ type: "session", id: "s" },
		{ type: "session_info", id: "1", parentId: null, name: "a" },
		{ type: "message", id: "2", parentId: "1", message: { role: "assistant", content: [{ type: "text", text: "on branch" }] } },
		{ type: "message", id: "3", parentId: "1", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } },
		{ type: "session_info", id: "4", parentId: "2", name: "b" },
	];
	const d = sessionDetail(lines.map((l) => JSON.stringify(l)).join("\n"));
	assert.equal(d.name, "b");
	assert.equal(d.lastAssistant, "on branch");
});

// ---------------------------------------------------------------- rows

test("source: status files merged over the scan; crashed/remote/closed; subagents hidden", { skip }, () => {
	const rows = sv.fleetSource(fx.env).load();
	const by = new Map(rows.map((r) => [r.id, r]));
	assert.ok(!by.has(IDS.oldSub), "subagent sessions are not rows");
	assert.equal(rows.length, 8);
	assert.equal(by.get(IDS.sweep)?.state, "running");
	assert.deepEqual(by.get(IDS.sweep)?.counts, { working: 2, waiting: 1, done: 3, error: 0 });
	assert.equal(by.get(IDS.crashy)?.state, "crashed");
	// A crashed session's threads come from its JSONL: working ones were interrupted.
	assert.deepEqual(by.get(IDS.crashy)?.counts, { working: 0, waiting: 0, done: 0, error: 0, interrupted: 1 });
	assert.equal(by.get(IDS.notes)?.state, "remote");
	assert.equal(by.get(IDS.old)?.state, "closed");
	assert.deepEqual(by.get(IDS.old)?.counts, { working: 0, waiting: 0, done: 1, error: 0, interrupted: 1 });
	assert.equal(by.get(IDS.old)?.repo, fx.repos.alpha);
	assert.equal(by.get(IDS.unnamed)?.name, "what does gamma do?");
	assert.equal(by.get(IDS.unnamed)?.unnamed, true);
	// Only the N most recent sessions that are not running.
	const few = sv.fleetSource(fx.env, { recent: 1 }).load();
	assert.deepEqual(few.filter((r) => r.state === "closed").map((r) => r.id), [IDS.old]);
});

test("source: a stale status of another host is not a remote row", { skip }, () => {
	const id = "00000000-0000-7000-8000-00000000d001";
	fx.writeStatus(id, { v: 1, sessionId: id, cwd: fx.repos.beta, host: "other-node", pid: 1, state: "idle", acked: true, since: "2026-11-01T00:00:00Z", heartbeat: "2026-11-01T00:00:00Z", subagents: {} });
	try {
		assert.ok(!sv.fleetSource(fx.env).load().some((r) => r.id === id));
	} finally {
		writeFileSync(join(fx.statusDir, `${id}.json`), "junk"); // unparsable: skipped
	}
	assert.ok(!sv.fleetSource(fx.env).load().some((r) => r.id === id));
});

// ---------------------------------------------------------------- render and keys

/** A JSONL line chained to the file's last entry (so it lands on the active branch). */
function appendChained(file: string, entry: Record<string, unknown>): void {
	const last = readFileSync(file, "utf8").trim().split("\n").at(-1)!;
	const parentId = JSON.parse(last).id ?? null;
	appendFileSync(file, `${JSON.stringify({ ...entry, id: `x${Math.random().toString(16).slice(2, 10)}`, parentId, timestamp: new Date().toISOString() })}\n`);
}
const assistantEntry = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

test("source: a closed session whose file keeps growing is not re-folded every tick, only once it settles", { skip }, () => {
	const f = buildFixture();
	try {
		const src = sv.fleetSource(f.env);
		const last = () => src.load().find((r) => r.id === IDS.old)!.lastAssistant;
		assert.equal(last(), "the old run finished");
		appendChained(f.files.old, assistantEntry("still going"));
		assert.equal(last(), "the old run finished", "a young file keeps its fold");
		appendChained(f.files.old, assistantEntry("still going 2"));
		assert.equal(last(), "the old run finished");
		const t = (Date.now() - 2 * 60_000) / 1000;
		utimesSync(f.files.old, t, t);
		assert.equal(last(), "still going 2", "refolded once it settled");
		// A file without a fold yet (no cache) is folded at once, young or not.
		const fresh = sv.fleetSource({ ...f.env, PI_FLEET_CACHE_DIR: join(f.root, "cache2") });
		appendChained(f.files.fork, assistantEntry("fork reply 2"));
		assert.equal(fresh.load().find((r) => r.id === IDS.fork)!.lastAssistant, "fork reply 2");
	} finally {
		f.cleanup();
	}
});

test("index: growth alone does not dirty the cache; save() is rate-limited unless a detail changed", () => {
	const f = buildFixture();
	try {
		const index = new SessionIndex(f.env);
		const t0 = Date.now();
		index.scan();
		index.save(t0);
		const cachePath = join(f.env.PI_FLEET_CACHE_DIR!, "index.json");
		const first = readFileSync(cachePath, "utf8");
		// Grows, same head: nothing to write even after the interval.
		appendChained(f.files.flare, assistantEntry("more"));
		index.scan();
		index.save(t0 + SAVE_INTERVAL_MS + 1);
		assert.equal(readFileSync(cachePath, "utf8"), first);
		// A head change (new name) is written, but not before the interval.
		appendChained(f.files.flare, { type: "session_info", name: "flare renamed" });
		index.scan();
		index.save(t0 + 1000);
		assert.equal(readFileSync(cachePath, "utf8"), first, "rate-limited");
		index.save(t0 + SAVE_INTERVAL_MS);
		const second = readFileSync(cachePath, "utf8");
		assert.equal(JSON.parse(second).files[f.files.flare].name, "flare renamed");
		// A new detail is written at once.
		const entry = index.scan().find((e) => e.id === IDS.flare)!;
		index.detail(entry);
		index.save(t0 + SAVE_INTERVAL_MS + 1);
		assert.ok(JSON.parse(readFileSync(cachePath, "utf8")).files[f.files.flare].detail, "detail written immediately");
	} finally {
		f.cleanup();
	}
});

test("index: repoOf caches the cwd fallback only when git exits non-zero, not on a signal", () => {
	const f = buildFixture();
	try {
		const bin = join(f.root, "fakegit");
		mkdirSync(bin, { recursive: true });
		const git = (script: string) => {
			writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
			chmodSync(join(bin, "git"), 0o755);
		};
		const index = new SessionIndex({ ...f.env, PATH: `${bin}:${process.env.PATH}` });
		git("kill -TERM $$");
		assert.equal(index.repoOf(f.repos.beta), f.repos.beta);
		git("echo /some/repo");
		assert.equal(index.repoOf(f.repos.beta), "/some/repo", "a killed git was not cached");
		git("exit 128");
		assert.equal(index.repoOf(f.repos.gamma), f.repos.gamma);
		git("echo /other/repo");
		assert.equal(index.repoOf(f.repos.gamma), f.repos.gamma, "not a repo is cached");
	} finally {
		f.cleanup();
	}
});

test("killSession: a confirmed kill on the control socket, scancel only when asked; never jumps or needs tmux", { skip }, async () => {
	const f = buildFixture();
	const server = createServer();
	try {
		// Any tmux call would be logged here: a kill must not jump to the pane.
		const bin = join(f.root, "faketmux");
		mkdirSync(bin, { recursive: true });
		const log = join(f.root, "tmux.log");
		writeFileSync(join(bin, "tmux"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
		chmodSync(join(bin, "tmux"), 0o755);
		const env = { ...f.env, PATH: `${bin}:${process.env.PATH}`, TMUX: "/tmp/fake,1,0", TMUX_PANE: "%1" };
		const ctlSock = join(f.root, "ctl.sock");
		const got: unknown[] = [];
		server.on("connection", (c) =>
			c.on("data", (d) => {
				got.push(JSON.parse(d.toString("utf8")));
				c.end('{"ok":true}\n');
			}),
		);
		await new Promise<void>((r) => server.listen(ctlSock, r));
		const row = (fields: Record<string, unknown> = {}) =>
			({
				id: "kill-me",
				name: "victim",
				cwd: "/",
				repo: "/",
				state: "running",
				live: "live",
				at: 0,
				counts: { working: 0, waiting: 0, done: 0, error: 0 },
				status: { ctlSock, host: "node1", tmux: { piPane: "%12" } },
				...fields,
			}) as unknown as import("../../pi/extensions/fleet/sessions-view.ts").SessionRow;
		const messages: string[] = [];
		const notify = (m: string) => messages.push(m);

		await sv.killSession(row(), false, notify, env);
		await sv.killSession(row(), true, notify, env);
		assert.deepEqual(got, [
			{ type: "kill", confirmed: true, scancel: false },
			{ type: "kill", confirmed: true, scancel: true },
		]);
		assert.deepEqual(messages, []);
		assert.equal(existsSync(log), false, "no tmux call (no jump)");

		// Dead or remote rows: nothing is sent.
		await sv.killSession(row({ live: "crashed", state: "crashed" }), false, notify, env);
		await sv.killSession(row({ live: "remote", state: "remote" }), false, notify, env);
		assert.equal(got.length, 2);
		assert.deepEqual(messages, ["pi-fleet: victim is not running", "pi-fleet: victim is running on node1"]);
		// Outside tmux too (the kill needs only the socket).
		await sv.killSession(row(), false, notify, f.env);
		assert.equal(got.length, 3);
	} finally {
		server.close();
		f.cleanup();
	}
});

