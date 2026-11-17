// pi-fleet nvim bridge (design §11, phase 5): nvim/lua/nvconf/pi_fleet.lua and
// pi/extensions/fleet/nvim.ts. Every nvim is `nvim --headless --listen <tmp sock>`, driven
// over msgpack-RPC with nvim.ts's own client; the control socket is a test server. No tmux:
// TMUX/TMUX_PANE are removed from this process. The user-config tests run the repo's nvim/
// config (XDG_CONFIG_HOME → a temp dir linking it) with the installed packer plugins, a temp
// HOME/state/cache/TMPDIR, and are skipped when packer is not installed (it would clone).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	handleUserEdit,
	msgpackDecode,
	msgpackEncode,
	nvimCall,
	nvimRequest,
	register,
	toolPath,
	USER_EDIT_EVENT,
} from "../../pi/extensions/fleet/nvim.ts";
import { parseUserEdit, USER_EDIT } from "../../pi/extensions/fleet/protocol.ts";
import { fleetOf } from "../../pi/extensions/fleet/shared.ts";

delete process.env.TMUX;
delete process.env.TMUX_PANE;
delete process.env.PI_FLEET_SESSION;

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../..");
const nvimDir = join(repo, "nvim");


const haveNvim = spawnSync("nvim", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
const realData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const havePlugins = existsSync(join(realData, "nvim/site/pack/packer/start/packer.nvim"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(25);
	}
}

/** The fake pi control socket: collects NDJSON lines. */
class CtlServer {
	readonly lines: any[] = [];
	readonly server: Server;
	readonly path: string;
	constructor(path: string) {
		this.path = path;
		this.server = createServer((conn) => {
			let buf = "";
			conn.on("data", (d) => {
				buf += d.toString("utf8");
				let i: number;
				while ((i = buf.indexOf("\n")) >= 0) {
					this.lines.push(JSON.parse(buf.slice(0, i)));
					buf = buf.slice(i + 1);
				}
			});
		});
	}
	listen(): Promise<void> {
		return new Promise((r) => this.server.listen(this.path, () => r()));
	}
	close(): void {
		this.server.close();
	}
}

interface NvimOpts {
	paired: boolean;
	userConfig: boolean;
	files?: string[];
}

class Nvim {
	readonly root = mkdtempSync(join(tmpdir(), "pfn-"));
	sock: string;
	readonly ctl: CtlServer;
	readonly work = join(this.root, "work");
	readonly session = "00000000-test-4000-8000-000000000005";
	proc: ChildProcess | undefined;
	output = "";
	env: NodeJS.ProcessEnv;

	readonly opts: NvimOpts;

	constructor(opts: NvimOpts, sock?: string) {
		this.opts = opts;
		this.sock = sock ?? join(this.root, "nvim.sock");
		mkdirSync(this.work);
		for (const d of ["home", "state", "cache", "tmp", "config"]) mkdirSync(join(this.root, d));
		this.ctl = new CtlServer(join(this.root, "ctl.sock"));
		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			HOME: join(this.root, "home"),
			TMPDIR: join(this.root, "tmp"),
			XDG_CONFIG_HOME: join(this.root, "config"),
			XDG_STATE_HOME: join(this.root, "state"),
			XDG_CACHE_HOME: join(this.root, "cache"),
			XDG_DATA_HOME: opts.userConfig ? realData : join(this.root, "data"),
			PI_FLEET_CTL_SOCK: this.ctl.path,
			PI_FLEET_PI_PANE: "%1",
			LANG: "C.UTF-8",
		};
		if (opts.paired) env.PI_FLEET_SESSION = this.session;
		this.env = env;
		if (opts.userConfig) symlinkSync(nvimDir, join(this.root, "config", "nvim"));
	}

	args(extra: string[] = []): string[] {
		const base = ["--headless", "-n"];
		if (!this.opts.userConfig) {
			// Same wiring as nvconf/init.lua, without the rest of the config.
			base.unshift("--clean");
			base.push(
				"--cmd", `set rtp^=${nvimDir}`,
				"--cmd", "lua if (vim.env.PI_FLEET_SESSION or '') ~= '' then require('nvconf.pi_fleet').setup() end",
			);
		}
		return [...base, ...extra];
	}

	async start(): Promise<this> {
		await this.ctl.listen();
		this.proc = spawn("nvim", this.args(["--listen", this.sock, ...(this.opts.files ?? [])]), {
			cwd: this.work,
			env: this.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.proc.stdout!.on("data", (d) => (this.output += d));
		this.proc.stderr!.on("data", (d) => (this.output += d));
		await waitFor("nvim socket", () => existsSync(this.sock));
		// VimEnter done
		await waitFor("nvim ready", () => true);
		await this.lua("return 1");
		return this;
	}

	lua(code: string, ...args: unknown[]): Promise<any> {
		return nvimRequest(this.sock, "nvim_exec_lua", [code, args], 5000);
	}

	cmd(command: string): Promise<any> {
		return nvimRequest(this.sock, "nvim_command", [command], 5000);
	}

	/** feedkeys as typed (mappings apply), then wait until nvim processed them. */
	async feed(keys: string): Promise<void> {
		await nvimRequest(this.sock, "nvim_feedkeys", [keys, "t", false], 5000);
		await this.lua("return 1");
	}

	file(name: string, text: string): string {
		const p = join(this.work, name);
		writeFileSync(p, text);
		return realpathSync(p);
	}

	async stop(): Promise<void> {
		if (this.proc && this.proc.exitCode === null) {
			await nvimRequest(this.sock, "nvim_command", ["qa!"], 2000).catch(() => {});
			await waitFor("nvim exit", () => this.proc!.exitCode !== null || this.proc!.signalCode !== null, 5000).catch(
				() => this.proc!.kill("SIGKILL"),
			);
		}
		this.ctl.close();
		rmSync(this.root, { recursive: true, force: true });
	}
}

async function withNvim(opts: NvimOpts, fn: (n: Nvim) => Promise<void>): Promise<void> {
	const n = new Nvim(opts);
	try {
		await n.start();
		await fn(n);
	} finally {
		await n.stop();
	}
}

const ERROR_RE = /(^|\n)\s*(E\d+:|Error|stack traceback|attempt to)/;

// ---------------------------------------------------------------- pure

test("msgpack round trip", () => {
	const values = [null, true, false, 0, 127, 128, 255, 65535, 70000, -1, -33, -40000, 1.5, "", "x".repeat(40),
		"é".repeat(200), "y".repeat(70000), [1, [2, "a"]], { a: 1, b: [null] }, new Array(20).fill(7)];
	for (const v of values) {
		const enc = msgpackEncode(v);
		const dec = msgpackDecode(enc);
		assert.ok(dec, `decodes ${JSON.stringify(v)?.slice(0, 40)}`);
		assert.deepEqual(dec[0], v);
		assert.equal(dec[1], enc.length);
		assert.equal(msgpackDecode(enc.subarray(0, enc.length - 1)), undefined, "incomplete → undefined");
	}
	// ext (nvim Buffer handle)
	const [ext] = msgpackDecode(Buffer.from([0xd4, 0x00, 0x05]))!;
	assert.deepEqual((ext as any).ext, 0);
});

test("parseUserEdit validates and normalises", () => {
	assert.equal(parseUserEdit({ type: "user_edit", mode: "loud", path: "/a", diff: "" }), undefined);
	assert.equal(parseUserEdit({ type: "user_edit", mode: "note", path: "rel", diff: "" }), undefined);
	assert.equal(parseUserEdit({ type: "ping" }), undefined);
	const m = parseUserEdit({ type: "user_edit", mode: "steer", path: "/a/b", diff: "@@\n+x\n", added: 1, removed: -3 });
	assert.equal(m?.mode, "steer");
	assert.equal(m?.added, 1);
	assert.equal(m?.removed, 0);
	assert.equal(USER_EDIT, "user_edit");
});

test("toolPath resolves tool arguments", () => {
	assert.equal(toolPath("src/x.py", "/w"), "/w/src/x.py");
	assert.equal(toolPath("@src/x.py", "/w"), "/w/src/x.py");
	assert.equal(toolPath("/abs/../y", "/w"), "/y");
	assert.equal(toolPath("~/f", "/w"), join(homedir(), "f"));
	assert.equal(toolPath(undefined, "/w"), undefined);
});

// ---------------------------------------------------------------- lua side (clean nvim)

const nvimTest = haveNvim ? test : test.skip;

nvimTest(":w!! in a paired nvim saves and sends mode steer", async () => {
	await withNvim({ paired: true, userConfig: false }, async (n) => {
		const f = n.file("a.py", "one\ntwo\nthree\n");
		await n.lua("vim.cmd.edit(...)", f);
		assert.equal(await n.lua("return vim.bo.readonly"), true, "readonly on read");
		assert.match(await n.lua("return vim.wo.winbar"), /pi_fleet/);
		assert.match(await n.lua("return require('nvconf.pi_fleet').winbar()"), /read-only · :w! save \+ note/);
		await n.lua("vim.api.nvim_buf_set_lines(0, 1, 2, false, {'TWO', 'extra'})");
		assert.match(await n.lua("return require('nvconf.pi_fleet').winbar()"), /modified/);
		await n.feed(":w!!\r");
		const msg = await waitFor("user_edit", () => n.ctl.lines[0]);
		assert.equal(msg.type, "user_edit");
		assert.equal(msg.mode, "steer");
		assert.equal(msg.path, f);
		assert.equal(msg.session, n.session);
		assert.equal(msg.added, 2);
		assert.equal(msg.removed, 1);
		assert.equal(msg.created, false);
		assert.match(msg.diff, /^@@ .* @@\n/);
		assert.match(msg.diff, /\n-two\n\+TWO\n\+extra\n/);
		assert.equal(readFileSync(f, "utf8"), "one\nTWO\nextra\nthree\n");
		assert.equal(await n.lua("return vim.bo.readonly"), true, "readonly again after the write");
		assert.equal(await n.lua("return vim.b.pi_fleet_write_mode"), null);
		assert.ok(parseUserEdit(msg), "lua message passes the TS validator");
	});
});

nvimTest(":w! sends mode note; unchanged writes and plain :w send nothing", async () => {
	await withNvim({ paired: true, userConfig: false }, async (n) => {
		const f = n.file("b.txt", "x\n");
		await n.lua("vim.cmd.edit(...)", f);
		await n.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'y'})");
		await n.feed(":w\r"); // E45 readonly
		assert.equal(readFileSync(f, "utf8"), "x\n");
		await n.feed(":w!\r");
		const msg = await waitFor("user_edit", () => n.ctl.lines[0]);
		assert.equal(msg.mode, "note");
		assert.equal(msg.diff, "@@ -1 +1 @@\n-x\n+y\n");
		await n.feed(":w!\r"); // no changes
		await sleep(200);
		assert.equal(n.ctl.lines.length, 1);
		// a search for w!! is not rewritten
		await n.feed("/w!!\r");
		await sleep(100);
		assert.equal(n.ctl.lines.length, 1);
	});
});

nvimTest(":wq! delivers the note before nvim exits", async () => {
	await withNvim({ paired: true, userConfig: false }, async (n) => {
		const f = n.file("q.txt", "1\n");
		await n.lua("vim.cmd.edit(...)", f);
		await n.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'2'})");
		await nvimRequest(n.sock, "nvim_feedkeys", [":wq!\r", "t", false], 5000);
		await waitFor("nvim exit", () => n.proc!.exitCode !== null);
		const msg = await waitFor("user_edit", () => n.ctl.lines[0]);
		assert.equal(msg.mode, "note");
		assert.equal(msg.diff, "@@ -1 +1 @@\n-1\n+2\n");
	});
});

nvimTest("large diffs are cut under the socket line cap, counts stay whole", async () => {
	await withNvim({ paired: true, userConfig: false }, async (n) => {
		const f = n.file("big.txt", "");
		await n.lua("vim.cmd.edit(...)", f);
		// quotes and control characters grow under JSON escaping
		await n.lua("local l = {} for i = 1, 4000 do l[i] = ('\"\\t'):rep(10) .. i end vim.api.nvim_buf_set_lines(0, 0, -1, false, l)");
		await n.feed(":w!\r");
		const msg = await waitFor("user_edit", () => n.ctl.lines[0]);
		assert.equal(msg.truncated, true);
		assert.equal(msg.added, 4000);
		assert.equal(msg.created, false);
		assert.ok(JSON.stringify(msg).length < 64 * 1024);
		assert.match(msg.diff, /\n$/, "cut at a line boundary");
	});
});

nvimTest("unpaired nvim: no mapping, no readonly, :w!! not rewritten", async () => {
	await withNvim({ paired: false, userConfig: false }, async (n) => {
		const f = n.file("c.txt", "orig\n");
		await n.lua("vim.cmd.edit(...)", f);
		assert.equal(await n.lua("return vim.fn.maparg('<CR>', 'c')"), "");
		assert.equal(await n.lua("return vim.fn.exists(':PiWriteSteer')"), 0);
		assert.equal(await n.lua("return vim.bo.readonly"), false);
		assert.equal(await n.lua("return vim.wo.winbar"), "");
		await n.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'new'})");
		await n.feed(":w!!\r");
		await sleep(300);
		assert.equal(n.ctl.lines.length, 0);
		assert.equal(readFileSync(f, "utf8"), "orig\n", "native :w!! does not write the file");
	});
});

nvimTest("agent_changed reloads clean buffers, flags modified ones; PiDiff; checktime_all", async () => {
	await withNvim({ paired: true, userConfig: false }, async (n) => {
		const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
		const clean = n.file("clean.txt", lines.join("\n") + "\n");
		const dirty = n.file("dirty.txt", "mine\n");
		await n.lua("vim.cmd.edit(...)", dirty);
		await n.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'user text'})");
		await n.lua("vim.cmd('hide edit ' .. vim.fn.fnameescape(...))", clean);
		await n.lua("vim.api.nvim_win_set_cursor(0, {150, 3})");
		const topBefore = await n.lua("return vim.fn.line('w0')");

		await sleep(20);
		writeFileSync(clean, ["changed by pi", ...lines].join("\n") + "\n");
		writeFileSync(dirty, "pi text\n");
		// through nvim.ts's RPC client: paths travel as data
		const count = await nvimCall(n.sock, { fn: "agent_changed", arg: [clean, dirty, join(n.work, "not-open.txt")] });
		assert.equal(count, 2);
		assert.equal(await n.lua("return vim.api.nvim_buf_get_lines(0, 0, 1, false)[1]"), "changed by pi");
		assert.deepEqual(await n.lua("return vim.api.nvim_win_get_cursor(0)"), [150, 3], "view kept");
		assert.equal(await n.lua("return vim.fn.line('w0')"), topBefore);
		assert.equal(await n.lua("return vim.bo.readonly"), true);

		const dbuf = await n.lua("return vim.fn.bufnr(...)", dirty);
		assert.deepEqual(await n.lua("return vim.api.nvim_buf_get_lines(..., 0, -1, false)", dbuf), ["user text"]);
		assert.equal(await n.lua("return vim.b[...].pi_fleet_conflict", dbuf), true);
		assert.match(n.output + (await n.lua("return vim.fn.execute('messages')")), /changed .*dirty\.txt — :PiDiff/);

		await n.lua("vim.cmd.buffer(...)", dbuf);
		assert.match(await n.lua("return require('nvconf.pi_fleet').winbar()"), /pi changed this file/);
		await n.cmd("PiDiff");
		assert.equal(await n.lua("return #vim.api.nvim_tabpage_list_wins(0)"), 2);
		assert.deepEqual(await n.lua("return vim.api.nvim_buf_get_lines(0, 0, -1, false)"), ["pi text"]);
		assert.equal(await n.lua("return vim.wo.diff"), true);
		await n.feed("q");
		assert.equal(await n.lua("return #vim.api.nvim_tabpage_list_wins(0)"), 1);
		assert.equal(await n.lua("return vim.wo.diff"), false);
		await n.cmd("edit!"); // take pi's version
		assert.deepEqual(await n.lua("return vim.api.nvim_buf_get_lines(0, 0, -1, false)"), ["pi text"]);
		assert.equal(await n.lua("return vim.b.pi_fleet_conflict"), null);

		// edits made through bash: checktime_all
		await sleep(20);
		writeFileSync(dirty, "bash text, longer\n");
		assert.equal(await nvimCall(n.sock, { fn: "checktime_all", arg: null }), true);
		assert.deepEqual(await n.lua("return vim.api.nvim_buf_get_lines(0, 0, -1, false)"), ["bash text, longer"]);

		// PiHelp opens a scratch help; PiFocus outside tmux only warns
		await n.cmd("PiHelp");
		assert.match((await n.lua("return vim.api.nvim_buf_get_lines(0, 0, -1, false)")).join("\n"), /:w!!\s+save \+ interrupt/);
		await n.feed("q");
		assert.equal(await n.lua("return require('nvconf.pi_fleet').focus()"), false);
		assert.doesNotMatch(n.output, ERROR_RE);
	});
});

// ---------------------------------------------------------------- nvim.ts in a fake pi

function fakePi() {
	const handlers = new Map<string, Function[]>();
	const events: [string, unknown][] = [];
	const pi: any = {
		on(name: string, fn: Function) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		events: { emit: (ch: string, data: unknown) => events.push([ch, data]), on() {} },
	};
	const fire = async (name: string, event: unknown, ctx: unknown) => {
		for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
	};
	return { pi, events, fire };
}

nvimTest("nvim.ts: edit/write tool results reload the paired nvim; user_edit handler", async () => {
	const runtime = mkdtempSync(join(tmpdir(), "pfr-"));
	const saved = process.env.PI_FLEET_RUNTIME_DIR;
	process.env.PI_FLEET_RUNTIME_DIR = runtime;
	// the nvim listens where nvim.ts looks outside tmux: <runtime>/<id>.nvim.sock
	const n = new Nvim({ paired: true, userConfig: false }, join(runtime, "00000000-test-4000-8000-000000000005.nvim.sock"));
	try {
		await n.start();
		const f = n.file("t.txt", "before\n");
		await n.lua("vim.cmd.edit(...)", f);

		const { pi, events, fire } = fakePi();
		const control: Record<string, Function> = {};
		fleetOf(pi).main = true;
		(fleetOf(pi) as any).control = { on: (type: string, h: Function) => (control[type] = h) };
		register(pi);
		assert.equal(typeof control[USER_EDIT], "function", "registered on the control registry");
		const ctx = { cwd: n.work, sessionManager: { getSessionId: () => n.session } };
		await fire("session_start", { reason: "startup" }, ctx);

		await sleep(20);
		writeFileSync(f, "after edit\n");
		await fire("tool_result", { toolName: "edit", input: { path: "t.txt" }, isError: false }, ctx);
		const end = Date.now() + 5000;
		while ((await n.lua("return vim.api.nvim_buf_get_lines(0, 0, 1, false)[1]")) !== "after edit") {
			if (Date.now() > end) assert.fail("edit tool result did not reload nvim");
			await sleep(25);
		}
		// failed tool results do nothing
		await sleep(20);
		writeFileSync(f, "after failed\n");
		await fire("tool_result", { toolName: "write", input: { path: f }, isError: true }, ctx);
		await sleep(200);
		assert.equal(await n.lua("return vim.api.nvim_buf_get_lines(0, 0, 1, false)[1]"), "after edit");
		await fire("agent_settled", {}, ctx);
		const end2 = Date.now() + 5000;
		while ((await n.lua("return vim.api.nvim_buf_get_lines(0, 0, 1, false)[1]")) !== "after failed") {
			if (Date.now() > end2) assert.fail("agent_settled did not checktime");
			await sleep(25);
		}

		// user_edit from the control socket → pi.events
		const good = { type: "user_edit", v: 1, mode: "note", path: f, diff: "@@ -1 +1 @@\n-a\n+b\n", added: 1, removed: 1, session: n.session };
		assert.equal(control[USER_EDIT](good), undefined);
		assert.throws(() => control[USER_EDIT]({ ...good, session: "other" }), /dropped/);
		assert.throws(() => control[USER_EDIT]({ ...good, mode: "x" }), /dropped/);
		assert.equal(events.length, 1);
		assert.equal(events[0][0], USER_EDIT_EVENT);
		assert.equal((events[0][1] as any).mode, "note");

		// subagent / non-main instances do nothing
		const sub = fakePi();
		register(sub.pi);
		assert.equal(handleUserEdit(sub.pi, good, n.session), false);
	} finally {
		if (saved === undefined) delete process.env.PI_FLEET_RUNTIME_DIR;
		else process.env.PI_FLEET_RUNTIME_DIR = saved;
		await n.stop();
		rmSync(runtime, { recursive: true, force: true });
	}
});

const haveTmux = spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 5000 }).status === 0;
const tmuxTest = haveNvim && haveTmux ? test : test.skip;

tmuxTest("nvim.ts in tmux: TUI pairs at session start (once, never in RPC), an edit re-pairs after nvim dies, status patched", async () => {
	const root = mkdtempSync(join(tmpdir(), "pft5-"));
	const sock = join(root, "tmux.sock"); // throwaway server; never the default socket
	const runtime = join(root, "run");
	const init = join(root, "init.lua");
	mkdirSync(runtime, { mode: 0o700 });
	mkdirSync(join(root, "home"));
	writeFileSync(
		init,
		`vim.opt.rtp:prepend(${JSON.stringify(nvimDir)})\nif (vim.env.PI_FLEET_SESSION or "") ~= "" then require("nvconf.pi_fleet").setup() end\n`,
	);
	const tenv: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: join(root, "home"),
		TMPDIR: root,
		XDG_STATE_HOME: join(root, "home"),
		XDG_DATA_HOME: join(root, "home"),
		LANG: "C.UTF-8",
	};
	const tmuxSync = (...args: string[]) =>
		spawnSync("tmux", ["-S", sock, "-f", "/dev/null", ...args], { env: tenv, encoding: "utf8", timeout: 5000 }).stdout.trim();
	const keys = ["TMUX", "TMUX_PANE", "PI_FLEET_TMUX_SOCKET", "PI_FLEET_TMUX_GUARD", "PI_FLEET_RUNTIME_DIR", "PI_FLEET_NVIM_CMD"];
	const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	const session = "00000000-tmux-4000-8000-000000000005";
	try {
		const piPane = tmuxSync("new-session", "-d", "-x", "200", "-y", "50", "-P", "-F", "#{pane_id}", "--", "sleep", "600");
		assert.match(piPane, /^%\d+$/);
		Object.assign(process.env, {
			TMUX_PANE: piPane,
			PI_FLEET_TMUX_SOCKET: sock,
			PI_FLEET_TMUX_GUARD: "1",
			PI_FLEET_RUNTIME_DIR: runtime,
			PI_FLEET_NVIM_CMD: `nvim -n -u ${init}`,
		});
		delete process.env.TMUX;

		const { pi, fire } = fakePi();
		const shared = fleetOf(pi);
		shared.main = true;
		const patches: any[] = [];
		let file: any = { tmux: { piPane } };
		shared.status = {
			patch: (f: any) => {
				patches.push(f);
				file = { ...file, ...f };
			},
			ack() {},
			current: () => file,
		};
		register(pi);
		// RPC mode never pairs, not at session start and not on an edit
		const rpc = fakePi();
		fleetOf(rpc.pi).main = true;
		register(rpc.pi);
		const rpcCtx = { cwd: root, mode: "rpc", sessionManager: { getSessionId: () => session } };
		await rpc.fire("session_start", { reason: "startup" }, rpcCtx);
		await rpc.fire("tool_result", { toolName: "edit", input: { path: join(root, "x.txt") }, isError: false }, rpcCtx);
		await sleep(500);
		assert.equal(tmuxSync("list-panes", "-t", piPane, "-F", "#{pane_id}").split("\n").length, 1, "rpc: no nvim pane");
		await rpc.fire("session_shutdown", {}, rpcCtx);

		const ctx = { cwd: root, mode: "tui", sessionManager: { getSessionId: () => session } };
		await fire("session_start", { reason: "startup" }, ctx);
		const first = await waitFor("paired at session start", () => file.tmux?.nvimPane);
		// idempotent: a second session_start (e.g. /reload) finds the live peer, no new split
		await fire("session_start", { reason: "reload" }, ctx);
		await sleep(300);
		assert.equal(tmuxSync("list-panes", "-t", piPane, "-F", "#{pane_id}").split("\n").length, 2, "one nvim pane");
		assert.equal(file.tmux.nvimPane, first);
		assert.equal(tmuxSync("show", "-pv", "-t", piPane, "@pi_fleet_peer"), first);
		assert.equal(file.nvimSock, join(runtime, `${session}.nvim.sock`));
		await waitFor("nvim socket", () => existsSync(file.nvimSock));
		await waitFor("nvim answers", () => true);
		const env1 = await nvimRequest(file.nvimSock, "nvim_exec_lua", ["return { vim.env.PI_FLEET_SESSION, package.loaded['nvconf.pi_fleet'] ~= nil }", []]);
		assert.deepEqual(env1, [session, true]);

		// the nvim dies; the next agent edit re-pairs
		tmuxSync("kill-pane", "-t", first);
		await waitFor("nvim pane gone", () => !tmuxSync("list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(first));
		await fire("tool_result", { toolName: "write", input: { path: join(root, "x.txt") }, isError: false }, ctx);
		const second = await waitFor("re-paired", () => (file.tmux?.nvimPane !== first ? file.tmux?.nvimPane : undefined));
		assert.notEqual(second, first);
		assert.equal(tmuxSync("show", "-pv", "-t", piPane, "@pi_fleet_peer"), second);
		assert.equal(file.tmux.piPane, piPane, "status tmux fields are merged, not replaced");
		assert.equal(tmuxSync("list-panes", "-t", piPane, "-F", "#{pane_id}").split("\n").length, 2, "exactly one nvim pane");
	} finally {
		spawnSync("tmux", ["-S", sock, "kill-server"], { stdio: "ignore", timeout: 5000 });
		for (const k of keys) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------- the user's config

const cfgTest = haveNvim && havePlugins ? test : test.skip;

cfgTest("user config: nvim --headless -c 'qa!' is clean, paired and unpaired", () => {
	for (const paired of [false, true]) {
		const n = new Nvim({ paired, userConfig: true });
		try {
			const r = spawnSync("nvim", n.args(["-c", "qa!"]), { cwd: n.work, env: n.env, encoding: "utf8", timeout: 60_000 });
			const out = (r.stdout ?? "") + (r.stderr ?? "");
			assert.equal(r.status, 0, `exit status (paired=${paired}): ${out}`);
			assert.doesNotMatch(out, ERROR_RE, `paired=${paired}`);
			assert.doesNotMatch(out, /pi ▸/, `no pi-fleet warnings (paired=${paired})`);
		} finally {
			rmSync(n.root, { recursive: true, force: true });
		}
	}
});

cfgTest("user config: :w!! sends steer when paired and is untouched when unpaired", async () => {
	await withNvim({ paired: true, userConfig: true }, async (n) => {
		const f = n.file("d.lua", "local x = 1\n");
		await n.lua("vim.cmd.edit(...)", f);
		assert.equal(await n.lua("return vim.bo.readonly"), true);
		assert.equal(await n.lua("return vim.fn.maparg('<CR>', 'c', false, true).desc"), "pi-fleet: :w!! = save + interrupt pi");
		await n.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'local x = 2'})");
		await n.feed(":w!!\r");
		const msg = await waitFor("user_edit", () => n.ctl.lines[0]);
		assert.equal(msg.mode, "steer");
		assert.equal(msg.path, f);
		assert.equal(readFileSync(f, "utf8"), "local x = 2\n");
		// side windows (nvim-tree) get no winbar, file windows keep it
		{
			assert.equal(await n.lua("return vim.fn.exists(':NvimTreeOpen')"), 2, "nvim-tree loaded");
			await n.cmd("NvimTreeOpen");
			const bars = await n.lua(
				"local r = {} for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do r[#r + 1] = vim.bo[vim.api.nvim_win_get_buf(w)].filetype .. '=' .. vim.wo[w].winbar end table.sort(r) return r",
			);
			assert.deepEqual(bars, ["NvimTree=", "lua=%{%v:lua.require'nvconf.pi_fleet'.winbar()%}"]);
		}
		assert.doesNotMatch(n.output, ERROR_RE);
	});
	await withNvim({ paired: false, userConfig: true }, async (n) => {
		assert.equal(await n.lua("return package.loaded['nvconf.pi_fleet'] == nil"), true, "module not loaded");
		assert.equal(await n.lua("return vim.fn.maparg('<CR>', 'c')"), "");
		const f = n.file("e.txt", "orig\n");
		await n.lua("vim.cmd.edit(...)", f);
		assert.equal(await n.lua("return vim.bo.readonly"), false);
		await n.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, {'new'})");
		await n.feed(":w!!\r");
		await sleep(300);
		assert.equal(n.ctl.lines.length, 0);
		assert.equal(readFileSync(f, "utf8"), "orig\n");
	});
});
