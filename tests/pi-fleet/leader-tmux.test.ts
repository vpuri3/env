// The leader end to end (design §12, phase 8): a real pi TUI with vim-mode and the fleet
// extension in a throwaway tmux server (`tmux -L fleettest-leader-…`, never the default socket,
// PI_FLEET_TMUX_GUARD=1) over the sessions fixture. Escape, Space shows `␣…` in the mode line;
// `E` opens the dashboard popup (a client is attached through `script`, whose log shows the
// popup), `e` the dashboard window (created and selected).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture, type Fixture } from "./support/sessions-fixture.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../..");
const fleetDir = join(repo, "pi/extensions/fleet");
const vimMode = join(repo, "pi/extensions/vim-mode.ts");
const fauxExt = join(here, "support/faux-provider.ts");
const piCmd = process.env.PI_FLEET_TEST_PI ?? "pi";
const havePi = spawnSync(piCmd, ["--version"], { stdio: "ignore", timeout: 20_000 }).status === 0;
const haveTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const haveScript = spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;
const skip = !havePi ? "pi not found" : !haveTmux ? "tmux not found" : !haveScript ? "script (util-linux) not found" : false;

let fx: Fixture;
before(() => {
	fx = buildFixture();
});
after(() => fx.cleanup());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 20_000, show?: () => string): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `\n${show()}` : ""}`);
		await sleep(100);
	}
}

test("vim-mode leader in pi: Space E opens the dashboard popup, Space e the dashboard window", { skip, timeout: 120_000 }, async () => {
	const label = `fleettest-leader-${process.pid}`;
	const env: NodeJS.ProcessEnv = {
		...fx.env,
		PATH: `${join(repo, "bin")}:${process.env.PATH}`,
		PI_CODING_AGENT_DIR: join(fx.root, "agent"),
		PI_FLEET_NVIM_CMD: "true",
		PI_FLEET_TMUX_GUARD: "1",
		PI_OFFLINE: "1",
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
	};
	delete env.TMUX;
	delete env.TMUX_PANE;
	mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
	const tmux = (args: string[]) => {
		const full = ["-L", label, ...args];
		assert.ok(full[0] === "-L" && basename(full[1]!) !== "default");
		return execFileSync("tmux", full, { env, encoding: "utf8" }).replace(/\n$/, "");
	};
	tmux(["-f", "/dev/null", "new-session", "-d", "-s", "main", "-x", "150", "-y", "45", "sh"]);
	tmux(["set", "-s", "escape-time", "0"]);
	const socket = tmux(["display-message", "-p", "#{socket_path}"]);
	tmux(["set-environment", "-g", "PI_FLEET_TMUX_SOCKET", socket]);
	let client: ChildProcess | undefined;
	const log = join(fx.root, "client.log");
	const capture = (pane: string) => {
		try {
			return tmux(["capture-pane", "-p", "-t", pane]);
		} catch {
			return "";
		}
	};
	try {
		const pane = tmux([
			"new-window", "-P", "-F", "#{pane_id}", "-c", fx.repos.alpha, "--",
			piCmd, "-ne", "-e", vimMode, "-e", fleetDir, "-e", fauxExt, "--offline", "--provider", "faux", "--model", "faux-1",
			"--session-dir", fx.sessionsDir, "-ns", "-np", "-nc",
		]);
		const show = () => capture(pane);
		const key = async (k: string) => {
			tmux(["send-keys", "-t", pane, k]);
			await sleep(150);
		};
		// INSERT mode: Space and e are typed into the prompt.
		await waitFor("pi to start in INSERT", () => / INSERT\s*$/m.test(capture(pane)), 30_000, show);
		tmux(["send-keys", "-t", pane, "-l", "x e"]);
		await waitFor("typed text", () => capture(pane).includes("x e"), 5_000, show);
		assert.doesNotMatch(capture(pane), /▾ gamma/);
		await key("C-u");

		// A client, so the popup has somewhere to show (its output lands in the log).
		client = spawn("script", ["-qfc", `tmux -L ${label} attach -t ${pane}`, log], { env, stdio: ["pipe", "ignore", "ignore"] });
		await waitFor("the client", () => tmux(["list-clients", "-F", "#{client_tty}"]) !== "", 10_000);
		// The client's output without escape sequences.
		const logText = () => {
			try {
				return readFileSync(log, "utf8").replace(/\x1b(\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*\x07|[()][0-9A-B]|.)/g, "");
			} catch {
				return "";
			}
		};

		// Space E: the popup (`pi-fleet dashboard` over this client), not a window.
		await key("Escape");
		await waitFor("NORMAL mode", () => / NORMAL\s*$/m.test(capture(pane)), 5_000, show);
		const windows = tmux(["list-windows", "-F", "#{window_id}"]);
		const before = logText().length;
		await key("Space");
		assert.match(capture(pane), / ␣…\s*$/m);
		await key("E");
		await waitFor("the popup dashboard", () => /pi-fleet .*live/.test(logText().slice(before)) && logText().slice(before).includes("▾ gamma"), 20_000, () => logText().slice(before));
		assert.equal(tmux(["list-windows", "-F", "#{window_id}"]), windows, "no new window");
		assert.doesNotMatch(capture(pane), /▾ gamma/, "pi's own pane is untouched");
		client.stdin!.write("q"); // the popup's dashboard quits
		await sleep(500);

		// Space e: the `fleet` window, created and selected.
		await key("Space");
		await key("e");
		const fleet = await waitFor("the fleet window", () => tmux(["list-windows", "-F", "#{window_id} #{@pi_fleet_dashboard}"]).split("\n").find((l) => l.endsWith(" 1"))?.split(" ")[0], 20_000, show);
		const dash = tmux(["display-message", "-p", "-t", fleet, "#{pane_id}"]);
		await waitFor("the dashboard in it", () => /▾ gamma \(2\)/.test(capture(dash)), 20_000, () => capture(dash));
		assert.equal(tmux(["display-message", "-p", "#{window_id}"]), fleet, "selected");
	} finally {
		client?.kill();
		try {
			tmux(["kill-server"]);
		} catch {
			// gone
		}
	}
});
