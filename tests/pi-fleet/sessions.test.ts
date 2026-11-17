// Session index (registry.ts scan) and SessionsView, the dashboard (design §6, §9; phase 4).
// Headless: rows come from a fixture sessions dir + status dir (support/sessions-fixture.ts),
// keys are fed to handleInput and render(width) is compared. pi-tui comes from pi's install
// through cli.ts's resolve hook, as in the dashboard; skipped without a pi install.
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

type Action = import("../../pi/extensions/fleet/sessions-view.ts").SessionsAction;

function makeView(opts: { height?: number; recent?: number } = {}) {
	const actions: Action[] = [];
	const view = new sv.SessionsView({
		source: sv.fleetSource(fx.env, { recent: opts.recent }),
		style: plainStyle,
		height: () => opts.height ?? 30,
		onAction: (a) => actions.push(a),
		requestRender: () => {},
		now: () => fx.now,
		host: "node1",
	});
	view.refresh();
	return { view, actions };
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** At this width the list column is 80 wide (the preview right of `│`). */
const WIDE = 170;
/** The screen without the preview column and blank lines, lines right-trimmed. */
const screen = (view: { render(w: number): string[] }, width = WIDE) =>
	view
		.render(width)
		.map((l) => {
			const plain = strip(l);
			const bar = plain.indexOf("│");
			return (bar >= 0 ? plain.slice(0, bar) : plain).trimEnd();
		})
		.filter((l) => l !== "");
const selectedLine = (view: { render(w: number): string[] }) => screen(view).find((l) => l.startsWith("›")) ?? "";
const press = (view: { handleInput(d: string): void }, ...keys: string[]) => {
	for (const k of keys) view.handleInput(k);
};

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

test("render: groups by repo, ordered by urgency (? > ✕ > ◐ > ● > ○), counts per main", { skip }, () => {
	const { view } = makeView();
	const lines = screen(view);
	assert.match(lines[0]!, /^ pi-fleet {2}node1 {3}3 live · 2 waiting +● working ● auto ◐ needs you \? question ✕ error ○ idle$/);
	assert.deepEqual(lines.slice(1), [
		" ▾ gamma (2)",
		"›  ? flare refactor                 question 12m         $0.80 1◐",
		"   ◌ what does gamma do?            2d ago",
		" ▾ beta (3)",
		"   ✕ crashy                         crashed just now           1 interrupted",
		"   ⇢ notes                          live on other-node",
		"   ◌ forked idea                    1d ago",
		" ▾ alpha (3)",
		"   ◐ ckpt restart                   done 2m ago          $0.40",
		"   ● physicsnemo sweep              bash 4m              $3.41 2w 1◐ 3✓",
		"   ◌ start the old run              3h ago                     1✓ 1 interrupted",
		` ? question: needs your answer · a dialog · for 12m · $0.80 · subagents 1◐ · ${fx.repos.gamma}`,
		" enter open · ctrl+l interact · space subagents · d kill · a new · / filter · !@#& status · ? help · q close",
	]);
});

test("keys: j/k, arrows, ctrl+n/ctrl+p move; Enter opens; group headers collapse", { skip }, () => {
	const { view, actions } = makeView();
	assert.match(selectedLine(view), /flare refactor/); // first main row
	press(view, "j");
	assert.match(selectedLine(view), /what does gamma do/);
	press(view, "\x1b[B"); // down: the beta header
	assert.match(selectedLine(view), /▾ beta/);
	press(view, "\x0e"); // ctrl+n
	assert.match(selectedLine(view), /crashy/);
	press(view, "\x10", "k"); // ctrl+p, k
	assert.match(selectedLine(view), /what does gamma do/);
	press(view, "\x1b[A");
	assert.match(selectedLine(view), /flare refactor/);
	press(view, "\r");
	assert.equal(actions.at(-1)?.type, "open");
	assert.equal((actions.at(-1) as { row: { id: string } }).row.id, IDS.flare);
	press(view, "k", " "); // collapse gamma
	assert.match(selectedLine(view), /▸ gamma \(2\)/);
	assert.ok(!screen(view).some((l) => l.includes("flare refactor")));
	press(view, "\r"); // Enter on a header toggles it too
	assert.ok(screen(view).some((l) => l.includes("flare refactor")));
});

test("keys: Space shows a main's subagents; Enter on a subagent opens its main", { skip }, () => {
	const { view, actions } = makeView();
	while (!selectedLine(view).includes("physicsnemo sweep")) press(view, "j");
	press(view, " ");
	const lines = screen(view);
	const at = lines.findIndex((l) => l.includes("physicsnemo sweep"));
	// The fixture registry (phase 1), as pi-subagent-manager's readRegistry folds it.
	assert.deepEqual(
		lines.slice(at + 1, at + 7).map((l) => l.trim().split(/\s+/).slice(0, 4).join(" ")),
		["✓ type1 /agent-1 completed", "✓ type1 /agent-2 completed", "✓ type2 /agent-3 completed", "✓ type3 /agent-4 completed", "✓ type2 /agent-5 completed", "● type2 /agent-6 running"],
	);
	press(view, "j");
	assert.match(selectedLine(view), /\/agent-1/);
	press(view, "\r");
	assert.equal((actions.at(-1) as { row: { id: string } }).row.id, IDS.sweep);
	// Space on a subagent collapses its main and selects the main again.
	press(view, " ");
	assert.match(selectedLine(view), /physicsnemo sweep/);
	assert.ok(!screen(view).some((l) => l.includes("/agent-1")));
	// A session that is not running shows working threads as interrupted.
	while (!selectedLine(view).includes("start the old run")) press(view, "j");
	press(view, " ");
	assert.ok(screen(view).some((l) => /◌ coder \/runner\s+interrupted/.test(l)));
});

test("keys: / filters (j and k type), Enter opens the match, Esc stops typing, clears, closes", { skip }, () => {
	const { view, actions } = makeView();
	press(view, "/", "c", "k", "p", "t");
	assert.equal(view.filter, "ckpt");
	assert.deepEqual(screen(view).slice(1, -2), [" ▾ alpha (1)", "›  ◐ ckpt restart                   done 2m ago          $0.40"]);
	assert.match(screen(view)[0]!, /\/ckpt▏$/);
	press(view, "\x7f", "\x7f", "\x7f", "\x7f", "j", "k", "d", "a"); // backspace to empty, then j k d a are typed
	assert.equal(view.filter, "jkda");
	assert.equal(view.confirming(), undefined);
	assert.equal(actions.length, 0);
	press(view, "\x7f", "\x7f", "\x7f", "\x7f", ..."gamma does");
	assert.match(selectedLine(view), /what does gamma do/); // matches its last message
	press(view, "\x1b");
	assert.equal(view.typing, false);
	assert.equal(view.filter, "gamma does");
	press(view, "\x1b"); // clears the filter
	assert.equal(view.filter, "");
	assert.equal(screen(view).length, 14);
	press(view, "\x1b"); // closes
	assert.equal(actions.at(-1)?.type, "close");
	press(view, "/", "o", "l", "d", "\r");
	assert.equal((actions.at(-1) as { row: { id: string } }).row.id, IDS.old);
});

test("keys: ! @ # & status filters, 0 clears; d on a dead row, a new, q close, ? help", { skip }, () => {
	const { view, actions } = makeView();
	const names = () => screen(view).filter((l) => /^[ ›]  \S /.test(l)).map((l) => l.slice(5, 30).trim());
	press(view, "!");
	assert.deepEqual(names(), ["physicsnemo sweep"]);
	press(view, "@");
	assert.deepEqual(names(), ["flare refactor", "ckpt restart"]);
	press(view, "#");
	assert.deepEqual(names(), ["notes", "forked idea", "start the old run", "what does gamma do?"]);
	press(view, "&");
	assert.deepEqual(names(), ["crashy"]);
	assert.match(screen(view)[0]!, /\[error\]$/);
	press(view, "d"); // crashed: nothing to kill
	assert.equal(view.confirming(), undefined);
	assert.equal(actions.length, 0);
	assert.match(screen(view).at(-1)!, /crashy is not running/);
	press(view, "a");
	assert.deepEqual(actions.at(-1), { type: "new", cwd: fx.repos.beta });
	press(view, "x", "n"); // no longer bound
	assert.equal(actions.length, 1);
	press(view, "0");
	assert.equal(names().length, 8);
	press(view, "?");
	assert.ok(screen(view).some((l) => l.includes("Space") && l.includes("subagents")));
	assert.ok(screen(view).some((l) => /^ d\s+kill the session: y kill · s kill \+ scancel/.test(l)));
	assert.ok(screen(view).some((l) => l === " ● working ● auto ◐ needs you ? question ✕ error ○ idle"));
	press(view, "?", "q");
	assert.equal(actions.at(-1)?.type, "close");
	// Kitty CSI-u letters work like plain ones.
	const before = selectedLine(view);
	press(view, "\x1b[106u");
	assert.notEqual(selectedLine(view), before);
});

test("render: never wider than the width; scrolls to keep the selection visible", { skip }, () => {
	const { view } = makeView({ height: 6 });
	for (const width of [20, 40, 60, 100, 160]) {
		for (const line of view.render(width)) assert.ok(tui.visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
	}
	assert.equal(view.render(80).length, 6);
	for (let i = 0; i < 9; i++) press(view, "j");
	const lines = screen(view, 80);
	assert.equal(lines.length, 6);
	assert.ok(lines.some((l) => l.startsWith("›")));
	assert.match(lines[1]!, /↑$/);
});

test("runAction outside tmux tells the user instead of throwing", { skip }, async () => {
	const rows = sv.fleetSource(fx.env).load();
	const messages: string[] = [];
	const moved = await sv.runAction({ type: "open", row: rows.find((r) => r.id === IDS.old)! }, (m) => messages.push(m), { env: fx.env });
	assert.equal(moved, false);
	assert.match(messages[0]!, /not inside tmux \(pi --session .*\.jsonl\)/);
	assert.ok(existsSync(fx.files.old));
});

// ---------------------------------------------------------------- phase 4 review fixes

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

test("runAction kill: a confirmed kill on the control socket, scancel only when asked; never jumps or needs tmux", { skip }, async () => {
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

		assert.equal(await sv.runAction({ type: "kill", row: row(), scancel: false }, notify, { env }), false);
		assert.equal(await sv.runAction({ type: "kill", row: row(), scancel: true }, notify, { env }), false);
		assert.deepEqual(got, [
			{ type: "kill", confirmed: true, scancel: false },
			{ type: "kill", confirmed: true, scancel: true },
		]);
		assert.deepEqual(messages, []);
		assert.equal(existsSync(log), false, "no tmux call (no jump)");

		// Dead or remote rows: nothing is sent.
		await sv.runAction({ type: "kill", row: row({ live: "crashed", state: "crashed" }), scancel: false }, notify, { env });
		await sv.runAction({ type: "kill", row: row({ live: "remote", state: "remote" }), scancel: false }, notify, { env });
		assert.equal(got.length, 2);
		assert.deepEqual(messages, ["pi-fleet: victim is not running", "pi-fleet: victim is running on node1"]);
		// Outside tmux too (the kill needs only the socket).
		await sv.runAction({ type: "kill", row: row(), scancel: false }, notify, { env: f.env });
		assert.equal(got.length, 3);
	} finally {
		server.close();
		f.cleanup();
	}
});

test("escape sequences in names, cwds, hosts, thread paths and messages never reach the screen", { skip }, () => {
	const f = buildFixture();
	try {
		const id = "00000000-0000-7000-8000-00000000e001";
		const cwd = "/nonexistent/ev\x1b]0;pwn\x07il\x1b[2Jdir";
		const dir = join(f.sessionsDir, "--evil--");
		mkdirSync(dir, { recursive: true });
		const entries = [
			{ type: "session", version: 3, id, timestamp: "2026-11-17T10:00:00.000Z", cwd },
			{ type: "session_info", id: "e1", parentId: null, name: "bad\x1b[31mname\x07\x9b2J" },
			{
				type: "custom",
				id: "e2",
				parentId: "e1",
				customType: "pi-subagent:registry:v1",
				data: { version: 1, rootSessionId: id, threads: [{ view: { path: "/t\x1b[2Jx", parent: null, owner: "/root", type: "co\x07der", state: "running", task: "t\x1bask" } }] },
			},
			{ type: "message", id: "e3", parentId: "e2", message: { role: "assistant", content: [{ type: "text", text: "last\x1b[2J\x1b]52;c;Zm9v\x07 word" }] } },
		];
		const file = join(dir, `2026-11-17T10-00-00-000Z_${id}.jsonl`);
		writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
		const t = (Date.now() - 5 * 60_000) / 1000;
		utimesSync(file, t, t);
		const notes = JSON.parse(readFileSync(join(f.statusDir, `${IDS.notes}.json`), "utf8"));
		f.writeStatus(IDS.notes, { ...notes, host: "evil\x1b[2Jhost", name: "no\x1b]2;title\x07tes" });

		const lines: string[] = [];
		for (const mode of ["list", "dashboard"] as const) {
			const view = new sv.SessionsView({
				source: sv.fleetSource(f.env),
				style: plainStyle,
				mode,
				height: () => 40,
				onAction: () => {},
				requestRender: () => {},
				preview: mode === "dashboard" ? () => undefined : undefined,
				now: () => f.now,
				host: "node\x1b[2J1",
			});
			view.refresh();
			view.flash("oops\x1b[2J\x1b]0;x\x07 flash");
			lines.push(...view.render(130));
			for (let i = 0; i < 20; i++) {
				press(view, "j");
				if (selectedLine(view).includes("badname")) press(view, " ");
				lines.push(...view.render(130));
			}
		}
		const text = lines.map(strip).join("\n");
		for (const want of ["badname", "evildir", "co der /tx", "evilhost", "notes", "node1", "last word", "/nonexistent/evildir", "oops flash"]) {
			assert.ok(text.includes(want), `${JSON.stringify(want)} not shown`);
		}
		for (const l of lines.map(strip)) assert.doesNotMatch(l, /[\x00-\x1f\x7f-\x9f]/, JSON.stringify(l));
	} finally {
		f.cleanup();
	}
});

// ---------------------------------------------------------------- highlight, colors, status line, d / a

/** A view over its own fixture (statuses may be rewritten), with ANSI colors unless `style` says. */
function polishView(f: Fixture, opts: { style?: unknown; squeue?: (ids: string[]) => Promise<unknown> } = {}) {
	const actions: Action[] = [];
	let renders = 0;
	const view = new sv.SessionsView({
		source: sv.fleetSource(f.env),
		style: (opts.style ?? sv.ansiStyle) as never,
		height: () => 30,
		onAction: (a) => actions.push(a),
		requestRender: () => renders++,
		preview: () => undefined,
		now: () => f.now,
		host: "node1",
		squeue: opts.squeue as never,
	});
	view.refresh();
	const select = (name: string) => {
		for (let i = 0; i < 40; i++) press(view, "k");
		for (let i = 0; i < 40 && !strip(listPart(view.render(120).find((l) => strip(l).startsWith("›")) ?? "")).includes(name); i++) press(view, "j");
		const line = listPart(view.render(120).find((l) => strip(l).startsWith("›")) ?? "");
		assert.ok(strip(line).includes(name), `selected ${name}`);
		return line;
	};
	return { view, actions, select, renders: () => renders };
}
/** A dashboard line without its preview column (left of the `│`). */
const listPart = (line: string) => (line.includes("│") ? line.slice(0, line.indexOf("│")) : line);
const rowOf = (lines: string[], name: string) => lines.map(listPart).find((l) => strip(l).includes(` ${name}`)) ?? "";

test("highlight: the selected row (only it) gets a full-width background", { skip }, () => {
	const f = buildFixture();
	try {
		for (const [width, listW] of [[120, 60], [80, 80]] as const) {
			// Side by side (the list is half the screen) and stacked (the list is the full width).
			const { view, select } = polishView(f);
			select("physicsnemo sweep");
			const lines = view.render(width);
			const hit = lines.filter((l) => l.includes(sv.ANSI_SELECTED_BG));
			assert.equal(hit.length, 1, `${width}`);
			assert.match(strip(hit[0]!), /^›\s+● physicsnemo sweep/);
			// Padded to the list width; every reset inside re-opens the background.
			const sel = hit[0]!.slice(0, hit[0]!.lastIndexOf("\x1b[49m") + 5);
			assert.equal(tui.visibleWidth(sel), listW, `${width}`);
			for (const m of sel.matchAll(/\x1b\[(?:0|49)?m/g)) {
				if (m.index! + m[0].length === sel.length) continue;
				assert.ok(sel.startsWith(sv.ANSI_SELECTED_BG, m.index! + m[0].length), `${width}: bg re-opened after ${JSON.stringify(m[0])}`);
			}
			// A group header highlights too.
			press(view, "k", "k");
			assert.ok(view.render(width).filter((l) => l.includes(sv.ANSI_SELECTED_BG)).some((l) => strip(l).includes("▾ alpha")), `${width}`);
			view.dispose();
		}
	} finally {
		f.cleanup();
	}
});

test("colors: glyph + state text by tone; autonomous working is green `auto`, an autonomous question stays magenta", { skip }, () => {
	const f = buildFixture();
	try {
		const { view } = polishView(f);
		const lines = view.render(120);
		const fg = (code: string, text: string) => `\x1b[${code}m${text}\x1b[39m`;
		// sweep: working (bright blue), glyph and detail; the name stays uncolored.
		assert.ok(rowOf(lines, "physicsnemo sweep").includes(fg("94", "●")));
		assert.ok(rowOf(lines, "physicsnemo sweep").includes(fg("94", "bash 4m")));
		assert.ok(rowOf(lines, "physicsnemo sweep").includes(" physicsnemo sweep "));
		assert.ok(rowOf(lines, "flare refactor").includes(`\x1b[1m${fg("35", "?")}\x1b[22m`), "question: magenta bold");
		assert.ok(rowOf(lines, "ckpt restart").includes(fg("33", "◐")), "waiting: yellow");
		assert.ok(rowOf(lines, "ckpt restart").includes(fg("33", "done 2m ago")));
		assert.ok(rowOf(lines, "crashy").includes(fg("31", "✕")), "crashed: red");
		assert.ok(rowOf(lines, "start the old run").includes(fg("38;5;250", "◌")), "closed: grey");
		assert.ok(rowOf(lines, "notes").includes(fg("38;5;250", "⇢")), "remote: grey");
		assert.ok(lines[0]!.includes(fg("32", "● auto")), "legend in the header");

		const sweep = JSON.parse(readFileSync(join(f.statusDir, `${IDS.sweep}.json`), "utf8"));
		f.writeStatus(IDS.sweep, { ...sweep, autonomous: true });
		const flare = JSON.parse(readFileSync(join(f.statusDir, `${IDS.flare}.json`), "utf8"));
		f.writeStatus(IDS.flare, { ...flare, autonomous: true });
		view.refresh();
		const auto = view.render(120);
		assert.ok(rowOf(auto, "physicsnemo sweep").includes(fg("32", "●")));
		assert.ok(rowOf(auto, "physicsnemo sweep").includes(fg("32", "auto bash 4m")));
		assert.ok(rowOf(auto, "flare refactor").includes(`\x1b[1m${fg("35", "?")}\x1b[22m`));
		assert.ok(rowOf(auto, "flare refactor").includes("question 12m"));
	} finally {
		f.cleanup();
	}
});

test("status line: the selected session in full; a repo header; a subagent", { skip }, () => {
	const f = buildFixture();
	try {
		const { view, select } = polishView(f, { style: plainStyle });
		const statusLine = () => view.render(200).map(strip).at(-2)!;
		select("physicsnemo sweep");
		assert.equal(statusLine(), ` ● working · tool bash · for 4m · $3.41 · subagents 2w 1◐ 3✓ · ${f.repos.alpha} · “sweeping”`);
		const sweep = JSON.parse(readFileSync(join(f.statusDir, `${IDS.sweep}.json`), "utf8"));
		f.writeStatus(IDS.sweep, { ...sweep, autonomous: true });
		view.refresh();
		assert.match(statusLine(), /^ ● working autonomously · tool bash · for 4m · /);
		select("flare refactor");
		assert.match(statusLine(), /^ \? question: needs your answer · a dialog · for 12m · \$0\.80 · subagents 1◐ · /);
		select("start the old run");
		assert.match(statusLine(), /^ ◌ not running · last active 3h ago · subagents 1✓ 1 interrupted · .*alpha\/sub · “the old run finished”$/);
		select("crashy");
		assert.match(statusLine(), /^ ✕ crashed · died just now · subagents 1 interrupted · /);
		press(view, "k");
		assert.equal(statusLine(), ` beta · ${f.repos.beta} · 3 sessions, 0 live · a: new session here`);
		select("physicsnemo sweep");
		press(view, " ", "j");
		assert.match(statusLine(), /^ ✓ completed · type1 \/agent-1 · of physicsnemo sweep/);
	} finally {
		f.cleanup();
	}
});

test("d: inline confirm with subagents and Slurm jobs; y kills, s kills + scancel, n/Esc cancel; j does not move", { skip }, async () => {
	const f = buildFixture();
	try {
		const sweep = JSON.parse(readFileSync(join(f.statusDir, `${IDS.sweep}.json`), "utf8"));
		f.writeStatus(IDS.sweep, { ...sweep, slurmJobs: ["8812345", "8812346"] });
		let answer: (jobs: unknown) => void = () => {};
		const asked: string[][] = [];
		const squeue = (ids: string[]) => {
			asked.push(ids);
			return new Promise((r) => (answer = r));
		};
		const { view, actions, select, renders } = polishView(f, { style: plainStyle, squeue });
		const bottom = () => view.render(200).map(strip).slice(-2);
		select("physicsnemo sweep");
		press(view, "d");
		assert.equal(view.confirming()?.row.id, IDS.sweep);
		assert.deepEqual(asked, [["8812345", "8812346"]]);
		assert.deepEqual(bottom(), [
			" Kill physicsnemo sweep? agent working · 2 subagents working · Slurm 8812345 8812346 (checking)",
			" y kill · s kill+scancel · n/Esc cancel",
		]);
		const before = renders();
		answer([{ id: "8812345", state: "RUNNING", time: "1:02" }]);
		await new Promise((r) => setTimeout(r, 10));
		assert.ok(renders() > before, "re-rendered when squeue answered");
		assert.equal(bottom()[0], " Kill physicsnemo sweep? agent working · 2 subagents working · Slurm 8812345 running");
		press(view, "j", "a", "x"); // other keys do nothing while asking
		assert.equal(view.confirming()?.row.id, IDS.sweep);
		assert.equal(actions.length, 0);
		press(view, "\x1b");
		assert.equal(view.confirming(), undefined);
		assert.match(strip(view.render(200).find((l) => strip(l).startsWith("›"))!), /physicsnemo sweep/);
		press(view, "d", "n");
		assert.equal(view.confirming(), undefined);
		assert.equal(actions.length, 0);

		press(view, "d");
		answer([{ id: "8812345", state: "RUNNING", time: "1:02" }]);
		await new Promise((r) => setTimeout(r, 10));
		press(view, "s");
		assert.deepEqual(actions.map((a) => [a.type, (a as { row?: { id: string } }).row?.id, (a as { scancel?: boolean }).scancel]), [["kill", IDS.sweep, true]]);
		assert.match(bottom()[1]!, /killing physicsnemo sweep and its Slurm jobs…/);
		press(view, "d", "y");
		assert.deepEqual(actions.at(-1), { type: "kill", row: view.selectedRow(), scancel: false });

		// No Slurm jobs: no `s` offered, and s does nothing.
		select("ckpt restart");
		press(view, "d");
		assert.deepEqual(bottom(), [" Kill ckpt restart?", " y kill · n/Esc cancel"]);
		press(view, "s");
		assert.ok(view.confirming());
		press(view, "y");
		assert.equal((actions.at(-1) as { row: { id: string } }).row.id, IDS.ckpt);

		// The session ends while asking: the confirm goes away.
		press(view, "d");
		const ckpt = JSON.parse(readFileSync(join(f.statusDir, `${IDS.ckpt}.json`), "utf8"));
		f.writeStatus(IDS.ckpt, { ...ckpt, pid: 999_999_999 });
		view.refresh();
		assert.equal(view.confirming(), undefined);
		assert.match(bottom()[1]!, /ckpt restart is not running/);

		// Closed, crashed and remote rows: a flash, no confirm.
		const n = actions.length;
		for (const [name, flash] of [["start the old run", /is not running/], ["crashy", /is not running/], ["notes", /runs on other-node: kill it there/]] as const) {
			select(name);
			press(view, "d");
			assert.equal(view.confirming(), undefined, name);
			assert.match(bottom()[1]!, flash);
		}
		press(view, "k");
		press(view, "d"); // a repo header
		assert.equal(view.confirming(), undefined);
		assert.equal(actions.length, n);
	} finally {
		f.cleanup();
	}
});

test("a: a new session in the repo of the row, or of the repo header", { skip }, () => {
	const f = buildFixture();
	try {
		const { view, actions, select } = polishView(f, { style: plainStyle });
		select("start the old run"); // cwd alpha/sub, repo alpha
		press(view, "a");
		assert.deepEqual(actions.at(-1), { type: "new", cwd: f.repos.alpha });
		select("forked idea");
		press(view, "a");
		assert.deepEqual(actions.at(-1), { type: "new", cwd: f.repos.beta });
		for (let i = 0; i < 20 && !/^›▾ gamma/.test(strip(view.render(120).find((l) => strip(l).startsWith("›"))!)); i++) press(view, "k");
		assert.match(strip(view.render(120).find((l) => strip(l).startsWith("›"))!), /^›▾ gamma/);
		press(view, "a");
		assert.deepEqual(actions.at(-1), { type: "new", cwd: f.repos.gamma });
	} finally {
		f.cleanup();
	}
});

// ---------------------------------------------------------------- one view: ctrl+l, joined, subagent previews

test("ctrl+l: interact with a live session of this host; other rows flash `not live`", { skip }, () => {
	const f = buildFixture();
	try {
		const { view, actions, select } = polishView(f, { style: plainStyle });
		const statusBar = () => strip(view.render(120).at(-1)!);
		select("physicsnemo sweep");
		press(view, "\x0c");
		assert.equal(actions.at(-1)?.type, "interact");
		assert.equal((actions.at(-1) as { row: { id: string } }).row.id, IDS.sweep);
		// ckpt is live but has no tmux pane in its status file.
		for (const [name, why] of [["start the old run", /start the old run is not live$/], ["crashy", /crashy is not live$/], ["notes", /notes is not live here \(on other-node\)$/], ["ckpt restart", /ckpt restart is not live in tmux$/]] as const) {
			const n = actions.length;
			select(name);
			press(view, "\x0c");
			assert.equal(actions.length, n, name);
			assert.match(statusBar(), why);
		}
		// On a subagent row: its main.
		select("physicsnemo sweep");
		press(view, " ", "j", "\x0c");
		assert.equal((actions.at(-1) as { row: { id: string } }).row.id, IDS.sweep);
	} finally {
		f.cleanup();
	}
});

test("joined: the list takes the whole pane, the joined row is marked, no capture runs", { skip }, async () => {
	const f = buildFixture();
	try {
		let captures = 0;
		const view = new sv.SessionsView({
			source: sv.fleetSource(f.env),
			style: plainStyle,
			height: () => 20,
			onAction: () => {},
			requestRender: () => {},
			preview: () => (captures++, Promise.resolve({ kind: "frame", lines: ["CAPTURED"] })),
			now: () => f.now,
			host: "node1",
		});
		view.refresh();
		view.setJoined(IDS.sweep);
		await view.updatePreview();
		assert.equal(captures, 0);
		// 64 columns: the dashboard pane once a pane took 60% of a 160-column window.
		const lines = view.render(64).map(strip);
		assert.equal(lines.length, 20);
		assert.ok(!lines.some((l) => l.includes("│") || l.startsWith("──")), "no preview column or rule");
		assert.ok(lines.some((l) => /^ ⇥ ● physicsnemo sweep/.test(l)), lines.join("\n"));
		assert.match(lines.at(-1)!, /ctrl\+l focus\/switch · C-h back/);
		view.setJoined(undefined);
		await view.updatePreview();
		assert.equal(captures, 1);
		assert.ok(view.render(64).map(strip).some((l) => l.startsWith("── ")), "the preview is back (stacked)");
	} finally {
		f.cleanup();
	}
});

test("subagent preview: the tail of its transcript (text, dim thinking, one line per tool call), sanitized", { skip }, async () => {
	const f = buildFixture();
	try {
		const style = { fg: (c: string, t: string) => (c === "dim" ? `<dim>${t}</dim>` : t), bold: (t: string) => t };
		const { view, select } = polishView(f, { style });
		const preview = () =>
			view
				.render(170)
				.map((l) => (l.includes("│") ? l.slice(l.indexOf("│") + 1).trimEnd() : ""))
				.filter(Boolean);
		select("start the old run");
		press(view, " ", "j");
		// /runner has no sessionFile in the registry: the index finds its subagent file (thread entry).
		await view.updatePreview();
		let p = preview();
		assert.match(p[0]!, /^── coder \/runner · interrupted /);
		assert.equal(p[1], "<dim> task: task of /runner</dim>");
		assert.equal(p[2], "<dim> no assistant output yet</dim>");

		// Now the registry names a session file (pi-subagent-manager's view.sessionFile).
		const file = join(f.root, "runner.jsonl");
		writeFileSync(file, readFileSync(new URL("./fixtures/subagent-transcript.jsonl", import.meta.url)));
		appendChained(f.files.old, { type: "custom", customType: "pi-subagent:registry-delta:v1", data: { version: 1, rootSessionId: IDS.old, changes: [{ path: "/runner", view: { sessionFile: file } }] } });
		const old = (f.now - 3 * 3600_000) / 1000;
		utimesSync(f.files.old, old, old); // settled: refolded
		view.refresh();
		await view.updatePreview();
		p = preview();
		assert.deepEqual(p.slice(2), [
			"<dim> I should look at</dim>",
			"<dim> the logs first</dim>",
			" Checking the logs.",
			" ✓ bash tail -n 5 run.log",
			" ✗ read /w/missing.py",
			" <dim>…</dim> grep loss",
			" The run finished:",
			" loss 0.12",
		]);
		for (const l of view.render(170)) assert.ok(!/\x1b(?!\[[0-9;]*m)|\x07/.test(l), JSON.stringify(l));
		// A short preview keeps the end.
		const short = new sv.SessionsView({
			source: sv.fleetSource(f.env),
			style: plainStyle,
			height: () => 8,
			onAction: () => {},
			requestRender: () => {},
			now: () => f.now,
		});
		short.refresh();
		for (let i = 0; i < 40 && !strip(listPart(short.render(170).find((l) => l.startsWith("›")) ?? "")).includes("start the old run"); i++) press(short, "j");
		press(short, " ", "j");
		await short.updatePreview();
		const body = short.render(170).slice(1, -2).map((l) => strip(l.slice(l.indexOf("│") + 1)).trimEnd());
		assert.deepEqual(body.slice(2), [" … grep loss", " The run finished:", " loss 0.12"]);
		view.dispose();
		short.dispose();
	} finally {
		f.cleanup();
	}
});
