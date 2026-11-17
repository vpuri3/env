// Handler tests for pi/extensions/fleet/status.ts: register() against a fake `pi` and context,
// so the event wiring (not just the reducer) is checked without spawning pi. RPC mode: no BEL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, seenPath, writeSeen } from "../../pi/extensions/fleet/status.ts";
import { REGISTRY_ENTRY } from "../../pi/extensions/fleet/registry.ts";
import { fleetOf } from "../../pi/extensions/fleet/shared.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const assistant = (id: string, text: string, cost = 0, parentId: string | null = null) => ({
	type: "message",
	id,
	parentId,
	message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: cost } } },
});

/** Start a fake main session; returns the event driver and the status as it would be written. */
async function start(opts: { branch?: any[]; entries?: any[] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-fleet-handlers-"));
	const prevDir = process.env.PI_FLEET_STATE_DIR;
	process.env.PI_FLEET_STATE_DIR = join(root, "state");
	const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
	const pi: any = { on: (name: string, fn: any) => handlers.set(name, fn) };
	register(pi);
	const branch = opts.branch ?? [];
	const sessionId = "sess-1";
	const ctx: any = {
		mode: "rpc",
		cwd: root,
		model: undefined,
		getContextUsage: () => undefined,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => join(root, "s.jsonl"),
			getSessionName: () => undefined,
			getHeader: () => ({}),
			getEntries: () => opts.entries ?? branch,
			getBranch: () => branch,
		},
	};
	const emit = async (name: string, event: any = {}) => {
		await handlers.get(name)?.(event, ctx);
	};
	await emit("session_start", { reason: "startup" });
	await sleep(10); // the "ready" timer
	const status = () => fleetOf(pi).status!.current()!;
	const done = async () => {
		await emit("session_shutdown", { reason: "quit" });
		if (prevDir === undefined) delete process.env.PI_FLEET_STATE_DIR;
		else process.env.PI_FLEET_STATE_DIR = prevDir;
		rmSync(root, { recursive: true, force: true });
	};
	const seen = seenPath(sessionId, { PI_FLEET_STATE_DIR: join(root, "state") });
	const env = { ...process.env, PI_FLEET_STATE_DIR: join(root, "state") };
	return { emit, status, done, seen, env, sessionId };
}

test("crash+resume: subagents a dead process left running are paused, so a settle is waiting", async () => {
	const registry = {
		type: "custom",
		customType: REGISTRY_ENTRY,
		id: "reg",
		parentId: null,
		data: { version: 1, rootSessionId: "R", threads: [{ view: { path: "/a", state: "running", type: "coder" } }] },
	};
	const s = await start({ branch: [registry] });
	try {
		assert.deepEqual(s.status().subagents, { working: 0, waiting: 1, done: 0, error: 0 });
		await s.emit("agent_start");
		await s.emit("agent_settled", { aborted: false });
		assert.equal(s.status().state, "waiting"); // not running(bg 1)
		assert.equal(s.status().sub, undefined);
		assert.deepEqual(s.status().subagents, { working: 0, waiting: 1, done: 0, error: 0 });
	} finally {
		await s.done();
	}
});

test("a stale .seen from an acknowledged run does not ack the next run", async () => {
	const s = await start();
	try {
		await s.emit("agent_start");
		await s.emit("agent_settled", { aborted: false });
		assert.equal(s.status().state, "waiting");
		await s.emit("input", { source: "interactive" });
		assert.equal(s.status().state, "idle");
		// `pi-fleet seen` after the user already acked: nobody consumes it while idle.
		await writeSeen(s.sessionId, undefined, s.env);
		await s.emit("agent_start");
		await s.emit("agent_settled", { aborted: false });
		assert.equal(existsSync(s.seen), false);
		await sleep(1300); // a seen poll tick
		assert.equal(s.status().state, "waiting");
		assert.equal(s.status().runId, "r2");
		// A fresh `pi-fleet seen` still acks (async poll).
		await writeSeen(s.sessionId, "r2", s.env);
		for (let i = 0; i < 40 && s.status().state !== "idle"; i++) await sleep(100);
		assert.equal(s.status().state, "idle");
		assert.equal(existsSync(s.seen), false);
	} finally {
		await s.done();
	}
});

test("only prompts during a run are questions; an idle user dialog is not", async () => {
	const s = await start();
	try {
		assert.equal(s.status().state, "idle");
		await s.emit("ui_prompt_start");
		assert.equal(s.status().state, "idle");
		await s.emit("ui_prompt_end");
		await s.emit("agent_start");
		await s.emit("ui_prompt_start");
		assert.equal(s.status().state, "question");
		await s.emit("ui_prompt_end");
		assert.equal(s.status().state, "running");
	} finally {
		await s.done();
	}
});

test("startup scan: lastAssistant is the last on the branch; cost sums all entries", async () => {
	const a1 = assistant("m1", "first", 0.5);
	const a2 = assistant("m2", "second", 0.25, "m1");
	const offBranch = assistant("m3", "abandoned branch", 1, "m1");
	const user = { type: "message", id: "u", parentId: "m2", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
	const s = await start({ branch: [a1, a2, user], entries: [a1, a2, offBranch, user] });
	try {
		assert.equal(s.status().lastAssistant, "second");
		assert.equal(s.status().costUsd, 1.75);
	} finally {
		await s.done();
	}
});
