// `/sessions` in a real pi TUI (design §9; phase 4): pi runs in a throwaway tmux server
// (`tmux -L fleettest-…`, the harness refuses the default socket, PI_FLEET_TMUX_GUARD=1) with
// only the fleet extension and a faux provider, a temp agent dir, no session file of its own,
// and the fixture sessions/status dirs. Keys go in with send-keys; the screen is capture-pane.
// Enter on a session that is not running opens it in a new window (the stub pi of the CLI tests).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDS, buildFixture, type Fixture } from "./support/sessions-fixture.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../..");
const fleetDir = join(repo, "pi/extensions/fleet");
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

async function waitFor<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 20_000, show?: () => string): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `\n${show()}` : ""}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}

test("/sessions in pi: the list, Space shows subagents, Enter opens a session in a new window", { skip, timeout: 240_000 }, async () => {
	const label = `fleettest-sessions-${process.pid}`;
	const env: NodeJS.ProcessEnv = {
		...fx.env,
		PATH: `${join(repo, "bin")}:${process.env.PATH}`,
		PI_CODING_AGENT_DIR: join(fx.root, "agent"),
		PI_FLEET_PI_CMD: join(here, "support/stub-pi.sh"),
		PI_FLEET_NVIM_CMD: "true",
		PI_FLEET_STUB_DIR: join(fx.root, "stub"),
		PI_OFFLINE: "1",
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
	};
	mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
	mkdirSync(env.PI_FLEET_STUB_DIR!, { recursive: true });
	const tmux = (args: string[]) => {
		const full = ["-L", label, ...args];
		assert.ok(full[0] === "-L" && basename(full[1]!) !== "default");
		return execFileSync("tmux", full, { env, encoding: "utf8" }).replace(/\n$/, "");
	};
	tmux(["-f", "/dev/null", "new-session", "-d", "-s", "main", "-x", "150", "-y", "45", "sh"]);
	const socket = tmux(["display-message", "-p", "#{socket_path}"]);
	tmux(["set-environment", "-g", "PI_FLEET_TMUX_SOCKET", socket]);
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
			piCmd, "-ne", "-e", fleetDir, "-e", fauxExt, "--offline", "--provider", "faux", "--model", "faux-1",
			"--session-dir", fx.sessionsDir, "-ns", "-np", "-nc",
		]);
		const show = () => capture(pane);
		const keys = (...k: string[]) => tmux(["send-keys", "-t", pane, ...k]);
		// The prompt editor: the non-blank lines between its two borders (the last two `─` rules).
		// A border reading `↑ N more` means scrolled-off lines, so the editor is not empty.
		const editor = (): { text: string; more: boolean } | undefined => {
			const lines = capture(pane).split("\n");
			const rules = lines.map((l, i) => (/^─{10}/.test(l) ? i : -1)).filter((i) => i >= 0);
			if (rules.length < 2) return undefined;
			const [top, bottom] = rules.slice(-2) as [number, number];
			const text = lines.slice(top + 1, bottom).map((l) => l.trim()).filter(Boolean).join("\n");
			return { text, more: /more/.test(lines[top]!) || /more/.test(lines[bottom]!) };
		};
		const editorEmpty = () => {
			const e = editor();
			return !!e && !e.text && !e.more;
		};
		const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
		// Keys sent while pi is still starting (terminal probes, raw mode) can be lost or garbled,
		// so each step checks what the editor shows and repairs it instead of trusting the keys.
		const clearEditor = async () => {
			await waitFor("an empty editor", () => {
				if (editorEmpty()) return true;
				keys(...Array(40).fill("BSpace"));
				return false;
			}, 30_000, show);
		};
		// pi is ready when its editor shows exactly what was typed.
		await waitFor("pi's editor", () => editor() !== undefined && /faux-1/.test(capture(pane)), 60_000, show);
		await waitFor("pi to take typed text", async () => {
			await clearEditor();
			keys("-l", "x");
			for (let i = 0; i < 20; i++) {
				if (editor()?.text === "x") return true;
				await sleep(100);
			}
			return false;
		}, 60_000, show);
		await clearEditor();
		// Type /sessions and Enter; the first Enter may only accept the autocomplete suggestion,
		// so Enter again only while the editor still holds /sessions. Garbled text is retyped.
		await waitFor("the sessions list", async () => {
			if (/▾ gamma \(2\)/.test(capture(pane))) return true;
			const e = editor();
			if (e && /^\/sessions\s*$/.test(e.text) && !e.more) {
				keys("Enter");
			} else if (e) {
				await clearEditor();
				keys("-l", "/sessions");
				await sleep(300);
				return false;
			}
			for (let i = 0; i < 20; i++) {
				if (/▾ gamma \(2\)/.test(capture(pane))) return true;
				await sleep(100);
			}
			return false;
		}, 60_000, show);
		const screen = capture(pane);
		assert.match(screen, /\? flare refactor\s+question/);
		assert.match(screen, /● physicsnemo sweep\s+bash \d+m\s+\$3\.41 2w 1◐ 3✓/);
		assert.match(screen, /○ start the old run\s+3h ago\s+1✓ 1 inter/);
		// Selected: this pi's own row once its status file exists, else the first session row.
		assert.match(screen, /^›\s+(\S \S+ session \(this\)|\? flare refactor)/m);

		// Move to the old run (ctrl+n / j), show its subagents.
		// One key at a time, each waiting for the selection to move, so a slow redraw never overshoots.
		const selected = () => /^›.*$/m.exec(capture(pane))?.[0];
		for (let i = 0; i < 12 && !/›\s+○ start the old run/.test(capture(pane)); i++) {
			const before = selected();
			keys(i % 2 ? "C-n" : "j");
			await waitFor("the selection to move", () => selected() !== before, 10_000, show);
		}
		assert.match(capture(pane), /›\s+○ start the old run/);
		tmux(["send-keys", "-t", pane, "Space"]);
		await waitFor("the subagent rows", () => /◌ coder \/runner\s+interrupted/.test(capture(pane)), 30_000, show);

		tmux(["send-keys", "-t", pane, "Enter"]);
		const runs = join(env.PI_FLEET_STUB_DIR!, `${IDS.old}.runs`);
		await waitFor("the opened session window", () => existsSync(runs), 60_000, show);
		assert.match(readFileSync(runs, "utf8"), /--session .*a003\.jsonl/);
		// The list closed; pi is still alive in its window.
		assert.ok(tmux(["list-panes", "-a", "-F", "#{pane_id}"]).split("\n").includes(pane));
	} finally {
		try {
			tmux(["kill-server"]);
		} catch {
			// gone
		}
	}
});
