// Tests for pi/extensions/fleet/title.ts: the pure helpers, the handler against a fake `pi`,
// and end-to-end a real `pi --mode rpc` with the faux provider (support/faux-provider.ts)
// answering the title requests. Everything lives in temp dirs; TMUX is unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	REFRESH_TURNS,
	TITLE_ENTRY,
	cleanTitle,
	generateTitle,
	pickTitleModels,
	register,
	titleInput,
	titleMode,
	titleState,
	wantsTitle,
} from "../../pi/extensions/fleet/title.ts";
import { fleetOf } from "../../pi/extensions/fleet/shared.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const fleetDir = join(here, "../../pi/extensions/fleet");
const fauxExt = join(here, "support/faux-provider.ts");
const piCmd = process.env.PI_FLEET_TEST_PI ?? "pi";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function havePi(): boolean {
	try {
		execFileSync(piCmd, ["--version"], { stdio: "ignore", env: { ...process.env, PI_CODING_AGENT_DIR: tmpdir() } });
		return true;
	} catch {
		return false;
	}
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 15_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const agent = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

// ---------------------------------------------------------------- helpers

const m = (provider: string, id: string, input?: number, extra: object = {}) => ({
	provider,
	id,
	...(input === undefined ? {} : { cost: { input, output: input * 4 } }),
	...extra,
});

test("pickTitleModels: override, then cheap models of the session's provider by price, then the session model", () => {
	const current = m("anthropic", "claude-opus-5-5", 5);
	const all = [
		current,
		m("anthropic", "claude-haiku-4-5", 1),
		m("anthropic", "claude-haiku-5-5", 0.1),
		m("openai", "gpt-5-nano", 0.05),
		m("anthropic", "claude-flash-image", 0.01, { type: "image" }),
	];
	const models = { getAvailable: () => all, find: (p: string, id: string) => all.find((x) => x.provider === p && x.id === id) };
	const ids = (list: any[]) => list.map((x) => `${x.provider}/${x.id}`);
	assert.deepEqual(ids(pickTitleModels(models, current)), ["anthropic/claude-haiku-5-5", "anthropic/claude-haiku-4-5", "anthropic/claude-opus-5-5"]);
	assert.deepEqual(ids(pickTitleModels(models, current, "openai/gpt-5-nano"))[0], "openai/gpt-5-nano");
	assert.deepEqual(ids(pickTitleModels(models, current, "nope/x")), ids(pickTitleModels(models, current)));
	assert.deepEqual(ids(pickTitleModels({ getAvailable: () => { throw new Error("x"); }, find: () => undefined }, current)), ["anthropic/claude-opus-5-5"]);
	assert.deepEqual(pickTitleModels(models, undefined), []);
});

test("titleInput: first user messages plus a short tail, truncated; none without a user message", () => {
	assert.equal(titleInput([agent("hi")]), undefined);
	assert.equal(titleInput([]), undefined);
	const long = "x".repeat(5000);
	const entries = [user(`fix the deck ${long}`), agent("ok"), user("and the colors"), ...Array.from({ length: 30 }, (_, i) => agent(`step ${i} ${long}`)), user("last ask")];
	const input = titleInput(entries)!;
	assert.ok(input.includes("User: fix the deck"));
	assert.ok(input.includes("User: and the colors"));
	assert.ok(input.includes("User: last ask"));
	assert.ok(input.includes("[…]"));
	assert.ok(input.length < 4500, `input is ${input.length} chars`);
	// A short session is not repeated.
	assert.equal(titleInput([user("hello"), agent("hi")])!.match(/hello/g)!.length, 1);
});

test("cleanTitle: one short line without quotes, prefixes or trailing punctuation", () => {
	assert.equal(cleanTitle('"Fix deck kill confirm."'), "Fix deck kill confirm");
	assert.equal(cleanTitle("Title: **Session titles for fleet**\n\nmore"), "Session titles for fleet");
	assert.equal(cleanTitle("\n  # Debug NFS heartbeat  \n"), "Debug NFS heartbeat");
	assert.equal(cleanTitle("Fix the deck's subagent rows so a live agent view opens in the session's pi"), "Fix the deck's subagent rows so a live agent view opens in the session's pi");
	const words = Array.from({ length: 20 }, (_, i) => `w${i + 1}`).join(" ");
	assert.equal(cleanTitle(words), Array.from({ length: 16 }, (_, i) => `w${i + 1}`).join(" "), "≤ 16 words");
	const long = `${"abcdefghij ".repeat(14)}end`;
	const cut = cleanTitle(long)!;
	assert.ok(cut.length <= 120 && !cut.endsWith(" ") && cut.split(" ").length <= 16, cut);
	assert.equal(cleanTitle("  \n"), undefined);
});

test("titleState/wantsTitle: only ours or unnamed; first title, then one refresh", () => {
	const info = (id: string, name: string) => ({ type: "session_info", id, name });
	const ours = (entryId: string, turns: number) => ({ type: "custom", customType: TITLE_ENTRY, data: { entryId, turns } });
	assert.deepEqual(titleState([]), { ours: true, name: undefined, titles: 0, lastTurns: 0 });
	assert.equal(wantsTitle(titleState([]), 0), false);
	assert.equal(wantsTitle(titleState([]), 1), true);
	const one = titleState([info("a", "Auto"), ours("a", 1)]);
	assert.equal(one.ours, true);
	assert.equal(wantsTitle(one, 2), false);
	assert.equal(wantsTitle(one, REFRESH_TURNS), true);
	assert.equal(wantsTitle(titleState([info("a", "Auto"), ours("a", 1), info("b", "Auto 2"), ours("b", REFRESH_TURNS)]), 50), false);
	// /name or --name: never ours, also after our own title, also when cleared.
	assert.equal(titleState([info("u", "mine")]).ours, false);
	assert.equal(titleState([info("a", "Auto"), ours("a", 1), info("u", "mine")]).ours, false);
	assert.equal(titleState([info("a", "Auto"), ours("a", 1), info("u", "")]).ours, false);
});

test("titleMode: default tui, on, off", () => {
	assert.equal(titleMode({}), "tui");
	assert.equal(titleMode({ PI_FLEET_TITLE: "on" }), "on");
	assert.equal(titleMode({ PI_FLEET_TITLE: "0" }), "off");
});

test("generateTitle: falls through failing models, times out, never throws", async () => {
	const a = m("p", "a"), b = m("p", "b"), c = m("p", "c");
	const replies: Record<string, () => Promise<any>> = {
		a: async () => ({ stopReason: "error", errorMessage: "boom", content: [] }),
		b: async () => {
			throw new Error("thrown");
		},
		c: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Good title." }] }),
	};
	const models = { streamSimple: (model: any) => ({ result: replies[model.id]! }) };
	const r = await generateTitle(models, [a, b, c], "input");
	assert.equal(r.title, "Good title");
	assert.equal(r.model, "p/c");
	assert.equal(r.errors.length, 2);
	const hang = {
		streamSimple: (_m: any, _c: any, opts: any) => ({
			result: () => new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve({ stopReason: "aborted", content: [] }))),
		}),
	};
	const t0 = Date.now();
	const keepAlive = setInterval(() => {}, 1000); // title.ts unrefs its timeout timer
	const r2 = await generateTitle(hang, [a, b], "input", { timeoutMs: 200 }).finally(() => clearInterval(keepAlive));
	assert.equal(r2.title, undefined);
	assert.ok(Date.now() - t0 < 2000);
	const sync = { streamSimple: () => { throw new Error("sync"); } };
	assert.equal((await generateTitle(sync as any, [a], "input")).title, undefined);
});

// ---------------------------------------------------------------- handler (fake pi)

function fakeSession(opts: { entries?: any[]; header?: any; mode?: string; reply?: (model: any) => Promise<any> } = {}) {
	const entries: any[] = opts.entries ?? [];
	let seq = 0;
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
	const calls: string[] = [];
	const pi: any = {
		on: (name: string, fn: any) => handlers.set(name, fn),
		setSessionName: (name: string) => entries.push({ type: "session_info", id: `i${++seq}`, name }),
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, id: `c${++seq}`, data }),
	};
	register(pi);
	const current = m("faux", "faux-1");
	const ctx: any = {
		mode: opts.mode ?? "tui",
		model: current,
		modelRegistry: {
			getAvailable: () => [current, m("faux", "faux-mini", 0.1)],
			find: () => undefined,
			streamSimple: (model: any) => {
				calls.push(model.id);
				return { result: () => (opts.reply ?? (async () => ({ stopReason: "stop", content: [{ type: "text", text: "Fake title" }] })))(model) };
			},
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getHeader: () => opts.header ?? {},
			getSessionId: () => "s1",
			getSessionName: () => undefined,
		},
	};
	const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	const start = async (main = true) => {
		fleetOf(pi).main = main;
		await emit("session_start", { reason: "startup" });
	};
	const names = () => entries.filter((e) => e.type === "session_info").map((e) => e.name);
	return { entries, emit, start, calls, names, pi };
}

test("handler: titles after the first settled run with the cheap model, once; refreshes once", async () => {
	const s = fakeSession({ entries: [user("make the deck show titles"), agent("ok")] });
	await s.start();
	await s.emit("agent_settled", { aborted: false });
	await waitFor("title", () => (s.names().length ? true : undefined));
	assert.deepEqual(s.calls, ["faux-mini"]);
	assert.deepEqual(s.names(), ["Fake title"]);
	const marker = s.entries.find((e) => e.customType === TITLE_ENTRY);
	assert.equal(marker.data.entryId, s.entries.find((e) => e.type === "session_info").id);
	await s.emit("agent_settled", { aborted: false });
	await sleep(20);
	assert.equal(s.calls.length, 1);
	for (let i = 1; i < REFRESH_TURNS; i++) s.entries.push(user(`more ${i}`), agent("ok"));
	await s.emit("agent_settled", { aborted: false });
	await waitFor("refresh", () => (s.calls.length === 2 ? true : undefined));
	await sleep(20);
	assert.equal(s.entries.filter((e) => e.customType === TITLE_ENTRY).length, 2);
	s.entries.push(user("even more"));
	await s.emit("agent_settled", { aborted: false });
	await sleep(20);
	assert.equal(s.calls.length, 2);
});

test("handler: a user-named session is never titled, even after an auto title", async () => {
	const named = fakeSession({ entries: [{ type: "session_info", id: "u", name: "mine" }, user("hello")] });
	await named.start();
	await named.emit("agent_settled", {});
	await sleep(20);
	assert.deepEqual(named.calls, []);
	assert.deepEqual(named.names(), ["mine"]);

	// The user renames while the model is still answering: the late title is dropped.
	let release!: () => void;
	const racing = fakeSession({
		entries: [user("hello")],
		reply: () => new Promise((r) => (release = () => r({ stopReason: "stop", content: [{ type: "text", text: "Late" }] }))),
	});
	await racing.start();
	await racing.emit("agent_settled", {});
	await waitFor("call", () => (racing.calls.length ? true : undefined));
	racing.entries.push({ type: "session_info", id: "u", name: "by hand" });
	release();
	await sleep(20);
	assert.deepEqual(racing.names(), ["by hand"]);
	assert.equal(racing.entries.some((e) => e.customType === TITLE_ENTRY), false);
});

test("handler: skips subagents, non-main sessions, RPC by default, sessions without a user message", async () => {
	const sub = fakeSession({ entries: [{ type: "custom", customType: "pi-subagent:thread:v1", data: {} }, user("hi")] });
	await sub.start();
	await sub.emit("agent_settled", {});
	const notMain = fakeSession({ entries: [user("hi")] });
	await notMain.start(false);
	await notMain.emit("agent_settled", {});
	const rpc = fakeSession({ entries: [user("hi")], mode: "rpc" });
	await rpc.start();
	await rpc.emit("agent_settled", {});
	const empty = fakeSession({ entries: [agent("hi")] });
	await empty.start();
	await empty.emit("agent_settled", {});
	await sleep(20);
	for (const s of [sub, notMain, rpc, empty]) assert.deepEqual(s.calls, []);
});

test("handler: failures are silent and retried a bounded number of times", async () => {
	const s = fakeSession({ entries: [user("hi")], reply: async () => ({ stopReason: "error", errorMessage: "nope", content: [] }) });
	await s.start();
	for (let i = 0; i < 6; i++) {
		await s.emit("agent_settled", {});
		await sleep(10);
	}
	assert.deepEqual(s.names(), []);
	// faux-mini then faux-1 per attempt, three attempts.
	assert.equal(s.calls.length, 6);
});

// ---------------------------------------------------------------- real pi (rpc)

function startPi(root: string, extraEnv: NodeJS.ProcessEnv, args: string[] = []) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_FLEET_STATE_DIR: join(root, "state"),
		PI_FLEET_TITLE: "on",
		PI_FLEET_TEST_CHEAP: "1",
		PI_FLEET_TEST_TITLE_LOG: join(root, "titles.jsonl"),
		PI_OFFLINE: "1",
		...extraEnv,
	};
	delete env.TMUX;
	delete env.TMUX_PANE;
	delete env.PI_FLEET_TEST_GATE;
	delete env.PI_FLEET_TITLE_MODEL;
	mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
	mkdirSync(join(root, "work"), { recursive: true });
	const child = spawn(
		piCmd,
		["--mode", "rpc", "-ne", "-e", fleetDir, "-e", fauxExt, "--offline", "--provider", "faux", "--model", "faux-1",
			"--session-dir", join(root, "sessions"), "-ns", "-np", "-nc", ...args],
		{ cwd: join(root, "work"), env, stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	const events: any[] = [];
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d;
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.trim()) events.push(JSON.parse(line));
		}
	});
	const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
	const send = (cmd: object) => child.stdin.write(JSON.stringify(cmd) + "\n");
	const statusDir = join(root, "state", "status");
	const status = (): any => {
		const f = existsSync(statusDir) ? readdirSync(statusDir).find((x) => x.endsWith(".json")) : undefined;
		if (!f) return undefined;
		try {
			return JSON.parse(readFileSync(join(statusDir, f), "utf8"));
		} catch {
			return undefined;
		}
	};
	const sessionEntries = (): any[] => {
		const dir = join(root, "sessions");
		const f = existsSync(dir) ? readdirSync(dir).find((x) => x.endsWith(".jsonl")) : undefined;
		if (!f) return [];
		return readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	};
	const titleCalls = (): any[] => {
		const f = join(root, "titles.jsonl");
		return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	};
	const settled = () => events.filter((e) => e.type === "agent_settled").length;
	const stop = async () => {
		child.stdin.end();
		return exited;
	};
	return { child, send, status, sessionEntries, titleCalls, settled, stop, stderr: () => stderr };
}

const skipPi = !havePi() && "pi not on PATH";

test("rpc pi: the first run gets a title from the cheap model; the status file carries it; /name wins", { skip: skipPi, timeout: 60_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-fleet-title-"));
	const p = startPi(root, {});
	try {
		p.send({ id: "p1", type: "prompt", message: "please make the deck show session titles" });
		const st = await waitFor("titled status", () => (p.status()?.name === "Faux session title" ? p.status() : undefined));
		assert.equal(st.state === "waiting" || st.state === "idle", true);
		const calls = p.titleCalls();
		assert.equal(calls.length, 1);
		assert.equal(calls[0].model, "faux/faux-mini");
		assert.ok(JSON.stringify(calls[0].context).includes("please make the deck show session titles"));
		await waitFor("marker on disk", () => (p.sessionEntries().some((e) => e.type === "custom" && e.customType === TITLE_ENTRY) ? true : undefined));
		const entries = p.sessionEntries();
		const info = entries.filter((e) => e.type === "session_info");
		assert.equal(info.length, 1);
		assert.equal(info[0].name, "Faux session title");
		assert.equal(entries.find((e) => e.customType === TITLE_ENTRY).data.entryId, info[0].id);

		// The user names it: later runs never touch the name again, also past the refresh point.
		p.send({ id: "n", type: "set_session_name", name: "my own name" });
		await waitFor("user name", () => (p.status()?.name === "my own name" ? true : undefined));
		for (let i = 0; i < REFRESH_TURNS; i++) {
			p.send({ id: `q${i}`, type: "prompt", message: `more ${i}` });
			await waitFor(`settle ${i}`, () => (p.settled() >= i + 2 ? true : undefined));
		}
		await sleep(500);
		assert.equal(p.titleCalls().length, 1);
		assert.equal(p.status()?.name, "my own name");
		assert.equal(await p.stop(), 0, p.stderr());
	} finally {
		if (p.child.exitCode === null) p.child.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
	assert.equal(p.stderr().match(/error/i), null, p.stderr());
});

test("rpc pi: --name is never replaced; failures and timeouts stay silent", { skip: skipPi, timeout: 90_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-fleet-title-"));
	const named = startPi(join(root, "named"), {}, ["--name", "given"]);
	const failing = startPi(join(root, "fail"), { PI_FLEET_TEST_TITLE: "fail", PI_FLEET_TITLE_DEBUG: join(root, "debug.log") });
	try {
		named.send({ id: "p1", type: "prompt", message: "hello" });
		failing.send({ id: "p1", type: "prompt", message: "hello" });
		await waitFor("named settle", () => (named.settled() >= 1 ? true : undefined));
		await waitFor("failed attempt logged", () => (existsSync(join(root, "debug.log")) ? true : undefined));
		await sleep(300);
		assert.deepEqual(named.titleCalls(), []);
		assert.equal(named.status()?.name, "given");
		assert.equal(failing.titleCalls().length, 2); // faux-mini, then the session model
		assert.equal(failing.status()?.name, undefined);
		assert.equal(failing.sessionEntries().some((e) => e.type === "session_info"), false);
		assert.match(readFileSync(join(root, "debug.log"), "utf8"), /faux title failure/);
		assert.equal(await named.stop(), 0, named.stderr());
		assert.equal(await failing.stop(), 0, failing.stderr());
	} finally {
		for (const p of [named, failing]) if (p.child.exitCode === null) p.child.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
	assert.equal(failing.stderr().match(/error|fail/i), null, failing.stderr());
});

test("rpc pi: a hanging title model does not block the session or its exit", { skip: skipPi, timeout: 60_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-fleet-title-"));
	const p = startPi(root, { PI_FLEET_TEST_TITLE: "hang" });
	try {
		p.send({ id: "p1", type: "prompt", message: "hello" });
		await waitFor("first settle", () => (p.settled() >= 1 ? true : undefined));
		await waitFor("title request", () => (p.titleCalls().length ? true : undefined));
		// The next run goes through while the title request hangs.
		p.send({ id: "p2", type: "prompt", message: "again" });
		await waitFor("second settle", () => (p.settled() >= 2 ? true : undefined), 5000);
		const t0 = Date.now();
		assert.equal(await p.stop(), 0, p.stderr());
		assert.ok(Date.now() - t0 < 10_000, "exit waited for the title request");
		assert.equal(p.sessionEntries().some((e) => e.type === "session_info"), false);
	} finally {
		if (p.child.exitCode === null) p.child.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
});

