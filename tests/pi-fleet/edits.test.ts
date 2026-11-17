// pi-fleet edit delivery (design §11, phase 7): pure policy/diff/format functions of
// pi/extensions/fleet/edits.ts, then its wiring against a fake pi (events, handlers,
// sendMessage, setWidget). The end-to-end test with a real RPC pi and a headless nvim is
// edits-rpc.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	combine,
	CUSTOM_TYPE,
	deliveryFor,
	formatEdit,
	formatMessage,
	guardBlocks,
	guardReason,
	MAX_DIFF_LINES,
	registerEdits,
	reverseApply,
	unifiedDiff,
	widgetLines,
	WIDGET_KEY,
	type Save,
} from "../../pi/extensions/fleet/edits.ts";
import { USER_EDIT_EVENT } from "../../pi/extensions/fleet/nvim.ts";
import { fleetOf } from "../../pi/extensions/fleet/shared.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- policy

test("deliveryFor: the §11 table", () => {
	// note: idle → note; working on that path → steer; working elsewhere → note
	assert.equal(deliveryFor("note", false, false), "note");
	assert.equal(deliveryFor("note", false, true), "note");
	assert.equal(deliveryFor("note", true, true), "steer");
	assert.equal(deliveryFor("note", true, false), "note");
	// steer: always
	for (const running of [false, true]) for (const touched of [false, true]) assert.equal(deliveryFor("steer", running, touched), "steer");
});

test("guardBlocks: edit/write after a user save, until a later read", () => {
	assert.equal(guardBlocks("write", undefined, undefined), false);
	assert.equal(guardBlocks("write", 10, undefined), true);
	assert.equal(guardBlocks("edit", 10, undefined), true);
	assert.equal(guardBlocks("edit", 10, 5), true);
	assert.equal(guardBlocks("edit", 10, 11), false);
	assert.equal(guardBlocks("read", 10, undefined), false);
	assert.equal(guardBlocks("bash", 10, undefined), false);
	assert.match(guardReason("src/a.py", new Date(2026, 0, 1, 14, 3, 5).getTime(), "write"), /^Blocked: the user edited src\/a\.py in their editor at 14:03:05, after you last read it\. Read the file again, then redo this write against its current content\.$/);
});

// ---------------------------------------------------------------- diffs

const haveNvim = spawnSync("nvim", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;

/** vim.text.diff(a, b) as pi_fleet.lua computes it. */
function vimDiffs(pairs: [string, string][]): string[] {
	const dir = mkdtempSync(join(tmpdir(), "pfe-"));
	try {
		writeFileSync(join(dir, "in.json"), JSON.stringify(pairs));
		const lua = `local p = vim.json.decode(io.open(${JSON.stringify(join(dir, "in.json"))}):read("*a"))
local out = {}
for i, ab in ipairs(p) do out[i] = vim.text.diff(ab[1], ab[2], { result_type = "unified", ctxlen = 3 }) end
io.open(${JSON.stringify(join(dir, "out.json"))}, "w"):write(vim.json.encode(out))`;
		writeFileSync(join(dir, "x.lua"), lua);
		const r = spawnSync("nvim", ["--headless", "--clean", "-c", `luafile ${join(dir, "x.lua")}`, "-c", "qa!"], { encoding: "utf8", timeout: 20_000 });
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(spawnSync("cat", [join(dir, "out.json")], { encoding: "utf8" }).stdout);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

const CASES: [string, string][] = [
	["a\nb\nc\n", "a\nB\nc\nd\n"],
	["", "x\ny\n"],
	["x\ny\n", ""],
	[lines(10), lines(10).replace("line 2\n", "").replace("line 10\n", "")],
	[lines(40), lines(40).replace("line 5\n", "five\nfive b\n").replace("line 30\n", "")],
	[lines(40), "top\n" + lines(40) + "bottom\n"],
	["a", "a\nb"],
	[lines(20), lines(20, (i) => (i % 3 ? `line ${i}` : `changed ${i}`))],
];

test("reverseApply undoes vim.text.diff; unifiedDiff round-trips", { skip: !haveNvim && "nvim not installed" }, () => {
	const diffs = vimDiffs(CASES);
	CASES.forEach(([a, b], i) => {
		const back = reverseApply(b, diffs[i]);
		assert.equal(back?.replace(/\n$/, ""), a.replace(/\n$/, ""), `case ${i}`);
		const ours = unifiedDiff(a, b)!;
		assert.equal(reverseApply(b, ours)?.replace(/\n$/, ""), a.replace(/\n$/, ""), `own diff case ${i}`);
	});
	// Mismatch → undefined
	assert.equal(reverseApply("a\nX\nc\nd\n", diffs[0]), undefined);
	// Our hunks match vim's for a simple change
	assert.equal(unifiedDiff(CASES[0][0], CASES[0][1]), "@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n");
	assert.equal(unifiedDiff("a\n", "a\n"), "");
});

function save(diff: string, extra: Partial<Save> = {}): Save {
	const added = diff.split("\n").filter((l) => l.startsWith("+")).length;
	const removed = diff.split("\n").filter((l) => l.startsWith("-")).length;
	return { diff, added, removed, created: false, truncated: false, ...extra };
}

test("combine: one net diff over several saves; revert drops; mismatch lists saves", { skip: !haveNvim && "nvim not installed" }, () => {
	const v0 = lines(30);
	const v1 = v0.replace("line 3\n", "THREE\n");
	const v2 = v1.replace("line 20\n", "TWENTY\nmore\n");
	const [d1, d2, dRevert] = vimDiffs([[v0, v1], [v1, v2], [v2, v0]]);
	const net = combine([save(d1), save(d2)], v2)!;
	assert.equal(net.diffs.length, 1);
	assert.deepEqual([net.added, net.removed], [3, 2]);
	assert.equal(reverseApply(v2, net.diffs[0]), v0);
	// edit and undo → nothing to tell
	assert.equal(combine([save(d1), save(d2), save(dRevert)], v0), undefined);
	// the file changed underneath (e.g. unreadable / other content) → save by save
	const listed = combine([save(d1), save(d2)], "unrelated\n")!;
	assert.equal(listed.diffs.length, 2);
	assert.deepEqual([listed.added, listed.removed], [3, 2]);
	// single empty save drops, single created save does not
	assert.equal(combine([save("")], undefined), undefined);
	assert.ok(combine([save("", { created: true })], undefined));
	// too large to diff in nvim: empty diff + truncated is a change, never dropped
	const big = combine([save("", { truncated: true, added: 0, removed: 0 })], undefined)!;
	assert.equal(big.truncated, true);
	assert.ok(combine([save(d1), save("", { truncated: true })], undefined));
});

test("formatEdit: exact text, cap at MAX_DIFF_LINES, truncated summary", () => {
	const d = "@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n";
	assert.equal(
		formatEdit("src/foo.py", { diffs: [d], added: 2, removed: 1, created: false, truncated: false }),
		"The user edited src/foo.py in their editor (+2 −1):\n```diff\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n```",
	);
	assert.match(formatEdit("n.py", { diffs: ["@@ -0,0 +1 @@\n+x\n"], added: 1, removed: 0, created: true, truncated: false }), /^The user created n\.py in their editor \(\+1 −0\):/);
	const atCap = "@@ -1,0 +1,119 @@\n" + Array.from({ length: MAX_DIFF_LINES - 1 }, (_, i) => `+${i}`).join("\n") + "\n";
	assert.match(formatEdit("f", { diffs: [atCap], added: 119, removed: 0, created: false, truncated: false }), /```diff/);
	const over = "@@ -10,0 +10,120 @@\n" + Array.from({ length: MAX_DIFF_LINES }, (_, i) => `+${i}`).join("\n") + "\n@@ -300,2 +420,1 @@\n-x\n-y\n+z\n";
	assert.equal(
		formatEdit("f.py", { diffs: [over], added: 121, removed: 2, created: false, truncated: false }),
		"The user edited f.py in their editor (+121 −2). The diff is too long to show here (125 lines); changed lines: 10–129, 420. Read the file before you continue working on it.",
	);
	assert.equal(
		formatEdit("f.py", { diffs: ["@@ -5,1 +5,1 @@\n-a\n+b\n"], added: 900, removed: 3, created: false, truncated: true }),
		"The user edited f.py in their editor (+900 −3). The diff is too large to show here; changed lines include: 5. Read the file before you continue working on it.",
	);
	assert.equal(
		formatEdit("huge.bin", { diffs: [""], added: 0, removed: 0, created: false, truncated: true }),
		"The user edited huge.bin in their editor (+0 −0). The diff is too large to show here. Read the file before you continue working on it.",
	);
	assert.match(formatEdit("f", { diffs: [d, d], added: 4, removed: 2, created: false, truncated: false }), /^The user edited f in their editor \(\+4 −2\), over 2 saves:\nSave 1 of 2:\n```diff\n/);
	assert.equal(
		formatMessage(["P"], ["a.py"]),
		"P\n\nRead a.py again before you edit or write it: pi blocks edits and writes to a file the user changed after you last read it.",
	);
	assert.equal(formatMessage(["P"], []), "P");
	assert.deepEqual(widgetLines([{ display: "foo.py", added: 3, removed: 1, mode: "note" }]), ["✎ foo.py (+3 −1) goes with your next message"]);
	assert.equal(widgetLines([]), undefined);
	assert.equal(widgetLines(Array.from({ length: 7 }, (_, i) => ({ display: `f${i}`, added: 1, removed: 0, mode: "note" as const })))!.length, 6);
});

// ---------------------------------------------------------------- wiring (fake pi)

function fakePi() {
	const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const sent: { message: any; options: any }[] = [];
	const widgets: (string[] | undefined)[] = [];
	let idle = true;
	const pi: any = {
		on(name: string, fn: any) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		events: {
			on(name: string, fn: any) {
				listeners.set(name, [...(listeners.get(name) ?? []), fn]);
				return () => {};
			},
			emit(name: string, data: unknown) {
				for (const fn of listeners.get(name) ?? []) fn(data);
			},
		},
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
		},
	};
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pfe-")));
	const ctx: any = {
		cwd: root,
		hasUI: true,
		isIdle: () => idle,
		ui: { setWidget: (key: string, lines: string[] | undefined) => key === WIDGET_KEY && widgets.push(lines) },
	};
	const fire = async (name: string, event: any = {}) => {
		let result: any;
		for (const fn of handlers.get(name) ?? []) result = (await fn(event, ctx)) ?? result;
		return result;
	};
	return {
		pi, ctx, root, sent, widgets, fire,
		setIdle: (v: boolean) => (idle = v),
		edit: (path: string, mode: "note" | "steer", diff: string, extra: object = {}) => {
			const s = save(diff);
			pi.events.emit(USER_EDIT_EVENT, { type: "user_edit", v: 1, mode, path, diff, added: s.added, removed: s.removed, created: false, truncated: false, session: "", time: Date.now(), ...extra });
		},
	};
}

async function setup() {
	const f = fakePi();
	fleetOf(f.pi).main = true;
	registerEdits(f.pi, { noteMs: 60, steerMs: 30 });
	await f.fire("session_start", { reason: "startup" });
	return f;
}

const D1 = "@@ -1,1 +1,1 @@\n-old\n+new\n";

test("wiring: idle note waits in the widget and goes with the next run", async () => {
	const f = await setup();
	try {
		const a = join(f.root, "a.py");
		writeFileSync(a, "new\n");
		f.edit(a, "note", D1);
		assert.deepEqual(f.widgets.at(-1), ["✎ a.py (+1 −1) goes with your next message"]);
		await sleep(120);
		assert.equal(f.sent.length, 0, "a note never steers while idle");
		const r = await f.fire("before_agent_start", { messageType: "user", prompt: "hi" });
		assert.equal(r.message.customType, CUSTOM_TYPE);
		assert.equal(r.message.display, true);
		assert.equal(
			r.message.content,
			"The user edited a.py in their editor (+1 −1):\n```diff\n@@ -1,1 +1,1 @@\n-old\n+new\n```\n\nRead a.py again before you edit or write it: pi blocks edits and writes to a file the user changed after you last read it.",
		);
		assert.equal(f.widgets.at(-1), undefined, "widget cleared");
		assert.equal(await f.fire("before_agent_start", { messageType: "user", prompt: "again" }), undefined, "delivered once");
		// an empty save (no change) is ignored
		f.edit(a, "note", "");
		assert.equal(await f.fire("before_agent_start", { messageType: "user", prompt: "x" }), undefined);
		// too large to diff: delivered as a summary
		f.edit(a, "note", "", { truncated: true, added: 5000, removed: 2 });
		const big = await f.fire("before_agent_start", { messageType: "user", prompt: "x" });
		assert.match(big.message.content, /^The user edited a\.py in their editor \(\+5000 −2\)\. The diff is too large to show here\. Read the file/);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("wiring: running note on another path waits; a message typed meanwhile carries it", async () => {
	const f = await setup();
	try {
		const a = join(f.root, "a.py");
		f.setIdle(false);
		await f.fire("agent_start");
		f.edit(a, "note", D1);
		await sleep(120);
		assert.equal(f.sent.length, 0);
		const r = await f.fire("input", { text: "also do X", source: "interactive", streamingBehavior: "steer" });
		assert.equal(r.action, "transform");
		assert.match(r.text, /^also do X\n\nThe user edited a\.py in their editor \(\+1 −1\):\n```diff\n/);
		// idle input is left alone (before_agent_start attaches instead)
		f.edit(a, "note", D1);
		assert.equal(await f.fire("input", { text: "y", source: "interactive" }), undefined);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("wiring: running note on a touched path steers; reading a pending path steers it", async () => {
	const f = await setup();
	try {
		const a = join(f.root, "a.py");
		const b = join(f.root, "b.py");
		writeFileSync(a, "new\n");
		writeFileSync(b, "new\n");
		f.setIdle(false);
		await f.fire("agent_start");
		await f.fire("tool_call", { toolName: "read", toolCallId: "r1", input: { path: "a.py" } });
		f.edit(a, "note", D1);
		await sleep(120);
		assert.equal(f.sent.length, 1);
		assert.deepEqual(f.sent[0].options, { deliverAs: "steer", triggerTurn: true });
		assert.match(f.sent[0].message.content, /^The user edited a\.py/);
		// b is pending (not touched); the agent reads b → steered right then
		f.edit(b, "note", D1);
		await sleep(120);
		assert.equal(f.sent.length, 1);
		await f.fire("tool_call", { toolName: "read", toolCallId: "r2", input: { path: b } });
		assert.equal(f.sent.length, 2);
		assert.match(f.sent[1].message.content, /^The user edited b\.py/);
		// after settle the touched set is cleared
		f.setIdle(true);
		await f.fire("agent_settled", {});
		f.setIdle(false);
		await f.fire("agent_start");
		f.edit(a, "note", D1);
		await sleep(120);
		assert.equal(f.sent.length, 2);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("wiring: :w!! steers (triggerTurn), coalesced per path", async () => {
	const f = await setup();
	try {
		const a = join(f.root, "a.py");
		writeFileSync(a, "1\n2\nB\n");
		f.edit(a, "steer", "@@ -1,3 +1,3 @@\n 1\n-x\n+2\n a\n");
		// a quick second :w! of the same file joins the pending steer
		f.edit(a, "note", "@@ -1,3 +1,3 @@\n 1\n 2\n-a\n+B\n");
		assert.deepEqual(f.widgets.at(-1), ["✎ a.py (+2 −2) goes to pi now"]);
		await sleep(80);
		assert.equal(f.sent.length, 1, "one steer for both saves");
		assert.deepEqual(f.sent[0].options, { deliverAs: "steer", triggerTurn: true });
		const content: string = f.sent[0].message.content;
		assert.match(content, /^The user edited a\.py in their editor \(\+2 −2\):\n```diff\n@@ -1,3 \+1,3 @@\n 1\n-x\n-a\n\+2\n\+B\n```/);
		assert.equal(f.widgets.at(-1), undefined);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("wiring: write guard blocks edit/write until the agent reads the file", async () => {
	const f = await setup();
	try {
		const a = join(f.root, "a.py");
		writeFileSync(a, "new\n");
		f.edit(a, "note", D1);
		f.setIdle(false);
		const blocked = await f.fire("tool_call", { toolName: "write", toolCallId: "w1", input: { path: "a.py", content: "x" } });
		assert.equal(blocked.block, true);
		assert.match(blocked.reason, /^Blocked: the user edited a\.py in their editor at \d\d:\d\d:\d\d, after you last read it\. Read the file again, then redo this write against its current content\.$/);
		assert.equal((await f.fire("tool_call", { toolName: "edit", toolCallId: "e1", input: { path: a } })).block, true);
		// a failed read does not clear it
		await f.fire("tool_call", { toolName: "read", toolCallId: "r0", input: { path: a } });
		await f.fire("tool_result", { toolName: "read", toolCallId: "r0", isError: true });
		assert.equal((await f.fire("tool_call", { toolName: "edit", toolCallId: "e2", input: { path: a } })).block, true);
		await sleep(5);
		await f.fire("tool_call", { toolName: "read", toolCallId: "r1", input: { path: a } });
		await f.fire("tool_result", { toolName: "read", toolCallId: "r1", isError: false });
		assert.equal(await f.fire("tool_call", { toolName: "edit", toolCallId: "e3", input: { path: a } }), undefined);
		// another save re-arms it
		await sleep(5);
		f.edit(a, "note", D1);
		assert.equal((await f.fire("tool_call", { toolName: "write", toolCallId: "w2", input: { path: a } })).block, true);
		// other files are never blocked
		assert.equal(await f.fire("tool_call", { toolName: "write", toolCallId: "w3", input: { path: "other.py" } }), undefined);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

test("wiring: nothing in a non-main session", async () => {
	const f = fakePi();
	registerEdits(f.pi, { noteMs: 10, steerMs: 10 });
	await f.fire("session_start", {});
	const a = join(f.root, "a.py");
	f.edit(a, "steer", D1);
	await sleep(40);
	assert.equal(f.sent.length, 0);
	assert.equal(await f.fire("tool_call", { toolName: "write", toolCallId: "w", input: { path: a } }), undefined);
	assert.equal(await f.fire("before_agent_start", {}), undefined);
	rmSync(f.root, { recursive: true, force: true });
});
