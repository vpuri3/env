// pi-fleet phase 3 (design §7, §8, §10, §13): /new, /resume → new window, /fork guard, /kill
// dialog, Slurm capture, duplicate guard, control socket, pairing of a hand-started pi.
//
// A real `pi --mode rpc` (faux provider) runs with TMUX/TMUX_PANE pointing into a throwaway
// tmux server (`tmux -L fleettest-…`, the harness refuses the default socket and the CLI runs
// with PI_FLEET_TMUX_GUARD=1). Windows opened by /new run the stub pi (PI_FLEET_PI_CMD).
// squeue/scancel are fakes on PATH. State, runtime, agent and HOME dirs are temporary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killPlan, submittedJobs } from "../../pi/extensions/fleet/lifecycle.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../..");
const fleetDir = join(repo, "pi/extensions/fleet");
const stubPi = join(here, "support/stub-pi.sh");
const piCmd = process.env.PI_FLEET_TEST_PI ?? "pi";

function have(cmd: string, args: string[]): boolean {
	return spawnSync(cmd, args, { stdio: "ignore", timeout: 10_000, env: { ...process.env, PI_CODING_AGENT_DIR: tmpdir() } }).status === 0;
}
const haveTmux = have("tmux", ["-V"]);
const haveNvim = have("nvim", ["--version"]);
const havePi = have(piCmd, ["--version"]);
const skipRpc = (!haveTmux || !havePi) && "tmux or pi missing";
const skipTui = (!haveTmux || !havePi || !haveNvim) && "tmux, pi or nvim missing";

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Test-only extension: a faux model that runs `bash` when asked to "submit", and a command that
// fakes two working subagents in pi-subagent-manager's registry format.
const FAUX_EXT = `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
export default function (pi) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const reply = async (context) => {
		faux.appendResponses([reply]);
		const last = context.messages.at(-1);
		const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b) => b.text ?? "").join("");
		if (last?.role === "user" && text.includes("submit")) {
			return fauxAssistantMessage(fauxToolCall("bash", { command: "echo Submitted batch job 8812345" }), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("done");
	};
	faux.setResponses([reply]);
	pi.registerProvider(faux.provider);
	pi.registerCommand("fake-subagents", {
		handler: async (_args, ctx) => {
			const view = (path) => ({ view: { path, type: "coder", state: "running", task: "t" } });
			pi.appendEntry("pi-subagent:registry:v1", { version: 1, rootSessionId: ctx.sessionManager.getSessionId(), threads: [view("/sweep-operator"), view("/coder-x")] });
		},
	});
}
`;

let serial = 0;

/** A throwaway tmux server plus temp dirs; pi children get TMUX/TMUX_PANE for its first pane. */
class Rig {
	readonly root = mkdtempSync(join(tmpdir(), "pfl-"));
	readonly label = `fleettest-${process.pid}-l${++serial}`;
	readonly stub = join(this.root, "stub");
	readonly statusDir = join(this.root, "state", "status");
	readonly sessions = join(this.root, "sessions");
	readonly work = join(this.root, "work");
	readonly fauxExt = join(this.root, "faux-ext.ts");
	readonly env: NodeJS.ProcessEnv;
	socket = "";
	firstPane = "";

	constructor() {
		for (const d of ["stub", "work", "home", "agent", "fakebin", "sessions"]) mkdirSync(join(this.root, d));
		writeFileSync(this.fauxExt, FAUX_EXT);
		const fake = (name: string, body: string) => {
			const p = join(this.root, "fakebin", name);
			writeFileSync(p, `#!/bin/sh\n${body}\n`);
			chmodSync(p, 0o755);
		};
		fake("squeue", `echo "$*" >> "${this.root}/squeue.log"\ncase "$*" in *8812345*) echo "8812345 RUNNING 1:02:11";; esac`);
		fake("scancel", `echo "$*" >> "${this.root}/scancel.log"`);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: join(this.root, "home"),
			PATH: `${join(this.root, "fakebin")}:${join(repo, "bin")}:${process.env.PATH}`,
			PI_CODING_AGENT_DIR: join(this.root, "agent"),
			PI_FLEET_STATE_DIR: join(this.root, "state"),
			PI_FLEET_RUNTIME_DIR: join(this.root, "run"),
			PI_FLEET_STUB_DIR: this.stub,
			PI_FLEET_PI_CMD: stubPi,
			PI_FLEET_BIN: join(repo, "bin/pi-fleet"),
			PI_FLEET_NVIM_CMD: "nvim --clean -n",
			PI_FLEET_TMUX_GUARD: "1",
			PI_OFFLINE: "1",
			SHELL: "/bin/sh",
		};
		for (const k of ["TMUX", "TMUX_PANE", "PI_FLEET_SESSION", "PI_FLEET_TMUX_SOCKET", "PI_FLEET_TEST_GATE"]) delete env[k];
		this.env = env;
		this.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "main", "-x", "200", "-y", "50", "sh"]);
		this.socket = this.tmux(["display-message", "-p", "#{socket_path}"]);
		assert.notEqual(basename(this.socket), "default");
		this.firstPane = this.tmux(["display-message", "-p", "-t", "main", "#{pane_id}"]);
	}

	tmux(args: string[]): string {
		const full = ["-L", this.label, ...args];
		if (!full[1] || full[1] === "default") throw new Error("refusing the default tmux socket");
		return execFileSync("tmux", full, { env: this.env, encoding: "utf8" }).replace(/\n$/, "");
	}
	tryTmux(args: string[]): string | undefined {
		try {
			return this.tmux(args);
		} catch {
			return undefined;
		}
	}
	/** Env of a process "inside" this tmux server, in pane `pane`. */
	tmuxEnv(pane = this.firstPane): NodeJS.ProcessEnv {
		return { ...this.env, TMUX: `${this.socket},${process.pid},0`, TMUX_PANE: pane };
	}
	windows(): string[] {
		return this.tmux(["list-windows", "-a", "-F", "#{window_id}"]).split("\n");
	}
	activePane(): string {
		return this.tmux(["display-message", "-p", "-t", "main", "#{pane_id}"]);
	}
	runsAll(): string[] {
		return readdirSync(this.stub)
			.filter((f) => f.endsWith(".runs"))
			.flatMap((f) => readFileSync(join(this.stub, f), "utf8").trim().split("\n"));
	}
	status(id: string): any {
		try {
			return JSON.parse(readFileSync(join(this.statusDir, `${id}.json`), "utf8"));
		} catch {
			return undefined;
		}
	}
	log(name: string): string {
		const p = join(this.root, name);
		return existsSync(p) ? readFileSync(p, "utf8") : "";
	}
	/** A stored session file (header + one user message). */
	sessionFile(id: string, cwd = this.work): string {
		const dir = join(this.sessions, "x");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
		const ts = new Date().toISOString();
		writeFileSync(
			file,
			[
				{ type: "session", version: 3, id, timestamp: ts, cwd },
				{ type: "message", id: "a1", parentId: null, timestamp: ts, message: { role: "user", content: "hi", timestamp: Date.now() } },
			].map((e) => JSON.stringify(e)).join("\n") + "\n",
		);
		return file;
	}
	close(): void {
		this.tryTmux(["kill-server"]);
		if (this.socket) rmSync(this.socket, { force: true });
		rmSync(this.root, { recursive: true, force: true });
	}
}

/** `pi --mode rpc` with the fleet and the test faux extension. */
class RpcPi {
	readonly child: ChildProcessWithoutNullStreams;
	readonly events: any[] = [];
	stderr = "";
	readonly exited: Promise<number | null>;
	private buf = "";
	private seq = 0;

	constructor(rig: Rig, env: NodeJS.ProcessEnv, extra: string[] = []) {
		this.child = spawn(
			piCmd,
			["--mode", "rpc", "-ne", "-e", fleetDir, "-e", rig.fauxExt, "--offline", "--provider", "faux", "--model", "faux-1",
				"--session-dir", rig.sessions, "-ns", "-np", "-nc", ...extra],
			{ cwd: rig.work, env, stdio: ["pipe", "pipe", "pipe"] },
		);
		this.child.stderr.on("data", (d) => (this.stderr += d));
		this.child.stdout.on("data", (d) => {
			this.buf += d;
			let nl: number;
			while ((nl = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, nl);
				this.buf = this.buf.slice(nl + 1);
				if (line.trim()) this.events.push(JSON.parse(line));
			}
		});
		this.exited = new Promise((resolve) => this.child.on("exit", resolve));
	}
	send(cmd: Record<string, unknown>): string {
		const id = `c${++this.seq}`;
		this.child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
		return id;
	}
	async call(cmd: Record<string, unknown>, timeoutMs = 15_000): Promise<any> {
		const id = this.send(cmd);
		return waitFor(`response to ${cmd.type}`, () => this.events.find((e) => e.type === "response" && e.id === id), timeoutMs);
	}
	/** The next unanswered dialog request (select/confirm/input). */
	async dialog(method?: string): Promise<any> {
		const answered = new Set(this.events.filter((e) => e._answered).map((e) => e.id));
		const req = await waitFor("dialog", () =>
			this.events.find((e) => e.type === "extension_ui_request" && ["select", "confirm", "input"].includes(e.method) && !e._answered && !answered.has(e.id)),
		);
		req._answered = true;
		if (method) assert.equal(req.method, method);
		return req;
	}
	answer(req: any, response: Record<string, unknown>): void {
		this.child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: req.id, ...response }) + "\n");
	}
	dialogs(): any[] {
		return this.events.filter((e) => e.type === "extension_ui_request" && ["select", "confirm", "input"].includes(e.method));
	}
	notices(): string[] {
		return this.events.filter((e) => e.type === "extension_ui_request" && e.method === "notify").map((e) => e.message);
	}
	settled(): number {
		return this.events.filter((e) => e.type === "agent_settled").length;
	}
	async sessionId(): Promise<string> {
		return (await this.call({ type: "get_state" })).data.sessionId;
	}
	kill(): void {
		if (this.child.exitCode === null) this.child.kill("SIGKILL");
	}
}

/** One NDJSON request on a unix socket; resolves with the reply lines. */
function ctl(path: string, lines: string[], opts: { half?: boolean } = {}): Promise<any[]> {
	return new Promise((resolve, reject) => {
		const sock = createConnection(path);
		let out = "";
		sock.setEncoding("utf8");
		sock.on("data", (d) => (out += d));
		sock.on("error", reject);
		sock.on("close", () => resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
		sock.on("connect", () => {
			sock.write(lines.join(""));
			if (opts.half) sock.end();
		});
	});
}

// ---------------------------------------------------------------- pure

test("submittedJobs: ids from sbatch output, deduplicated", () => {
	assert.deepEqual(submittedJobs("Submitted batch job 12\nfoo\nSubmitted batch job 13\nSubmitted batch job 12\n"), ["12", "13"]);
	assert.deepEqual(submittedJobs("sbatch: error: no"), []);
});

test("killPlan: dialog text and options (§8)", () => {
	const plan = killPlan({
		label: "physicsnemo sweep", busy: true, hasMessages: true, subagents: ["/sweep-operator", "/coder-x"],
		jobs: [{ id: "8812345", state: "RUNNING", time: "1:02:11" }], submitted: ["8812345", "77"],
	})!;
	assert.equal(
		plan.title,
		'Kill session "physicsnemo sweep"?   (agent is working: its run will be aborted)\n' +
			"  2 subagents working (/sweep-operator, /coder-x) will be stopped; transcripts are kept.\n" +
			"  Slurm jobs from this session still queued/running: 8812345 (RUNNING 1:02:11)",
	);
	assert.deepEqual(plan.options, ["Kill, leave Slurm jobs running", "Kill and scancel 8812345", "Cancel"]);
	// Nothing running and no conversation: no dialog.
	assert.equal(killPlan({ label: "x", busy: false, hasMessages: false, subagents: [], jobs: [], submitted: ["1"] }), undefined);
	// A conversation, finished jobs only: plain Kill / Cancel.
	assert.deepEqual(killPlan({ label: "x", busy: false, hasMessages: true, subagents: [], jobs: [], submitted: ["1"] })!.options, ["Kill", "Cancel"]);
	// squeue failed: the captured ids are listed and can still be cancelled.
	const unknown = killPlan({ label: "x", busy: false, hasMessages: false, subagents: [], jobs: undefined, submitted: ["5"] })!;
	assert.match(unknown.title, /squeue failed, state unknown\): 5/);
	assert.deepEqual(unknown.options, ["Kill, leave Slurm jobs running", "Kill and scancel 5", "Cancel"]);
});

// ---------------------------------------------------------------- rpc pi in tmux

test("rpc pi in tmux: /new and /resume open windows, the original lives on", { skip: skipRpc, timeout: 90_000 }, async () => {
	const rig = new Rig();
	const pi = new RpcPi(rig, rig.tmuxEnv());
	try {
		const id = await pi.sessionId();
		const st = await waitFor("status with ctlSock", () => rig.status(id)?.ctlSock && rig.status(id));
		assert.equal(st.pid, pi.child.pid);
		assert.equal(st.tmux.piPane, rig.firstPane);
		// Control socket: 0600 in the private dir; ping answers; junk and unknown types are errors.
		assert.equal(st.ctlSock, join(rig.root, "run", `${id}.pi.sock`));
		assert.equal(statSync(st.ctlSock).mode & 0o777, 0o600);
		const replies = await ctl(st.ctlSock, ['{"type":"ping"}\n', "nope\n", '{"type":"bogus"}\n', '{"cmd":"ping"}'], { half: true });
		assert.deepEqual(replies, [
			{ ok: true, pid: pi.child.pid, host: hostname(), sessionId: id },
			{ ok: false, error: "bad JSON" },
			{ ok: false, error: "unknown type bogus" },
			{ ok: true, pid: pi.child.pid, host: hostname(), sessionId: id },
		]);
		const tooLong = await ctl(st.ctlSock, [`{"type":"ping","x":"${"a".repeat(70_000)}"}\n`]);
		assert.deepEqual(tooLong, [{ ok: false, error: "line too long" }]);
		// An idle connection is dropped after 2 s.
		const t0 = Date.now();
		assert.deepEqual(await ctl(st.ctlSock, []), []);
		assert.ok(Date.now() - t0 >= 1900);

		// /new: cancelled in place, a new window with a fresh session id in the same cwd.
		const before = rig.windows().length;
		const created = await pi.call({ type: "new_session" });
		assert.deepEqual(created.data, { cancelled: true });
		await waitFor("new window", () => rig.windows().length === before + 1);
		const run = await waitFor("stub pi in the new window", () => rig.runsAll()[0]);
		assert.match(run, /--session-id [0-9a-f-]{36}$/);
		assert.equal(await pi.sessionId(), id, "the original session is still current");
		assert.ok(rig.status(id), "original status file kept");
		assert.equal(pi.child.exitCode, null);

		// /resume of a stored session: a new window running `--session <file>`.
		const otherId = "11111111-2222-7333-8444-555555555555";
		const otherFile = rig.sessionFile(otherId);
		const resumed = await pi.call({ type: "switch_session", sessionPath: otherFile });
		assert.deepEqual(resumed.data, { cancelled: true });
		await waitFor("resume window", () => rig.windows().length === before + 2);
		await waitFor("stub pi resumed", () => rig.runsAll().some((l) => l.endsWith(`--session ${otherFile}`)));
		assert.equal(await pi.sessionId(), id);

		// /resume of a live session: jump to its window, no new one.
		const liveId = "99999999-2222-7333-8444-555555555555";
		const liveFile = rig.sessionFile(liveId);
		const livePane = rig.tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "sh"]);
		mkdirSync(rig.statusDir, { recursive: true });
		const now = new Date().toISOString();
		writeFileSync(join(rig.statusDir, `${liveId}.json`), JSON.stringify({
			v: 1, sessionId: liveId, sessionFile: liveFile, cwd: rig.work, host: hostname(), pid: process.pid, state: "idle", acked: true,
			since: now, heartbeat: now, subagents: { working: 0, waiting: 0, done: 0, error: 0 }, tmux: { socket: rig.socket, piPane: livePane },
		}));
		const windows = rig.windows().length;
		const jumped = await pi.call({ type: "switch_session", sessionPath: liveFile });
		assert.deepEqual(jumped.data, { cancelled: true });
		await waitFor("jump to the live pane", () => rig.activePane() === livePane);
		assert.equal(rig.windows().length, windows);
		assert.equal(rig.runsAll().filter((l) => l.includes(liveId)).length, 0);

		pi.child.stdin.end();
		assert.equal(await pi.exited, 0, pi.stderr);
		assert.equal(existsSync(st.ctlSock), false, "the owner unlinks its socket");
	} finally {
		pi.kill();
		rig.close();
	}
});

test("rpc pi: Slurm capture, /fork guard, /kill dialog (control socket and command)", { skip: skipRpc, timeout: 90_000 }, async () => {
	const rig = new Rig();
	const pi = new RpcPi(rig, rig.tmuxEnv());
	try {
		const id = await pi.sessionId();
		const ctlSock = (await waitFor("ctlSock", () => rig.status(id)?.ctlSock)) as string;

		// The faux model runs `echo Submitted batch job 8812345` through bash.
		await pi.call({ type: "prompt", message: "please submit" });
		await waitFor("settle", () => pi.settled() >= 1);
		await waitFor("slurmJobs in status", () => rig.status(id)?.slurmJobs?.[0] === "8812345");
		const entries = (await pi.call({ type: "get_entries" })).data.entries;
		assert.ok(entries.some((e: any) => e.customType === "pi-fleet:slurm-job" && e.data?.jobId === "8812345"));

		// Two working subagents (registry entries in pi-subagent-manager's format).
		await pi.call({ type: "prompt", message: "/fake-subagents" });

		// /clone with subagents working: confirm; declining cancels.
		const clone = pi.send({ type: "clone" });
		const confirm = await pi.dialog("confirm");
		assert.match(confirm.title, /Clone with 2 subagents working\?/);
		assert.match(confirm.message, /stops \/sweep-operator, \/coder-x/);
		pi.answer(confirm, { confirmed: false });
		const cloned = await waitFor("clone response", () => pi.events.find((e) => e.type === "response" && e.id === clone));
		assert.equal(cloned.data.cancelled, true);
		assert.equal(await pi.sessionId(), id);

		// Dashboard `x`: {"type":"kill"} on the socket opens the dialog; Cancel keeps pi.
		assert.deepEqual(await ctl(ctlSock, ['{"type":"kill"}\n'], { half: true }), [{ ok: true }]);
		const first = await pi.dialog("select");
		assert.equal(
			first.title,
			`Kill session "${basename(rig.work)}"?\n` +
				"  2 subagents working (/sweep-operator, /coder-x) will be stopped; transcripts are kept.\n" +
				"  Slurm jobs from this session still queued/running: 8812345 (RUNNING 1:02:11)",
		);
		assert.deepEqual(first.options, ["Kill, leave Slurm jobs running", "Kill and scancel 8812345", "Cancel"]);
		assert.match(rig.log("squeue.log"), /-h -j 8812345 -o %i %T %M/);
		pi.answer(first, { value: "Cancel" });
		await sleep(500);
		assert.equal(pi.child.exitCode, null);
		// The fleet's own dialog is not a `question`.
		assert.notEqual(rig.status(id)?.state, "question");

		// /kill, scancel: pi exits 0 and removes its status file and socket.
		pi.send({ type: "prompt", message: "/kill" });
		const second = await pi.dialog("select");
		pi.answer(second, { value: "Kill and scancel 8812345" });
		assert.equal(await pi.exited, 0, pi.stderr);
		assert.equal(rig.log("scancel.log").trim(), "8812345");
		assert.equal(existsSync(join(rig.statusDir, `${id}.json`)), false);
		assert.equal(existsSync(ctlSock), false);
	} finally {
		pi.kill();
		rig.close();
	}
});

test("rpc pi: /kill of an empty session asks nothing; outside tmux /new stays in place", { skip: !havePi && "pi missing", timeout: 60_000 }, async () => {
	const rig = haveTmux ? new Rig() : undefined;
	if (!rig) return;
	try {
		const a = new RpcPi(rig, rig.env); // no TMUX: pi's own behaviour
		try {
			const id = await a.sessionId();
			const r = await a.call({ type: "new_session" });
			assert.deepEqual(r.data, { cancelled: false });
			assert.notEqual(await a.sessionId(), id);
			assert.ok(a.notices().some((m) => /not in tmux, so \/new replaces this session here/.test(m)), JSON.stringify(a.notices()));
			assert.deepEqual(rig.runsAll(), []);
			a.send({ type: "prompt", message: "/kill" });
			assert.equal(await a.exited, 0, a.stderr);
			assert.deepEqual(a.dialogs(), []);
		} finally {
			a.kill();
		}
	} finally {
		rig.close();
	}
});

test("rpc pi: duplicate guard quits the second pi and keeps the first one's file and socket", { skip: skipRpc, timeout: 90_000 }, async () => {
	const rig = new Rig();
	const a = new RpcPi(rig, rig.tmuxEnv());
	let b: RpcPi | undefined;
	try {
		const id = await a.sessionId();
		await a.call({ type: "prompt", message: "hello" });
		await waitFor("settle", () => a.settled() >= 1);
		const st = await waitFor("status of a", () => rig.status(id)?.ctlSock && rig.status(id));
		const file = st.sessionFile as string;
		await waitFor("session file", () => existsSync(file));

		b = new RpcPi(rig, rig.tmuxEnv(), ["--session", file]);
		const guard = await b.dialog("select");
		assert.match(guard.title, new RegExp(`^Session ".*" is already running as pid ${a.child.pid} \\(window 0\\)\\.`));
		assert.deepEqual(guard.options, ["Jump there", "Quit"]);
		b.answer(guard, { value: "Quit" });
		assert.equal(await b.exited, 0, b.stderr);
		// a's status file is back (b overwrote it, then removed it on quit), and a kept its socket.
		const back = await waitFor("a's status file", () => rig.status(id));
		assert.equal(back.pid, a.child.pid);
		assert.deepEqual((await ctl(st.ctlSock, ['{"type":"ping"}\n'], { half: true }))[0].pid, a.child.pid);
		assert.equal(a.child.exitCode, null);
	} finally {
		b?.kill();
		a.kill();
		rig.close();
	}
});

test("rpc pi: /fork in a paired pane re-keys the pane options and the nvim's session env", { skip: (skipRpc || !haveNvim) && "tmux, pi or nvim missing", timeout: 90_000 }, async () => {
	const rig = new Rig();
	let pi: RpcPi | undefined;
	try {
		// A pair made for another session id: %0 is "pi", a real nvim on the right.
		mkdirSync(join(rig.root, "run"), { recursive: true, mode: 0o700 });
		const nvimSock = join(rig.root, "run", "old.nvim.sock");
		const nvimPane = rig.tmux(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", rig.firstPane,
			"-e", "PI_FLEET_SESSION=old", "-e", "PI_FLEET_CTL_SOCK=/nowhere", "--", "nvim", "--clean", "-n", "--listen", nvimSock]);
		rig.tmux(["set-option", "-p", "-t", rig.firstPane, "@pi_fleet_role", "pi", ";", "set-option", "-p", "-t", rig.firstPane, "@pi_fleet_session", "old", ";",
			"set-option", "-p", "-t", rig.firstPane, "@pi_fleet_peer", nvimPane, ";", "set-option", "-p", "-t", nvimPane, "@pi_fleet_role", "nvim", ";",
			"set-option", "-p", "-t", nvimPane, "@pi_fleet_session", "old", ";", "set-option", "-p", "-t", nvimPane, "@pi_fleet_peer", rig.firstPane, ";",
			"set-option", "-p", "-t", nvimPane, "@pi_fleet_nvim_sock", nvimSock]);
		await waitFor("nvim socket", () => existsSync(nvimSock));
		const nvimEnv = () => {
			const r = spawnSync("nvim", ["--server", nvimSock, "--remote-expr", "$PI_FLEET_SESSION . ' ' . $PI_FLEET_CTL_SOCK"], { encoding: "utf8", timeout: 5000 });
			return r.stdout.trim();
		};
		const opt = (pane: string) => rig.tmux(["display-message", "-p", "-t", pane, "#{@pi_fleet_session}"]);
		const ctlOf = (id: string) => join(rig.root, "run", `${id}.pi.sock`);

		pi = new RpcPi(rig, rig.tmuxEnv());
		const id = await pi.sessionId();
		// Started in a pane paired for "old": re-keyed to this session.
		await waitFor("re-keyed at start", () => opt(rig.firstPane) === id && opt(nvimPane) === id && nvimEnv() === `${id} ${ctlOf(id)}`);

		await pi.call({ type: "prompt", message: "hello" });
		await waitFor("settle", () => pi!.settled() >= 1);
		const msgs = (await pi.call({ type: "get_fork_messages" })).data.messages;
		const forked = await pi.call({ type: "fork", entryId: msgs[0].entryId });
		assert.equal(forked.data.cancelled, false);
		const forkId = await pi.sessionId();
		assert.notEqual(forkId, id);
		await waitFor("re-keyed after /fork", () => opt(rig.firstPane) === forkId && opt(nvimPane) === forkId && nvimEnv() === `${forkId} ${ctlOf(forkId)}`);
		await waitFor("control socket of the fork", () => existsSync(ctlOf(forkId)));
		assert.equal(rig.tmux(["display-message", "-p", "-t", rig.firstPane, "#{@pi_fleet_peer}"]), nvimPane);
	} finally {
		pi?.kill();
		rig.close();
	}
});

// ---------------------------------------------------------------- TUI pi in a tmux pane

test("tui pi started by hand in tmux: glyph-named window, nvim peer; /new opens a window; /kill ends it", { skip: skipTui, timeout: 90_000 }, async () => {
	const rig = new Rig();
	try {
		const piArgs = ["-ne", "-e", fleetDir, "-e", rig.fauxExt, "--offline", "--provider", "faux", "--model", "faux-1", "--session-dir", rig.sessions, "-ns", "-np", "-nc"];
		const envArgs = Object.entries(rig.env).filter(([k]) => k.startsWith("PI_") || k === "PATH" || k === "HOME").flatMap(([k, v]) => ["-e", `${k}=${v}`]);
		const pane = rig.tmux(["new-window", "-P", "-F", "#{pane_id}", "-c", rig.work, ...envArgs, "--", piCmd, ...piArgs]);
		const peer = await waitFor("nvim peer", () => rig.tryTmux(["display-message", "-p", "-t", pane, "#{@pi_fleet_peer}"]) || undefined, 30_000);
		assert.match(peer, /^%\d+$/);
		await waitFor("nvim role", () => rig.tmux(["display-message", "-p", "-t", peer, "#{@pi_fleet_role}"]) === "nvim");
		const id = rig.tmux(["display-message", "-p", "-t", pane, "#{@pi_fleet_session}"]);
		const st = await waitFor("status nvimPane", () => rig.status(id)?.tmux?.nvimPane === peer && rig.status(id)).catch((e) => { throw new Error(e.message + rig.tmux(["capture-pane", "-p", "-t", pane])); });
		assert.ok(st.nvimSock);
		// The window gets glyph names from `pi-fleet bar`...
		await waitFor("@pi_fleet_named", () => rig.tmux(["display-message", "-p", "-t", pane, "#{@pi_fleet_named}"]) === "1");
		// ...unless the user named it (automatic-rename off).
		const mine = rig.tmux(["new-window", "-d", "-n", "mine", "-P", "-F", "#{pane_id}", "-c", rig.work, ...envArgs, "--", piCmd, ...piArgs]);
		await waitFor("second nvim peer", () => rig.tryTmux(["display-message", "-p", "-t", mine, "#{@pi_fleet_peer}"]) || undefined, 30_000);
		await sleep(500);
		assert.equal(rig.tmux(["display-message", "-p", "-t", mine, "#{@pi_fleet_named}"]), "");
		assert.equal(rig.tmux(["display-message", "-p", "-t", mine, "#{window_name}"]), "mine");

		const before = rig.windows().length;
		rig.tmux(["send-keys", "-t", pane, "/new"]);
		await sleep(300);
		rig.tmux(["send-keys", "-t", pane, "Enter"]);
		await waitFor("window from /new", () => rig.windows().length === before + 1);
		await waitFor("stub pi", () => rig.runsAll().length === 1);
		assert.ok(rig.status(id), "the original pi still runs");
		assert.equal(rig.tryTmux(["display-message", "-p", "-t", pane, "#{pane_dead}"]), "0");

		// Empty session: /kill quits without a dialog; the pane (no run-pi here) closes.
		rig.tmux(["select-window", "-t", pane]);
		rig.tmux(["send-keys", "-t", pane, "/kill"]);
		await sleep(300);
		rig.tmux(["send-keys", "-t", pane, "Enter"]);
		await waitFor("pi pane gone", () => !rig.tmux(["list-panes", "-a", "-F", "#{pane_id}"]).split("\n").includes(pane), 20_000);
		await waitFor("status file removed", () => !rig.status(id));
	} finally {
		rig.close();
	}
});
