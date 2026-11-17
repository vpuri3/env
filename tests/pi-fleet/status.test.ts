// Reducer tests for pi/extensions/fleet/status.ts over synthetic pi event sequences.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	derive,
	initialModel,
	liveness,
	reduce,
	shouldBell,
	type Derived,
	type FleetEvent,
	type Model,
} from "../../pi/extensions/fleet/status.ts";

/** Run events, returning the derived state after each and the states that rang BEL. */
function run(events: FleetEvent[], start: Model = initialModel()) {
	let model = start;
	let before: Derived = derive(model);
	const states: string[] = [];
	const bells: string[] = [];
	for (const event of events) {
		model = reduce(model, event);
		const after = derive(model);
		if (shouldBell(before, after)) bells.push(after.state);
		states.push(after.sub ? `${after.state}(${after.sub})` : after.state);
		before = after;
	}
	return { model, states, bells, derived: derive(model) };
}

const settle = (runId: string, aborted = false): FleetEvent => ({ type: "agent_settled", runId, aborted });

test("starting, then idle once ready", () => {
	const { states, bells } = run([{ type: "session_start" }, { type: "ready" }]);
	assert.deepEqual(states, ["starting", "idle"]);
	assert.deepEqual(bells, []);
});

test("a run: running with tool sub, then waiting with BEL, then input acks to idle", () => {
	const { states, bells, model } = run([
		{ type: "session_start" },
		{ type: "ready" },
		{ type: "input" },
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "tool_start", id: "t1", name: "bash" },
		{ type: "tool_end", id: "t1" },
		{ type: "turn_end" },
		{ type: "turn_start" },
		{ type: "turn_end" },
		settle("r1"),
		{ type: "input" },
	]);
	assert.deepEqual(states, [
		"starting",
		"idle",
		"idle",
		"running",
		"running",
		"running(tool:bash)",
		"running",
		"running",
		"running",
		"running",
		"waiting",
		"idle",
	]);
	assert.deepEqual(bells, ["waiting"]);
	assert.equal(model.runId, "r1");
});

test("run id is minted once per run (agent_start again inside a run keeps it)", () => {
	const { model, derived } = run([
		{ type: "ready" },
		{ type: "agent_start" },
		{ type: "agent_start" }, // retry / follow-up inside the same run
		settle("r1"),
		{ type: "agent_start" },
	]);
	assert.equal(model.runId, "r2");
	assert.equal(derived.state, "running");
});

test("run-id guard: a late settle of an older run is ignored", () => {
	const { derived, model } = run([{ type: "ready" }, { type: "agent_start" }, settle("r1"), { type: "agent_start" }, settle("r1")]);
	assert.equal(model.runId, "r2");
	assert.equal(derived.state, "running");
	assert.equal(run([settle("r2")], model).derived.state, "waiting");
});

test("seen acks only the run it names", () => {
	const { model } = run([{ type: "ready" }, { type: "agent_start" }, settle("r1"), { type: "agent_start" }, settle("r2")]);
	assert.equal(run([{ type: "seen", runId: "r1" }], model).derived.state, "waiting");
	assert.equal(run([{ type: "seen", runId: "r2" }], model).derived.state, "idle");
	assert.equal(run([{ type: "seen" }], model).derived.state, "idle");
});

test("an aborted run settles acknowledged (idle, no BEL)", () => {
	const { states, bells } = run([{ type: "ready" }, { type: "agent_start" }, settle("r1", true)]);
	assert.deepEqual(states.at(-1), "idle");
	assert.deepEqual(bells, []);
});

test("a failed run settles as error with BEL; ack clears it; next run clears failure", () => {
	const r = run([{ type: "ready" }, { type: "agent_start" }, { type: "turn_end", error: true }, settle("r1")]);
	assert.equal(r.derived.state, "error");
	assert.deepEqual(r.bells, ["error"]);
	assert.equal(run([{ type: "input" }], r.model).derived.state, "idle");
	const next = run([{ type: "agent_start" }, { type: "turn_end" }, settle("r2")], r.model);
	assert.equal(next.derived.state, "waiting");
	// A retry that succeeds after an error turn is not a failed run.
	const retried = run([{ type: "ready" }, { type: "agent_start" }, { type: "turn_end", error: true }, { type: "turn_end" }, settle("r1")]);
	assert.equal(retried.derived.state, "waiting");
});

test("question from a UI prompt and from ask_user_question, back to running after", () => {
	const r = run([
		{ type: "ready" },
		{ type: "agent_start" },
		{ type: "prompt_start" },
		{ type: "prompt_end" },
		{ type: "tool_start", id: "a", name: "ask_user_question" },
		{ type: "tool_end", id: "a" },
	]);
	assert.deepEqual(r.states.slice(1), ["running", "question", "running", "question(ask)", "running"]);
	assert.deepEqual(r.bells, ["question", "question"]);
	// A prompt while idle (e.g. an extension dialog) is a question too.
	assert.equal(run([{ type: "ready" }, { type: "prompt_start" }]).derived.state, "question");
});

test("bg substate: idle or waiting main with working subagents shows running(bg N)", () => {
	const r = run([
		{ type: "ready" },
		{ type: "agent_start" },
		{ type: "subagents", working: 2 },
		settle("r1"),
		{ type: "subagents", working: 1 },
		{ type: "subagents", working: 0 },
	]);
	assert.deepEqual(r.states.slice(1), ["running", "running", "running(bg 2)", "running(bg 1)", "waiting"]);
	assert.deepEqual(r.bells, ["waiting"]);
	// Acknowledged while children work: idle once they finish, no BEL.
	const acked = run([{ type: "ready" }, { type: "subagents", working: 1 }, { type: "subagents", working: 0 }]);
	assert.deepEqual(acked.states, ["idle", "running(bg 1)", "idle"]);
	assert.deepEqual(acked.bells, []);
	// An error is not hidden by background work.
	const err = run([{ type: "ready" }, { type: "agent_start" }, { type: "turn_end", error: true }, { type: "subagents", working: 1 }, settle("r1")]);
	assert.equal(err.derived.state, "error");
});

test("liveness: crashed, remote, stale, live", () => {
	const now = Date.parse("2026-01-01T00:01:00Z");
	const fresh = "2026-01-01T00:00:30Z";
	const old = "2026-01-01T00:00:00Z".replace("00:00:00", "23:59:00").replace("2026-01-01", "2025-12-31");
	const alive = () => true;
	const dead = () => false;
	assert.equal(liveness({ host: "a", pid: 1, heartbeat: fresh }, { now, host: "a", pidAlive: alive }), "live");
	assert.equal(liveness({ host: "a", pid: 1, heartbeat: fresh }, { now, host: "a", pidAlive: dead }), "crashed");
	assert.equal(liveness({ host: "a", pid: 1, heartbeat: old }, { now, host: "a", pidAlive: alive }), "crashed");
	assert.equal(liveness({ host: "b", pid: 1, heartbeat: fresh }, { now, host: "a" }), "remote");
	assert.equal(liveness({ host: "b", pid: 1, heartbeat: old }, { now, host: "a" }), "stale");
});
