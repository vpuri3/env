// Handler tests for fleet/lifecycle.ts with status.ts: register() against a fake `pi` and
// context (RPC mode, no tmux), so the wiring is checked without spawning pi:
//   - a confirmed kill on the control socket (the deck list's `d`) asks nothing
//     and scancels only when asked; an unconfirmed one still opens the dialog;
//   - autonomous mode: set by /run-autonomously (or the old /leavemealone; the input text), cleared by /autonomous off,
//     restored from its session entry on resume.
// squeue/scancel are fakes on PATH; the status dir is temporary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTONOMOUS_ENTRY, SLURM_ENTRY, register as lifecycle, startsAutonomous } from "../../pi/extensions/fleet/lifecycle.ts";
import { fleetOf } from "../../pi/extensions/fleet/shared.ts";
import { register as status } from "../../pi/extensions/fleet/status.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake main session with both modules; `entries` are its session entries (resume). */
async function start(opts: { entries?: any[] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-fleet-lc-"));
	const saved = { dir: process.env.PI_FLEET_STATE_DIR, path: process.env.PATH, tmux: process.env.TMUX };
	process.env.PI_FLEET_STATE_DIR = join(root, "state");
	delete process.env.TMUX;
	const bin = join(root, "bin");
	mkdirSync(bin);
	const fake = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\necho "$*" >> "${root}/${name}.log"\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	fake("squeue", 'case "$*" in *8812345*) echo "8812345 RUNNING 1:02:11";; esac');
	fake("scancel", "");
	process.env.PATH = `${bin}:${process.env.PATH}`;

	const handlers = new Map<string, ((event: any, ctx: any) => Promise<unknown>)[]>();
	const commands = new Map<string, any>();
	const entries: any[] = [...(opts.entries ?? [])];
	const pi: any = {
		on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		events: { emit() {}, on() {} },
	};
	status(pi);
	lifecycle(pi);
	const calls: string[] = [];
	const notes: string[] = [];
	const ctx: any = {
		mode: "rpc",
		hasUI: true,
		cwd: root,
		model: undefined,
		getContextUsage: () => undefined,
		isIdle: () => true,
		abort: () => calls.push("abort"),
		shutdown: () => calls.push("shutdown"),
		ui: {
			select: async (title: string) => {
				calls.push(`select:${title.split("\n")[0]}`);
				return "Cancel";
			},
			notify: (m: string) => notes.push(m),
		},
		sessionManager: {
			getSessionId: () => "sess-lc",
			getSessionFile: () => join(root, "s.jsonl"),
			getSessionName: () => "lc",
			getHeader: () => ({}),
			getEntries: () => entries,
			getBranch: () => entries,
		},
	};
	const emit = async (name: string, event: any = {}) => {
		for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
	};
	await emit("session_start", { reason: "startup" });
	await sleep(10);
	const current = () => fleetOf(pi).status?.current();
	const command = (name: string, args = "") => commands.get(name).handler(args, ctx);
	const log = (name: string) => (existsSync(join(root, `${name}.log`)) ? readFileSync(join(root, `${name}.log`), "utf8") : "");
	const done = async () => {
		await emit("session_shutdown", { reason: "quit" });
		for (const [k, v] of [["PI_FLEET_STATE_DIR", saved.dir], ["PATH", saved.path], ["TMUX", saved.tmux]] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(root, { recursive: true, force: true });
	};
	return { pi, ctx, emit, calls, notes, entries, current, command, log, done };
}

const slurm = { type: "custom", customType: SLURM_ENTRY, data: { jobId: "8812345" } };
const message = { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } };

test("kill on the control socket: confirmed asks nothing and leaves Slurm jobs; scancel only when asked", async () => {
	for (const scancel of [false, true]) {
		const s = await start({ entries: [message, slurm] });
		try {
			const kill = fleetOf(s.pi).control.get("kill")!;
			assert.deepEqual(kill({ type: "kill", confirmed: true, scancel }), {});
			for (let i = 0; i < 100 && !s.calls.includes("shutdown"); i++) await sleep(10);
			assert.deepEqual(s.calls, ["shutdown"], "no dialog");
			assert.equal(s.log("scancel").trim(), scancel ? "8812345" : "");
			if (!scancel) assert.equal(s.log("squeue"), "", "squeue is not even asked");
		} finally {
			await s.done();
		}
	}
	// Not confirmed (or `scancel` without `confirmed`): the dialog as before; Cancel keeps pi.
	const s = await start({ entries: [message, slurm] });
	try {
		fleetOf(s.pi).control.get("kill")!({ type: "kill", scancel: true });
		for (let i = 0; i < 100 && !s.calls.length; i++) await sleep(10);
		await sleep(20);
		assert.deepEqual(s.calls, ['select:Kill session "lc"?']);
		assert.equal(s.log("scancel"), "");
	} finally {
		await s.done();
	}
});

test("autonomous: /run-autonomously sets it in the status file and the session; /autonomous off clears it", async () => {
	assert.equal(startsAutonomous("/run-autonomously"), true);
	assert.equal(startsAutonomous("/leavemealone"), true, "the old name, for sessions started before the rename");
	assert.equal(startsAutonomous("/run-autonomouslyx"), false);
	assert.equal(startsAutonomous("  /leavemealone back at 5"), true);
	assert.equal(startsAutonomous("/leavemealonex"), false);
	assert.equal(startsAutonomous("please /leavemealone"), false);
	const s = await start();
	try {
		assert.equal(s.current()?.autonomous, undefined);
		await s.emit("input", { text: "what is /run-autonomously?", source: "interactive" });
		assert.equal(s.current()?.autonomous, undefined);
		await s.command("autonomous");
		assert.match(s.notes.at(-1)!, /not autonomous/);
		await s.emit("input", { text: "/run-autonomously back at 5", source: "interactive" });
		assert.equal(s.current()?.autonomous, true);
		await s.command("autonomous");
		assert.match(s.notes.at(-1)!, /autonomous \(since \/run-autonomously\)/);
		await s.command("autonomous", "off");
		assert.equal(s.current()?.autonomous, undefined);
		assert.ok(!JSON.stringify(s.current()).includes("autonomous"), "the field is gone from the file");
		await s.command("autonomous", "sideways");
		assert.match(s.notes.at(-1)!, /usage: \/autonomous \[off\]/);
		assert.deepEqual(
			s.entries.filter((e) => e.customType === AUTONOMOUS_ENTRY).map((e) => e.data.on),
			[true, false],
		);
	} finally {
		await s.done();
	}
	// Resume: the last entry wins.
	const on = (v: boolean) => ({ type: "custom", customType: AUTONOMOUS_ENTRY, data: { on: v } });
	const resumed = await start({ entries: [on(true), on(false), on(true)] });
	try {
		assert.equal(resumed.current()?.autonomous, true);
	} finally {
		await resumed.done();
	}
	const ended = await start({ entries: [on(true), on(false)] });
	try {
		assert.equal(ended.current()?.autonomous, undefined);
	} finally {
		await ended.done();
	}
});
