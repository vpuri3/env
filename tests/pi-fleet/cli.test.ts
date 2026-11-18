// pi-fleet CLI and tmux glue: run-pi, pair/peer (a pi started by hand in your tmux), ls, tmux.conf and
// `pf` (pi-deck-design.md §8, §15). Every test drives a throwaway tmux server (`tmux -L
// fleettest-<pid>-<n>`, and `…-deck` for the deck); the harness refuses the default socket, and the CLI
// runs with PI_FLEET_TMUX_GUARD=1 so it refuses it (and pifleet) too. pi is the stub in
// support/stub-pi.sh (PI_FLEET_PI_CMD); nvim is real (`nvim --clean -n`), skipped if missing. State,
// runtime and HOME dirs are temporary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
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
	/** A pi started by hand in this tmux (a window running `pi-fleet run-pi`), paired with an nvim split (`pair`). */
	async open(): Promise<{ pi: string; nvim: string; id: string }> {
		const id = randomUUID();
		const pi = this.tmux(["new-window", "-P", "-F", "#{pane_id}", "-c", this.work, "-e", `PI_FLEET_SESSION=${id}`, "--", cliBin, "run-pi", "--session-id", id]);
		await waitFor("stub pi to start", () => this.runs(id).length === 1);
		const r = this.cli(["pair", pi, "--session", id]);
		assert.equal(r.code, 0, r.err);
		const nvim = r.out.trim();
		assert.match(nvim, /^%\d+$/);
		return { pi, nvim, id };
	}
	close(): void {
		this.tryTmux(["kill-server"]);
		if (this.socket) rmSync(this.socket, { force: true }); // tmux 3.2a leaves the socket file
		// The deck `pf` starts (PI_FLEET_DECK_SOCKET, see deckEnv).
		const deck = `${this.label}-deck`;
		spawnSync("tmux", ["-L", deck, "kill-server"], { stdio: "ignore" });
		rmSync(join(`${process.env.TMUX_TMPDIR || "/tmp"}/tmux-${process.getuid?.() ?? 0}`, deck), { force: true });
		rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
	/** This test's throwaway deck server (`<label>-deck`). */
	deckEnv(): NodeJS.ProcessEnv {
		return { PI_FLEET_DECK_SOCKET: `${this.label}-deck` };
	}
	deckTmux(args: string[]): string {
		const full = ["-L", `${this.label}-deck`, ...args];
		guardTmuxArgs(full);
		return execFileSync("tmux", full, { encoding: "utf8" }).replace(/\n$/, "");
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

test("tmux.conf loads on this tmux: bell, the deck bar (no polling), prefix g/G popup, prefix e; user bindings kept", { skip: skipTmux }, () => {
	const f = new Fleet({ conf: tmuxConf });
	try {
		assert.equal(f.tmux(["show", "-gwv", "monitor-bell"]), "on");
		assert.equal(f.tmux(["show", "-gv", "bell-action"]), "other");
		assert.equal(f.tmux(["show", "-gv", "visual-bell"]), "off");
		assert.equal(f.tmux(["show", "-gv", "status-left-length"]), "120");
		assert.equal(f.tmux(["show", "-gv", "status-left"]), "[#{session_name}] #{@pi_deck_bar}");
		assert.doesNotMatch(readFileSync(tmuxConf, "utf8"), /#\(/, "no #(...) in the status bar");
		assert.equal(f.tmux(["show", "-gv", "prefix"]), "C-s");
		const hooks = f.tmux(["show-hooks", "-g"]);
		assert.doesNotMatch(hooks, /pi-fleet/);
		assert.match(hooks, /client-attached\[0\] run-shell -b "#\{@ssh_link_cmd\}"/);
		assert.equal(f.tryTmux(["list-keys", "-T", "root", "C-h"]), undefined, "no root C-h");
		const keys = f.tmux(["list-keys", "-T", "prefix"]);
		const key = (k: string) => keys.split("\n").find((l) => new RegExp(`-T prefix +${k} `).test(l)) ?? "";
		assert.match(key("e"), /@pi_fleet_peer/);
		assert.match(key("e"), /pi-fleet peer --select [^|]*\|\| true\\*"/, "a failure must not put the pane in view mode");
		assert.match(key("g"), /display-popup -E -h 90% -w 95% pi-deck-attach/);
		assert.match(key("G"), /display-popup -E -h 90% -w 95% pi-deck-attach/);
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

test("tmux.conf and deck.tmux.conf agree on the terminal settings", { skip: skipTmux }, () => {
	const f = new Fleet({ conf: tmuxConf });
	try {
		const deckConf = join(repo, "pi/deck.tmux.conf");
		f.deckTmux(["-f", deckConf, "new-session", "-d", "-s", "x", "sleep 600"]);
		for (const [flag, opt] of [["-gv", "default-terminal"], ["-sv", "extended-keys"], ["-sv", "escape-time"], ["-gv", "prefix"], ["-gv", "set-clipboard"]]) {
			assert.equal(f.deckTmux(["show", flag, opt]), f.tmux(["show", flag, opt]), opt);
		}
	} finally {
		f.close();
	}
});

test("ls: status files of this node, with liveness", { skip: skipTmux }, () => {
	const f = new Fleet();
	try {
		f.writeStatus({ sessionId: "live-1", name: "flare#1", state: "waiting", acked: false, runId: "r2" });
		f.writeStatus({ sessionId: "dead-1", name: "busy", state: "running", pid: 999_999_999 });
		f.writeStatus({ sessionId: "remote-2", name: "far", state: "waiting", acked: false, host: "elsewhere-node" });
		const ls = JSON.parse(f.cli(["ls", "--json"]).out);
		assert.equal(ls.length, 3);
		assert.equal(ls.find((s: any) => s.sessionId === "live-1").liveness, "live");
		assert.equal(ls.find((s: any) => s.sessionId === "dead-1").liveness, "crashed");
		assert.equal(ls.find((s: any) => s.sessionId === "remote-2").liveness, "remote");
		assert.match(f.cli(["ls"]).out, /flare#1/);
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

// ---------------------------------------------------------------- pf (aliases.sh)

test("pf (aliases.sh): plain pf starts the deck only; pf DIR [-- ARGS] opens a session there in the deck (also inside tmux)", { skip: !haveTmux && "tmux not found", timeout: 90_000 }, async () => {
	const f = new Fleet();
	try {
		const aliases = join(repo, "aliases.sh");
		const pf = (args: string[], extra: NodeJS.ProcessEnv = {}, cwd = f.work) => {
			const env: NodeJS.ProcessEnv = { ...f.env, ...f.deckEnv(), PF_NO_ATTACH: "1", PI_FLEET_PI_PACKAGES: join(f.root, "none"), ...extra };
			delete env.PI_FLEET_TMUX_SOCKET;
			const r = spawnSync("bash", ["-c", '. "$0"; pf "$@"', aliases, ...args], { env, cwd, encoding: "utf8", timeout: 30_000 });
			return { code: r.status ?? -1, err: r.stderr };
		};
		const deckPanes = () =>
			f.deckTmux(["list-panes", "-a", "-F", "#{session_name}:#{window_name}.#{pane_index}\t#{@pi_fleet_role}\t#{@pi_fleet_session}\t#{pane_current_path}"]).split("\n").map((l) => l.split("\t"));
		const pis = () => deckPanes().filter((p) => p[1] === "pi");
		const dir = join(f.work, "proj");
		mkdirSync(dir);

		// Plain pf: the deck (list, nvim slot, pi slot), no session; the user's tmux is left alone.
		let r = pf([]);
		assert.equal(r.code, 0, r.err);
		assert.deepEqual(deckPanes().filter((p) => p[0]!.startsWith("deck:")).map((p) => p[1]), ["list", "nvim-holder", "preview"]);
		assert.equal(pis().length, 0);
		assert.deepEqual(f.tmux(["list-sessions", "-F", "#{session_name}"]).split("\n"), ["main"]);

		// pf DIR -- ARGS: a new session in DIR, shown in the pi slot.
		r = pf(["proj", "--", "--model", "x"]);
		assert.equal(r.code, 0, r.err);
		const [first] = pis();
		assert.equal(first![0], "deck:deck.2");
		assert.equal(first![3], dir);
		await waitFor("stub pi to start", () => f.runs(first![2]!).length === 1);
		assert.match(f.runs(first![2]!)[0]!, /--session-id \S+ --model x$/);

		// pf -- ARGS: a new session here. Inside tmux: the same (the popup is skipped with PF_NO_ATTACH).
		r = pf(["--", "--model", "y"], {}, dir);
		assert.equal(r.code, 0, r.err);
		assert.equal(pis().length, 2);
		r = pf([dir], { TMUX: `${f.socket},1,0`, TMUX_PANE: f.active() });
		assert.equal(r.code, 0, r.err);
		assert.equal(pis().length, 3);
		assert.equal(f.tmux(["list-windows", "-t", "=main"]).split("\n").length, 1, "no window in the user's tmux");

		// Errors.
		r = pf([join(f.work, "nope")]);
		assert.equal(r.code, 1);
		assert.match(r.err, /pf: not a directory: /);
		r = pf(["proj", "extra"]);
		assert.equal(r.code, 2);
		assert.match(r.err, /usage: pf \[DIR\] \[-- PI_ARGS\.\.\.\]/);
	} finally {
		f.close();
	}
});
