// tmux.conf binds no root C-h any more (the pi deck has its own server and keys, pi-deck-design.md
// §15; the old dashboard's C-h is unbound for servers that still have it): C-h reaches the pane,
// also one an old pi-fleet marked @pi_fleet_joined. ~/env/tmux.conf is loaded into a throwaway server (`tmux -L
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

test("tmux.conf C-h: every pane gets C-h itself (no root binding)", { skip, timeout: 60_000 }, async () => {
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
		assert.throws(() => tmux(["list-keys", "-T", "root", "C-h"]), "no root C-h");
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

		// A pane an old pi-fleet marked as joined: still just a key.
		const pi = tmux(["split-window", "-h", "-t", plain, "-P", "-F", "#{pane_id}", recorder("pi")]);
		tmux(["set-option", "-p", "-t", pi, "@pi_fleet_joined", tmux(["display-message", "-p", "-t", pi, "#{window_id}"])]);
		await waitFor("the pi pane active", () => tmux(["display-message", "-p", "#{pane_id}"]) === pi);
		typed("x\x08y");
		await waitFor("C-h delivered to the marked pane", () => {
			try {
				return readFileSync(out("pi"), "utf8") === "x\x08y";
			} catch {
				return false;
			}
		});
		assert.equal(tmux(["display-message", "-p", "#{pane_id}"]), pi);
	} finally {
		client?.kill();
		try {
			tmux(["kill-server"]);
		} catch {
			// gone
		}
		rmSync(`${process.env.TMUX_TMPDIR || "/tmp"}/tmux-${process.getuid?.() ?? 0}/${label}`, { force: true }); // tmux 3.2a leaves it
	}
});
