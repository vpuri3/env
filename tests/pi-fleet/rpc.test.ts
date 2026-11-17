// End-to-end: a real `pi --mode rpc` with only the fleet extension and a faux provider.
// Checks starting/idle → running → waiting (r1, unacked) → seen → idle → second run r2 →
// input acks → clean quit deletes the status file. Everything lives in a temp dir:
// PI_CODING_AGENT_DIR, PI_FLEET_STATE_DIR and --session-dir; TMUX is unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSeen } from "../../pi/extensions/fleet/status.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const fleetDir = join(here, "../../pi/extensions/fleet");
const fauxExt = join(here, "support/faux-provider.ts");
const piCmd = process.env.PI_FLEET_TEST_PI ?? "pi";

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
		await new Promise((r) => setTimeout(r, 50));
	}
}

test("rpc pi: running → waiting, seen, ack, quit", { skip: !havePi() && "pi not on PATH", timeout: 60_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-fleet-test-"));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_FLEET_STATE_DIR: join(root, "state"),
		PI_FLEET_TEST_GATE: join(root, "gate"),
		PI_OFFLINE: "1",
	};
	delete env.TMUX;
	delete env.TMUX_PANE;
	mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
	mkdirSync(join(root, "work"));
	const statusDir = join(root, "state", "status");
	const child = spawn(
		piCmd,
		["--mode", "rpc", "-ne", "-e", fleetDir, "-e", fauxExt, "--offline", "--provider", "faux", "--model", "faux-1",
			"--session-dir", join(root, "sessions"), "-ns", "-np", "-nc"],
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
			if (line.trim()) events.push(JSON.parse(line)); // stdout must stay pure JSONL (no BEL)
		}
	});
	const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
	const send = (cmd: object) => child.stdin.write(JSON.stringify(cmd) + "\n");
	const statusFile = () => readdirSync(statusDir).filter((f) => f.endsWith(".json")).map((f) => join(statusDir, f))[0];
	const status = (): any => {
		const f = existsSync(statusDir) ? statusFile() : undefined;
		if (!f) return undefined;
		try {
			return JSON.parse(readFileSync(f, "utf8"));
		} catch {
			return undefined; // mid-rename; atomic writes make this rare
		}
	};
	const settledCount = () => events.filter((e) => e.type === "agent_settled").length;

	try {
		// Session start writes the file right away.
		const first = await waitFor("status file", () => status());
		assert.equal(first.v, 1);
		assert.equal(first.pid, child.pid);
		assert.equal(first.cwd, join(root, "work"));
		assert.ok(["starting", "idle"].includes(first.state));
		assert.equal(statSync(statusDir).mode & 0o777, 0o700);
		assert.equal(statSync(statusFile()!).mode & 0o777, 0o600);
		assert.equal(statSync(join(root, "state")).mode & 0o777, 0o700);
		assert.equal(first.tmux, undefined);
		await waitFor("idle", () => (status()?.state === "idle" ? true : undefined));
		// Not a git repo: repo falls back to cwd.
		await waitFor("repo", () => (status()?.repo === join(root, "work") ? true : undefined));

		// Run 1 blocks in the faux provider until the gate file exists.
		send({ id: "p1", type: "prompt", message: "hello" });
		const running = await waitFor("running", () => (status()?.state === "running" ? status() : undefined));
		assert.equal(running.runId, "r1");
		assert.equal(running.acked, true);
		writeFileSync(env.PI_FLEET_TEST_GATE!, "");
		await waitFor("agent_settled event", () => (settledCount() >= 1 ? true : undefined));
		const waiting = await waitFor("waiting", () => (status()?.state === "waiting" ? status() : undefined));
		assert.equal(waiting.runId, "r1");
		assert.equal(waiting.acked, false);
		assert.equal(waiting.lastAssistant, "done: the faux model answered");
		assert.equal(waiting.model, "faux/faux-1");
		assert.deepEqual(waiting.subagents, { working: 0, waiting: 0, done: 0, error: 0 });
		assert.ok(waiting.sessionFile?.startsWith(join(root, "sessions")));
		assert.equal(waiting.sessionId, statusFile()!.split("/").at(-1)!.replace(/\.json$/, ""));

		// `pi-fleet seen` for an older run does nothing; for this run it acks.
		await writeSeen(waiting.sessionId, "r0", env);
		await new Promise((r) => setTimeout(r, 1500));
		assert.equal(status().state, "waiting");
		await writeSeen(waiting.sessionId, "r1", env);
		const idle = await waitFor("idle after seen", () => (status()?.state === "idle" ? status() : undefined));
		assert.equal(idle.acked, true);
		assert.equal(existsSync(join(statusDir, `${waiting.sessionId}.seen`)), false);

		// Run 2 (gate open): new run id; the next user input acks it.
		send({ id: "p2", type: "prompt", message: "again" });
		await waitFor("second settle", () => (settledCount() >= 2 ? true : undefined));
		const second = await waitFor("waiting r2", () => (status()?.runId === "r2" && status()?.state === "waiting" ? status() : undefined));
		assert.equal(second.acked, false);
		send({ id: "n", type: "set_session_name", name: "fleet test" });
		await waitFor("name", () => (status()?.name === "fleet test" ? true : undefined));

		// Clean quit deletes the status file.
		child.stdin.end();
		assert.equal(await exited, 0, stderr);
		assert.deepEqual(readdirSync(statusDir), []);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
	assert.equal(stderr.match(/error/i), null, stderr);
});

test("rpc pi: a subagent session writes no status file", { skip: !havePi() && "pi not on PATH", timeout: 60_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-fleet-test-"));
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_FLEET_STATE_DIR: join(root, "state"), PI_OFFLINE: "1" };
	delete env.TMUX;
	delete env.TMUX_PANE;
	mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
	mkdirSync(join(root, "sessions"));
	const id = "00000000-0000-7000-8000-0000000000aa";
	const file = join(root, "sessions", `child_${id}.jsonl`);
	const ts = new Date().toISOString();
	writeFileSync(
		file,
		[
			{ type: "session", version: 3, id, timestamp: ts, cwd: root, parentSession: join(root, "sessions", "parent.jsonl") },
			{ type: "session_info", id: "00000001", parentId: null, timestamp: ts, name: "coder /fix" },
			{ type: "custom", customType: "pi-subagent:thread:v1", id: "00000002", parentId: "00000001", timestamp: ts, data: { rootId: "R", threadPath: "/fix", inheritedCount: 0 } },
		].map((e) => JSON.stringify(e)).join("\n") + "\n",
	);
	const child = spawn(piCmd, ["--mode", "rpc", "-ne", "-e", fleetDir, "-e", fauxExt, "--offline", "--provider", "faux", "--model", "faux-1", "--session", file, "-ns", "-np", "-nc"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
	try {
		child.stdin.write(JSON.stringify({ id: "s", type: "get_state" }) + "\n");
		await waitFor("get_state response", () => (out.includes('"command":"get_state"') ? true : undefined));
		assert.ok(out.includes(id), "pi opened the subagent session");
		await new Promise((r) => setTimeout(r, 500));
		const dir = join(root, "state", "status");
		assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
		child.stdin.end();
		assert.equal(await exited, 0);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
});
