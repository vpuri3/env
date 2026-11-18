// A fixture pi sessions dir + status dir for the sessions-view and deck list tests.
// Everything lives in one temp dir; env points PI_CODING_AGENT_SESSION_DIR, PI_FLEET_STATE_DIR,
// PI_FLEET_CACHE_DIR and PI_FLEET_RUNTIME_DIR there and drops TMUX, so nothing touches the
// user's sessions, status files or tmux server.
//
// Repos: work/alpha (git, with alpha/sub), work/beta (no git), work/gamma (git).
//   alpha  sweep        live running (tool:bash), registry from fixtures/registry-session.jsonl
//          ckpt restart live waiting
//          old run      not running (cwd alpha/sub), one thread left running → 1 interrupted
//          (a subagent session of old run: not a row)
//   beta   crashy       status file, same host, dead pid → crashed; one running thread
//          notes        status of another host, fresh heartbeat → remote (no session file)
//          forked idea  a fork of old run (parentSession, no thread entry) → a main, not running
//   gamma  flare refactor live question
//          (unnamed)    not running; its first user message sits behind a >16 KB entry
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

export const IDS = {
	sweep: "00000000-0000-7000-8000-00000000a001",
	ckpt: "00000000-0000-7000-8000-00000000a002",
	old: "00000000-0000-7000-8000-00000000a003",
	oldSub: "00000000-0000-7000-8000-00000000a004",
	crashy: "00000000-0000-7000-8000-00000000b001",
	notes: "00000000-0000-7000-8000-00000000b002",
	fork: "00000000-0000-7000-8000-00000000b003",
	flare: "00000000-0000-7000-8000-00000000c001",
	unnamed: "00000000-0000-7000-8000-00000000c002",
};

const MIN = 60_000;

export interface Fixture {
	root: string;
	env: NodeJS.ProcessEnv;
	now: number;
	files: Record<keyof typeof IDS, string>;
	repos: { alpha: string; beta: string; gamma: string };
	statusDir: string;
	sessionsDir: string;
	writeStatus(id: string, fields: Record<string, unknown>): void;
	cleanup(): void;
}

function deadPid(): number {
	const r = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
	return Number(r.stdout.trim());
}

function line(entry: Record<string, unknown>): string {
	return `${JSON.stringify(entry)}\n`;
}

let n = 0;
function id8(): string {
	return (++n).toString(16).padStart(8, "0");
}

/** A chain of entries with ids/parentIds. */
function chain(entries: Record<string, unknown>[]): string {
	let parent: string | null = null;
	let out = "";
	for (const e of entries) {
		const id = id8();
		out += line({ ...e, id, parentId: parent, timestamp: "2026-11-17T10:00:00.000Z" });
		parent = id;
	}
	return out;
}

const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const info = (name: string) => ({ type: "session_info", name });
const thread = (path: string, state: string, task = `task of ${path}`) => ({ view: { path, parent: null, owner: "/root", type: "coder", state, task } });
const registry = (root: string, threads: unknown[]) => ({
	type: "custom",
	customType: "pi-subagent:registry:v1",
	data: { version: 1, rootSessionId: root, threads },
});

export function buildFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pfs-"));
	const now = Date.now();
	const work = join(root, "work");
	const alpha = join(work, "alpha");
	const beta = join(work, "beta");
	const gamma = join(work, "gamma");
	for (const d of [join(alpha, "sub"), beta, gamma, join(root, "home")]) mkdirSync(d, { recursive: true });
	for (const d of [alpha, gamma]) execFileSync("git", ["init", "-q", d]);
	const sessionsDir = join(root, "sessions");
	const statusDir = join(root, "state", "status");
	mkdirSync(statusDir, { recursive: true });

	const dirFor = (cwd: string) => {
		const d = join(sessionsDir, `--${cwd.replace(/\//g, "-")}--`);
		mkdirSync(d, { recursive: true });
		return d;
	};
	const files = {} as Record<keyof typeof IDS, string>;
	const write = (key: keyof typeof IDS, cwd: string, body: string, ageMs: number, extraHeader: Record<string, unknown> = {}) => {
		const file = join(dirFor(cwd), `2026-11-17T10-00-00-000Z_${IDS[key]}.jsonl`);
		writeFileSync(file, line({ type: "session", version: 3, id: IDS[key], timestamp: "2026-11-17T10:00:00.000Z", cwd, ...extraHeader }) + body);
		const t = (now - ageMs) / 1000;
		utimesSync(file, t, t);
		files[key] = file;
	};

	// sweep: the anonymised registry of a real session (phase 1 fixture), header replaced.
	const reg = readFileSync(new URL("../fixtures/registry-session.jsonl", import.meta.url), "utf8").split("\n").slice(1).join("\n");
	write("sweep", alpha, chain([info("physicsnemo sweep"), user("sweep it")]) + reg, 1 * MIN);
	write("ckpt", alpha, chain([info("ckpt restart"), user("restart"), assistant("checkpoint restarted")]), 2 * MIN);
	write(
		"old",
		join(alpha, "sub"),
		chain([user("start the old run"), registry(IDS.old, [thread("/runner", "running"), thread("/checker", "completed")]), assistant("the old run finished")]),
		3 * 60 * MIN,
	);
	write(
		"oldSub",
		join(alpha, "sub"),
		chain([info("coder /runner"), { type: "custom", customType: "pi-subagent:thread:v1", data: { rootId: IDS.old, threadPath: "/runner" } }, user("do it")]),
		3 * 60 * MIN,
		{ parentSession: "x.jsonl" },
	);
	write("crashy", beta, chain([info("crashy"), registry(IDS.crashy, [thread("/w", "running")]), assistant("was working")]), 30 * MIN);
	write("fork", beta, chain([info("forked idea"), user("fork it"), assistant("forked reply")]), 24 * 60 * MIN, { parentSession: "old.jsonl" });
	write("flare", gamma, chain([info("flare refactor"), user("refactor")]), 12 * MIN);
	write(
		"unnamed",
		gamma,
		chain([{ type: "message", message: { role: "system", content: "x".repeat(20_000) } }, user("what does gamma do?"), assistant("gamma does things")]),
		2 * 24 * 60 * MIN,
	);

	const iso = (ms: number) => new Date(ms).toISOString();
	const base = (id: string, cwd: string, repo: string) => ({
		v: 1,
		sessionId: id,
		cwd,
		repo,
		host: hostname(),
		pid: process.pid,
		acked: false,
		subagents: { working: 0, waiting: 0, done: 0, error: 0 },
		heartbeat: iso(now - 5000),
	});
	const writeStatus = (id: string, fields: Record<string, unknown>) =>
		writeFileSync(join(statusDir, `${id}.json`), JSON.stringify(fields));
	writeStatus(IDS.sweep, {
		...base(IDS.sweep, alpha, alpha),
		sessionFile: files.sweep,
		name: "physicsnemo sweep",
		tmux: { piPane: "%12" },
		state: "running",
		sub: "tool:bash",
		since: iso(now - 4 * MIN),
		costUsd: 3.41,
		subagents: { working: 2, waiting: 1, done: 3, error: 0 },
		lastAssistant: "sweeping",
	});
	writeStatus(IDS.ckpt, { ...base(IDS.ckpt, alpha, alpha), sessionFile: files.ckpt, name: "ckpt restart", state: "waiting", since: iso(now - 2 * MIN), costUsd: 0.4 });
	writeStatus(IDS.crashy, { ...base(IDS.crashy, beta, beta), sessionFile: files.crashy, name: "crashy", state: "running", pid: deadPid(), since: iso(now - 30 * MIN), heartbeat: iso(now - 20_000) });
	writeStatus(IDS.notes, { ...base(IDS.notes, beta, beta), name: "notes", host: "other-node", state: "idle", acked: true, since: iso(now - 60 * MIN), lastAssistant: "notes taken" });
	writeStatus(IDS.flare, { ...base(IDS.flare, gamma, gamma), sessionFile: files.flare, name: "flare refactor", state: "question", since: iso(now - 12 * MIN), costUsd: 0.8, subagents: { working: 0, waiting: 1, done: 0, error: 0 } });

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: join(root, "home"),
		PI_CODING_AGENT_SESSION_DIR: sessionsDir,
		PI_FLEET_STATE_DIR: join(root, "state"),
		PI_FLEET_CACHE_DIR: join(root, "cache"),
		PI_FLEET_RUNTIME_DIR: join(root, "run"),
		PI_FLEET_TMUX_GUARD: "1",
	};
	for (const k of ["TMUX", "TMUX_PANE", "PI_FLEET_SESSION", "PI_FLEET_TMUX_SOCKET", "PI_CODING_AGENT_DIR"]) delete env[k];
	return {
		root,
		env,
		now,
		files,
		repos: { alpha, beta, gamma },
		statusDir,
		sessionsDir,
		writeStatus,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Identity style: plain text, so tests can compare lines. */
export const plainStyle = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
