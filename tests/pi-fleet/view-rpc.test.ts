// /view end to end (design §11, phase 6): a real `pi --mode rpc` with only the fleet extension,
// resuming a hand-written session that already has tool calls, and a headless nvim listening on
// <runtime>/<session id>.nvim.sock (what resolveNvim finds outside tmux). Checks the nvim
// buffer, cursor and scratch buffers after `/view src/x.py:10`, `/view tool:N`, the bare
// picker (answered over extension_ui_request) and the no-nvim fallback notice. Everything lives
// in a temp dir; TMUX is unset, so no tmux server is touched and nothing is paired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nvimRequest } from "../../pi/extensions/fleet/nvim.ts";
import { tempRoot } from "./support/tmp.ts";

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
const haveNvim = spawnSync("nvim", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
const skip = !havePi() ? "pi not on PATH" : !haveNvim ? "nvim not on PATH" : false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

const SID = "0f1e2d3c-0000-4000-8000-00000000c0de";

function sessionFile(root: string, work: string): string {
	const ts = new Date().toISOString();
	const ms = Date.now();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (id: string, parentId: string, callId: string, name: string, args: object) => ({
		type: "message", id, parentId, timestamp: ts,
		message: { role: "assistant", content: [{ type: "toolCall", id: callId, name, arguments: args }], api: "faux", provider: "faux", model: "faux-1", usage, stopReason: "toolUse", timestamp: ms },
	});
	const result = (id: string, parentId: string, callId: string, name: string, text: string) => ({
		type: "message", id, parentId, timestamp: ts,
		message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: ms },
	});
	const entries = [
		{ type: "session", version: 3, id: SID, timestamp: ts, cwd: work },
		{ type: "message", id: "e1", parentId: null, timestamp: ts, message: { role: "user", content: [{ type: "text", text: "look at x" }], timestamp: ms } },
		assistant("e2", "e1", "call_read_1", "read", { path: "src/x.py" }),
		result("e3", "e2", "call_read_1", "read", "line 1\n"),
		assistant("e4", "e3", "call_bash_2", "bash", { command: "echo hello" }),
		result("e5", "e4", "call_bash_2", "bash", "hello\nworld\n"),
	];
	const dir = join(root, "sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `view_${SID}.jsonl`);
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return file;
}

class Rpc {
	readonly events: any[] = [];
	readonly child: ChildProcess;
	stderr = "";
	private buf = "";
	private answered = new Set<string>();
	constructor(child: ChildProcess) {
		this.child = child;
		child.stderr!.on("data", (d) => (this.stderr += d));
		child.stdout!.on("data", (d) => {
			this.buf += d;
			let nl: number;
			while ((nl = this.buf.indexOf("\n")) >= 0) {
				const line = this.buf.slice(0, nl);
				this.buf = this.buf.slice(nl + 1);
				if (line.trim()) this.events.push(JSON.parse(line));
			}
		});
	}
	send(cmd: object): void {
		this.child.stdin!.write(JSON.stringify(cmd) + "\n");
	}
	/** Run a slash command and wait for its response (sent once the handler finished). */
	async command(text: string, wait = true): Promise<string> {
		const id = `c${this.events.length}-${Math.random().toString(36).slice(2, 8)}`;
		this.send({ id, type: "prompt", message: text });
		if (wait) await this.response(id, text);
		return id;
	}
	async response(id: string, what = id): Promise<void> {
		await waitFor(`response to ${what}`, () => this.events.find((e) => e.type === "response" && e.id === id));
	}
	notices(): string[] {
		return this.events.filter((e) => e.type === "extension_ui_request" && e.method === "notify").map((e) => e.message);
	}
	async nextDialog(method: string): Promise<any> {
		const req = await waitFor(`${method} dialog`, () =>
			this.events.find((e) => e.type === "extension_ui_request" && e.method === method && !this.answered.has(e.id)),
		);
		this.answered.add(req.id);
		return req;
	}
	answer(req: any, response: object): void {
		this.send({ type: "extension_ui_response", id: req.id, ...response });
	}
}

test("rpc pi: /view FILE:LINE, tool:N and the bare picker drive the paired nvim", { skip, timeout: 90_000 }, async () => {
	const root = tempRoot("pfv-rpc-");
	const work = join(root, "work");
	const run = join(root, "run");
	mkdirSync(join(work, "src"), { recursive: true });
	mkdirSync(run, { mode: 0o700 });
	writeFileSync(join(work, "src/x.py"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
	writeFileSync(join(work, "src/other.py"), "other\n");
	writeFileSync(join(work, "notes.md"), "# notes\n");
	execFileSync("git", ["init", "-q"], { cwd: work });
	const file = sessionFile(root, work);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_FLEET_STATE_DIR: join(root, "state"),
		PI_FLEET_RUNTIME_DIR: run,
		PI_OFFLINE: "1",
	};
	delete env.TMUX;
	delete env.TMUX_PANE;
	delete env.PI_FLEET_SESSION;
	mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });

	const sock = join(run, `${SID}.nvim.sock`);
	const nvim = spawn("nvim", ["--clean", "--headless", "-n", "--listen", sock], {
		cwd: work,
		env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_STATE_HOME: join(root, "xs"), XDG_CACHE_HOME: join(root, "xc"), XDG_CONFIG_HOME: join(root, "xcfg"), LANG: "C.UTF-8" },
		stdio: "ignore",
	});
	const lua = (code: string, ...args: unknown[]) => nvimRequest(sock, "nvim_exec_lua", [code, args], 5000) as Promise<any>;
	const current = () => lua("return { vim.api.nvim_buf_get_name(0), vim.api.nvim_win_get_cursor(0)[1], vim.bo.readonly, vim.bo.modifiable, vim.bo.filetype, vim.api.nvim_buf_get_lines(0, 0, -1, false) }");

	const pi = new Rpc(
		spawn(piCmd, ["--mode", "rpc", "-ne", "-e", fleetDir, "-e", fauxExt, "--offline", "--provider", "faux", "--model", "faux-1", "--session", file, "-ns", "-np", "-nc"], {
			cwd: work,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		}),
	);
	const exited = new Promise<number | null>((resolve) => pi.child.on("exit", resolve));
	try {
		await waitFor("nvim socket", () => existsSync(sock));
		await waitFor("nvim ready", () => lua("return 1").then(() => true, () => false));
		pi.send({ id: "s", type: "get_state" });
		await waitFor("pi ready", () => pi.events.find((e) => e.type === "response" && e.id === "s"));

		// /view FILE:LINE → buffer + cursor (line clamped to the file).
		await pi.command("/view src/x.py:10");
		let cur = await waitFor("x.py open", async () => {
			const c = await current();
			return c[0] === join(work, "src/x.py") ? c : undefined;
		});
		assert.equal(cur[1], 10);
		await pi.command("/view src/x.py:999");
		await waitFor("cursor clamped", async () => ((await current())[1] === 30 ? true : undefined));
		await pi.command(`/view ${join(work, "notes.md")}`);
		cur = await waitFor("notes.md open", async () => {
			const c = await current();
			return c[0] === join(work, "notes.md") ? c : undefined;
		});
		assert.equal(cur[1], 1);

		// /view tool:1 → the newest call (bash) as a read-only scratch buffer.
		await pi.command("/view tool:1");
		cur = await waitFor("bash output", async () => {
			const c = await current();
			return String(c[0]).endsWith("/bash.log") ? c : undefined;
		});
		assert.match(cur[0], /^pi:\/\/tool\/.+\/bash\.log$/);
		assert.deepEqual(cur[5], ["$ echo hello", "", "hello", "world"]);
		assert.equal(cur[2], true, "readonly");
		assert.equal(cur[3], false, "not modifiable");
		// Opening it again reuses the buffer.
		await pi.command("/view tool:1");
		const sameName = await lua("local n = 0 for _, b in ipairs(vim.api.nvim_list_bufs()) do if vim.api.nvim_buf_get_name(b):match('bash%.log$') then n = n + 1 end end return n");
		assert.equal(sameName, 1);
		await pi.command("/view tool:2");
		cur = await waitFor("read output", async () => {
			const c = await current();
			return String(c[0]).endsWith("/x.py") && String(c[0]).startsWith("pi://") ? c : undefined;
		});
		assert.equal(cur[4], "python", "filetype from the document name");
		await pi.command("/view tool:9");
		await waitFor("range error", () => pi.notices().find((m) => m.includes("tool:1..tool:2")));

		// Bare /view: one select with touched files first, then the tool calls.
		const bare = await pi.command("/view", false);
		const sel = await pi.nextDialog("select");
		const options: string[] = sel.options;
		const iX = options.findIndex((o) => o.startsWith("src/x.py"));
		const iTool = options.findIndex((o) => o.includes("✓ bash  echo hello"));
		assert.ok(iX >= 0 && iTool > iX, JSON.stringify(options));
		assert.ok(options.findIndex((o) => o.startsWith("notes.md")) < iTool, "viewed files count as touched");
		pi.answer(sel, { value: options.find((o) => o.startsWith("src/x.py")) });
		await pi.response(bare);
		await waitFor("x.py via picker", async () => ((await current())[0] === join(work, "src/x.py") ? true : undefined));

		// A missing file: an error notice (RPC has no fuzzy picker to fall back to).
		await pi.command("/view src/nope.py");
		await waitFor("missing notice", () => pi.notices().find((m) => m.includes("no such file: src/nope.py")));

		// No nvim: the fallback notice (RPC mode, no tmux: nothing to open it in).
		await nvimRequest(sock, "nvim_command", ["qa!"], 2000).catch(() => {});
		await waitFor("nvim gone", () => nvim.exitCode !== null || nvim.signalCode !== null);
		rmSync(sock, { force: true });
		await pi.command("/view src/other.py");
		await waitFor("fallback notice", () => pi.notices().find((m) => m.includes("no paired nvim")));

		pi.child.stdin!.end();
		assert.equal(await exited, 0, pi.stderr);
	} finally {
		if (pi.child.exitCode === null) pi.child.kill("SIGKILL");
		if (nvim.exitCode === null) nvim.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
	assert.equal(pi.stderr.match(/error/i), null, pi.stderr);
});
