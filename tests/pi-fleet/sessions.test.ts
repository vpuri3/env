// Session index (registry.ts scan) and SessionsView / `/sessions` (design §6, §9; phase 4).
// Headless: rows come from a fixture sessions dir + status dir (support/sessions-fixture.ts),
// keys are fed to handleInput and render(width) is compared. pi-tui comes from pi's install
// through cli.ts's resolve hook, as in the dashboard; skipped without a pi install.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locatePiPackages, usePiPackages } from "../../pi/extensions/fleet/cli.ts";
import { SessionIndex, classifyHead, sessionDetail } from "../../pi/extensions/fleet/registry.ts";
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

function makeView(opts: { height?: number; currentId?: string; recent?: number } = {}) {
	const actions: Action[] = [];
	const view = new sv.SessionsView({
		source: sv.fleetSource(fx.env, { recent: opts.recent }),
		style: plainStyle,
		mode: "list",
		height: () => opts.height ?? 30,
		onAction: (a) => actions.push(a),
		requestRender: () => {},
		now: () => fx.now,
		host: "node1",
		currentId: opts.currentId,
	});
	view.refresh();
	return { view, actions };
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const screen = (view: { render(w: number): string[] }, width = 100) => view.render(width).map(strip);
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
	const { view } = makeView({ currentId: IDS.ckpt });
	assert.deepEqual(screen(view), [
		" pi-fleet  node1   3 live · 2 waiting                                             / filter   ? help ",
		" ▾ gamma (2)",
		"   ? flare refactor                 question 12m         $0.80 1◐",
		"   ○ what does gamma do?            2d ago                     ",
		" ▾ beta (3)",
		"   ✕ crashy                         crashed just now           1 interrupted",
		"   ⇢ notes                          live on other-node         ",
		"   ○ forked idea                    1d ago                     ",
		" ▾ alpha (3)",
		"›  ◐ ckpt restart (this)            done 2m ago          $0.40 ",
		"   ● physicsnemo sweep              bash 4m              $3.41 2w 1◐ 3✓",
		"   ○ start the old run              3h ago                     1✓ 1 interrupted",
		" enter open · space subagents · / filter · !@#& status · x kill · n new · q close",
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
	assert.deepEqual(screen(view).slice(1, -1), [" ▾ alpha (1)", "›  ◐ ckpt restart                   done 2m ago          $0.40 "]);
	assert.match(screen(view)[0]!, /\/ckpt▏ $/);
	press(view, "\x7f", "\x7f", "\x7f", "\x7f", "j", "k"); // backspace to empty, then j k are typed
	assert.equal(view.filter, "jk");
	press(view, "\x7f", "\x7f", ..."gamma does");
	assert.match(selectedLine(view), /what does gamma do/); // matches its last message
	press(view, "\x1b");
	assert.equal(view.typing, false);
	assert.equal(view.filter, "gamma does");
	press(view, "\x1b"); // clears the filter
	assert.equal(view.filter, "");
	assert.equal(screen(view).length, 13);
	press(view, "\x1b"); // closes
	assert.equal(actions.at(-1)?.type, "close");
	press(view, "/", "o", "l", "d", "\r");
	assert.equal((actions.at(-1) as { row: { id: string } }).row.id, IDS.old);
});

test("keys: ! @ # & status filters, 0 clears; x kill, n new, q close, ? help", { skip }, () => {
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
	assert.match(screen(view)[0]!, /\[error\] $/);
	press(view, "x");
	assert.deepEqual([actions.at(-1)?.type, (actions.at(-1) as { row: { id: string } }).row.id], ["kill", IDS.crashy]);
	press(view, "n");
	assert.deepEqual(actions.at(-1), { type: "new", cwd: fx.repos.beta });
	press(view, "0");
	assert.equal(names().length, 8);
	press(view, "?");
	assert.ok(screen(view).some((l) => l.includes("Space") && l.includes("subagents")));
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
