// The dashboard (design §9; phase 4): SessionsView full-screen with a live preview.
//   - preview plumbing: control-character stripping, gone-vs-slow classification, capture-pane
//     against a throwaway tmux pane (and fake tmux binaries for the slow cases);
//   - headless dashboard render with a fake preview (frame, gone, slow keeps the last frame);
//   - end to end: `pi-fleet dashboard` in a throwaway tmux server (`tmux -L fleettest-…`; the
//     harness refuses the default socket and the CLI runs with PI_FLEET_TMUX_GUARD=1) on the
//     fixture sessions dir, with the stub pi of the CLI tests.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { locatePiPackages, usePiPackages } from "../../pi/extensions/fleet/cli.ts";
import { IDS, buildFixture, plainStyle, type Fixture } from "./support/sessions-fixture.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../..");
const cliBin = join(repo, "bin/pi-fleet");
const stubPi = join(here, "support/stub-pi.sh");
const packages = locatePiPackages();
const haveTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const skip = packages ? false : "pi's pi-tui not found (pi not on PATH)";
const skipTmux = skip || (haveTmux ? false : "tmux not found");

let sv: typeof import("../../pi/extensions/fleet/sessions-view.ts");
let tui: typeof import("@earendil-works/pi-tui");
let fx: Fixture;

before(async () => {
	fx = buildFixture();
	if (!packages) return;
	await usePiPackages(packages);
	sv = await import("../../pi/extensions/fleet/sessions-view.ts");
	tui = await import("@earendil-works/pi-tui");
});
after(() => fx.cleanup());

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** agent-deck's default_socket_guard idea: tmux args must name a throwaway socket. */
function guardTmuxArgs(args: string[]): void {
	if ((args[0] !== "-L" && args[0] !== "-S") || !args[1] || basename(args[1]) === "default") {
		throw new Error(`test harness refuses tmux without a throwaway socket: ${args.join(" ")}`);
	}
}

// ---------------------------------------------------------------- preview plumbing

test("stripControlPreserveSgr keeps SGR, drops other escapes and control characters", { skip }, () => {
	const raw = "\x1b[1;32mok\x1b[0m\x1b[2K\x1b]8;;http://x\x07link\x1b]8;;\x1b\\\x07\ta\x00b\x1b(B\x1b[38:5:1mz";
	assert.equal(sv.stripControlPreserveSgr(raw), "\x1b[1;32mok\x1b[0mlink ab\x1b[38:5:1mz");
	assert.deepEqual(sv.previewLines("a\nb\n\x1b[0m\n\n", 5), ["a", "b"]);
	assert.deepEqual(sv.previewLines("1\n2\n3\n4\n", 2), ["3", "4"]);
});

test("gone vs slow: tmux's can't-find/no-server errors are gone, anything else is not", { skip }, () => {
	for (const m of ["can't find pane: %9", "can't find session: x", "no server running on /tmp/x", "error connecting to /tmp/x (No such file or directory)"]) {
		assert.equal(sv.isGoneError(m), true, m);
	}
	for (const m of ["Command failed: tmux", "server version is too old", ""]) assert.equal(sv.isGoneError(m), false, m);
});

test("capturePane: a timeout or an unknown error is slow, never gone", { skip }, async () => {
	const bin = join(fx.root, "fakebin");
	mkdirSync(bin, { recursive: true });
	const env = (script: string) => {
		writeFileSync(join(bin, "tmux"), `#!/bin/sh\n${script}\n`);
		chmodSync(join(bin, "tmux"), 0o755);
		return { ...fx.env, PATH: `${bin}:${process.env.PATH}` };
	};
	const opts = { socket: join(fx.root, "fake.sock") };
	assert.deepEqual(await sv.capturePane("%1", 5, { ...opts, env: env("sleep 5"), timeoutMs: 300 }), { kind: "slow", reason: "timeout" });
	assert.deepEqual(await sv.capturePane("%1", 5, { ...opts, env: env("echo 'lost connection' >&2; exit 1") }), { kind: "slow", reason: "lost connection" });
	assert.equal((await sv.capturePane("%1", 5, { ...opts, env: env("echo \"can't find pane: %1\" >&2; exit 1") })).kind, "gone");
	// The harness guard: the default socket is refused (as slow: nothing was captured).
	const guarded = await sv.capturePane("%1", 5, { socket: "/tmp/tmux-1/default", env: fx.env });
	assert.equal(guarded.kind, "slow");
});

// ---------------------------------------------------------------- headless dashboard

function dashboard(height: number, preview: (row: { id: string }) => Promise<import("../../pi/extensions/fleet/sessions-view.ts").PreviewResult> | undefined) {
	const view = new sv.SessionsView({
		source: sv.fleetSource(fx.env),
		style: plainStyle,
		height: () => height,
		onAction: () => {},
		requestRender: () => {},
		preview,
		now: () => fx.now,
		host: "node1",
	});
	view.refresh();
	return view;
}

test("dashboard render: list | preview side by side, exactly the screen height", { skip }, async () => {
	let result: import("../../pi/extensions/fleet/sessions-view.ts").PreviewResult = { kind: "frame", lines: ["\x1b[32m● bash\x1b[0m  squeue -u $USER", "  8812345 RUNNING", "> "] };
	const asked: string[] = [];
	const view = dashboard(16, (row) => {
		asked.push(row.id);
		return Promise.resolve(result);
	});
	view.handleInput("/");
	for (const ch of "sweep") view.handleInput(ch);
	view.handleInput("\x1b");
	await view.updatePreview();
	assert.equal(asked.at(-1), IDS.sweep);
	let lines = view.render(130);
	assert.equal(lines.length, 16);
	for (const l of lines) assert.ok(tui.visibleWidth(l) <= 130, JSON.stringify(l));
	let plain = lines.map(strip);
	assert.match(plain[1]!, /▾ alpha \(1\) +│── physicsnemo sweep · %\d* /);
	assert.match(plain[2]!, /^›  ● physicsnemo sweep .*│● bash  squeue -u \$USER/);
	assert.match(plain[3]!, /│  8812345 RUNNING/);
	assert.ok(lines[2]!.includes("\x1b[32m● bash"), "the preview keeps SGR");

	// slow (timeout): the last frame stays, marked
	result = { kind: "slow", reason: "timeout" };
	await view.updatePreview();
	plain = view.render(130).map(strip);
	assert.match(plain[1]!, /physicsnemo sweep · .* · slow, last frame/);
	assert.match(plain[2]!, /│● bash  squeue/);

	// gone: says so, and shows the last assistant message instead
	result = { kind: "gone", reason: "can't find pane: %12" };
	await view.updatePreview();
	plain = view.render(130).map(strip);
	assert.ok(plain.some((l) => /│ pane .* is gone \(can't find pane: %12\)/.test(l)));
	assert.ok(plain.some((l) => l.endsWith("│ sweeping")));
});

test("dashboard render: a row that is not running previews its last message; remote rows say where", { skip }, async () => {
	const view = dashboard(14, () => undefined);
	view.handleInput("/");
	for (const ch of "old run") view.handleInput(ch);
	view.handleInput("\x1b");
	let plain = view.render(130).map(strip);
	assert.ok(plain.some((l) => l.includes("│ not running · last active 3h ago")));
	assert.ok(plain.some((l) => l.includes("│ subagents: 1✓ 1 interrupted")));
	assert.ok(plain.some((l) => l.includes("│ the old run finished")));
	view.handleInput("\x1b");
	view.handleInput("/");
	for (const ch of "notes") view.handleInput(ch);
	view.handleInput("\x1b");
	plain = view.render(130).map(strip);
	assert.ok(plain.some((l) => l.includes("│ running on other-node: no preview from this node")));
});

test("dashboard render: narrow screens stack the preview under the list", { skip }, () => {
	const view = dashboard(20, () => undefined);
	const plain = view.render(80).map(strip);
	assert.equal(plain.length, 20);
	const rule = plain.findIndex((l) => l.startsWith("── "));
	assert.ok(rule > 3 && rule < 19, `preview rule at ${rule}`);
	assert.ok(!plain.some((l) => l.includes("│")));
});

// ---------------------------------------------------------------- end to end

let serial = 0;
class Server {
	readonly label = `fleettest-dash-${process.pid}-${++serial}`;
	readonly env: NodeJS.ProcessEnv;
	socket: string;
	constructor(extra: NodeJS.ProcessEnv) {
		mkdirSync(join(fx.root, "stub"), { recursive: true });
		this.env = {
			...fx.env,
			PATH: `${join(repo, "bin")}:${process.env.PATH}`,
			PI_FLEET_PI_CMD: stubPi,
			PI_FLEET_NVIM_CMD: "true",
			PI_FLEET_STUB_DIR: join(fx.root, "stub"),
			PI_FLEET_PI_PACKAGES: packages,
			SHELL: "/bin/sh",
			...extra,
		};
		this.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "main", "-x", "160", "-y", "40", "sh"]);
		this.socket = this.tmux(["display-message", "-p", "#{socket_path}"]);
		assert.notEqual(basename(this.socket), "default");
		this.env.PI_FLEET_TMUX_SOCKET = this.socket;
		// New windows get the test env from the server's global environment.
		this.tmux(["set-environment", "-g", "PI_FLEET_TMUX_SOCKET", this.socket]);
	}
	tmux(args: string[]): string {
		const full = ["-L", this.label, ...args];
		guardTmuxArgs(full);
		const env = { ...this.env };
		delete env.PI_FLEET_TMUX_SOCKET;
		return execFileSync("tmux", full, { env, encoding: "utf8" }).replace(/\n$/, "");
	}
	capture(pane: string): string {
		try {
			return this.tmux(["capture-pane", "-p", "-t", pane]);
		} catch {
			return "";
		}
	}
	alive(pane: string): boolean {
		return this.tmux(["list-panes", "-a", "-F", "#{pane_id}"]).split("\n").includes(pane);
	}
	/** Keys one by one, pausing after Escape (Escape + a quick key would read as Alt+key). */
	async keys(pane: string, ...keys: string[]): Promise<void> {
		for (const k of keys) {
			this.tmux(["send-keys", "-t", pane, k]);
			if (k === "Escape") await new Promise((r) => setTimeout(r, 300));
		}
	}
	type(pane: string, text: string): void {
		this.tmux(["send-keys", "-t", pane, "-l", text]);
	}
	kill(): void {
		try {
			this.tmux(["kill-server"]);
		} catch {
			// gone
		}
	}
}

test("e2e: the dashboard lists the fixture, previews a live pane, notices it gone, opens a session", { skip: skipTmux, timeout: 60_000 }, async () => {
	const server = new Server({});
	try {
		const live = server.tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "printf '\\033[32mGREEN\\033[0m live pane\\n> prompt\\n'; exec sleep 600"]);
		const status = JSON.parse(readFileSync(join(fx.statusDir, `${IDS.sweep}.json`), "utf8"));
		status.tmux = { socket: server.socket, piPane: live };
		status.heartbeat = new Date().toISOString();
		fx.writeStatus(IDS.sweep, status);

		const dash = server.tmux(["new-window", "-P", "-F", "#{pane_id}", "--", cliBin, "dashboard"]);
		await waitFor("the dashboard header", () => server.capture(dash).includes("pi-fleet"));
		const screen = server.capture(dash);
		assert.match(screen, /▾ gamma \(2\)/);
		assert.match(screen, /\? flare refactor/);
		assert.match(screen, /⇢ notes/);
		assert.ok(!screen.includes("coder /runner"), "subagent sessions are not rows");

		server.type(dash, "/sweep");
		await server.keys(dash, "Escape");
		await waitFor("the live preview", () => server.capture(dash).includes("GREEN live pane"));
		const colored = server.tmux(["capture-pane", "-p", "-e", "-t", dash]);
		assert.match(colored, /\x1b\[32mGREEN/);

		server.tmux(["kill-pane", "-t", live]);
		await waitFor("the gone preview", () => /pane %\d+ is gone/.test(server.capture(dash)));

		// Enter on a session that is not running: `pi-fleet open --session FILE` in a new window.
		// This window is not the `fleet` window (no @pi_fleet_dashboard), so like the popup the
		// dashboard quits once focus moved.
		await server.keys(dash, "Escape");
		server.type(dash, "/old run");
		await server.keys(dash, "Enter");
		const runs = join(fx.root, "stub", `${IDS.old}.runs`);
		await waitFor("the stub pi of the opened session", () => existsSync(runs)).catch((error) => {
			throw new Error(`${error.message}\n${server.capture(dash)}\n${server.tmux(["list-panes", "-a", "-F", "#{pane_id} #{pane_current_command}"]).split("\n").map((l) => `${l}\n${server.capture(l.split(" ")[0]!)}`).join("\n")}`);
		});
		assert.match(readFileSync(runs, "utf8"), new RegExp(`--session ${fx.files.old.replace(/[.]/g, "\\.")}`));
		await waitFor("the dashboard to quit", () => !server.alive(dash));
	} finally {
		server.kill();
	}
});

test("e2e: `dashboard --window` makes the fleet window; q goes back, the dashboard keeps running", { skip: skipTmux, timeout: 60_000 }, async () => {
	const server = new Server({});
	try {
		const first = server.tmux(["display-message", "-p", "-t", "main", "#{window_id}"]);
		const other = server.tmux(["new-window", "-P", "-F", "#{window_id}", "sh"]);
		const r = spawnSync(cliBin, ["dashboard", "--window"], { env: server.env, encoding: "utf8", timeout: 20_000 });
		assert.equal(r.status, 0, r.stderr);
		const fleet = server.tmux(["display-message", "-p", "-t", "main", "#{window_id}"]);
		assert.notEqual(fleet, other);
		assert.notEqual(fleet, first);
		assert.equal(server.tmux(["show-options", "-wqv", "-t", fleet, "@pi_fleet_dashboard"]), "1");
		const pane = server.tmux(["display-message", "-p", "-t", fleet, "#{pane_id}"]);
		await waitFor("the dashboard in the fleet window", () => server.capture(pane).includes("pi-fleet"));
		await server.keys(pane, "q");
		await waitFor("last-window", () => server.tmux(["display-message", "-p", "-t", "main", "#{window_id}"]) === other);
		assert.ok(server.alive(pane), "the dashboard keeps running in its window");
		await server.keys(pane, "C-c");
		await waitFor("ctrl+c quits", () => !server.alive(pane));
	} finally {
		server.kill();
	}
});

// ---------------------------------------------------------------- phase 4 review fixes

test("dashboard: a pi-tui that fails to import falls back to the plain list", { timeout: 30_000 }, () => {
	const broken = join(fx.root, "broken", "node_modules");
	mkdirSync(join(broken, "@earendil-works", "pi-tui"), { recursive: true });
	writeFileSync(join(broken, "@earendil-works", "pi-tui", "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", exports: "./index.js" }));
	writeFileSync(join(broken, "@earendil-works", "pi-tui", "index.js"), 'throw new Error("broken pi-tui");\n');
	// No tmux server is contacted: tmux is a stub that fails, the socket a path in the fixture.
	const bin = join(fx.root, "nobin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "tmux"), "#!/bin/sh\necho 'no server running' >&2\nexit 1\n");
	chmodSync(join(bin, "tmux"), 0o755);
	const env = { ...fx.env, PATH: `${bin}:${process.env.PATH}`, PI_FLEET_PI_PACKAGES: broken, PI_FLEET_TMUX_SOCKET: join(fx.root, "nosuch.sock") };
	// stdin is not a TTY: the plain list draws once and quits.
	const r = spawnSync(cliBin, ["dashboard"], { env, encoding: "utf8", input: "", timeout: 20_000 });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stderr, /^pi-fleet: pi-tui unusable \(.*broken pi-tui.*\); showing ls$/m);
	assert.match(r.stdout, /no pi-tui: plain list/);
	assert.match(r.stdout, /flare refactor/);
});

test("dashboard: previews of rows that are gone are dropped on refresh", { skip }, async () => {
	const row = (id: string) => ({ id, name: id, cwd: "/", repo: "/r", state: "idle", live: "live", at: 0, counts: { working: 0, waiting: 0, done: 0, error: 0 }, status: { tmux: { piPane: "%1" } } });
	let rows = [row("a"), row("b")];
	const view = new sv.SessionsView({
		source: { load: () => rows as never, threads: () => [] },
		style: plainStyle,
		height: () => 20,
		onAction: () => {},
		requestRender: () => {},
		preview: () => Promise.resolve({ kind: "frame", lines: ["x"] }),
		now: () => fx.now,
	});
	view.refresh();
	const previews = (view as unknown as { previews: Map<string, unknown> }).previews;
	const first = view.selectedRow()!.id;
	await view.updatePreview();
	assert.ok(previews.has(first));
	rows = rows.filter((r) => r.id !== first);
	view.refresh();
	assert.ok(!previews.has(first));
	assert.equal(previews.size, 0);
});

// ---------------------------------------------------------------- ctrl+l: a session's pi in the dashboard window

/** Two live sessions in their own windows: sweep (pi | nvim, paired) and ckpt (pi alone). */
function liveSessions(server: Server) {
	const opt = (pane: string, ...kv: string[]) => {
		for (let i = 0; i < kv.length; i += 2) server.tmux(["set-option", "-p", "-t", pane, kv[i]!, kv[i + 1]!]);
	};
	const [sweepPi, sweepWin] = server.tmux(["new-window", "-d", "-n", "sweepwin", "-P", "-F", "#{pane_id} #{window_id}", "printf 'SWEEP PI\\n'; exec sleep 600"]).split(" ") as [string, string];
	const nvim = server.tmux(["split-window", "-d", "-h", "-l", "50%", "-t", sweepPi, "-P", "-F", "#{pane_id}", "printf 'SWEEP NVIM\\n'; exec sleep 600"]);
	opt(sweepPi, "@pi_fleet_role", "pi", "@pi_fleet_session", IDS.sweep, "@pi_fleet_peer", nvim);
	opt(nvim, "@pi_fleet_role", "nvim", "@pi_fleet_session", IDS.sweep, "@pi_fleet_peer", sweepPi);
	server.tmux(["set-option", "-w", "-t", sweepWin, "@pi_fleet_named", "1"]);
	const [ckptPi, ckptWin] = server.tmux(["new-window", "-d", "-n", "ckptwin", "-P", "-F", "#{pane_id} #{window_id}", "printf 'CKPT PI\\n'; exec sleep 600"]).split(" ") as [string, string];
	opt(ckptPi, "@pi_fleet_role", "pi", "@pi_fleet_session", IDS.ckpt);
	const heartbeat = new Date().toISOString();
	for (const [id, pane] of [[IDS.sweep, sweepPi], [IDS.ckpt, ckptPi]] as const) {
		const status = JSON.parse(readFileSync(join(fx.statusDir, `${id}.json`), "utf8"));
		fx.writeStatus(id, { ...status, tmux: { socket: server.socket, piPane: pane }, heartbeat });
	}
	return { sweepPi, sweepWin, nvim, ckptPi, ckptWin };
}

const fmt = (server: Server, target: string, format: string) => server.tmux(["display-message", "-p", "-t", target, format]);

test("e2e: ctrl+l joins a live session's pi beside the dashboard; switching, q, ctrl+c, Enter and a killed dashboard send it home", { skip: skipTmux, timeout: 120_000 }, async () => {
	const server = new Server({});
	try {
		const s = liveSessions(server);
		const start = server.tmux(["display-message", "-p", "-t", "main", "#{window_id}"]);
		const openDashboard = async () => {
			const r = spawnSync(cliBin, ["dashboard", "--window", "--pane", fmt(server, "main:", "#{pane_id}")], { env: server.env, encoding: "utf8", timeout: 20_000 });
			assert.equal(r.status, 0, r.stderr);
			const fleet = server.tmux(["list-windows", "-F", "#{window_id} #{@pi_fleet_dashboard}"]).split("\n").find((l) => l.endsWith(" 1"))!.split(" ")[0]!;
			const dash = fmt(server, fleet, "#{pane_id}");
			await waitFor("the dashboard", () => server.capture(dash).includes("▾ alpha"));
			return { fleet, dash };
		};
		const select = async (dash: string, name: string) => {
			// `/`, ctrl+u (drops the last filter), the name, Escape (stop typing).
			server.type(dash, "/");
			await server.keys(dash, "C-u");
			server.type(dash, name);
			await server.keys(dash, "Escape");
			await waitFor(`${name} selected`, () => new RegExp(`^›.*${name}`, "m").test(server.capture(dash)));
		};
		const windowOf = (pane: string) => fmt(server, pane, "#{window_id}");
		const homeAgain = async (pane: string, window: string) => {
			await waitFor(`${pane} home in ${window}`, () => server.alive(pane) && windowOf(pane) === window && !fmt(server, pane, "#{@pi_fleet_joined}"));
			assert.equal(fmt(server, pane, "#{@pi_fleet_home}"), "");
		};
		let { fleet, dash } = await openDashboard();

		// ctrl+l on sweep: its pi joins the fleet window on the right, ~60%, marked, focused.
		await select(dash, "physicsnemo sweep");
		await server.keys(dash, "C-l");
		await waitFor("sweep joined", () => windowOf(s.sweepPi) === fleet);
		assert.equal(fmt(server, s.sweepPi, "#{@pi_fleet_joined}"), fleet);
		assert.equal(fmt(server, s.sweepPi, "#{@pi_fleet_home}"), s.sweepWin);
		assert.equal(fmt(server, s.sweepPi, "#{pane_active}"), "1");
		assert.ok(Number(fmt(server, s.sweepPi, "#{pane_left}")) > Number(fmt(server, dash, "#{pane_left}")), "on the right");
		const width = Number(fmt(server, s.sweepPi, "#{pane_width}"));
		assert.ok(width >= 90 && width <= 100, `~60% of 160: ${width}`);
		// The dashboard re-lays out for its narrower pane: the list only, the joined row marked.
		await waitFor("the joined layout", () => /⇥ ● physicsnemo sweep/.test(server.capture(dash)) && !server.capture(dash).includes("│"));
		// nvim pairing still resolves from the joined pane; bar renames the home window, not the fleet window.
		assert.equal(spawnSync(cliBin, ["peer", s.sweepPi], { env: server.env, encoding: "utf8" }).stdout.trim(), s.nvim);
		spawnSync(cliBin, ["bar"], { env: server.env, encoding: "utf8", timeout: 20_000 });
		assert.equal(fmt(server, fleet, "#{window_name}"), "fleet");
		assert.equal(fmt(server, s.sweepWin, "#{window_name}"), "● physicsnemo sweep");

		// Back in the list (what C-h does), ctrl+l on the same session only focuses it.
		server.tmux(["select-pane", "-t", dash]);
		await server.keys(dash, "C-l");
		await waitFor("sweep focused", () => fmt(server, s.sweepPi, "#{pane_active}") === "1");
		assert.equal(windowOf(s.sweepPi), fleet);

		// ctrl+l on ckpt: sweep goes home left of its nvim (50/50), then ckpt joins.
		server.tmux(["select-pane", "-t", dash]);
		await select(dash, "ckpt restart");
		await server.keys(dash, "C-l");
		await waitFor("ckpt joined", () => windowOf(s.ckptPi) === fleet);
		await homeAgain(s.sweepPi, s.sweepWin);
		assert.ok(Number(fmt(server, s.sweepPi, "#{pane_left}")) < Number(fmt(server, s.nvim, "#{pane_left}")), "left of nvim");
		const [w1, w2] = [s.sweepPi, s.nvim].map((p) => Number(fmt(server, p, "#{pane_width}")));
		assert.ok(Math.abs(w1! - w2!) <= 1, `50/50: ${w1}/${w2}`);
		assert.equal(spawnSync(cliBin, ["peer", s.sweepPi], { env: server.env, encoding: "utf8" }).stdout.trim(), s.nvim);
		assert.equal(server.tmux(["list-panes", "-t", fleet, "-F", "#{pane_id}"]).split("\n").length, 2);

		// q: ckpt (alone in its window, which closed when it left) goes home to a new window of its own.
		server.tmux(["select-pane", "-t", dash]);
		await server.keys(dash, "q");
		await waitFor("ckpt home", () => windowOf(s.ckptPi) !== fleet && !fmt(server, s.ckptPi, "#{@pi_fleet_joined}"));
		assert.equal(fmt(server, s.ckptPi, "#{window_name}"), "◐ ckpt restart");
		assert.equal(fmt(server, s.ckptPi, "#{@pi_fleet_named}"), "1");
		assert.equal(server.tmux(["list-panes", "-t", fleet, "-F", "#{pane_id}"]), dash);
		assert.notEqual(fmt(server, "main", "#{window_id}"), fleet, "q left the fleet window");

		// Enter on the joined session: home first, then the jump lands in its own window.
		server.tmux(["select-window", "-t", fleet]);
		await select(dash, "physicsnemo sweep");
		await server.keys(dash, "C-l");
		await waitFor("sweep joined again", () => windowOf(s.sweepPi) === fleet);
		server.tmux(["select-pane", "-t", dash]);
		await server.keys(dash, "Enter");
		await homeAgain(s.sweepPi, s.sweepWin);
		await waitFor("the jump", () => fmt(server, "main", "#{window_id}") === s.sweepWin);

		// ctrl+c quits the dashboard and sends the joined pane home.
		server.tmux(["select-window", "-t", fleet]);
		await server.keys(dash, "C-l");
		await waitFor("sweep joined (ctrl+c)", () => windowOf(s.sweepPi) === fleet);
		server.tmux(["select-pane", "-t", dash]);
		await server.keys(dash, "C-c");
		await homeAgain(s.sweepPi, s.sweepWin);
		await waitFor("the dashboard to quit", () => !server.alive(dash));

		// The dashboard pane killed (SIGHUP) while a pane is joined: that pane goes home, alive.
		({ fleet, dash } = await openDashboard());
		assert.equal(start === fleet, false);
		await select(dash, "physicsnemo sweep");
		await server.keys(dash, "C-l");
		await waitFor("sweep joined (kill)", () => windowOf(s.sweepPi) === fleet);
		server.tmux(["kill-pane", "-t", dash]);
		await homeAgain(s.sweepPi, s.sweepWin);
		assert.ok(server.alive(s.nvim));
	} finally {
		server.kill();
	}
});

test("e2e: in the popup (not the fleet window) ctrl+l jumps to the session's window; dead rows flash `not live`", { skip: skipTmux, timeout: 60_000 }, async () => {
	const server = new Server({});
	try {
		const s = liveSessions(server);
		const dash = server.tmux(["new-window", "-P", "-F", "#{pane_id}", "--", cliBin, "dashboard"]);
		await waitFor("the dashboard", () => server.capture(dash).includes("▾ alpha"));
		server.type(dash, "/old run");
		await server.keys(dash, "Escape", "C-l");
		await waitFor("not live", () => /start the old run is not live/.test(server.capture(dash)));
		await server.keys(dash, "Escape");
		server.type(dash, "/physicsnemo");
		await server.keys(dash, "Escape", "C-l");
		await waitFor("the jump", () => fmt(server, "main", "#{window_id}") === s.sweepWin);
		assert.equal(fmt(server, s.sweepWin, "#{pane_id}"), s.sweepPi, "the pi pane is active");
		assert.equal(fmt(server, s.sweepPi, "#{@pi_fleet_joined}"), "", "never joined");
		await waitFor("the popup dashboard to quit", () => !server.alive(dash));
	} finally {
		server.kill();
	}
});
