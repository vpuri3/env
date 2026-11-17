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
		mode: "dashboard",
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
