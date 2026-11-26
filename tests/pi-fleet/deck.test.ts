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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmuxBaseArgs } from "../../pi/extensions/fleet/cli.ts";
import { killServers } from "./support/tmux-cleanup.ts";
import { LIST_LOOP, deckSizesFor, deckSockPath, deckTmuxArgs, inDeck, popupBorderless, slotArgs, slotSizeFor, type DeckPane } from "../../pi/extensions/fleet/deck.ts";
import { tempRoot } from "./support/tmp.ts";

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

/** Poll until `probe()` equals `want`; on timeout name what was awaited and the last value seen. */
async function waitEq(what: string, probe: () => string, want: string, timeoutMs = 12_000): Promise<void> {
	let last = "";
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			last = probe();
			if (last === want) return;
		} catch (e) {
			last = `error: ${e}`;
		}
		if (Date.now() > end) throw new Error(`timed out waiting for ${what} === ${JSON.stringify(want)}; last observed ${JSON.stringify(last)}`);
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
	readonly root = tempRoot("pdk-");
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
			PI_FLEET_DECK_START_WAIT_MS: "30000", // deck-start waits 3 s for the list; a loaded machine (parallel runs) needs more
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
	/** The pi slot (right half). */
	slot(): Pane {
		return this.panes().find((p) => p.where === "deck:deck.3")!;
	}
	/** The terminal slot (bottom-left). */
	termSlot(): Pane {
		return this.panes().find((p) => p.where === "deck:deck.2")!;
	}
	/** The nvim slot (below the list). */
	nvimSlot(): Pane {
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
	request(message: Record<string, unknown>, extra: NodeJS.ProcessEnv = {}): Record<string, unknown> {
		return this.deckCall(`d.deckRequest(${JSON.stringify(message)})`, extra) as Record<string, unknown>;
	}
	/** Evaluate `expr` (with `d` = deck.ts) in a node child with this deck's env; its JSON result. */
	deckCall(expr: string, extra: NodeJS.ProcessEnv = {}): unknown {
		const script = `import("${join(repo, "pi/extensions/fleet/deck.ts")}").then(async (d) => { process.stdout.write(JSON.stringify(await ${expr})); })`;
		const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...this.env, ...extra }, encoding: "utf8", timeout: 30_000 });
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	}
	/** deckCall without blocking this process (for sockets the test itself serves). */
	async deckCallAsync(expr: string): Promise<unknown> {
		const script = `import("${join(repo, "pi/extensions/fleet/deck.ts")}").then(async (d) => { process.stdout.write(JSON.stringify(await ${expr})); })`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (b) => (out += b));
		child.stderr.on("data", (b) => (err += b));
		const code = await new Promise<number | null>((r) => child.once("exit", r));
		assert.equal(code, 0, err);
		return JSON.parse(out);
	}
	/** pi-deck-attach run directly (as from a terminal) in a pane of the throwaway server `<label>-<suffix>`. */
	async attachDirect(suffix: string, size = { x: 180, y: 50 }): Promise<void> {
		const before = this.tryTmux(["list-clients", "-F", "#{client_name}"])?.split("\n").filter(Boolean).length ?? 0;
		this.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "h", "-x", String(size.x), "-y", String(size.y), `env -u TMUX ${attachBin}`], suffix);
		await waitFor("the deck client", () => this.tmux(["list-clients", "-F", "#{client_name}"]).split("\n").filter(Boolean).length > before);
	}
	close(): void {
		killServers(this.servers, { tmux: "tmux", env: this.env, socketDir });
		this.servers.clear();
		rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
	// As when the user's tmux server was started from inside a pane: popup jobs inherit this $TMUX_PANE.
	d.tmux(["set-environment", "-g", "TMUX_PANE", d.tmux(["display-message", "-p", "-t", "main", "#{pane_id}"], "outer")], "outer");
	d.tmux(
		["-f", "/dev/null", "new-session", "-d", "-s", "h", "-x", "160", "-y", "48", `env -u TMUX ${realTmux} -L ${d.label}-outer attach -t main`],
		"h",
	);
	d.tmux(["set", "-g", "escape-time", "0"], "h");
	await waitFor("the outer client", () => d.tmux(["list-clients", "-F", "#{client_name}"], "outer") !== "");
	await waitEq("the outer client size", () => d.tmux(["list-clients", "-F", "#{client_width}x#{client_height}"], "outer"), "160x48");
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

test("deckSizesFor: left column at pct%; list, nvim at hpct%, npct% of the height, the terminal the rest; one border column and two border lines", () => {
	assert.deepEqual(deckSizesFor(200, 50, 50), { list: { width: 100, height: 20 }, nvim: { width: 100, height: 20 }, term: { width: 100, height: 8 }, pi: { width: 99, height: 50 } });
	assert.deepEqual(deckSizesFor(150, 41, 50, 40, 40), { list: { width: 75, height: 16 }, nvim: { width: 75, height: 16 }, term: { width: 75, height: 7 }, pi: { width: 74, height: 41 } });
	assert.deepEqual(deckSizesFor(100, 30, 40, 35, 30), { list: { width: 40, height: 10 }, nvim: { width: 40, height: 9 }, term: { width: 40, height: 9 }, pi: { width: 59, height: 30 } });
	// Tiny windows keep every pane at least one line.
	const tiny = deckSizesFor(20, 5, 50);
	assert.ok(tiny.list.height >= 1 && tiny.nvim.height >= 1 && tiny.term.height >= 1);
	assert.equal(tiny.list.height + tiny.nvim.height + tiny.term.height + 2, 5);
});

test("slotArgs: one call puts the pi, nvim and terminal in their slots; nothing if they are there", () => {
	const pane = (id: string, where: "pi" | "nvim" | "term" | "pool"): DeckPane =>
		({ pane: id, inSlot: where === "pi", inNvimSlot: where === "nvim", inTermSlot: where === "term", role: "" }) as unknown as DeckPane;
	const swapPi = ["swap-pane", "-d", "-Z", "-s", "%5", "-t", "=deck:=deck.3"];
	const swapNvim = ["swap-pane", "-d", "-Z", "-s", "%6", "-t", "=deck:=deck.1"];
	const swapTerm = ["swap-pane", "-d", "-Z", "-s", "%7", "-t", "=deck:=deck.2"];
	assert.deepEqual(
		slotArgs([pane("%1", "pi"), pane("%2", "nvim"), pane("%3", "term"), pane("%5", "pool"), pane("%6", "pool"), pane("%7", "pool")], { pi: "%5", nvim: "%6", term: "%7" }),
		[...swapPi, ";", ...swapNvim, ";", ...swapTerm],
	);
	assert.equal(slotArgs([pane("%5", "pi"), pane("%6", "nvim"), pane("%7", "term")], { pi: "%5", nvim: "%6", term: "%7" }), undefined);
	assert.deepEqual(slotArgs([pane("%5", "pi"), pane("%6", "nvim"), pane("%3", "term"), pane("%7", "pool")], { pi: "%5", nvim: "%6", term: "%7" }), swapTerm);
	assert.deepEqual(slotArgs([pane("%1", "pi"), pane("%2", "nvim"), pane("%5", "pool"), pane("%6", "pool")], { pi: "%5", nvim: "%6" }), [...swapPi, ";", ...swapNvim]);
	assert.equal(slotArgs([pane("%5", "pi"), pane("%6", "nvim")], { pi: "%5", nvim: "%6" }), undefined);
	assert.deepEqual(slotArgs([pane("%5", "pi"), pane("%2", "nvim"), pane("%6", "pool")], { pi: "%5", nvim: "%6" }), swapNvim);
	// Crossed over (the pi in the nvim slot, its nvim in the pi slot): one swap fixes both.
	assert.deepEqual(slotArgs([pane("%6", "pi"), pane("%5", "nvim")], { pi: "%5", nvim: "%6" }), swapPi);
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
	// $TMUX names the socket dir by its real path; $TMUX_TMPDIR may go through a symlink (macOS: /var).
	const base = tempRoot("pdkt-");
	try {
		const link = join(base, "link");
		symlinkSync(base, link);
		const real = `${base}/tmux-${process.getuid?.() ?? 0}`;
		const q = { TMUX_TMPDIR: link, PI_FLEET_DECK_SOCKET: "decktest-q" };
		assert.equal(inDeck({ ...q, TMUX: `${real}/decktest-q,1,0` }), true);
		assert.equal(inDeck({ ...q, TMUX: `${real}/default,1,0` }), false);
		assert.equal(inDeck({ ...q, TMUX_TMPDIR: base, TMUX: `${real}/decktest-q,1,0` }), true);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
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
		assert.equal(d.tmux(["show", "-gv", "@deck_list_height_pct"]), "40");
		assert.equal(d.tmux(["show", "-gv", "@deck_nvim_height_pct"]), "40");
		assert.match(d.tmux(["show", "-sv", "terminal-features"]), /tmux\*:extkeys/);
		assert.match(d.tmux(["show-hooks", "-wg"]), /pane-died\[0\] if-shell -F "#\{==:#\{@pi_fleet_role\},list\}" (\{ )?respawn-pane/);
		// C-h/j/k/l: the neighbouring pane, else the key itself (pi: C-h always the list; list: C-l its own).
		assert.match(d.tmux(["list-keys", "-T", "root", "C-h"]), /if-shell -F .*pane_at_left.*@pi_fleet_role\},pi.*send-keys C-h.*select-pane -t =deck:=deck\.0/);
		assert.match(d.tmux(["list-keys", "-T", "root", "C-j"]), /if-shell -F .*pane_at_bottom.*send-keys C-j.*select-pane -D/);
		assert.match(d.tmux(["list-keys", "-T", "root", "C-k"]), /if-shell -F .*pane_at_top.*send-keys C-k.*select-pane -U/);
		assert.match(d.tmux(["list-keys", "-T", "root", "C-l"]), /if-shell -F .*pane_at_right.*list.*send-keys C-l.*select-pane -t =deck:=deck\.3/);
		// No right-click menus (Kill, Respawn, Split, Swap would break a pi or the two-pane layout).
		const root = d.tmux(["list-keys", "-T", "root"]);
		assert.doesNotMatch(root, /MouseDown3/);
		assert.doesNotMatch(root, /kill-pane|respawn-pane|split-window|swap-pane|kill-window|new-window/);
		// The list loop in pi-deck-attach is deck.ts's LIST_LOOP.
		assert.ok(readFileSync(attachBin, "utf8").includes(`list_loop='${LIST_LOOP}'`), "bin/pi-deck-attach list_loop != LIST_LOOP");
		const prefix = d.tmux(["list-keys", "-T", "prefix"]);
		for (const k of ["h", "j", "k", "l"]) {
			assert.match(prefix, new RegExp(`prefix\\s+${k}\\s+send-keys C-${k}`));
			assert.match(prefix, new RegExp(`prefix\\s+C-${k}\\s+send-keys C-${k}`));
		}
		assert.match(prefix, /prefix\s+z\s+resize-pane -Z/);
		assert.match(prefix, /prefix\s+g\s+detach-client/);
		assert.match(prefix, /prefix\s+d\s+detach-client/);
		assert.match(prefix, /prefix\s+\[\s+copy-mode/);
		assert.match(prefix, /prefix\s+PPage\s+copy-mode -u/);
		assert.match(prefix, /prefix\s+e\s+if-shell -F .*pane_index\},1.*select-pane -t =deck:=deck\.3.*select-pane -t =deck:=deck\.1/);
		// No splits, break-pane, kill-pane, new windows, layouts.
		for (const k of ['"', "%", "!", "x", "&", "c", "Space", "{", "}"]) {
			assert.doesNotMatch(prefix, new RegExp(`prefix\\s+${k.replace(/[{}"%!&]/g, (c) => `\\${c}`)}\\s`), k);
		}
	} finally {
		d.close();
	}
});

test("deck-start: deck (list / nvim slot / terminal slot | pi slot, 40/40/20) and pool (manual, each window at its slot's size)", { skip: skipTmux, timeout: 60_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const panes = d.panes();
		const list = d.list();
		const slot = d.slot();
		const nvimSlot = d.nvimSlot();
		const termSlot = d.termSlot();
		assert.equal(panes.filter((p) => p.where.startsWith("deck:")).length, 4);
		assert.equal(list.role, "list");
		assert.equal(nvimSlot.role, "nvim-holder");
		assert.equal(termSlot.role, "term-holder");
		assert.equal(slot.role, "preview");
		const [ww, wh] = d.tmux(["display-message", "-p", "-t", "=deck:=deck", "#{window_width} #{window_height}"]).split(" ").map(Number);
		const want = deckSizesFor(ww, wh, 50);
		assert.deepEqual([list.width, list.height], [want.list.width, want.list.height]);
		assert.deepEqual([nvimSlot.width, nvimSlot.height], [want.nvim.width, want.nvim.height]);
		assert.deepEqual([termSlot.width, termSlot.height], [want.term.width, want.term.height]);
		assert.deepEqual([slot.width, slot.height], [want.pi.width, want.pi.height]);
		assert.equal(list.width + 1 + slot.width, ww);
		assert.equal(list.height + 1 + nvimSlot.height + 1 + termSlot.height, wh);
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
		// The list publishes deck.sock: a client whose runtime dir differs (runtimeDir's per-process fallback) finds it.
		assert.equal(d.tmux(["show", "-gv", "@deck_sock"]), join(d.root, "run", `deck-${d.label}.sock`));
		assert.deepEqual(d.request({ type: "ping" }, { PI_FLEET_RUNTIME_DIR: join(d.root, "elsewhere") }), { ok: true, pid: Number(pid) });
		// A second start finds it running.
		assert.match(d.cli(["deck-start"]).out, /^running /);
	} finally {
		d.close();
	}
});

test("open ×3: pool pis at the pi-slot size, nvims and shells (made on first show) at their slots' sizes; swaps send no SIGWINCH", { skip: skipNvim, timeout: 90_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const sessions = [await d.open(), await d.open(), await d.open()];
		const slot = d.slot();
		const nvimSlot = d.nvimSlot();
		assert.equal(slot.session, sessions[2].id, "the last opened is shown");
		assert.equal(nvimSlot.role, "nvim");
		assert.equal(nvimSlot.session, sessions[2].id, "with its nvim");
		assert.equal(d.activeIndex(), "3", "and its pi focused");
		const termSlot = d.termSlot();
		assert.deepEqual([termSlot.role, termSlot.session], ["term", sessions[2].id], "and its shell");
		for (const s of sessions) {
			const p = d.panes().find((q) => q.pane === s.pane)!;
			assert.equal(p.role, "pi");
			assert.equal(p.session, s.id);
			assert.deepEqual([p.width, p.height], [slot.width, slot.height]);
			const nvim = d.panes().find((q) => q.pane === p.peer)!;
			assert.equal(nvim.role, "nvim", "every shown session has its nvim");
			assert.equal(nvim.peer, s.pane);
			assert.deepEqual([nvim.width, nvim.height], [nvimSlot.width, nvimSlot.height]);
			const terms = d.panes().filter((q) => q.role === "term" && q.session === s.id);
			assert.equal(terms.length, 1, "one shell per session");
			assert.deepEqual([terms[0]!.width, terms[0]!.height], [termSlot.width, termSlot.height]);
			assert.equal(d.tmux(["display-message", "-p", "-t", terms[0]!.pane, "#{pane_current_path}"]), d.work, "in the session's cwd");
			const [, pane, deckFlag, ...args] = d.file(s.id, "runs").trim().split(" ");
			assert.equal(pane, s.pane);
			assert.equal(deckFlag, "1");
			assert.deepEqual(args, ["--session-id", s.id]);
		}
		await waitFor("the last session's nvim in the slot", () => d.nvimSlot().session === sessions[sessions.length - 1].id && d.nvimSlot().role === "nvim");
		await sleep(300); // negative check below: let any startup SIGWINCH land first
		const before = sessions.map((s) => d.file(s.id, "winch"));
		for (const s of [sessions[0], sessions[1], sessions[2], sessions[0]]) {
			const r = d.request({ type: "select", session: s.id });
			assert.equal(r.ok, true, JSON.stringify(r));
			assert.equal(d.slot().session, s.id);
			assert.equal(d.nvimSlot().session, s.id);
			assert.equal(d.nvimSlot().role, "nvim");
			assert.deepEqual([d.termSlot().role, d.termSlot().session], ["term", s.id]);
		}
		assert.equal(d.panes().filter((p) => p.role === "term").length, 3, "no second shell for a session");
		assert.equal(d.panes().filter((p) => p.role === "nvim").length, 3, "no second nvim for a session");
		await waitFor("the selection shown", () => d.slot().session === sessions[0].id && d.nvimSlot().session === sessions[0].id && d.termSlot().session === sessions[0].id);
		await sleep(300); // bounded stability window for the negative check
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

test("layout repair and zoom: a vanished pi slot comes back on the right; swaps keep a zoom; a dead nvim in the slot is swapped out before it is killed", { skip: skipNvim, timeout: 90_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const a = await d.open();
		const b = await d.open();
		const right = () => d.panes().filter((p) => p.where.startsWith("deck:")).map((p) => [p.where, p.role]);
		await waitFor("b and its nvim shown", () => d.slot().pane === b.pane && d.nvimSlot().role === "nvim");

		// Zoomed pi slot: selecting another session keeps the zoom (swap-pane -Z).
		d.tmux(["resize-pane", "-Z", "-t", "=deck:=deck.3"]);
		assert.equal(d.request({ type: "select", session: a.id }).ok, true);
		assert.equal(d.slot().pane, a.pane);
		assert.equal(d.tmux(["display-message", "-p", "-t", "=deck:=deck", "#{window_zoomed_flag}"]), "1");
		d.tmux(["resize-pane", "-Z", "-t", "=deck:=deck.3"]);

		// A dead nvim still in the nvim slot (POOL_WRAP marked it, no reconcile yet): showing its session makes
		// a new one, swaps it in, then kills the old one; the window keeps its three panes.
		assert.equal(d.request({ type: "select", session: b.id }).ok, true);
		const old = d.nvimSlot();
		assert.equal(old.session, b.id);
		d.tmux(["set-option", "-p", "-t", old.pane, "@pi_fleet_exited", "0"]);
		assert.equal(d.request({ type: "select", session: b.id }).ok, true);
		const fresh = d.nvimSlot();
		assert.notEqual(fresh.pane, old.pane);
		assert.deepEqual([fresh.role, fresh.session], ["nvim", b.id]);
		assert.equal(d.slot().pane, b.pane);
		assert.ok(!d.panes().some((p) => p.pane === old.pane), "the dead nvim is gone");
		assert.equal(right().length, 4);

		// The pi slot vanishes (the left column left): the list's reconcile puts a full-height right pane back.
		const reconcile = () => process.kill(Number(d.tmux(["show", "-gv", "@deck_tui_pid"])), "SIGUSR2");
		const shape = async () => {
			await waitFor("four panes again", () => right().length === 4);
			const panes = d.panes().filter((p) => p.where.startsWith("deck:"));
			const [lw, nw, tw, pw] = panes.map((p) => p.width);
			assert.ok(lw === nw && nw === tw, "list, nvim and terminal slots share the left column");
			assert.equal(panes[3]!.height, Number(d.tmux(["display-message", "-p", "-t", "=deck:=deck", "#{window_height}"])), "the right pane is full height");
			assert.equal(d.tmux(["display-message", "-p", "-t", "=deck:=deck.3", "#{pane_at_right} #{pane_at_left}"]), "1 0");
			assert.equal(d.tmux(["display-message", "-p", "-t", "=deck:=deck.2", "#{pane_at_left} #{pane_at_bottom}"]), "1 1");
			assert.ok(pw! > 1);
			assert.equal(d.list().role, "list");
		};
		d.tmux(["kill-pane", "-t", "=deck:=deck.3"]);
		reconcile();
		await shape();
		// The terminal slot vanishes: back under the nvim slot. Both: both back.
		d.tmux(["kill-pane", "-t", "=deck:=deck.2"]);
		reconcile();
		await shape();
		d.tmux(["kill-pane", "-t", "=deck:=deck.3", ";", "kill-pane", "-t", "=deck:=deck.2"]);
		reconcile();
		await shape();
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
		d.tmux(["set", "-g", "@deck_jump", "%999"]);
		await d.attachDirect("h");
		assert.equal(d.tryTmux(["show", "-gv", "@deck_outer"]) ?? "", "", "a direct attach is no popup");
		assert.equal(d.tryTmux(["show", "-gv", "@deck_jump"]) ?? "", "", "a leftover @deck_jump is cleared at attach");
		const settled = (w: number) =>
			waitFor(`pool at the slot sizes for width ${w}`, () => {
				const slot = d.slot();
				const nvimSlot = d.nvimSlot();
				const pool = d.panes().filter((p) => p.where.startsWith("pool:"));
				const termSlot = d.termSlot();
				const at = (p: Pane, s: Pane) => p.width === s.width && p.height === s.height;
				const slotOf = (role: string) => (role === "nvim" || role === "nvim-holder" ? nvimSlot : role === "term" || role === "term-holder" ? termSlot : slot);
				return slot.width === slotSizeFor(w, slot.height, 50).slot.width && pool.every((p) => at(p, slotOf(p.role)));
			});
		await settled(180);
		writeFileSync(log, "");
		d.tmux(["resize-window", "-t", "h", "-x", "140", "-y", "40"], "h");
		await settled(140);
		const callsNow = () =>
			readFileSync(log, "utf8")
				.split("\n")
				.filter((l) => l.startsWith(`-L ${d.label} `) && /resize-window/.test(l));
		await waitFor("the pool resize-window call", () => callsNow().length >= 1);
		await sleep(300); // negative: no second resize call
		const calls = callsNow();
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

test("nvim quit by hand in the nvim slot: a new nvim for the same pi takes its place", { skip: skipNvim, timeout: 90_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const a = await d.open();
		const old = await waitFor("a's nvim in the nvim slot", () => {
			const n = d.nvimSlot();
			return n.role === "nvim" && n.session === a.id && !n.dead ? n : undefined;
		});
		await waitFor("nvim drawn in its pane", () => d.tmux(["capture-pane", "-p", "-t", old.pane]).includes("~"));
		d.tmux(["send-keys", "-t", old.pane, "Escape", ":qa!", "Enter"]);
		const fresh = await waitFor("a new nvim in the nvim slot", () => {
			const n = d.nvimSlot();
			return n.role === "nvim" && n.pane !== old.pane && !n.dead ? n : undefined;
		});
		assert.equal(fresh.session, a.id);
		assert.equal(fresh.peer, a.pane);
		await waitEq("a's @pi_fleet_peer pointing at the new nvim", () => d.tmux(["show", "-pv", "-t", a.pane, "@pi_fleet_peer"]), fresh.pane);
		await waitFor("the old nvim pane killed", () => !d.panes().some((p) => p.pane === old.pane));
	} finally {
		d.close();
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
		await waitFor("b's nvim gone, the nvim holder below the list", () => d.nvimSlot().role === "nvim-holder");
		// Seen once under load, not reproduced since: on a timeout, say what the panes were.
		await waitFor("b's shell gone, the terminal holder in its slot", () => d.termSlot().role === "term-holder" && !d.panes().some((p) => p.role === "term" && p.session === b.id)).catch((error) => {
			const seen = d.panes().map((p) => `${p.pane} ${p.where} ${p.role || "-"} ${p.session.slice(0, 8) || "-"}${p.dead ? " dead" : ""}`);
			throw new Error(`${(error as Error).message} (b ${b.id.slice(0, 8)}; panes: ${seen.join(", ")})`);
		});
		// a's shell runs a foreground job: it goes with a anyway (killed, never waited for).
		const aTerm = d.panes().find((p) => p.role === "term" && p.session === a.id)!;
		d.tmux(["send-keys", "-t", aTerm.pane, "sleep 1000", "Enter"]);
		await waitEq("a's shell foreground command", () => d.tmux(["display-message", "-p", "-t", aTerm.pane, "#{pane_current_command}"]), "sleep");
		writeFileSync(join(d.stub, `${a.id}.exit`), "0\n");
		await waitFor("a's pane killed", () => !d.panes().some((p) => p.pane === a.pane));
		await waitFor("a's shell killed too", () => !d.panes().some((p) => p.pane === aTerm.pane));
		// The list crashes: restarted in place.
		const pid = d.tmux(["show", "-gv", "@deck_tui_pid"]);
		process.kill(Number(pid), "SIGKILL");
		// The new list publishes @deck_tui_pid (initDeck) before it binds deck.sock: wait for its answer.
		const pid2 = await waitFor("a new list answering on deck.sock", () => {
			const p = d.tryTmux(["show", "-gv", "@deck_tui_pid"]);
			if (!p || p === pid) return undefined;
			const r = d.request({ type: "ping" });
			return r.ok === true && r.pid === Number(p) ? p : undefined;
		});
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
		await waitFor("the respawned list answering on deck.sock", () => d.request({ type: "ping" }).ok === true);
	} finally {
		d.close();
	}
});

test("the holders: a default shell and nvim in $HOME you can type into, kept across rows, respawned after a clean exit", { skip: skipTmux, timeout: 90_000 }, async () => {
	const d = new Deck();
	try {
		// A fake nvim (PI_FLEET_NVIM_CMD): says where it runs, exits 0 on a line `q`.
		const fake = join(d.root, "fake-nvim");
		writeFileSync(fake, '#!/bin/sh\necho "fake-nvim $$ in $(pwd)"\nwhile read l; do [ "$l" = q ] && exit 0; echo "got $l"; done\n');
		chmodSync(fake, 0o755);
		d.env.PI_FLEET_NVIM_CMD = fake;
		d.start();
		const home = join(d.root, "home");
		const cap = (pane: string) => d.tmux(["capture-pane", "-p", "-t", pane]);
		const term = d.termSlot();
		assert.equal(term.role, "term-holder");
		assert.equal(d.tmux(["display-message", "-p", "-t", term.pane, "#{pane_current_path}"]), home);
		// Focusable and typed into like a session's shell (no stty -echo, nothing refocuses the list).
		d.tmux(["select-pane", "-t", "=deck:=deck.2"]);
		assert.equal(d.activeIndex(), "2");
		d.tmux(["send-keys", "-t", term.pane, "X=kept; echo hi$((40+2))", "Enter"]);
		await waitFor("the shell's output", () => cap(term.pane).includes("hi42"));
		const nvim = d.nvimSlot();
		assert.equal(nvim.role, "nvim-holder");
		await waitFor("the fake nvim in $HOME", () => cap(nvim.pane).includes(`in ${home}`));
		d.tmux(["send-keys", "-t", nvim.pane, "abc", "Enter"]);
		await waitFor("the nvim got the line", () => cap(nvim.pane).includes("got abc"));
		// A deck session takes the slots, the holders wait in the pool with their state; back on a non-live row, the same ones.
		const s = await d.open();
		await waitFor("the session's shell in the slot", () => d.termSlot().role === "term" && d.termSlot().session === s.id);
		assert.ok(d.panes().some((p) => p.pane === term.pane && p.where.startsWith("pool:") && !p.dead));
		d.deckCall("d.showHolder()");
		assert.equal(d.termSlot().pane, term.pane);
		assert.equal(d.nvimSlot().pane, nvim.pane);
		d.tmux(["send-keys", "-t", term.pane, "echo X=$X-$((1+1))", "Enter"]);
		await waitFor("the shell kept its state", () => cap(term.pane).includes("X=kept-2"));
		assert.ok(cap(nvim.pane).includes("got abc"), "the nvim too");
		// `exit`: respawned fresh in place (same pane, in the slot, new process).
		const pid = d.tmux(["display-message", "-p", "-t", term.pane, "#{pane_pid}"]);
		d.tmux(["send-keys", "-t", term.pane, "exit", "Enter"]);
		await waitFor("a fresh shell in the terminal slot", () => {
			const t = d.termSlot();
			return t.pane === term.pane && !t.dead && d.tmux(["display-message", "-p", "-t", term.pane, "#{pane_pid}"]) !== pid && !d.tmux(["show", "-pqv", "-t", term.pane, "@pi_fleet_exited"]);
		});
		d.tmux(["send-keys", "-t", term.pane, "echo X=$X-$((2+3))", "Enter"]);
		await waitFor("the new shell answers, without the old state", () => cap(term.pane).includes("X=-5"));
		// The nvim quits cleanly (:qa) while in the pool: respawned there.
		await d.open();
		await waitFor("the nvim holder in the pool", () => d.panes().some((p) => p.pane === nvim.pane && p.where.startsWith("pool:")));
		const npid = d.tmux(["display-message", "-p", "-t", nvim.pane, "#{pane_pid}"]);
		d.tmux(["send-keys", "-t", nvim.pane, "q", "Enter"]);
		await waitFor("a fresh nvim in the pool", () => {
			const p = d.panes().find((q) => q.pane === nvim.pane);
			return p && !p.dead && p.where.startsWith("pool:") && d.tmux(["display-message", "-p", "-t", nvim.pane, "#{pane_pid}"]) !== npid;
		});
		await waitFor("the new nvim runs", () => cap(nvim.pane).includes(`in ${home}`) && !cap(nvim.pane).includes("got abc"));
	} finally {
		d.close();
	}
});

test("the holders' fallbacks: no nvim on PATH → the shell; a shell that fails at start → the dim note, not a loop", { skip: skipTmux, timeout: 60_000 }, async () => {
	const d = new Deck();
	try {
		d.env.PI_FLEET_NVIM_CMD = "pi-fleet-no-such-nvim";
		d.env.SHELL = join(d.root, "failing-shell");
		writeFileSync(d.env.SHELL, "#!/bin/sh\nexit 3\n");
		chmodSync(d.env.SHELL, 0o755);
		d.start();
		const cap = (pane: string) => d.tmux(["capture-pane", "-p", "-t", pane]);
		const term = d.termSlot();
		const nvim = d.nvimSlot();
		await waitFor("the terminal holder's note", () => cap(term.pane).includes("no shell: not a live deck session"));
		await waitFor("the nvim holder (its shell failed too) shows its note", () => cap(nvim.pane).includes("no editor: not a live deck session"));
		await waitEq("the note's sleep runs", () => d.tmux(["display-message", "-p", "-t", term.pane, "#{pane_current_command}"]), "sleep");
		assert.ok(!d.termSlot().dead && !d.nvimSlot().dead);
		assert.deepEqual([d.termSlot().pane, d.nvimSlot().pane], [term.pane, nvim.pane], "not respawned");
	} finally {
		d.close();
	}
	const e = new Deck();
	try {
		e.env.PI_FLEET_NVIM_CMD = "pi-fleet-no-such-nvim";
		e.start();
		const nvim = e.nvimSlot();
		e.tmux(["send-keys", "-t", nvim.pane, "echo shell-$((3+4))", "Enter"]);
		await waitFor("no nvim: the nvim holder runs the shell", () => e.tmux(["capture-pane", "-p", "-t", nvim.pane]).includes("shell-7"));
	} finally {
		e.close();
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

test("attaching never points ~/.ssh/ssh_auth_sock at itself", { skip: skipTmux, timeout: 60_000 }, async () => {
	const d = new Deck();
	const agent = createServer(() => {});
	try {
		const agentSock = join(d.root, "agent.sock");
		await new Promise<void>((r) => agent.listen(agentSock, r));
		const link = join(d.root, "home", ".ssh", "ssh_auth_sock");
		mkdirSync(join(d.root, "home", ".ssh"), { recursive: true });
		symlinkSync(agentSock, link);
		d.start();
		await d.attachDirect("h");
		assert.equal(d.tmux(["show-environment", "SSH_AUTH_SOCK"]), `SSH_AUTH_SOCK=${link}`, "the attach exported the link");
		// The client-attached hook runs in the background; give it time, and a second attach.
		await sleep(300);
		await d.attachDirect("h2");
		await sleep(300);
		assert.equal(readlinkSync(link), agentSock);
	} finally {
		agent.close();
		d.close();
	}
});

test("select of an exited pi (not yet reconciled) is refused and leaves the slot alone", { skip: skipTmux, timeout: 60_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const a = await d.open();
		const b = await d.open();
		await waitEq("the slot showing b's pi", () => d.slot().pane, b.pane);
		// What POOL_WRAP sets when pi exits, without the SIGUSR2 that would reconcile it.
		d.tmux(["set-option", "-p", "-t", a.pane, "@pi_fleet_exited", "0"]);
		const r = d.request({ type: "select", session: a.id });
		assert.equal(r.ok, false);
		assert.match(String(r.error), /has exited/);
		assert.equal(d.slot().pane, b.pane);
	} finally {
		d.close();
	}
});

test("pi-deck-attach in an ordinary pane is refused; stand-in q detaches only the client that typed it", { skip: skipTmux, timeout: 60_000 }, async () => {
	const d = new Deck();
	try {
		const out = join(d.root, "attach.out");
		d.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "p", `${attachBin} >${out} 2>&1; echo "rc=$?" >>${out}; sleep 600`], "pane");
		await waitFor("pi-deck-attach in a pane", () => readFileSync(out, "utf8").includes("rc="));
		assert.match(readFileSync(out, "utf8"), /inside a tmux pane[\s\S]*rc=1/);
		assert.equal(d.tryTmux(["has-session", "-t", "=deck"]), undefined, "no deck started");

		// The phase-1 stand-in list (no pi-tui for the list TUI).
		const started = d.cli(["deck-start"], { PI_FLEET_PI_PACKAGES: join(d.root, "no-packages") });
		assert.equal(started.code, 0, started.err);
		await d.attachDirect("h");
		await d.attachDirect("h2");
		const clientOf = (suffix: string) => d.tmux(["display-message", "-p", "-t", "h", "#{pane_tty}"], suffix);
		await waitFor("the stand-in list drawn", () => /stand-in list/.test(d.tmux(["capture-pane", "-p", "-t", "=deck:=deck.0"])));
		d.tmux(["select-pane", "-t", "=deck:=deck.0"]);
		d.tmux(["send-keys", "-t", "h", "q"], "h2");
		await waitFor("one client detached", () => d.tmux(["list-clients", "-F", "#{client_tty}"]).split("\n").filter(Boolean).length === 1);
		assert.equal(d.tmux(["list-clients", "-F", "#{client_tty}"]), clientOf("h"), "the other client stays");
	} finally {
		d.close();
	}
});

test("kill-deck leaves the deck running for an nvim with unsaved changes unless told", { skip: skipNvim, timeout: 90_000 }, async () => {
	const d = new Deck();
	try {
		d.start();
		const s = await d.open();
		const ctl = createServer((sock) => {
			sock.setEncoding("utf8");
			sock.on("data", () => {
				sock.end(`${JSON.stringify({ ok: true })}\n`);
				writeFileSync(join(d.stub, `${s.id}.exit`), "0\n");
			});
		});
		await new Promise<void>((r) => ctl.listen(join(d.root, "run", `${s.id}.pi.sock`), r));
		try {
			const pair = d.cli(["pair", "--deck", s.pane, "--json"]);
			assert.equal(pair.code, 0, pair.err);
			const nvim = JSON.parse(pair.out);
			const nvimPane: string = nvim.nvimPane;
			await waitFor("nvim up", () => existsSync(nvim.nvimSock));
			d.tmux(["send-keys", "-t", nvimPane, "i", "unsaved", "Escape"]);
			await waitFor("buffer modified", () => {
				const r = spawnSync("nvim", ["--server", nvim.nvimSock, "--remote-expr", "&modified"], { encoding: "utf8", timeout: 10000 });
				return r.stdout.trim() === "1";
			});
			const r = (await d.deckCallAsync("d.killDeck({ waitMs: 5000 })")) as { killedServer: boolean; nvims: { pane: string }[]; asked: string[] };
			assert.deepEqual(r.asked, [s.id], JSON.stringify(r));
			assert.equal(r.killedServer, false);
			assert.deepEqual(r.nvims.map((n) => n.pane), [nvimPane]);
			assert.ok(d.tryTmux(["has-session", "-t", "=deck"]) !== undefined, "the deck still runs");
			const child = spawn(cliBin, ["kill-deck", "--yes"], { env: d.env, stdio: ["ignore", "pipe", "pipe"] });
			let err = "";
			child.stderr.on("data", (b) => (err += b));
			assert.equal(await new Promise<number | null>((r) => child.once("exit", r)), 0, err);
			assert.match(err, /1 nvim\(s\) still open/);
			assert.equal(d.tryTmux(["has-session", "-t", "=deck"]), undefined);
		} finally {
			ctl.close();
		}
	} finally {
		d.close();
	}
});

// ---------------------------------------------------------------- keys through the popup

test("popup: attach, C-h/j/k/l between the panes, prefix C-<key>, Shift+Enter, prefix e, prefix z, prefix g", { skip: skipNvim, timeout: 120_000 }, async () => {
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
		// tmux 3.2a (no -B) caps a 100% popup at the client less one column and one row, and draws its border inside.
		const [cw, ch] = popupBorderless() ? [160, 48] : [157, 45];
		assert.equal(deckClientSize, `${cw}x${ch}`, "the whole 160x48 client, minus the popup border if any");
		const sizes = deckSizesFor(cw, ch, 50);
		const at = (p: Pane, z: { width: number; height: number }) => p.width === z.width && p.height === z.height;
		const pool = (p: Pane, ...roles: string[]) => p.where.startsWith("pool:") && roles.includes(p.role);
		await waitFor("slots and pool at the popup's slot sizes", () =>
			d.panes().every((p) => {
				if (p.where === "deck:deck.0") return at(p, sizes.list);
				if (p.where === "deck:deck.1" || pool(p, "nvim", "nvim-holder")) return at(p, sizes.nvim);
				if (p.where === "deck:deck.2" || pool(p, "term", "term-holder")) return at(p, sizes.term);
				if (p.where === "deck:deck.3" || p.where.startsWith("pool:")) return at(p, sizes.pi);
				return true;
			}),
		);
		await sleep(300); // baseline for the negative SIGWINCH check
		const winch0 = d.file(s.id, "winch");
		const nvim = d.nvimSlot();
		assert.equal(nvim.role, "nvim");
		assert.equal(nvim.session, s.id);
		assert.equal(nvim.peer, s.pane);

		// Focus the list, then C-l (the list's own: focus the session's pi).
		d.tmux(["select-pane", "-t", "=deck:=deck.0"]);
		h.keys("C-l");
		await waitFor("pi slot focused", () => d.activeIndex() === "3");
		// Shift+Enter reaches the pool pi byte-exact.
		h.hex("1b 5b 31 33 3b 32 75");
		await waitFor("Shift+Enter in the pi", () => d.file(s.id, "keys").includes("\x1b[13;2u"));
		// In the pi C-j and C-k are the pi's (nothing above or below it); C-l too (at the right edge).
		h.keys("C-j");
		await waitFor("C-j in the pi", () => d.file(s.id, "keys").endsWith("\n"));
		h.keys("C-k");
		await waitFor("C-k in the pi", () => d.file(s.id, "keys").endsWith("\x0b"));
		h.keys("C-l");
		await waitFor("C-l in the pi", () => d.file(s.id, "keys").endsWith("\x0c"));
		assert.equal(d.activeIndex(), "3");
		// C-h: back to the list; the pi gets nothing, the outer root C-h does not fire.
		const keysBefore = d.file(s.id, "keys");
		h.keys("C-h");
		await waitFor("list focused", () => d.activeIndex() === "0");
		assert.equal(d.file(s.id, "keys"), keysBefore);
		assert.equal(d.tryTmux(["show", "-gv", "@outer_ch"], "outer") ?? "", "");
		// List: C-j down to the nvim; nvim: C-k up to the list, C-l right to the pi; C-h in the nvim stays there.
		h.keys("C-j");
		await waitFor("nvim slot focused (C-j)", () => d.activeIndex() === "1");
		h.keys("C-k");
		await waitFor("list focused (C-k)", () => d.activeIndex() === "0");
		h.keys("C-j");
		await waitFor("nvim slot focused", () => d.activeIndex() === "1");
		h.keys("C-h");
		await sleep(300);
		assert.equal(d.activeIndex(), "1", "C-h at the left edge goes to nvim");
		// nvim: C-j down to the shell; the shell: C-h and C-j are its own (left and bottom edges), C-k up to
		// the nvim, C-l right to the pi.
		const term = d.termSlot();
		assert.deepEqual([term.role, term.session], ["term", s.id]);
		const typed = join(d.root, "term-keys");
		d.tmux(["send-keys", "-t", term.pane, `stty raw -echo; cat > ${typed}`, "Enter"]);
		await waitEq("the shell's foreground command", () => d.tmux(["display-message", "-p", "-t", term.pane, "#{pane_current_command}"]), "cat");
		h.keys("C-j");
		await waitFor("terminal slot focused (C-j)", () => d.activeIndex() === "2");
		h.keys("C-h", "C-j");
		await waitFor("C-h and C-j in the shell", () => existsSync(typed) && readFileSync(typed, "latin1").includes("\x08\n"));
		assert.equal(d.activeIndex(), "2");
		h.keys("C-k");
		await waitFor("nvim slot focused (C-k from the shell)", () => d.activeIndex() === "1");
		h.keys("C-j");
		await waitFor("terminal slot focused", () => d.activeIndex() === "2");
		h.keys("C-l");
		await waitFor("pi slot focused (C-l from the shell)", () => d.activeIndex() === "3");
		d.tmux(["select-pane", "-t", "=deck:=deck.1"]);
		h.keys("C-l");
		await waitFor("pi slot focused (C-l)", () => d.activeIndex() === "3");
		// prefix C-h / prefix h: a literal C-h to the pi.
		h.keys("C-s", "C-h");
		await waitFor("literal C-h in the pi", () => d.file(s.id, "keys").endsWith("\x08"));
		const n = d.file(s.id, "keys").length;
		h.keys("C-s", "h");
		await waitFor("literal C-h in the pi (prefix h)", () => d.file(s.id, "keys").length > n && d.file(s.id, "keys").endsWith("\x08"));
		assert.equal(d.activeIndex(), "3");

		// prefix e: pi slot <-> nvim slot (from the list: the nvim).
		h.keys("C-s", "e");
		await waitFor("nvim focused (prefix e)", () => d.activeIndex() === "1");
		h.keys("C-s", "e");
		await waitFor("pi focused (prefix e)", () => d.activeIndex() === "3");
		h.keys("C-h");
		await waitFor("list focused", () => d.activeIndex() === "0");
		h.keys("C-s", "e");
		await waitFor("nvim from the list (prefix e)", () => d.activeIndex() === "1");
		// prefix z zooms the focused pane; C-l from a zoomed nvim is nvim's own (it is at every edge).
		h.keys("C-s", "z");
		await waitFor("zoomed", () => d.tmux(["display-message", "-p", "-t", "=deck:=deck", "#{window_zoomed_flag}"]) === "1");
		h.keys("C-s", "z");
		await waitFor("unzoomed", () => d.tmux(["display-message", "-p", "-t", "=deck:=deck", "#{window_zoomed_flag}"]) === "0");
		await sleep(300);
		assert.equal(d.file(s.id, "winch"), winch0, "no SIGWINCH in the pi from moving between panes");

		// Another session shows its own pi and nvim; selecting s brings s's nvim back (no new one).
		const other = d.request({ type: "open", cwd: d.work, focus: false });
		assert.equal(other.ok, true);
		await waitFor("the other session's nvim", () => d.nvimSlot().session === other.session && d.nvimSlot().role === "nvim");
		assert.equal(d.slot().session, other.session);
		assert.deepEqual([d.termSlot().role, d.termSlot().session], ["term", other.session]);
		d.request({ type: "select", session: s.id });
		assert.equal(d.slot().pane, s.pane);
		assert.equal(d.nvimSlot().pane, nvim.pane, "selecting the session shows its nvim again");
		assert.equal(d.termSlot().pane, term.pane, "and its shell");
		assert.equal(d.panes().filter((p) => p.role === "nvim").length, 2);

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
