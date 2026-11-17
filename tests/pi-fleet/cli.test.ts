// pi-fleet CLI and tmux glue (design §7, §10; phase 2). Every test drives a throwaway tmux
// server (`tmux -L fleettest-<pid>-<n>`); the harness refuses the default socket, and the CLI
// runs with PI_FLEET_TMUX_GUARD=1 so it refuses it too. pi is the stub in support/stub-pi.sh
// (PI_FLEET_PI_CMD); nvim is real (`nvim --clean -n`), skipped if missing. State, runtime and
// HOME dirs are temporary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ctlSockPath, nvimSockPath, runtimeDir } from "../../pi/extensions/fleet/cli.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../..");
const cliBin = join(repo, "bin/pi-fleet");
const stubPi = join(here, "support/stub-pi.sh");
const tmuxConf = join(repo, "tmux.conf");

function have(cmd: string, flag: string): boolean {
	return spawnSync(cmd, [flag], { stdio: "ignore", timeout: 5000 }).status === 0;
}
const haveTmux = have("tmux", "-V");
const haveNvim = have("nvim", "--version");

/** The harness guard (agent-deck's default_socket_guard idea): tmux args must name a non-default socket. */
export function guardTmuxArgs(args: string[]): void {
	const flag = args[0];
	const name = args[1];
	if ((flag !== "-L" && flag !== "-S") || !name || basename(name) === "default") {
		throw new Error(`test harness refuses tmux without a throwaway socket: ${args.join(" ")}`);
	}
}

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

let serial = 0;

class Fleet {
	readonly root = mkdtempSync(join(tmpdir(), "pft-"));
	readonly label = `fleettest-${process.pid}-${++serial}`;
	readonly stub = join(this.root, "stub");
	readonly work = join(this.root, "work");
	readonly statusDir = join(this.root, "state", "status");
	readonly env: NodeJS.ProcessEnv;
	socket = "";

	constructor(opts: { conf?: string } = {}) {
		mkdirSync(this.stub);
		mkdirSync(this.work);
		mkdirSync(join(this.root, "home"));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: join(this.root, "home"),
			PATH: `${join(repo, "bin")}:${process.env.PATH}`,
			PI_FLEET_STATE_DIR: join(this.root, "state"),
			PI_FLEET_RUNTIME_DIR: join(this.root, "run"),
			PI_FLEET_STUB_DIR: this.stub,
			PI_FLEET_PI_CMD: stubPi,
			PI_FLEET_NVIM_CMD: "nvim --clean -n",
			PI_FLEET_TMUX_GUARD: "1",
			SHELL: "/bin/sh",
		};
		delete env.TMUX;
		delete env.TMUX_PANE;
		delete env.PI_FLEET_SESSION;
		delete env.PI_FLEET_TMUX_SOCKET;
		this.env = env;
		this.tmux(["-f", opts.conf ?? "/dev/null", "new-session", "-d", "-s", "main", "-x", "200", "-y", "50", "sh"]);
		this.socket = this.tmux(["display-message", "-p", "#{socket_path}"]);
		assert.notEqual(basename(this.socket), "default");
		this.env.PI_FLEET_TMUX_SOCKET = this.socket;
	}

	tmux(args: string[]): string {
		const full = ["-L", this.label, ...args];
		guardTmuxArgs(full);
		const env = { ...this.env };
		delete env.PI_FLEET_TMUX_SOCKET;
		return execFileSync("tmux", full, { env, encoding: "utf8" }).replace(/\n$/, "");
	}
	tryTmux(args: string[]): string | undefined {
		try {
			return this.tmux(args);
		} catch {
			return undefined;
		}
	}
	cli(args: string[], extra: NodeJS.ProcessEnv = {}): { code: number; out: string; err: string } {
		const r = spawnSync(cliBin, args, { env: { ...this.env, ...extra }, encoding: "utf8", timeout: 20_000 });
		return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
	}
	opt(pane: string, name: string): string {
		return this.tmux(["display-message", "-p", "-t", pane, `#{${name}}`]);
	}
	panes(): string[] {
		return this.tmux(["list-panes", "-a", "-F", "#{pane_id}"]).split("\n");
	}
	windows(): string[] {
		return this.tmux(["list-windows", "-a", "-F", "#{window_id}"]).split("\n");
	}
	active(): string {
		return this.tmux(["display-message", "-p", "-t", "main", "#{pane_id}"]);
	}
	runs(id: string): string[] {
		const f = join(this.stub, `${id}.runs`);
		return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : [];
	}
	exitPi(id: string, code: number): void {
		writeFileSync(join(this.stub, `${id}.exit`), `${code}\n`);
	}
	writeStatus(fields: Record<string, unknown>): string {
		mkdirSync(this.statusDir, { recursive: true });
		const now = new Date().toISOString();
		const status = {
			v: 1, cwd: this.work, host: hostname(), pid: process.pid, state: "idle", acked: true, since: now, heartbeat: now,
			subagents: { working: 0, waiting: 0, done: 0, error: 0 },
			...fields,
		};
		writeFileSync(join(this.statusDir, `${status.sessionId}.json`), JSON.stringify(status));
		return status.sessionId as string;
	}
	/** open a new session; returns its pi pane, nvim pane and session id. */
	async open(): Promise<{ pi: string; nvim: string; id: string }> {
		const r = this.cli(["open", "--cwd", this.work]);
		assert.equal(r.code, 0, r.err);
		const pi = r.out.trim();
		assert.match(pi, /^%\d+$/);
		const id = this.opt(pi, "@pi_fleet_session");
		await waitFor("stub pi to start", () => this.runs(id).length === 1);
		return { pi, nvim: this.opt(pi, "@pi_fleet_peer"), id };
	}
	close(): void {
		this.tryTmux(["kill-server"]);
		if (this.socket) rmSync(this.socket, { force: true }); // tmux 3.2a leaves the socket file
		rmSync(this.root, { recursive: true, force: true });
	}
}

const skipTmux = !haveTmux && "tmux not installed";
const skipNvim = (!haveTmux || !haveNvim) && "tmux or nvim not installed";

test("harness and CLI refuse the default tmux socket", { skip: skipTmux }, () => {
	assert.throws(() => guardTmuxArgs(["list-sessions"]));
	assert.throws(() => guardTmuxArgs(["-L", "default", "list-sessions"]));
	assert.throws(() => guardTmuxArgs(["-S", "/tmp/tmux-1/default", "ls"]));
	const env = { ...process.env, PI_FLEET_TMUX_GUARD: "1" };
	delete env.TMUX;
	delete env.PI_FLEET_TMUX_SOCKET;
	for (const args of [["peer", "--select", "%0"], ["pair", "%0", "--session", "x"]]) {
		const r = spawnSync(cliBin, args, { env, encoding: "utf8" });
		assert.notEqual(r.status, 0);
	}
	const r = spawnSync(cliBin, ["pair", "%0", "--session", "x"], { env, encoding: "utf8" });
	assert.match(r.stderr, /refuses the default tmux server/);
	const viaTmux = spawnSync(cliBin, ["pair", "%0", "--session", "x"], { env: { ...env, TMUX: `/tmp/tmux-${process.getuid?.()}/default,1,0` }, encoding: "utf8" });
	assert.match(viaTmux.stderr, /refuses the default tmux server/);
});

test("runtimeDir: a bad default dir falls back to one mkdtemp dir, cached for every socket path", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pft-rt-"));
	try {
		const uid = process.getuid?.() ?? 0;
		const bad = join(tmp, `pi-fleet-${uid}`);
		mkdirSync(bad);
		chmodSync(bad, 0o755); // not 0700: rejected
		const env: NodeJS.ProcessEnv = {};
		const dir = runtimeDir(env, tmp);
		assert.notEqual(dir, bad);
		assert.ok(dir.startsWith(`${bad}-`), dir);
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.equal(env.PI_FLEET_RUNTIME_DIR, dir, "cached so later calls (and new panes) agree");
		assert.equal(runtimeDir(env, tmp), dir);
		assert.equal(nvimSockPath("s1", env), join(dir, "s1.nvim.sock"));
		assert.equal(ctlSockPath("s1", env), join(dir, "s1.pi.sock"));
		assert.equal(execFileSync("ls", [tmp], { encoding: "utf8" }).trim().split("\n").length, 2, "no extra dirs leak");
		// a good default is used as is (and not cached)
		const tmp2 = mkdtempSync(join(tmpdir(), "pft-rt-"));
		try {
			const env2: NodeJS.ProcessEnv = {};
			assert.equal(runtimeDir(env2, tmp2), join(tmp2, `pi-fleet-${uid}`));
			assert.equal(env2.PI_FLEET_RUNTIME_DIR, undefined);
		} finally {
			rmSync(tmp2, { recursive: true, force: true });
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("tmux.conf loads on this tmux: bell, bar, hook, keys; user bindings kept", { skip: skipTmux }, () => {
	const f = new Fleet({ conf: tmuxConf });
	try {
		assert.equal(f.tmux(["show", "-gwv", "monitor-bell"]), "on");
		assert.equal(f.tmux(["show", "-gv", "bell-action"]), "other");
		assert.equal(f.tmux(["show", "-gv", "visual-bell"]), "off");
		assert.equal(f.tmux(["show", "-gv", "status-interval"]), "5");
		assert.equal(f.tmux(["show", "-gv", "status-left-length"]), "120");
		assert.match(f.tmux(["show", "-gv", "status-left"]), /#\(pi-fleet bar --pane "#\{pane_id\}"/);
		assert.equal(f.tmux(["show", "-gv", "prefix"]), "C-s");
		const hooks = f.tmux(["show-hooks", "-g"]);
		assert.match(hooks, /session-window-changed\[0\] run-shell -b "pi-fleet seen --window #\{window_id\}/);
		assert.match(hooks, /client-attached\[0\] run-shell -b "#\{@ssh_link_cmd\}"/);
		const keys = f.tmux(["list-keys", "-T", "prefix"]);
		const key = (k: string) => keys.split("\n").find((l) => new RegExp(`-T prefix +${k} `).test(l)) ?? "";
		assert.match(key("e"), /@pi_fleet_peer/);
		assert.match(key("e"), /pi-fleet peer --select [^|]*\|\| true\\*"/, "a failure must not put the pane in view mode");
		assert.match(key("g"), /@pi_fleet_dashboard.*last-window.*pi-fleet dashboard --window/);
		assert.match(key("G"), /display-popup -E -h 90% -w 95% "pi-fleet dashboard"/);
		for (const [k, cmd] of [["h", "select-pane -L"], ["j", "select-pane -D"], ["k", "select-pane -U"], ["l", "select-pane -R"],
			["H", "resize-pane -L 10"], ["J", "resize-pane -D 10"], ["K", "resize-pane -U 10"], ["L", "resize-pane -R 10"],
			["v", "split-window -h"], ["s", "split-window -v"], ["r", "source-file"]]) {
			assert.ok(key(k).includes(cmd), `prefix ${k}: ${key(k)}`);
		}
		for (const k of ["0", "1", "9"]) assert.match(key(k), /select-window -t :=\d/);
	} finally {
		f.close();
	}
});

test("open: one window per session, pi | nvim paired by pane id", { skip: skipNvim, timeout: 60_000 }, async () => {
	const f = new Fleet();
	try {
		const a = await f.open();
		const b = await f.open();
		assert.notEqual(a.id, b.id);
		assert.equal(f.windows().length, 3);
		for (const s of [a, b]) {
			assert.equal(f.opt(s.pi, "@pi_fleet_role"), "pi");
			assert.equal(f.opt(s.nvim, "@pi_fleet_role"), "nvim");
			assert.equal(f.opt(s.nvim, "@pi_fleet_peer"), s.pi);
			assert.equal(f.opt(s.nvim, "@pi_fleet_session"), s.id);
			assert.equal(f.opt(s.pi, "window_id"), f.opt(s.nvim, "window_id"));
			assert.equal(f.opt(s.pi, "@pi_fleet_named"), "1");
			assert.match(f.opt(s.pi, "window_name"), /^⟳ work$/);
			assert.equal(f.opt(s.pi, "pane_current_path"), f.work);
			const [, pane, ...args] = f.runs(s.id)[0].split(" ");
			assert.equal(pane, s.pi);
			assert.deepEqual(args, ["--session-id", s.id]);
			const sock = f.opt(s.nvim, "@pi_fleet_nvim_sock");
			assert.equal(sock, join(f.root, "run", `${s.id}.nvim.sock`));
			await waitFor("nvim to listen", () => existsSync(sock));
		}
		assert.equal(f.active(), b.pi, "the new pi pane is focused");
		// pair is idempotent while the peer lives
		const again = f.cli(["pair", a.pi, "--json"]);
		assert.equal(again.code, 0, again.err);
		assert.deepEqual(JSON.parse(again.out), { piPane: a.pi, nvimPane: a.nvim, nvimSock: f.opt(a.nvim, "@pi_fleet_nvim_sock"), created: false });

		// --session of a live session with its pane present jumps there: no new window
		f.writeStatus({ sessionId: a.id, tmux: { socket: f.socket, piPane: a.pi }, state: "waiting", acked: false, runId: "r1" });
		const jump = f.cli(["open", "--session", a.id.slice(0, 8)]);
		assert.equal(jump.code, 0, jump.err);
		assert.equal(jump.out.trim(), a.pi);
		assert.equal(f.windows().length, 3);
		assert.equal(f.active(), a.pi);

		// live on another host: refused
		const remote = f.writeStatus({ sessionId: "remote-1", host: "elsewhere-node", tmux: { socket: f.socket, piPane: a.pi } });
		const refused = f.cli(["open", "--session", remote]);
		assert.equal(refused.code, 1);
		assert.match(refused.err, /running on elsewhere-node/);
		assert.equal(f.windows().length, 3);

		// crashed (dead pid, pane gone): a new window resumes it with --session
		const dead = f.writeStatus({ sessionId: "dead-1", pid: 999_999_999, tmux: { socket: f.socket, piPane: "%999" } });
		const reopened = f.cli(["open", "--session", dead]);
		assert.equal(reopened.code, 0, reopened.err);
		assert.equal(f.windows().length, 4);
		await waitFor("resumed stub", () => f.runs(dead).length === 1);
		assert.deepEqual(f.runs(dead)[0].split(" ").slice(2), ["--session", dead]);
	} finally {
		f.close();
	}
});

test("peer survives added and swapped panes; re-pairs when nvim is gone", { skip: skipNvim, timeout: 60_000 }, async () => {
	const f = new Fleet();
	try {
		const s = await f.open();
		const extra = f.tmux(["split-window", "-v", "-t", s.pi, "-P", "-F", "#{pane_id}", "sh"]);
		f.tmux(["split-window", "-h", "-t", s.nvim, "sh"]);
		f.tmux(["swap-pane", "-s", s.pi, "-t", s.nvim]);
		f.tmux(["swap-pane", "-s", extra, "-t", s.nvim]);
		f.tmux(["break-pane", "-d", "-s", s.nvim]); // nvim moves to its own window
		assert.equal(f.cli(["peer", s.pi]).out.trim(), s.nvim);
		assert.equal(f.cli(["peer", s.nvim]).out.trim(), s.pi);
		assert.equal(f.cli(["peer", extra]).code, 1, "a user pane has no peer");

		assert.equal(f.cli(["peer", "--select", s.pi]).code, 0);
		assert.equal(f.active(), s.nvim);
		assert.equal(f.cli(["peer", "--select", s.nvim]).code, 0);
		assert.equal(f.active(), s.pi);

		f.tmux(["kill-pane", "-t", s.nvim]);
		assert.equal(f.cli(["peer", s.pi]).code, 1);
		const sel = f.cli(["peer", "--select", s.pi]);
		assert.equal(sel.code, 0, sel.err);
		const nvim2 = f.opt(s.pi, "@pi_fleet_peer");
		assert.notEqual(nvim2, s.nvim);
		assert.equal(f.opt(nvim2, "@pi_fleet_role"), "nvim");
		assert.equal(f.opt(nvim2, "@pi_fleet_peer"), s.pi);
		assert.equal(f.active(), nvim2);
	} finally {
		f.close();
	}
});

test("prefix e: the tmux.conf binding jumps between pi and nvim", { skip: skipNvim, timeout: 60_000 }, async () => {
	const f = new Fleet({ conf: tmuxConf });
	try {
		const s = await f.open();
		// Run the bound command as tmux would (no client: the context is the active pane).
		const bound = f.tmux(["list-keys", "-T", "prefix", "e"]).replace(/^bind-key\s+-T prefix\s+e\s+/, "");
		const conf = join(f.root, "key-e.conf");
		writeFileSync(conf, `${bound}\n`);
		f.tmux(["source-file", conf]);
		await waitFor("nvim focused", () => f.active() === s.nvim);
		f.tmux(["swap-pane", "-s", s.pi, "-t", s.nvim]);
		f.tmux(["source-file", conf]);
		await waitFor("pi focused", () => f.active() === s.pi);
	} finally {
		f.close();
	}
});

test("run-pi: a crash keeps the pane with a restart offer; exit 0 closes nvim", { skip: skipNvim, timeout: 60_000 }, async () => {
	const f = new Fleet();
	try {
		const s = await f.open();
		await waitFor("nvim socket", () => existsSync(f.opt(s.nvim, "@pi_fleet_nvim_sock")));
		f.exitPi(s.id, 3);
		await waitFor("crash banner", () => /pi exited \(3\)\. r restart · q close/.test(f.tmux(["capture-pane", "-p", "-t", s.pi])));
		assert.ok(f.panes().includes(s.pi), "the pane stays");
		f.tmux(["send-keys", "-t", s.pi, "x"]); // other keys do nothing
		f.tmux(["send-keys", "-t", s.pi, "r"]);
		await waitFor("restart", () => f.runs(s.id).length === 2);
		assert.deepEqual(f.runs(s.id)[1].split(" ").slice(1), [s.pi, "--session-id", s.id]);
		f.exitPi(s.id, 0);
		await waitFor("window closed", () => !f.panes().includes(s.pi) && !f.panes().includes(s.nvim));
		assert.equal(f.windows().length, 1);
	} finally {
		f.close();
	}
});

test("run-pi: exit 0 leaves nvim open when it has modified buffers; q closes after a crash", { skip: skipNvim, timeout: 60_000 }, async () => {
	const f = new Fleet();
	try {
		const s = await f.open();
		await waitFor("nvim socket", () => existsSync(f.opt(s.nvim, "@pi_fleet_nvim_sock")));
		f.tmux(["send-keys", "-t", s.nvim, "ihello", "Escape"]);
		await waitFor("typed", () => f.tmux(["capture-pane", "-p", "-t", s.nvim]).includes("hello"));
		f.exitPi(s.id, 0);
		await waitFor("pi pane gone", () => !f.panes().includes(s.pi));
		await new Promise((r) => setTimeout(r, 500));
		assert.ok(f.panes().includes(s.nvim), "nvim with a modified buffer stays");

		const t = await f.open();
		await waitFor("nvim socket", () => existsSync(f.opt(t.nvim, "@pi_fleet_nvim_sock")));
		f.exitPi(t.id, 1);
		await waitFor("crash banner", () => /pi exited \(1\)/.test(f.tmux(["capture-pane", "-p", "-t", t.pi])));
		f.tmux(["send-keys", "-t", t.pi, "q"]);
		await waitFor("closed", () => !f.panes().includes(t.pi) && !f.panes().includes(t.nvim));
		assert.equal(f.runs(t.id).length, 1);
	} finally {
		f.close();
	}
});

test("bar lists waiting sessions by real window index, renames fleet windows; seen acks", { skip: skipNvim, timeout: 60_000 }, async () => {
	const f = new Fleet();
	try {
		const a = await f.open();
		const b = await f.open();
		const c = await f.open();
		f.tmux(["move-window", "-s", f.opt(c.pi, "window_id"), "-t", "main:7"]);
		const t0 = Date.now();
		const at = (ms: number) => new Date(t0 - ms).toISOString();
		const sock = f.socket;
		f.writeStatus({ sessionId: a.id, name: "flare#1", state: "waiting", acked: false, runId: "r2", since: at(60_000), tmux: { socket: sock, piPane: a.pi } });
		f.writeStatus({ sessionId: b.id, name: "a very long session name", state: "question", acked: false, runId: "r1", since: at(1000), tmux: { socket: sock, piPane: b.pi } });
		f.writeStatus({ sessionId: c.id, name: "busy", state: "running", acked: true, runId: "r5", since: at(0), tmux: { socket: sock, piPane: c.pi } });
		f.writeStatus({ sessionId: "remote-2", name: "far", state: "waiting", acked: false, host: "elsewhere-node", tmux: { socket: sock, piPane: a.pi } });
		f.writeStatus({ sessionId: "other-server", name: "other", state: "waiting", acked: false, tmux: { socket: "/tmp/nope", piPane: a.pi } });
		const ia = f.opt(a.pi, "window_index");
		const ib = f.opt(b.pi, "window_index");
		const r = f.cli(["bar", "--pane", a.pi]);
		assert.equal(r.code, 0, r.err);
		assert.equal(r.out, `π [${ib}]? a very long… [${ia}]◐ flare##1 `);
		assert.equal(f.opt(a.pi, "window_name"), "◐ flare#1");
		assert.equal(f.opt(c.pi, "window_name"), "● busy");
		assert.equal(f.opt(c.pi, "window_index"), "7");
		// a user-named window is left alone
		f.tmux(["set-option", "-w", "-t", f.opt(b.pi, "window_id"), "@pi_fleet_named", "0"]);
		f.tmux(["rename-window", "-t", f.opt(b.pi, "window_id"), "mine"]);
		f.cli(["bar"]);
		assert.equal(f.opt(b.pi, "window_name"), "mine");

		// seen: only waiting/question with a runId; never running
		f.cli(["seen", "--window", f.opt(c.pi, "window_id")]);
		assert.ok(!existsSync(join(f.statusDir, `${c.id}.seen`)));
		f.cli(["seen", "--window", f.opt(a.pi, "window_id")]);
		assert.deepEqual(JSON.parse(readFileSync(join(f.statusDir, `${a.id}.seen`), "utf8")), { runId: "r2" });
		f.cli(["seen", b.id]);
		assert.deepEqual(JSON.parse(readFileSync(join(f.statusDir, `${b.id}.seen`), "utf8")), { runId: "r1" });

		// crashed (pid dead) with its pane present: ✕ in the bar
		f.writeStatus({ sessionId: c.id, name: "busy", state: "running", pid: 999_999_999, tmux: { socket: sock, piPane: c.pi } });
		assert.match(f.cli(["bar"]).out, /\[7\]✕ busy/);
		assert.equal(f.opt(c.pi, "window_name"), "✕ busy");

		const ls = JSON.parse(f.cli(["ls", "--json"]).out);
		assert.equal(ls.length, 5);
		assert.equal(ls.find((s: any) => s.sessionId === c.id).liveness, "crashed");
		assert.equal(ls.find((s: any) => s.sessionId === "remote-2").liveness, "remote");
	} finally {
		f.close();
	}
});

test("# in cwd, names and session names is literal, not a tmux format", { skip: skipNvim, timeout: 60_000 }, async () => {
	const f = new Fleet();
	try {
		f.tmux(["new-session", "-d", "-s", "s#1", "-x", "200", "-y", "50", "sh"]);
		const target = f.tmux(["display-message", "-p", "-t", "s#1:", "#{pane_id}"]);
		const cwd = join(f.work, "x#{session_name}#H");
		mkdirSync(cwd);
		const r = f.cli(["open", "--cwd", cwd, "--target", target]);
		assert.equal(r.code, 0, r.err);
		const pi = r.out.trim();
		const id = f.opt(pi, "@pi_fleet_session");
		await waitFor("stub pi to start", () => f.runs(id).length === 1);
		const nvim = f.opt(pi, "@pi_fleet_peer");
		assert.equal(f.opt(pi, "session_name"), "s#1");
		assert.equal(f.opt(pi, "window_name"), "⟳ x#{session_name}#H");
		assert.equal(f.opt(pi, "pane_current_path"), cwd);
		await waitFor("nvim cwd", () => f.opt(nvim, "pane_current_path") === cwd);

		f.writeStatus({ sessionId: id, name: "n#{session_name}#H", state: "waiting", acked: false, runId: "r1", tmux: { socket: f.socket, piPane: pi } });
		const bar = f.cli(["bar", "--pane", f.active()]);
		assert.equal(bar.out, `π [s##1:${f.opt(pi, "window_index")}]◐ n##{session_… `);
		assert.equal(f.opt(pi, "window_name"), "◐ n#{session_name}#H");
		// the next tick sees the literal name and does not rename again
		f.tmux(["set-hook", "-g", "window-renamed", "set -g @pft_renamed 1"]);
		f.cli(["bar"]);
		f.cli(["bar"]);
		assert.equal(f.tmux(["show", "-gqv", "@pft_renamed"]), "");
		f.tmux(["rename-window", "-t", pi, "probe"]); // the hook itself works
		await waitFor("hook fired", () => f.tmux(["show", "-gqv", "@pft_renamed"]) === "1");
	} finally {
		f.close();
	}
});

test("run-pi: SIGTERM is forwarded to pi and exits 143 without the crash prompt", { skip: skipNvim, timeout: 60_000 }, async () => {
	const f = new Fleet();
	try {
		const s = await f.open();
		f.tmux(["set-option", "-w", "-t", s.pi, "remain-on-exit", "on"]);
		process.kill(Number(f.opt(s.pi, "pane_pid")), "SIGTERM");
		await waitFor("run-pi exited", () => f.opt(s.pi, "pane_dead") === "1");
		// pane_dead can flip (pty EOF) before tmux has reaped the exit status
		const status = await waitFor("exit status", () => f.opt(s.pi, "pane_dead_status"), 3000).catch(() => "none (killed by a signal?)");
		assert.equal(status, "143");
		assert.doesNotMatch(f.tmux(["capture-pane", "-p", "-t", s.pi]), /r restart/);
		assert.equal(f.runs(s.id).length, 1);
	} finally {
		f.close();
	}
});

test("tmux.conf hook: switching to a window acks its waiting pi", { skip: skipTmux, timeout: 30_000 }, async () => {
	const f = new Fleet({ conf: tmuxConf });
	try {
		const w1 = f.tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "sh"]);
		const w2 = f.tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "sh"]);
		const waiting = f.writeStatus({ sessionId: "hook-wait", state: "waiting", acked: false, runId: "r3", tmux: { socket: f.socket, piPane: w1 } });
		const running = f.writeStatus({ sessionId: "hook-run", state: "running", acked: true, runId: "r4", tmux: { socket: f.socket, piPane: w2 } });
		f.tmux(["select-window", "-t", w2]);
		f.tmux(["select-window", "-t", w1]);
		const seenFile = join(f.statusDir, `${waiting}.seen`);
		await waitFor("hook wrote .seen", () => existsSync(seenFile));
		assert.deepEqual(JSON.parse(readFileSync(seenFile, "utf8")), { runId: "r3" });
		assert.ok(!existsSync(join(f.statusDir, `${running}.seen`)));
	} finally {
		f.close();
	}
});

test("dashboard --window: creates the fleet window, then toggles back", { skip: skipTmux, timeout: 30_000 }, async () => {
	const f = new Fleet();
	try {
		const start = f.active();
		assert.equal(f.cli(["dashboard", "--window", "--pane", start]).code, 0);
		const dash = f.active();
		assert.notEqual(dash, start);
		assert.equal(f.opt(dash, "window_name"), "fleet");
		assert.equal(f.opt(dash, "@pi_fleet_dashboard"), "1");
		await waitFor("placeholder drawn", () => f.tmux(["capture-pane", "-p", "-t", dash]).includes("pi-fleet"));
		assert.equal(f.cli(["dashboard", "--window", "--pane", dash]).code, 0);
		assert.equal(f.active(), start, "from the dashboard: back to the last window");
		assert.equal(f.cli(["dashboard", "--window", "--pane", start]).code, 0);
		assert.equal(f.active(), dash, "reuses the existing window");
		assert.equal(f.windows().length, 2);
	} finally {
		f.close();
	}
});
