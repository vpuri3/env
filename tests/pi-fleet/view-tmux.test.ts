// /view in the TUI (design §11, phase 6): a real interactive pi (fleet extension + faux provider)
// in a throwaway tmux server (`tmux -L pfv-…`, never the default socket; the fleet runs with
// PI_FLEET_TMUX_GUARD=1), driven by send-keys/capture-pane. Checks: no nvim at session start,
// tiered completion in the editor, `/view FILE:LINE` pairs an nvim (lazily) and opens the file
// there and focuses its pane, a killed nvim is
// re-paired by `/view tool:N`, and the bare /view fuzzy picker filters and opens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nvimRequest } from "../../pi/extensions/fleet/nvim.ts";
import { tempRoot } from "./support/tmp.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const fleetDir = join(here, "../../pi/extensions/fleet");
const fauxExt = join(here, "support/faux-provider.ts");
const piCmd = process.env.PI_FLEET_TEST_PI ?? "pi";

const ok = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore", timeout: 5000, env: { ...process.env, PI_CODING_AGENT_DIR: tmpdir() } }).status === 0;
const skip = !ok(piCmd, ["--version"]) ? "pi not on PATH" : !ok("nvim", ["--version"]) ? "nvim not on PATH" : !ok("tmux", ["-V"]) ? "tmux not found" : false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		try {
			const value = await probe();
			if (value !== undefined && value !== false) return value as T;
		} catch (error) {
			last = error;
		}
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
		await sleep(100);
	}
}

const SID = "0f1e2d3c-0000-4000-8000-0000000ab1ed";

test("tui pi in tmux: completion, /view FILE:LINE focuses nvim, re-pair, bare picker", { skip, timeout: 120_000 }, async () => {
	const root = tempRoot("pfv-tmux-");
	const server = `pfv-${process.pid}`;
	assert.notEqual(server, "default");
	const tmux = (...args: string[]) => execFileSync("tmux", ["-L", server, ...args], { encoding: "utf8", env: { ...process.env, TMUX: "" } }).replace(/\n$/, "");
	const work = join(root, "work");
	const run = join(root, "run");
	mkdirSync(join(work, "src"), { recursive: true });
	mkdirSync(run, { mode: 0o700 });
	mkdirSync(join(root, "agent"));
	writeFileSync(join(work, "src/x.py"), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
	writeFileSync(join(work, "README.md"), "# readme\n");
	execFileSync("git", ["init", "-q"], { cwd: work });

	const ts = new Date().toISOString();
	const msNow = Date.now();
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const session = join(root, "sessions", `t_${SID}.jsonl`);
	mkdirSync(join(root, "sessions"));
	writeFileSync(
		session,
		[
			{ type: "session", version: 3, id: SID, timestamp: ts, cwd: work },
			{ type: "message", id: "e1", parentId: null, timestamp: ts, message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: msNow } },
			{ type: "message", id: "e2", parentId: "e1", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id: "call_r", name: "read", arguments: { path: "src/x.py" } }], api: "faux", provider: "faux", model: "faux-1", usage, stopReason: "toolUse", timestamp: msNow } },
			{ type: "message", id: "e3", parentId: "e2", timestamp: ts, message: { role: "toolResult", toolCallId: "call_r", toolName: "read", content: [{ type: "text", text: "line 1" }], isError: false, timestamp: msNow } },
			{ type: "message", id: "e4", parentId: "e3", timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", id: "call_b", name: "bash", arguments: { command: "echo tmuxtest" } }], api: "faux", provider: "faux", model: "faux-1", usage, stopReason: "toolUse", timestamp: msNow } },
			{ type: "message", id: "e5", parentId: "e4", timestamp: ts, message: { role: "toolResult", toolCallId: "call_b", toolName: "bash", content: [{ type: "text", text: "tmuxtest\n" }], isError: false, timestamp: msNow } },
		].map((e) => JSON.stringify(e)).join("\n") + "\n",
	);

	const envs: Record<string, string> = {
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_FLEET_STATE_DIR: join(root, "state"),
		PI_FLEET_RUNTIME_DIR: run,
		PI_FLEET_NVIM_CMD: "nvim --clean -n",
		PI_FLEET_TMUX_GUARD: "1",
		PI_OFFLINE: "1",
	};
	const piArgs = [piCmd, "-ne", "-e", fleetDir, "-e", fauxExt, "--offline", "--provider", "faux", "--model", "faux-1", "--session", session, "-ns", "-np", "-nc"];
	try {
		tmux("-f", "/dev/null", "new-session", "-d", "-x", "200", "-y", "50", "-c", work,
			...Object.entries(envs).flatMap(([k, v]) => ["-e", `${k}=${v}`]), ...piArgs);
		tmux("set", "-s", "escape-time", "0");
		const piPane = tmux("display", "-p", "-t", "0:0.0", "#{pane_id}");
		const panes = () => tmux("list-panes", "-a", "-F", "#{pane_id} #{pane_active}").split("\n").map((l) => l.split(" "));
		const active = () => panes().find((p) => p[1] === "1")?.[0];
		const capture = (pane = piPane) => tmux("capture-pane", "-p", "-t", pane);
		// One key per send-keys with a pause, so Escape + Enter never arrive as alt+enter.
		const keys = async (...k: string[]) => {
			for (const key of k) {
				tmux("send-keys", "-t", piPane, key);
				await sleep(150);
			}
		};
		const type = (text: string) => tmux("send-keys", "-t", piPane, "-l", text);
		const sock = join(run, `${SID}.nvim.sock`);
		const current = () => nvimRequest(sock, "nvim_exec_lua", ["return { vim.api.nvim_buf_get_name(0), vim.api.nvim_win_get_cursor(0)[1] }", []], 3000) as Promise<any>;

		// No nvim at session start: it starts on first use (pi-deck-design.md decision 1).
		await waitFor("pi prompt", () => capture().includes("faux"));
		await sleep(1000);
		assert.equal(panes().length, 1, "no nvim before /view");

		// Completion: the touched file comes first, labelled "session".
		type("/view x.p");
		const shown = await waitFor("completion list", () => {
			const c = capture();
			return c.includes("src/x.py") && c.includes("session") ? c : undefined;
		});
		assert.match(shown, /src\/x\.py\s+session/);
		await keys("Escape", "C-u");

		// /view FILE:LINE → an nvim is split beside pi, shows the file at the line, and is focused.
		type("/view src/x.py:10");
		await sleep(400);
		await keys("Escape", "Enter");
		await waitFor("nvim pane from /view", () => panes().length === 2);
		const nvimPane = panes().find((p) => p[0] !== piPane)![0];
		await waitFor("x.py at line 10", async () => {
			const c = await current();
			return c[0] === join(work, "src/x.py") && c[1] === 10;
		}).catch(async (e) => {
			throw new Error(`${e.message}\nnvim: ${JSON.stringify(await current().catch(String))}\npi pane:\n${capture()}`);
		});
		await waitFor("nvim focused", () => active() === nvimPane);

		// Kill the nvim: /view tool:1 pairs a new one, shows the bash output and focuses it.
		tmux("select-pane", "-t", piPane);
		tmux("kill-pane", "-t", nvimPane);
		await waitFor("nvim gone", () => panes().length === 1);
		type("/view tool:1");
		await sleep(300);
		await keys("Escape", "Enter");
		await waitFor("re-paired nvim", () => panes().length === 2);
		const nvim2 = panes().find((p) => p[0] !== piPane)![0];
		const sock2 = tmux("show-options", "-pqv", "-t", nvim2, "@pi_fleet_nvim_sock") || sock;
		await waitFor("bash output in new nvim", async () => {
			const c = (await nvimRequest(sock2, "nvim_exec_lua", ["return vim.api.nvim_buf_get_name(0)", []], 3000)) as string;
			return c.startsWith("pi://tool/") && c.endsWith("bash.log");
		});
		await waitFor("new nvim focused", () => active() === nvim2);

		// Bare /view: the fuzzy picker; typing filters it, Enter opens the choice.
		tmux("select-pane", "-t", piPane);
		type("/view");
		await sleep(300);
		await keys("Escape", "Enter");
		const picker = await waitFor("picker", () => {
			const c = capture();
			return c.includes("View") && c.includes("src/x.py") && c.includes("echo tmuxtest") ? c : undefined;
		});
		assert.ok(picker.indexOf("src/x.py") < picker.indexOf("echo tmuxtest"), picker);
		type("tmuxtest");
		await waitFor("filtered", () => {
			const c = capture();
			return !/→ src\/x\.py/.test(c) && /→ .*echo tmuxtest/.test(c) ? true : undefined;
		});
		await keys("Enter");
		await waitFor("picked tool output focused", () => active() === nvim2);
	} finally {
		spawnSync("tmux", ["-L", server, "kill-server"], { stdio: "ignore", env: { ...process.env, TMUX: "" } });
		rmSync(root, { recursive: true, force: true });
	}
});
