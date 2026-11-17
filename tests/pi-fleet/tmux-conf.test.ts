// tmux.conf's root C-h (pi-fleet ctrl+l / C-h, design §9): in a pi pane joined into the dashboard
// window (@pi_fleet_joined) it selects the pane on the left (the dashboard list); everywhere else
// the pane gets C-h itself. ~/env/tmux.conf is loaded into a throwaway server (`tmux -L
// fleettest-conf-…`; the harness refuses the default socket) with a temp HOME and a PATH without
// pi-fleet. Root key bindings only run for keys a client types, so a client is attached through
// `script` (a pty) and the keys are written to it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const conf = join(here, "../../tmux.conf");
const haveTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const haveScript = spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;
const skip = !haveTmux ? "tmux not found" : !haveScript ? "script (util-linux) not found" : false;

let root: string;
let agent: Server;
before(async () => {
	root = mkdtempSync(join(tmpdir(), "pfc-"));
	mkdirSync(join(root, "home", ".ssh"), { recursive: true });
	// tmux.conf links $SSH_AUTH_SOCK to ~/.ssh/ssh_auth_sock on attach; without a socket that
	// run-shell fails and tmux shows its exit status in view mode, which would eat the keys.
	agent = createServer();
	await new Promise<void>((r) => agent.listen(join(root, "agent.sock"), r));
});
after(() => {
	agent?.close();
	rmSync(root, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

test("tmux.conf C-h: a normal pane gets C-h; a joined pi pane goes to the pane on its left", { skip, timeout: 60_000 }, async () => {
	const label = `fleettest-conf-${process.pid}`;
	// No pi-fleet on PATH (the status bar and hooks stay inert), HOME a temp dir.
	const env: NodeJS.ProcessEnv = {
		HOME: join(root, "home"),
		// Only tmux's and script's dirs: never a pi-fleet that could see the user's status files.
		PATH: [...new Set(["tmux", "script"].map((b) => dirname(execFileSync("sh", ["-c", `command -v ${b}`], { encoding: "utf8" }).trim())))].join(":"),
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
		SSH_AUTH_SOCK: join(root, "agent.sock"),
	};
	const tmux = (args: string[]) => {
		const full = ["-L", label, ...args];
		assert.ok(full[0] === "-L" && basename(full[1]!) !== "default");
		return execFileSync("tmux", full, { env, encoding: "utf8" }).replace(/\n$/, "");
	};
	const out = (name: string) => join(root, `${name}.out`);
	// A pane that records the raw bytes it gets.
	const recorder = (name: string) => `stty raw -echo; exec dd bs=1 of=${out(name)} 2>/dev/null`;
	let client: ChildProcess | undefined;
	try {
		tmux(["-f", conf, "new-session", "-d", "-s", "main", "-x", "120", "-y", "30", recorder("plain")]);
		assert.match(tmux(["list-keys", "-T", "root", "C-h"]), /if-shell -F "?#\{@pi_fleet_joined\}"? "?select-pane -L"? "?send-keys C-h"?/);
		const plain = tmux(["display-message", "-p", "-t", "main", "#{pane_id}"]);
		client = spawn("script", ["-qfc", `tmux -L ${label} attach -t main`, "/dev/null"], { env, stdio: ["pipe", "ignore", "ignore"] });
		await waitFor("the client", () => tmux(["list-clients", "-F", "#{client_tty}"]) !== "");
		await sleep(500);
		assert.equal(tmux(["display-message", "-p", "-t", plain, "#{pane_in_mode}"]), "0", "no view mode over the pane");
		const typed = (keys: string) => client!.stdin!.write(keys);

		// Not joined: the pane gets the byte.
		typed("a\x08b");
		await waitFor("C-h delivered", () => {
			try {
				return readFileSync(out("plain")).equals(Buffer.from("a\x08b"));
			} catch {
				return false;
			}
		});

		// A joined pi pane right of the list: C-h selects the list, the pi gets nothing.
		const list = tmux(["new-window", "-P", "-F", "#{pane_id}", recorder("list")]);
		const pi = tmux(["split-window", "-h", "-t", list, "-P", "-F", "#{pane_id}", recorder("pi")]);
		tmux(["set-option", "-p", "-t", pi, "@pi_fleet_joined", tmux(["display-message", "-p", "-t", pi, "#{window_id}"])]);
		await waitFor("the pi pane active", () => tmux(["display-message", "-p", "#{pane_id}"]) === pi);
		typed("x\x08y");
		await waitFor("C-h went left", () => tmux(["display-message", "-p", "-t", list, "#{pane_active}"]) === "1");
		await waitFor("y typed into the list", () => {
			try {
				return readFileSync(out("list"), "utf8") === "y";
			} catch {
				return false;
			}
		});
		assert.equal(readFileSync(out("pi"), "utf8"), "x");
		// Once it is home (marks unset) C-h is a plain key there again.
		tmux(["set-option", "-pu", "-t", pi, "@pi_fleet_joined"]);
		tmux(["select-pane", "-t", pi]);
		typed("\x08");
		await waitFor("C-h delivered to the unjoined pi", () => readFileSync(out("pi"), "utf8") === "x\x08");
		assert.equal(tmux(["display-message", "-p", "#{pane_id}"]), pi);
		assert.notEqual(plain, pi);
	} finally {
		client?.kill();
		try {
			tmux(["kill-server"]);
		} catch {
			// gone
		}
	}
});
