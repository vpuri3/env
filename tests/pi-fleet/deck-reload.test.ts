// `pi-fleet deck-reload` and pi's /reload hook (fleet/reload.ts): the running deck picks up repo changes
// (deck.tmux.conf re-sourced, the list restarted, an outdated list loop respawned) without touching the pool
// panes or the slot. Every server is a throwaway `tmux -L decktest-v<pid>-<n>` (support/deck-harness.ts:
// refuses `default` and `pifleet`, the CLI runs with PI_FLEET_TMUX_GUARD=1); pi in the pool is the node stub.
// The hook test runs a real `pi --mode rpc` (fleet + faux provider + a command calling ctx.reload()).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIST_LOOP, isCurrentListLoop } from "../../pi/extensions/fleet/deck.ts";
import { Deck, cliBin, haveTmux, repo, sleep, waitFor } from "./support/deck-harness.ts";

const skipTmux = !haveTmux && "tmux not installed";
const piCmd = process.env.PI_FLEET_TEST_PI ?? "pi";
function havePi(): boolean {
	try {
		execFileSync(piCmd, ["--version"], { stdio: "ignore", env: { ...process.env, PI_CODING_AGENT_DIR: "/nonexistent-pi-fleet-test" } });
		return true;
	} catch {
		return false;
	}
}

const decks: Deck[] = [];
after(() => {
	for (const d of decks) d.close();
});
/** A throwaway deck whose config is a copy the test may change (PI_FLEET_DECK_CONF). */
function deck(): Deck & { conf: string } {
	const d = new Deck() as Deck & { conf: string };
	decks.push(d);
	d.conf = join(d.root, "deck.tmux.conf");
	copyFileSync(join(repo, "pi/deck.tmux.conf"), d.conf);
	d.env.PI_FLEET_DECK_CONF = d.conf;
	return d;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
const listPid = (d: Deck) => Number(d.tryTmux(["show", "-gqv", "@deck_tui_pid"]) || 0);
async function newListPid(d: Deck, old: number): Promise<number> {
	return waitFor("a new list pid", () => {
		const p = listPid(d);
		return p > 1 && p !== old ? p : undefined;
	});
}
/** Pool and slot panes: id, place, role, session, pid (none of these may change on a reload). */
function poolState(d: Deck): string[] {
	return d
		.tmux(["list-panes", "-a", "-F", "#{pane_id} #{session_name}:#{window_name}.#{pane_index} #{@pi_fleet_role} #{@pi_fleet_session} #{pane_pid} #{pane_dead}"])
		.split("\n")
		.filter((l) => !l.includes(" deck:deck.0 "))
		.sort();
}
function cliAsync(d: Deck, args: string[]): Promise<{ code: number | null; out: string }> {
	const child = spawn(cliBin, args, { env: d.env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (b) => (out += b));
	child.stderr.on("data", (b) => (out += b));
	return new Promise((res) => child.once("exit", (code) => res({ code, out })));
}

test("isCurrentListLoop: matches LIST_LOOP as tmux prints pane_start_command, not an older loop", () => {
	// tmux 3.2a's #{pane_start_command} for `sh -c LIST_LOOP BIN`.
	const printed = `sh -c "${LIST_LOOP.replace(/"/g, '\\"').replace(/\$n/g, "\\$n")}" /x/bin/pi-fleet`;
	assert.ok(isCurrentListLoop(printed), printed);
	assert.ok(isCurrentListLoop(`sh -c '${LIST_LOOP}' /x/bin/pi-fleet`));
	assert.ok(!isCurrentListLoop(`sh -c "while :; do \\"$0\\" deck; sleep 0.3; done" /x/bin/pi-fleet`));
	assert.ok(!isCurrentListLoop(""));
});

test("deck-reload without a deck: a message, exit 0, no server started", { skip: skipTmux, timeout: 30_000 }, () => {
	const d = deck();
	const r = d.cli(["deck-reload"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /no deck running/);
	assert.equal(d.tryTmux(["has-session", "-t", "=deck"]), undefined);
});

test("deck-reload re-reads deck.tmux.conf and restarts the list; pool panes and the slot stay", { skip: skipTmux, timeout: 90_000 }, async () => {
	const d = deck();
	d.start();
	const a = await d.open();
	const b = await d.open();
	assert.equal(d.slot().pane, b.pane);
	const pid1 = listPid(d);
	const list = d.panes().find((p) => p.where === "deck:deck.0")!;
	const before = poolState(d);
	appendFileSync(d.conf, "\nset -g @deck_test_marker reloaded\n");
	const r = d.cli(["deck-reload"]);
	assert.equal(r.code, 0, r.err + r.out);
	assert.match(r.out, /config re-read, list restarted \(pid \d+ → \d+\)/);
	assert.equal(d.tmux(["show", "-gv", "@deck_test_marker"]), "reloaded");
	const pid2 = await newListPid(d, pid1);
	assert.ok(r.out.includes(`${pid1} → ${pid2}`), r.out);
	await waitFor("the old list gone", () => !alive(pid1));
	// The list pane itself was not respawned (its loop restarted the list), and nothing else moved.
	const listNow = d.panes().find((p) => p.where === "deck:deck.0")!;
	assert.equal(listNow.pane, list.pane);
	assert.equal(listNow.role, "list");
	await sleep(500); // the new list's start-up reconcile
	assert.deepEqual(poolState(d), before);
	assert.equal(d.slot().pane, b.pane);
	for (const s of [a, b]) assert.equal(d.file(s.id, "runs").trim().split("\n").length, 1, `${s.id} started once`);
	// The new list serves deck.sock.
	const c = await d.open();
	assert.equal(d.slot().pane, c.pane);
});

test("deck-reload respawns a list pane that runs an older loop (same pane, current LIST_LOOP)", { skip: skipTmux, timeout: 90_000 }, async () => {
	const d = deck();
	d.start();
	const a = await d.open();
	const pid1 = listPid(d);
	const list = d.panes().find((p) => p.where === "deck:deck.0")!;
	// An old loop (as an older pi-deck-attach started it).
	d.tmux(["respawn-pane", "-k", "-t", list.pane, "sh", "-c", 'while :; do "$0" deck; tmux set-option -gu @deck_tui_pid 2>/dev/null; sleep 0.3; done', cliBin]);
	const pidOld = await newListPid(d, pid1);
	assert.ok(!isCurrentListLoop(d.tmux(["display", "-p", "-t", list.pane, "#{pane_start_command}"])));
	const before = poolState(d);
	const r = d.cli(["deck-reload"]);
	assert.equal(r.code, 0, r.err + r.out);
	assert.match(r.out, /list pane respawned with the current loop \(pid \d+ → \d+\)/);
	const pid2 = await newListPid(d, pidOld);
	await waitFor("the old list gone", () => !alive(pidOld));
	assert.ok(isCurrentListLoop(d.tmux(["display", "-p", "-t", list.pane, "#{pane_start_command}"])));
	const listNow = d.panes().find((p) => p.where === "deck:deck.0")!;
	assert.equal(listNow.pane, list.pane, "same pane id");
	assert.equal(listNow.dead, false);
	assert.equal(listNow.role, "list");
	await sleep(500);
	assert.deepEqual(poolState(d), before);
	assert.equal(d.slot().pane, a.pane);
	assert.equal(listPid(d), pid2);
	// A second reload finds the loop current: SIGTERM only.
	const r2 = d.cli(["deck-reload"]);
	assert.match(r2.out, /list restarted/);
});

test("deck-reload --debounce: concurrent reloads restart the list once", { skip: skipTmux, timeout: 90_000 }, async () => {
	const d = deck();
	d.start();
	const pid1 = listPid(d);
	const runs = await Promise.all([1, 2, 3].map(() => cliAsync(d, ["deck-reload", "--debounce", "5000"])));
	for (const r of runs) assert.equal(r.code, 0, r.out);
	assert.equal(runs.filter((r) => /list restarted/.test(r.out)).length, 1, runs.map((r) => r.out).join(""));
	assert.equal(runs.filter((r) => /just reloaded/.test(r.out)).length, 2, runs.map((r) => r.out).join(""));
	const pid2 = await newListPid(d, pid1);
	await sleep(1000);
	assert.equal(listPid(d), pid2, "restarted once");
	// Still within the window: skipped. Without --debounce: always.
	assert.match(d.cli(["deck-reload", "--debounce", "5000"]).out, /just reloaded/);
	assert.match(d.cli(["deck-reload"]).out, /list restarted/);
});

test("pi's /reload (ctx.reload in a real rpc pi) reloads the deck; startup does not", { skip: (!haveTmux || !havePi()) && "tmux or pi missing", timeout: 120_000 }, async () => {
	const d = deck();
	d.start();
	const pid1 = listPid(d);
	const reloadExt = join(d.root, "reload-cmd.ts");
	writeFileSync(
		reloadExt,
		`export default function (pi) {\n\tpi.registerCommand("test-reload", { description: "reload", handler: async (_args, ctx) => { await ctx.reload(); } });\n}\n`,
	);
	const agentDir = join(d.root, "agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(d.root, "piwork"), { recursive: true });
	// No PI_FLEET_BIN: the hook finds bin/pi-fleet next to the extension.
	const env: NodeJS.ProcessEnv = { ...d.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
	delete env.PI_FLEET_BIN;
	const child = spawn(
		piCmd,
		["--mode", "rpc", "-ne", "-e", join(repo, "pi/extensions/fleet"), "-e", join(repo, "tests/pi-fleet/support/faux-provider.ts"), "-e", reloadExt,
			"--offline", "--provider", "faux", "--model", "faux-1", "--session-dir", join(d.root, "pisessions"), "-ns", "-np", "-nc"],
		{ cwd: join(d.root, "piwork"), env, stdio: ["pipe", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (b) => (stderr += b));
	let stdout = "";
	child.stdout.on("data", (b) => (stdout += b));
	const exited = new Promise((r) => child.once("exit", r));
	try {
		await waitFor("pi's status file", () => existsSync(d.statusDir) && readdirSync(d.statusDir).some((f) => f.endsWith(".json")), 30_000);
		await sleep(1500);
		assert.equal(d.tryTmux(["show", "-gqv", "@deck_reload"]), "", "a startup does not reload the deck");
		assert.equal(listPid(d), pid1);
		appendFileSync(d.conf, "\nset -g @deck_test_marker via-pi\n");
		child.stdin.write(`${JSON.stringify({ id: "r", type: "prompt", message: "/test-reload" })}\n`);
		await waitFor("the marker", () => d.tryTmux(["show", "-gqv", "@deck_test_marker"]) === "via-pi", 30_000);
		const pid2 = await newListPid(d, pid1);
		assert.ok(pid2 > 1);
		assert.match(d.tmux(["show", "-gv", "@deck_reload"]), /^\d+:[0-9a-f]+$/);
	} finally {
		child.stdin.end();
		await Promise.race([exited, sleep(5000)]);
		if (child.exitCode === null) child.kill("SIGKILL");
		if (process.env.DEBUG_DECK_RELOAD) process.stderr.write(stderr + stdout);
	}
});
