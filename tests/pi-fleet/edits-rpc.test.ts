// pi-fleet edit delivery end to end (design §11, phase 7): a real `pi --mode rpc` with the fleet
// extension and a scripted faux provider, plus a paired `nvim --headless` (pi_fleet.lua) whose
// `:w!` / `:w!!` go over pi's real control socket. The provider writes the context of every
// LLM call to call-N.json and waits for reply-N.json, so the test sees exactly what the agent
// was told and when. Everything lives in a temp dir; TMUX is unset; the user's tmux, nvim and
// sessions are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nvimRequest } from "../../pi/extensions/fleet/nvim.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../..");
const fleetDir = join(repo, "pi/extensions/fleet");
const nvimDir = join(repo, "nvim");
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
const skip = !havePi() ? "pi not on PATH" : !haveNvim ? "nvim not installed" : false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(30);
	}
}

const FAUX = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
export default function (pi) {
	const dir = process.env.PI_FLEET_TEST_SCRIPT;
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	let n = 0;
	const reply = async (context) => {
		const k = ++n;
		writeFileSync(dir + "/call-" + k + ".json", JSON.stringify(context.messages));
		const f = dir + "/reply-" + k + ".json";
		while (!existsSync(f)) await new Promise((r) => setTimeout(r, 30));
		faux.appendResponses([reply]);
		const r = JSON.parse(readFileSync(f, "utf8"));
		if (r.tool) return fauxAssistantMessage(fauxToolCall(r.tool, r.args, { id: "t" + k }), { stopReason: "toolUse" });
		return fauxAssistantMessage(r.text);
	};
	faux.setResponses([reply]);
	pi.registerProvider(faux.provider);
}
`;

/** All text of one LLM context, message by message (role + text). */
function texts(messages: any[]): { role: string; text: string }[] {
	return messages.map((m) => {
		const c = m.content;
		const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? (p.type === "toolCall" ? `[call ${p.name}]` : "")).join("") : "";
		return { role: m.role, text };
	});
}

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

test("rpc pi + paired nvim: :w! notes, same-file steer, :w!! steer, write guard, coalescing, cap", { skip, timeout: 180_000 }, async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pfe-")));
	const work = join(root, "work");
	const script = join(root, "script");
	const runtime = join(root, "rt");
	for (const d of [work, script, join(root, "agent"), join(root, "nh"), join(root, "nt")]) mkdirSync(d, { recursive: true });
	mkdirSync(runtime, { mode: 0o700 });
	writeFileSync(join(root, "faux.ts"), FAUX);
	writeFileSync(join(work, "a.txt"), lines(30));
	writeFileSync(join(work, "b.txt"), lines(10, (i) => `bee ${i}`));
	writeFileSync(join(work, "c.txt"), "see\n");
	writeFileSync(join(work, "d.txt"), lines(200));

	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_FLEET_STATE_DIR: join(root, "state"),
		PI_FLEET_RUNTIME_DIR: runtime,
		PI_FLEET_TEST_SCRIPT: script,
		PI_OFFLINE: "1",
	};
	delete env.TMUX;
	delete env.TMUX_PANE;
	delete env.PI_FLEET_SESSION;
	const pi = spawn(
		piCmd,
		["--mode", "rpc", "-ne", "-e", fleetDir, "-e", join(root, "faux.ts"), "--offline", "--provider", "faux", "--model", "faux-1",
			"--session-dir", join(root, "sessions"), "-ns", "-np", "-nc"],
		{ cwd: work, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	pi.stderr.on("data", (d) => (stderr += d));
	const events: any[] = [];
	let buf = "";
	pi.stdout.on("data", (d) => {
		buf += d;
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.trim()) events.push(JSON.parse(line));
		}
	});
	const send = (cmd: object) => pi.stdin.write(JSON.stringify(cmd) + "\n");
	const count = (type: string) => events.filter((e) => e.type === type).length;
	const widget = () => {
		const w = events.filter((e) => e.type === "extension_ui_request" && e.method === "setWidget" && e.widgetKey === "pi-fleet-edits").at(-1);
		return w ? (w.widgetLines as string[] | undefined) : undefined;
	};

	let call = 0;
	const nextCall = async () => {
		call++;
		const f = join(script, `call-${call}.json`);
		await waitFor(`LLM call ${call}`, () => existsSync(f));
		await sleep(30);
		return texts(JSON.parse(readFileSync(f, "utf8")));
	};
	const reply = (r: object) => writeFileSync(join(script, `reply-${call}.json`), JSON.stringify(r));
	const noCallYet = () => !existsSync(join(script, `call-${call + 1}.json`));

	let nvim: ChildProcess | undefined;
	try {
		send({ id: "s", type: "get_state" });
		const state = await waitFor("get_state", () => events.find((e) => e.type === "response" && e.command === "get_state"));
		const session: string = state.data.sessionId;
		const ctl = join(runtime, `${session}.pi.sock`);
		await waitFor("control socket", () => existsSync(ctl));

		const nsock = join(root, "n.sock");
		nvim = spawn("nvim", ["--clean", "--headless", "-n", "--cmd", `set rtp^=${nvimDir}`,
			"--cmd", "lua require('nvconf.pi_fleet').setup()", "--listen", nsock], {
			cwd: work,
			env: { PATH: process.env.PATH, HOME: join(root, "nh"), TMPDIR: join(root, "nt"), XDG_CONFIG_HOME: join(root, "nh"),
				XDG_STATE_HOME: join(root, "nh"), XDG_DATA_HOME: join(root, "nh"), LANG: "C.UTF-8",
				PI_FLEET_SESSION: session, PI_FLEET_CTL_SOCK: ctl, PI_FLEET_PI_PANE: "%1" },
			stdio: "ignore",
		});
		await waitFor("nvim socket", () => existsSync(nsock));
		const lua = (code: string, ...args: unknown[]) => nvimRequest(nsock, "nvim_exec_lua", [code, args], 5000);
		await lua("return 1");
		/** Open `file`, run an ex command on it, and save with :w! or :w!! typed on the command line. */
		const save = async (file: string, ex: string, how: ":w!" | ":w!!") => {
			await lua("vim.cmd.edit(...)", file);
			await lua("vim.cmd(...)", ex);
			await nvimRequest(nsock, "nvim_feedkeys", [`${how}\r`, "t", false], 5000);
			// typeahead is consumed asynchronously: wait until the write happened
			const end = Date.now() + 5000;
			while (await lua("return vim.bo.modified")) {
				if (Date.now() > end) throw new Error(`${how} of ${file} did not write`);
				await sleep(20);
			}
			const msg = await lua("return vim.v.errmsg");
			assert.equal(msg, "", `nvim error after ${how}: ${msg}`);
		};

		// ---- 1. idle :w! twice on a.txt: widget, coalesced into ONE net diff with the next prompt
		await save("a.txt", "3s/.*/THREE/", ":w!");
		await waitFor("widget a.txt", () => widget()?.[0] === "✎ a.txt (+1 −1) goes with your next message");
		await save("a.txt", "20s/.*/TWENTY/", ":w!");
		await waitFor("widget a.txt x2", () => widget()?.[0] === "✎ a.txt (+2 −2) goes with your next message");
		await sleep(2500);
		assert.equal(count("agent_start"), 0, "a note never starts a turn");
		send({ id: "p1", type: "prompt", message: "p1" });
		let ctx = await nextCall();
		const p1 = ctx.findIndex((m) => m.text === "p1");
		const notes1 = ctx.filter((m) => m.text.includes("The user edited a.txt"));
		assert.equal(notes1.length, 1, "one message for both saves");
		assert.ok(ctx.indexOf(notes1[0]) > p1, "the note follows the prompt");
		assert.equal(
			notes1[0].text,
			"The user edited a.txt in their editor (+2 −2):\n```diff\n@@ -1,6 +1,6 @@\n line 1\n line 2\n-line 3\n+THREE\n line 4\n line 5\n line 6\n" +
				"@@ -17,7 +17,7 @@\n line 17\n line 18\n line 19\n-line 20\n+TWENTY\n line 21\n line 22\n line 23\n```\n\n" +
				"Read a.txt again before you edit or write it: pi blocks edits and writes to a file the user changed after you last read it.",
		);
		await waitFor("widget cleared", () => widget() === undefined);
		reply({ text: "ok" });
		await waitFor("settle 1", () => count("agent_settled") >= 1);

		// ---- 2. running: the agent reads b.txt; :w! on b.txt steers, :w! on c.txt waits
		send({ id: "p2", type: "prompt", message: "p2" });
		await nextCall();
		reply({ tool: "read", args: { path: "b.txt" } });
		await nextCall(); // the agent has read b.txt and is "thinking"
		await save("b.txt", "2s/.*/BEE TWO/", ":w!");
		await save("c.txt", "1s/.*/SEE/", ":w!");
		await waitFor("widget c.txt", () => widget()?.some((l) => l.startsWith("✎ c.txt")) && !widget()?.some((l) => l.startsWith("✎ b.txt")));
		reply({ tool: "bash", args: { command: "echo bashed" } });
		ctx = await nextCall();
		const bashed = ctx.findIndex((m) => m.role === "toolResult" && m.text.includes("bashed"));
		const bNote = ctx.findIndex((m) => m.text.startsWith("The user edited b.txt in their editor (+1 −1):"));
		assert.ok(bashed >= 0 && bNote > bashed, "b.txt steer lands after the running tool call, before the next LLM call");
		assert.equal(ctx.filter((m) => m.text.includes("c.txt")).length, 0, "c.txt (untouched) still waits");

		// write guard: edit of b.txt blocked (user saved after the agent's read), then allowed after a read
		reply({ tool: "edit", args: { path: "b.txt", edits: [{ oldText: "bee 3", newText: "BEE 3" }] } });
		ctx = await nextCall();
		assert.match(ctx.at(-1)!.text, /^Blocked: the user edited b\.txt in their editor at \d\d:\d\d:\d\d, after you last read it\. Read the file again, then redo this edit against its current content\.$/);
		assert.equal(readFileSync(join(work, "b.txt"), "utf8").includes("BEE 3"), false);
		reply({ tool: "read", args: { path: "b.txt" } });
		await nextCall();
		reply({ tool: "edit", args: { path: "b.txt", edits: [{ oldText: "bee 3", newText: "BEE 3" }] } });
		ctx = await nextCall();
		assert.ok(readFileSync(join(work, "b.txt"), "utf8").includes("BEE TWO\nBEE 3\n"), "edit allowed after the read, user change kept");

		// the user's next message while the agent works (an RPC steer) carries the c.txt note
		send({ id: "st", type: "steer", message: "also this" });
		await waitFor("widget cleared 2", () => widget() === undefined);
		reply({ text: "edited" });
		ctx = await nextCall();
		const steerMsg = ctx.find((m) => m.text.startsWith("also this"));
		assert.ok(steerMsg, "user steer delivered");
		assert.match(steerMsg!.text, /^also this\n\nThe user edited c\.txt in their editor \(\+1 −1\):\n```diff\n@@ -1 \+1 @@\n-see\n\+SEE\n```/);
		reply({ text: "done 2" });
		await waitFor("settle 2", () => count("agent_settled") >= 2);

		// ---- 3. :w!! while a long tool runs: the tool finishes, the steer lands right after it
		send({ id: "p3", type: "prompt", message: "p3" });
		await nextCall();
		reply({ tool: "bash", args: { command: "sleep 3; echo slept" } });
		await waitFor("bash running", () => events.some((e) => e.type === "tool_execution_start" && e.toolName === "bash" && e.toolCallId === `t${call}`));
		await save("a.txt", "5s/.*/FIVE/", ":w!!");
		ctx = await nextCall();
		const slept = ctx.findIndex((m) => m.role === "toolResult" && m.text.includes("slept"));
		const aNote = ctx.findIndex((m) => m.text.startsWith("The user edited a.txt in their editor (+1 −1):"));
		assert.ok(slept >= 0, "the running bash was not killed");
		assert.ok(aNote > slept, "the :w!! steer lands after the tool call");
		reply({ text: "done 3" });
		await waitFor("settle 3", () => count("agent_settled") >= 3);

		// ---- 4. :w!! while idle starts a turn
		const starts = count("agent_start");
		await save("a.txt", "6s/.*/SIX/", ":w!!");
		ctx = await nextCall();
		assert.ok(count("agent_start") > starts, "a turn started");
		assert.match(ctx.at(-1)!.text, /^The user edited a\.txt in their editor \(\+1 −1\):\n```diff\n@@ -3,7 \+3,7 @@\n/);
		reply({ text: "done 4" });
		await waitFor("settle 4", () => count("agent_settled") >= 4);

		// ---- 5. cap: a 200-line change is summarised with "Read the file"
		await save("d.txt", "%s/^/x/", ":w!");
		await waitFor("widget d.txt", () => widget()?.[0] === "✎ d.txt (+200 −200) goes with your next message");
		assert.ok(noCallYet());
		send({ id: "p5", type: "prompt", message: "p5" });
		ctx = await nextCall();
		const dNote = ctx.find((m) => m.text.startsWith("The user edited d.txt"));
		assert.equal(
			dNote?.text,
			"The user edited d.txt in their editor (+200 −200). The diff is too long to show here (401 lines); changed lines: 1–200. Read the file before you continue working on it.\n\n" +
				"Read d.txt again before you edit or write it: pi blocks edits and writes to a file the user changed after you last read it.",
		);
		reply({ text: "done 5" });
		await waitFor("settle 5", () => count("agent_settled") >= 5);

		pi.stdin.end();
		await waitFor("pi exit", () => pi.exitCode !== null, 10_000);
	} finally {
		if (nvim && nvim.exitCode === null) nvim.kill("SIGKILL");
		if (pi.exitCode === null) pi.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
	assert.equal(stderr.match(/error/i), null, stderr);
});
