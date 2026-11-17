// pi-deck server layer (docs/pi-deck-design.md §5, §7, §8, §12 phase 1). Every tmux server here is a
// throwaway `tmux -L decktest-<pid>-<n>[-outer|-h]`; the harness refuses the `default` and `pifleet` sockets,
// and the CLI runs with PI_FLEET_TMUX_GUARD=1 (which refuses them too). pi is the node stub in
// support/deck-stub-pi.mjs (records runs, typed bytes and SIGWINCHes); nvim is real (`nvim --clean -n`).
// Key tests use the §11 harness: a harness server whose pane runs a real client of an outer server, which
// opens the deck popup (`pi-fleet attach`); keys are typed with `send-keys` into the harness pane.
// Each test kills its servers and removes their socket files.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmuxBaseArgs } from "../../pi/extensions/fleet/cli.ts";
import { deckSockPath, deckTmuxArgs, inDeck, slotSizeFor } from "../../pi/extensions/fleet/deck.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../..");
const cliBin = join(repo, "bin/pi-fleet");
const attachBin = join(repo, "bin/pi-deck-attach");
const deckConf = join(repo, "pi/deck.tmux.conf");
const stubPi = join(here, "support/deck-stub-pi.mjs");

function have(cmd: string, flag: string): boolean {
	return spawnSync(cmd, [flag], { stdio: "ignore", timeout: 5000 }).status === 0;
}
const haveTmux = have("tmux", "-V");
const haveNvim = have("nvim", "--version");
const realTmux = haveTmux ? execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim() : "tmux";
const skipTmux = !haveTmux && "tmux not installed";
const skipNvim = (!haveTmux || !haveNvim) && "tmux or nvim not installed";
const socketDir = `${process.env.TMUX_TMPDIR || "/tmp"}/tmux-${process.getuid?.() ?? 0}`;

/** The harness guard: tmux args must name a throwaway socket, never `default` or `pifleet`. */
function guardTmuxArgs(args: string[]): void {
	const flag = args[0];
	const name = args[1];
	if ((flag !== "-L" && flag !== "-S") || !name || ["default", "pifleet"].includes(basename(name))) {
		throw new Error(`test harness refuses tmux without a throwaway socket: ${args.join(" ")}`);
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		let value: T | undefined | false;
		try {
			value = probe();
		} catch {
			value = undefined;
		}
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
}

interface Pane {
	pane: string;
	where: string;
	role: string;
	session: string;
	peer: string;
	width: number;
	height: number;
	windowSize: string;
	dead: boolean;
	active: boolean;
}

let serial = 0;
const live: Deck[] = [];
after(() => {
	for (const d of live) d.close();
});

class Deck {
	readonly root = mkdtempSync(join(tmpdir(), "pdk-"));
	readonly label = `decktest-${process.pid}-${++serial}`;
	readonly stub = join(this.root, "stub");
	readonly work = join(this.root, "work");
	readonly env: NodeJS.ProcessEnv;
	readonly servers = new Set<string>();

	constructor(opts: { pathPrefix?: string } = {}) {
		for (const d of [this.stub, this.work, join(this.root, "home")]) mkdirSync(d, { recursive: true });
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: join(this.root, "home"),
			PATH: `${opts.pathPrefix ? `${opts.pathPrefix}:` : ""}${join(repo, "bin")}:${process.env.PATH}`,
			PI_FLEET_STATE_DIR: join(this.root, "state"),
			PI_FLEET_RUNTIME_DIR: join(this.root, "run"),
			PI_FLEET_STUB_DIR: this.stub,
			PI_FLEET_PI_CMD: `${process.execPath} ${stubPi}`,
			PI_FLEET_NVIM_CMD: "nvim --clean -n",
			PI_FLEET_TMUX_GUARD: "1",
			PI_FLEET_DECK_SOCKET: this.label,
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
		};
		for (const k of ["TMUX", "TMUX_PANE", "PI_FLEET_SESSION", "PI_FLEET_TMUX_SOCKET", "PI_FLEET_DECK", "PI_FLEET_DECK_CONF", "PI_CODING_AGENT_DIR"]) delete env[k];
		this.env = env;
		this.servers.add(this.label);
		live.push(this);
	}

	/** tmux on one of this test's servers: the deck (default), or `<label>-<suffix>`. */
	tmux(args: string[], suffix = ""): string {
		const name = suffix ? `${this.label}-${suffix}` : this.label;
		const full = ["-L", name, ...args];
		guardTmuxArgs(full);
		this.servers.add(name);
		const env = { ...this.env };
		return execFileSync("tmux", full, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");
	}
	tryTmux(args: string[], suffix = ""): string | undefined {
		try {
			return this.tmux(args, suffix);
		} catch {
			return undefined;
		}
	}
	cli(args: string[], extra: NodeJS.ProcessEnv = {}): { code: number; out: string; err: string } {
		const r = spawnSync(cliBin, args, { env: { ...this.env, ...extra }, encoding: "utf8", timeout: 30_000 });
		return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
	}
	panes(): Pane[] {
		const out = this.tmux([
			"list-panes", "-a", "-F",
			"#{pane_id}\t#{session_name}:#{window_name}.#{pane_index}\t#{@pi_fleet_role}\t#{@pi_fleet_session}\t#{@pi_fleet_peer}\t#{pane_width}\t#{pane_height}\t#{window-size}\t#{pane_dead}\t#{pane_active}",
		]);
		return out.split("\n").map((l) => {
			const f = l.split("\t");
			return { pane: f[0], where: f[1], role: f[2], session: f[3], peer: f[4], width: Number(f[5]), height: Number(f[6]), windowSize: f[7], dead: f[8] === "1", active: f[9] === "1" };
		});
	}
	slot(): Pane {
		return this.panes().find((p) => p.where === "deck:deck.1")!;
	}
	list(): Pane {
		return this.panes().find((p) => p.where === "deck:deck.0")!;
	}
	/** The active pane of the deck window. */
	activeIndex(): string {
		return this.tmux(["display-message", "-p", "-t", "=deck:=deck", "#{pane_index}"]);
	}
	file(id: string, ext: string): string {
		const f = join(this.stub, `${id}.${ext}`);
		return existsSync(f) ? readFileSync(f, "utf8") : "";
	}
	start(): void {
		const r = this.cli(["deck-start"]);
		assert.equal(r.code, 0, r.err);
	}
	/** `open --deck`; waits for the stub pi to run. */
	async open(extra: string[] = []): Promise<{ id: string; pane: string }> {
		const r = this.cli(["open", "--deck", "--cwd", this.work, "--json", ...extra]);
		assert.equal(r.code, 0, r.err + r.out);
		const reply = JSON.parse(r.out);
		assert.equal(reply.ok, true, r.out);
		await waitFor("stub pi to start", () => this.file(reply.session, "runs") !== "");
		return { id: reply.session, pane: reply.pane };
	}
	request(message: Record<string, unknown>): Record<string, unknown> {
		const script = `import("${join(repo, "pi/extensions/fleet/deck.ts")}").then(async (d) => { process.stdout.write(JSON.stringify(await d.deckRequest(${JSON.stringify(message)}))); })`;
		const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: this.env, encoding: "utf8", timeout: 20_000 });
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	}
	close(): void {
		for (const name of this.servers) {
			try {
				execFileSync("tmux", ["-L", name, "kill-server"], { stdio: "ignore", env: this.env });
			} catch {
				// gone
			}
			rmSync(join(socketDir, name), { force: true }); // tmux 3.2a leaves the socket file
		}
		this.servers.clear();
		rmSync(this.root, { recursive: true, force: true });
	}
}

/**
 * The §3 harness: an outer server (prefix C-s, a shell pane) and a harness server whose pane runs a
 * real client of it. Keys typed into the harness pane reach the outer client like a terminal's.
 */
async function harness(d: Deck): Promise<{ keys: (...k: string[]) => void; hex: (h: string) => void; outerSocket: string }> {
	const outerConf = join(d.root, "outer.conf");
	writeFileSync(
		outerConf,
		[
			"set -g prefix C-s",
			"unbind C-b",
			"bind C-s send-prefix",
			"set -s escape-time 0",
			"set -g extended-keys on",
			"set -as terminal-features ',*:extkeys'",
			"set -g status off",
			// An outer root C-h that must NOT fire while the popup is open.
			"bind -n C-h set -g @outer_ch fired",
		].join("\n"),
	);
	d.tmux(["-f", outerConf, "new-session", "-d", "-s", "main", "-x", "160", "-y", "48", "/bin/sh"], "outer");
	const outerSocket = d.tmux(["display-message", "-p", "#{socket_path}"], "outer");
	d.tmux(
		["-f", "/dev/null", "new-session", "-d", "-s", "h", "-x", "160", "-y", "48", `env -u TMUX ${realTmux} -L ${d.label}-outer attach -t main`],
		"h",
	);
	d.tmux(["set", "-g", "escape-time", "0"], "h");
	await waitFor("the outer client", () => d.tmux(["list-clients", "-F", "#{client_name}"], "outer") !== "");
	await sleep(300);
	return {
		keys: (...k: string[]) => d.tmux(["send-keys", "-t", "h", ...k], "h") as unknown as void,
		hex: (h: string) => d.tmux(["send-keys", "-t", "h", "-H", ...h.split(" ")], "h") as unknown as void,
		outerSocket,
	};
}

// ---------------------------------------------------------------- pure

test("slotSizeFor: list at pct% (rounded down), one border column", () => {
	assert.deepEqual(slotSizeFor(200, 50, 50), { listWidth: 100, slot: { width: 99, height: 50 } });
	assert.deepEqual(slotSizeFor(150, 41, 50), { listWidth: 75, slot: { width: 74, height: 41 } });
	assert.deepEqual(slotSizeFor(151, 41, 40), { listWidth: 60, slot: { width: 90, height: 41 } });
});

test("guards: deck calls refuse the default and pifleet sockets under PI_FLEET_TMUX_GUARD", () => {
	const g = { PI_FLEET_TMUX_GUARD: "1" };
	assert.throws(() => deckTmuxArgs({ ...g }), /refuses the deck socket pifleet/);
	assert.throws(() => deckTmuxArgs({ ...g, PI_FLEET_DECK_SOCKET: "default" }), /refuses/);
	assert.throws(() => deckTmuxArgs({ ...g, PI_FLEET_DECK_SOCKET: "/tmp/tmux-1/pifleet" }), /refuses/);
	assert.deepEqual(deckTmuxArgs({ ...g, PI_FLEET_DECK_SOCKET: "decktest-x" }), ["-L", "decktest-x"]);
	assert.deepEqual(deckTmuxArgs({}), ["-L", "pifleet"]);
	assert.throws(() => tmuxBaseArgs({ ...g, TMUX: "/tmp/tmux-1/pifleet,1,0" }), /refuses/);
	assert.deepEqual(tmuxBaseArgs({ ...g, TMUX: "/tmp/tmux-1/decktest-x,1,0" }), ["-S", "/tmp/tmux-1/decktest-x"]);
	const r = spawnSync(attachBin, [], { env: { ...process.env, ...g, PI_FLEET_DECK_SOCKET: "", TMUX: "" }, encoding: "utf8" });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /refuses the pifleet socket/);
	// deck.sock never collides with the real deck's for a test socket.
	const run = mkdtempSync(join(tmpdir(), "pdkr-"));
	try {
		assert.equal(deckSockPath({ PI_FLEET_RUNTIME_DIR: run, PI_FLEET_DECK_SOCKET: "decktest-1" }), join(run, "deck-decktest-1.sock"));
		assert.equal(deckSockPath({ PI_FLEET_RUNTIME_DIR: run }), join(run, "deck.sock"));
	} finally {
		rmSync(run, { recursive: true, force: true });
	}
	assert.equal(inDeck({ PI_FLEET_DECK: "1" }), true);
	assert.equal(inDeck({ TMUX: `${socketDir}/decktest-q,1,0`, PI_FLEET_DECK_SOCKET: "decktest-q" }), true);
	assert.equal(inDeck({ TMUX: `${socketDir}/default,1,0`, PI_FLEET_DECK_SOCKET: "decktest-q" }), false);
});

// ---------------------------------------------------------------- server

test("deck.tmux.conf: options and keys (list-keys, show -gv)", { skip: skipTmux }, () => {
	const d = new Deck();
	try {
		d.tmux(["-f", deckConf, "new-session", "-d", "-s", "x", "sleep 600"]);
		assert.equal(d.tmux(["show", "-gv", "prefix"]), "C-s");
		assert.equal(d.tmux(["show", "-gv", "status"]), "off");
		assert.equal(d.tmux(["show", "-sv", "escape-time"]), "0");
		assert.equal(d.tmux(["show", "-sv", "extended-keys"]), "on");
		assert.equal(d.tmux(["show", "-gv", "bell-action"]), "any");
		assert.equal(d.tmux(["show", "-wgv", "remain-on-exit"]), "on");
		assert.equal(d.tmux(["show", "-gv", "@deck_list_pct"]), "50");
		assert.match(d.tmux(["show", "-sv", "terminal-features"]), /tmux\*:extkeys/);
		assert.match(d.tmux(["show-hooks", "-wg"]), /pane-died\[0\] if-shell -F "#\{==:#\{@pi_fleet_role\},list\}" respawn-pane/);
		assert.match(d.tmux(["list-keys", "-T", "root", "C-h"]), /select-pane -t =deck:=deck\.0/);
		const prefix = d.tmux(["list-keys", "-T", "prefix"]);
		assert.match(prefix, /prefix\s+C-h\s+send-keys C-h/);
		assert.match(prefix, /prefix\s+g\s+detach-client/);
		assert.match(prefix, /prefix\s+d\s+detach-client/);
		assert.match(prefix, /prefix\s+\[\s+copy-mode/);
		assert.match(prefix, /prefix\s+PPage\s+copy-mode -u/);
		assert.match(prefix, /prefix\s+e\s+run-shell .*swap-pane -d -s .*pair --deck/);
		// No splits, break-pane, kill-pane, new windows, layouts.
		for (const k of ['"', "%", "!", "x", "&", "c", "Space", "z", "{", "}"]) {
			assert.doesNotMatch(prefix, new RegExp(`prefix\\s+${k.replace(/[{}"%!&]/g, (c) => `\\${c}`)}\\s`), k);
		}
	} finally {
		d.close();
	}
});

test("deck-start: deck (list | slot, 50/50) and pool (manual, default-size = slot size)", { skip: skipTmux, timeout: 60_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const panes = d.panes();
		const list = d.list();
		const slot = d.slot();
		assert.equal(panes.filter((p) => p.where.startsWith("deck:")).length, 2);
		assert.equal(list.role, "list");
		assert.equal(slot.role, "preview");
		assert.equal(list.width + 1 + slot.width, Number(d.tmux(["display-message", "-p", "-t", "=deck:=deck", "#{window_width}"])));
		assert.ok(Math.abs(list.width - slot.width) <= 1, `${list.width} vs ${slot.width}`);
		assert.equal(d.tmux(["show", "-v", "-t", "=pool:", "default-size"]), `${slot.width}x${slot.height}`);
		for (const p of panes.filter((p) => p.where.startsWith("pool:"))) {
			assert.equal(p.windowSize, "manual", p.where);
			assert.deepEqual([p.width, p.height], [slot.width, slot.height], p.where);
		}
		assert.ok(panes.some((p) => p.role === "anchor"));
		const pid = d.tmux(["show", "-gv", "@deck_tui_pid"]);
		assert.match(pid, /^\d+$/);
		assert.ok(existsSync(join(d.root, "run", `deck-${d.label}.sock`)));
		assert.deepEqual(d.request({ type: "ping" }), { ok: true, pid: Number(pid) });
		// A second start finds it running.
		assert.match(d.cli(["deck-start"]).out, /^running /);
	} finally {
		d.close();
	}
});

test("open ×3: pool pis at slot size, PI_FLEET_DECK=1; swapping them sends no SIGWINCH", { skip: skipTmux, timeout: 90_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const sessions = [await d.open(), await d.open(), await d.open()];
		const slot = d.slot();
		assert.equal(slot.session, sessions[2].id, "the last opened is shown");
		assert.equal(d.activeIndex(), "1", "and focused");
		for (const s of sessions) {
			const p = d.panes().find((q) => q.pane === s.pane)!;
			assert.equal(p.role, "pi");
			assert.equal(p.session, s.id);
			assert.deepEqual([p.width, p.height], [slot.width, slot.height]);
			const [, pane, deckFlag, ...args] = d.file(s.id, "runs").trim().split(" ");
			assert.equal(pane, s.pane);
			assert.equal(deckFlag, "1");
			assert.deepEqual(args, ["--session-id", s.id]);
		}
		await sleep(500);
		const before = sessions.map((s) => d.file(s.id, "winch"));
		for (const s of [sessions[0], sessions[1], sessions[2], sessions[0]]) {
			const r = d.request({ type: "select", session: s.id });
			assert.equal(r.ok, true, JSON.stringify(r));
			assert.equal(d.slot().session, s.id);
		}
		await sleep(500);
		assert.deepEqual(sessions.map((s) => d.file(s.id, "winch")), before, "no SIGWINCH from swaps");
		// open of a session already in the deck selects it; open --session of a closed one resumes into the pool.
		const again = d.cli(["open", "--deck", "--session", sessions[1].id, "--json"]);
		assert.equal(JSON.parse(again.out).created, false);
		assert.equal(d.slot().session, sessions[1].id);
		const missing = d.cli(["open", "--deck", "--session", "deadbeef-0000", "--json"]);
		assert.equal(missing.code, 0, missing.err);
		assert.equal(JSON.parse(missing.out).created, true);
	} finally {
		d.close();
	}
});

test("open refuses a session live in the user's tmux (outside) with its window", { skip: skipTmux, timeout: 60_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const id = "11111111-2222-7333-8444-555555555555";
		mkdirSync(join(d.root, "state", "status"), { recursive: true });
		const now = new Date().toISOString();
		writeFileSync(
			join(d.root, "state", "status", `${id}.json`),
			JSON.stringify({ v: 1, sessionId: id, cwd: d.work, host: (await import("node:os")).hostname(), pid: process.pid, state: "idle", acked: true, since: now, heartbeat: now, subagents: {}, tmux: { socket: `${socketDir}/default`, piPane: "%9", windowIndex: 3 } }),
		);
		const r = d.cli(["open", "--deck", "--session", id, "--json"]);
		assert.equal(r.code, 1);
		const reply = JSON.parse(r.out);
		assert.equal(reply.ok, false);
		assert.match(reply.error, /runs in your tmux \(window 3\)/);
		assert.equal(reply.outside.pane, "%9");
	} finally {
		d.close();
	}
});

test("resizing the deck client resizes every pool window in one tmux call", { skip: skipTmux, timeout: 90_000 }, async () => {
	// A tmux wrapper on the deck server's PATH logs every call the list makes.
	const wrapDir = mkdtempSync(join(tmpdir(), "pdkw-"));
	const log = join(wrapDir, "calls.log");
	writeFileSync(join(wrapDir, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realTmux}' "$@"\n`);
	chmodSync(join(wrapDir, "tmux"), 0o755);
	const d = new Deck({ pathPrefix: wrapDir });
	try {
		d.start();
		await d.open();
		await d.open();
		// A client attached directly (pi-deck-attach in a harness pane, as from a terminal), then resized.
		d.tmux(["set", "-g", "@deck_outer", "stale"]);
		d.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "h", "-x", "180", "-y", "50", `env -u TMUX ${attachBin}`], "h");
		await waitFor("the deck client", () => d.tmux(["list-clients", "-F", "#{client_name}"]) !== "");
		assert.equal(d.tryTmux(["show", "-gv", "@deck_outer"]) ?? "", "", "a direct attach is no popup");
		const settled = (w: number) =>
			waitFor(`pool at the slot size for width ${w}`, () => {
				const slot = d.slot();
				const pool = d.panes().filter((p) => p.where.startsWith("pool:"));
				return slot.width === slotSizeFor(w, slot.height, 50).slot.width && pool.every((p) => p.width === slot.width && p.height === slot.height);
			});
		await settled(180);
		await sleep(300);
		writeFileSync(log, "");
		d.tmux(["resize-window", "-t", "h", "-x", "140", "-y", "40"], "h");
		await settled(140);
		await sleep(300);
		const calls = readFileSync(log, "utf8")
			.split("\n")
			.filter((l) => l.startsWith(`-L ${d.label} `) && /resize-window/.test(l));
		const poolWindows = Number(d.tmux(["display-message", "-p", "-t", "=pool:", "#{session_windows}"]));
		assert.equal(calls.length, 1, calls.join("\n"));
		assert.equal(calls[0].match(/resize-window/g)!.length, poolWindows);
		assert.match(calls[0], /set-option -t =pool: default-size /);
		const slot = d.slot();
		assert.equal(d.tmux(["show", "-v", "-t", "=pool:", "default-size"]), `${slot.width}x${slot.height}`);
	} finally {
		d.close();
		rmSync(wrapDir, { recursive: true, force: true });
	}
});

test("a pi exiting 0 leaves the pool and the slot falls back to the holder; a dead list respawns", { skip: skipTmux, timeout: 90_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const a = await d.open();
		const b = await d.open();
		writeFileSync(join(d.stub, `${b.id}.exit`), "0\n");
		await waitFor("b's pane killed", () => !d.panes().some((p) => p.pane === b.pane));
		assert.equal(d.slot().role, "preview");
		writeFileSync(join(d.stub, `${a.id}.exit`), "0\n");
		await waitFor("a's pane killed", () => !d.panes().some((p) => p.pane === a.pane));
		// The list crashes: restarted in place.
		const pid = d.tmux(["show", "-gv", "@deck_tui_pid"]);
		process.kill(Number(pid), "SIGKILL");
		const pid2 = await waitFor("a new list", () => {
			const p = d.tryTmux(["show", "-gv", "@deck_tui_pid"]);
			return p && p !== pid ? p : undefined;
		});
		assert.deepEqual(d.request({ type: "ping" }), { ok: true, pid: Number(pid2) });
		// The list pane's process itself dies: the pane-died hook respawns it. (tmux 3.2a sometimes loses the
		// SIGCHLD of a pane until the next child exits; a run-shell provides one.)
		const list = d.list();
		const panePid = d.tmux(["display-message", "-p", "-t", list.pane, "#{pane_pid}"]);
		process.kill(Number(panePid), "SIGKILL");
		process.kill(Number(pid2), "SIGKILL");
		await waitFor("the list pane dead or respawned", () => d.tmux(["display-message", "-p", "-t", list.pane, "#{pane_pid}"]) !== panePid || d.list().dead);
		d.tmux(["run-shell", "true"]);
		await waitFor("the list respawned", () => {
			const p = d.tryTmux(["show", "-gv", "@deck_tui_pid"]);
			return !d.list().dead && p && p !== pid2;
		});
		assert.equal(d.list().pane, list.pane, "same pane, respawned");
		assert.equal(d.request({ type: "ping" }).ok, true);
	} finally {
		d.close();
	}
});

test("kill-deck asks each deck pi to quit, then kills only its own server", { skip: skipTmux, timeout: 60_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const s = await d.open();
		// A control socket for the stub pi (pi-fleet's control.ts in a real pi): `kill` makes it exit 0.
		const got: string[] = [];
		const ctl = createServer((sock) => {
			sock.setEncoding("utf8");
			sock.on("data", (line: string) => {
				got.push(line.trim());
				sock.end(`${JSON.stringify({ ok: true })}\n`);
				writeFileSync(join(d.stub, `${s.id}.exit`), "0\n");
			});
		});
		await new Promise<void>((r) => ctl.listen(join(d.root, "run", `${s.id}.pi.sock`), r));
		d.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "x", "sleep 600"], "bystander");
		const r = d.cli(["kill-deck"], {});
		assert.equal(r.code, 1, "no --yes and no terminal: refused");
		assert.ok(d.tryTmux(["has-session", "-t", "=deck"]) !== undefined);
		const child = spawn(cliBin, ["kill-deck", "--yes"], { env: d.env, stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		child.stderr.on("data", (b) => (err += b));
		const code = await new Promise<number | null>((r) => child.once("exit", r));
		ctl.close();
		assert.equal(code, 0, err);
		assert.deepEqual(got.map((l) => JSON.parse(l)), [{ type: "kill", confirmed: true, scancel: false }]);
		assert.equal(err, "", "the pi exited before the server was killed");
		assert.equal(d.tryTmux(["has-session", "-t", "=deck"]), undefined);
		assert.notEqual(d.tryTmux(["has-session", "-t", "=x"], "bystander"), undefined);
	} finally {
		d.close();
	}
});

// ---------------------------------------------------------------- keys through the popup

test("popup: attach, C-h, prefix C-h, Shift+Enter, prefix e (lazy nvim), prefix g", { skip: skipNvim, timeout: 120_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const s = await d.open();
		const h = await harness(d);
		// `pi-fleet attach` typed into the outer shell pane: the deck opens in a popup over that client.
		h.keys("pi-fleet attach", "Enter");
		await waitFor("the deck client in the popup", () => d.tmux(["list-clients", "-F", "#{client_name}"]) !== "", 15_000);
		const outerClient = d.tmux(["list-clients", "-F", "#{client_name}"], "outer");
		assert.equal(d.tmux(["show", "-gv", "@deck_outer"]), `${h.outerSocket}|${outerClient}`);
		const deckClientSize = d.tmux(["list-clients", "-F", "#{client_width}x#{client_height}"]);
		assert.equal(deckClientSize, "150x41", "95%x90% of 160x48, minus the popup border");
		const popupSlot = slotSizeFor(150, 41, 50).slot;
		await waitFor("slot and pool at the popup's slot size", () =>
			d.panes().filter((p) => p.where.startsWith("pool:") || p.where === "deck:deck.1").every((p) => p.width === popupSlot.width && p.height === popupSlot.height),
		);
		await sleep(500);
		const winch0 = d.file(s.id, "winch");

		// Focus the list, then Enter (the stand-in list focuses the slot).
		d.tmux(["select-pane", "-t", "=deck:=deck.0"]);
		h.keys("Enter");
		await waitFor("slot focused", () => d.activeIndex() === "1");
		// Shift+Enter reaches the pool pi byte-exact.
		h.hex("1b 5b 31 33 3b 32 75");
		await waitFor("Shift+Enter in the pi", () => d.file(s.id, "keys").includes("\x1b[13;2u"));
		// C-h: back to the list; the pi gets nothing, the outer root C-h does not fire.
		const keysBefore = d.file(s.id, "keys");
		h.keys("C-h");
		await waitFor("list focused", () => d.activeIndex() === "0");
		assert.equal(d.file(s.id, "keys"), keysBefore);
		assert.equal(d.tryTmux(["show", "-gv", "@outer_ch"], "outer") ?? "", "");
		// prefix C-h: a literal C-h to the pi.
		d.tmux(["select-pane", "-t", "=deck:=deck.1"]);
		h.keys("C-s", "C-h");
		await waitFor("literal C-h in the pi", () => d.file(s.id, "keys").endsWith("\x08"));
		assert.equal(d.activeIndex(), "1");

		// prefix e: creates the nvim (pool, slot size) and shows it; again: back to the pi; again: nvim (no new one).
		h.keys("C-s", "e");
		const nvim = await waitFor("nvim in the slot", () => (d.slot().role === "nvim" ? d.slot() : undefined), 15_000);
		assert.equal(nvim.session, s.id);
		assert.equal(nvim.peer, s.pane);
		assert.equal(d.panes().find((p) => p.pane === s.pane)!.peer, nvim.pane);
		assert.deepEqual([nvim.width, nvim.height], [popupSlot.width, popupSlot.height]);
		assert.equal(d.tmux(["display-message", "-p", "-t", s.pane, "#{window-size} #{window_width}x#{window_height}"]), `manual ${popupSlot.width}x${popupSlot.height}`, "the new pool window was born at the slot size");
		assert.equal(d.activeIndex(), "1", "the slot stays focused");
		h.keys("C-s", "e");
		await waitFor("pi back in the slot", () => d.slot().pane === s.pane);
		h.keys("C-s", "e");
		await waitFor("the same nvim again", () => d.slot().pane === nvim.pane);
		// From the list too.
		h.keys("C-h");
		await waitFor("list focused", () => d.activeIndex() === "0");
		h.keys("C-s", "e");
		await waitFor("pi back from the list", () => d.slot().pane === s.pane);
		assert.equal(d.activeIndex(), "0");
		assert.equal(d.panes().filter((p) => p.role === "nvim").length, 1);
		await sleep(300);
		assert.equal(d.file(s.id, "winch"), winch0, "no SIGWINCH from the toggles");

		// The list remembers a shown nvim when the slot moves on.
		h.keys("C-s", "e");
		await waitFor("nvim shown", () => d.slot().pane === nvim.pane);
		const other = d.request({ type: "open", cwd: d.work, focus: false });
		assert.equal(other.ok, true);
		assert.equal(d.panes().find((p) => p.pane === s.pane) && d.tmux(["display-message", "-p", "-t", s.pane, "#{@pi_fleet_shown}"]), "nvim");
		d.request({ type: "select", session: s.id });
		assert.equal(d.slot().pane, nvim.pane, "selecting the session shows its nvim again");

		// prefix g: detach, which closes the popup; the outer client stays, and goes to @deck_jump (an outside pane).
		const jump = d.tmux(["new-window", "-d", "-t", "main:", "-P", "-F", "#{pane_id}", "/bin/sh"], "outer");
		d.tmux(["set", "-g", "@deck_jump", jump]);
		h.keys("C-s", "g");
		await waitFor("deck client gone", () => d.tmux(["list-clients", "-F", "#{client_name}"]) === "");
		await waitFor("popup closed", () => !/pi-deck|stand-in/.test(d.tmux(["capture-pane", "-p", "-t", "h"], "h")));
		await waitFor("the outer client jumped", () => d.tmux(["list-clients", "-F", "#{client_name} #{pane_id}"], "outer") === `${outerClient} ${jump}`);
		assert.equal(d.tryTmux(["show", "-gv", "@deck_jump"]) ?? "", "", "@deck_jump consumed");
		assert.ok(d.tryTmux(["has-session", "-t", "=deck"]) !== undefined, "detaching never stops the deck");
	} finally {
		d.close();
	}
});

test("leftover throwaway sockets of this run are gone", { skip: skipTmux }, () => {
	for (const d of live) d.close();
	const mine = readdirSync(socketDir).filter((n) => n.startsWith(`decktest-${process.pid}-`));
	assert.deepEqual(mine, []);
});
