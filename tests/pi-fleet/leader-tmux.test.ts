// The leader end to end (design §12, phase 8): a real pi TUI with vim-mode and the fleet
// extension in a throwaway tmux server (`tmux -L fleettest-leader-…`, never the default socket,
// PI_FLEET_TMUX_GUARD=1) over the /sessions fixture. Escape, Space shows `␣…` in the mode line,
// then `e` opens /sessions.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
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
const skip = !havePi ? "pi not found" : !haveTmux ? "tmux not found" : false;

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

test("vim-mode leader in pi: Escape, Space, e opens /sessions", { skip, timeout: 90_000 }, async () => {
	const label = `fleettest-leader-${process.pid}`;
	const env: NodeJS.ProcessEnv = {
		...fx.env,
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

		await key("Escape");
		await waitFor("NORMAL mode", () => / NORMAL\s*$/m.test(capture(pane)), 5_000, show);
		await key("Space");
		assert.match(capture(pane), / ␣…\s*$/m);
		await key("e");
		await waitFor("the sessions list", () => /▾ gamma \(2\)/.test(capture(pane)), 20_000, show);
	} finally {
		try {
			tmux(["kill-server"]);
		} catch {
			// gone
		}
	}
});
