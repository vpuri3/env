// Tear down throwaway tmux servers so a test's temp dir can be removed: kill-server only signals the panes,
// and their processes (stub or real pis, the list's node, nvims) may still be writing into the temp dir
// for a moment (on a loaded machine, for seconds), which made rmSync fail with ENOTEMPTY. Here every
// pane's process group is waited for (SIGKILLed after graceMs), then the socket files are removed.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Kill the servers `tmux -L <name>` (names only, never `default`/`pifleet`: the callers guard), wait for their panes' processes. */
export function killServers(names: Iterable<string>, opts: { tmux: string; env: NodeJS.ProcessEnv; socketDir: string; graceMs?: number }): void {
	const groups: number[] = [];
	for (const name of names) {
		try {
			const out = execFileSync(opts.tmux, ["-L", name, "list-panes", "-a", "-F", "#{pane_pid}"], { env: opts.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			for (const pid of out.split("\n").map(Number)) if (pid > 1) groups.push(pid);
		} catch {
			// no server
		}
		try {
			execFileSync(opts.tmux, ["-L", name, "kill-server"], { stdio: "ignore", env: opts.env });
		} catch {
			// gone
		}
		rmSync(join(opts.socketDir, name), { force: true }); // tmux 3.2a leaves the socket file
	}
	// A pane's pid leads its process group (tmux setsid()s it); its shell's children stay in it.
	const end = Date.now() + (opts.graceMs ?? 5000);
	let alive = groups.filter(groupAlive);
	while (alive.length && Date.now() < end) {
		sleepSync(25);
		alive = alive.filter(groupAlive);
	}
	for (const pgid of alive) {
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
			// gone
		}
	}
}
