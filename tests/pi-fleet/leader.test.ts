// fleet/leader.ts (design §12, phase 8): the pi-fleet:action handler. Stubbed openers check the
// dispatch (main sessions only, the session_start UI context, handled flag, errors); the real
// ACTIONS are checked to reach the right view.ts opener through a fake ui; `Space g s` runs :Git
// in a headless nvim; `Space f h`'s command list and prompt insertion. Resolves
// `@earendil-works/*` from pi's install (skipped when pi is not on PATH).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fleetOf } from "../../pi/extensions/fleet/shared.ts";
import { piPackages, usePackages } from "./support/view-support.ts";

delete process.env.TMUX;
delete process.env.TMUX_PANE;
const root = realpathSync(mkdtempSync(join(tmpdir(), "pfl-")));
process.env.PI_FLEET_RUNTIME_DIR = join(root, "run");
// Never the real state, cache or sessions dirs.
process.env.PI_FLEET_STATE_DIR = join(root, "state");
process.env.PI_FLEET_CACHE_DIR = join(root, "cache");
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
after(() => rmSync(root, { recursive: true, force: true }));

const packages = piPackages();
const skip = packages ? false : "pi's packages not found (pi not on PATH)";
let leader: typeof import("../../pi/extensions/fleet/leader.ts");
let vim: typeof import("../../pi/extensions/vim-mode.ts");
let sv: typeof import("../../pi/extensions/fleet/sessions-view.ts");
let cli: typeof import("../../pi/extensions/fleet/cli.ts");
let createEventBus: () => { emit(c: string, d: unknown): void; on(c: string, h: (d: unknown) => void): () => void };
let builtins: { name: string; description: string }[] = [];

before(async () => {
	if (!packages) return;
	await usePackages(packages);
	leader = await import("../../pi/extensions/fleet/leader.ts");
	vim = await import("../../pi/extensions/vim-mode.ts");
	sv = await import("../../pi/extensions/fleet/sessions-view.ts");
	cli = await import("../../pi/extensions/fleet/cli.ts");
	const dist = join(packages, "@earendil-works", "pi-coding-agent", "dist");
	({ createEventBus } = await import(pathToFileURL(join(dist, "core", "event-bus.js")).href));
	builtins = (await import(pathToFileURL(join(dist, "core", "slash-commands.js")).href)).BUILTIN_SLASH_COMMANDS;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakePi(opts: { main?: boolean; commands?: { name: string; description?: string; source: string }[] } = {}) {
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	const sent: { text: string; options: unknown }[] = [];
	const pi: any = {
		on: (name: string, fn: any) => (handlers[name] = fn),
		events: createEventBus(),
		getCommands: () => opts.commands ?? [],
		sendUserMessage: (text: string, options: unknown) => sent.push({ text, options }),
	};
	fleetOf(pi).main = opts.main ?? true;
	const notes: [string, string][] = [];
	const calls: string[] = [];
	let editorText = "";
	const ctx: any = {
		cwd: root,
		hasUI: true,
		sessionManager: { getSessionId: () => "sid-leader", getBranch: () => [] },
		ui: {
			notify: (message: string, level: string) => notes.push([message, level]),
			select: async (title: string, options: string[]) => {
				calls.push(`select:${title}`);
				return ctx.ui.choose?.(options);
			},
			input: async (title: string) => {
				calls.push(`input:${title}`);
				return undefined;
			},
			getEditorText: () => editorText,
			setEditorText: (t: string) => (editorText = t),
		},
	};
	const start = () => handlers.session_start!({ reason: "startup" }, ctx);
	const emit = (name: string) => {
		const event: any = { name, handled: false };
		pi.events.emit("pi-fleet:action", event);
		return event.handled as boolean;
	};
	return { pi, ctx, handlers, start, emit, notes, calls, sent, editor: { get: () => editorText, set: (t: string) => (editorText = t) } };
}

test("ACTIONS cover exactly the vim-mode leader maps", { skip }, () => {
	assert.deepEqual(Object.keys(leader.ACTIONS).sort(), [...new Set(Object.values(vim.LEADER_MAPS))].sort());
	assert.equal(leader.ACTION_EVENT, vim.FLEET_ACTION_EVENT);
});

test("dispatch: stubbed action gets pi and the session_start ctx; handled is set synchronously", { skip }, async () => {
	const f = fakePi();
	const got: unknown[][] = [];
	const stubs = Object.fromEntries(Object.keys(leader.ACTIONS).map((name) => [name, (pi: unknown, ctx: unknown) => got.push([name, pi, ctx])]));
	leader.registerLeader(f.pi, stubs);
	assert.equal(f.emit("files"), false, "no UI context before session_start");
	await f.start();
	for (const name of Object.keys(stubs)) assert.equal(f.emit(name), true, name);
	await sleep(10);
	assert.deepEqual(got.map((g) => g[0]), Object.keys(stubs));
	for (const g of got) {
		assert.equal(g[1], f.pi);
		assert.equal(g[2], f.ctx);
	}
	await f.handlers.session_shutdown!({}, f.ctx);
	assert.equal(f.emit("files"), false, "not after session_shutdown");
});

test("dispatch: not in subagent/non-main sessions or without UI; unknown names and errors are reported", { skip }, async () => {
	const sub = fakePi({ main: false });
	let ran = 0;
	leader.registerLeader(sub.pi, { files: () => ran++ });
	await sub.start();
	assert.equal(sub.emit("files"), false);

	const noUi = fakePi();
	noUi.ctx.hasUI = false;
	leader.registerLeader(noUi.pi, { files: () => ran++ });
	await noUi.start();
	assert.equal(noUi.emit("files"), false);

	const f = fakePi();
	leader.registerLeader(f.pi, {
		files: () => ran++,
		boom: async () => {
			throw new Error("kaput");
		},
	});
	await f.start();
	assert.equal(f.emit("toString"), true);
	assert.equal(f.emit("boom"), true);
	await sleep(10);
	assert.equal(ran, 0);
	assert.deepEqual(f.notes, [
		["pi-fleet: unknown action toString", "warning"],
		["pi-fleet: boom: kaput", "error"],
	]);
});

test("real ACTIONS reach the view.ts openers with the right scope", { skip }, async () => {
	mkdirSync(join(root, "repo"), { recursive: true });
	const f = fakePi();
	f.ctx.cwd = join(root, "repo");
	leader.registerLeader(f.pi);
	await f.start();
	for (const name of ["files", "git-files", "session-files", "grep", "tool-output"]) f.emit(name);
	for (let i = 0; i < 50 && f.calls.length + f.notes.length < 4; i++) await sleep(50);
	await sleep(100);
	// session files: nothing touched, so no list; repo listing of an empty dir: no list either.
	// The openers that always ask: grep (input), tool-output (notice without tool calls).
	assert.ok(f.calls.includes("input:Grep >"), JSON.stringify(f.calls));
	assert.deepEqual(f.notes, [["No tool calls in this session yet", "info"]]);
});

test("files / git-files list their scope (non-TUI select path of the picker)", { skip }, async () => {
	const repo = join(root, "repo2");
	mkdirSync(repo, { recursive: true });
	spawnSync("git", ["init", "-q"], { cwd: repo });
	spawnSync("sh", ["-c", "echo x > a.txt && git add a.txt"], { cwd: repo });
	const f = fakePi();
	f.ctx.cwd = repo;
	let offered: string[] = [];
	f.ctx.ui.choose = (options: string[]) => {
		offered = options;
		return undefined;
	};
	leader.registerLeader(f.pi);
	await f.start();
	f.emit("git-files");
	for (let i = 0; i < 100 && !f.calls.length; i++) await sleep(50);
	assert.deepEqual(f.calls, ["select:Open repo file"]);
	assert.ok(offered.some((o) => o.startsWith("a.txt")), JSON.stringify(offered));
	f.emit("files");
	for (let i = 0; i < 100 && f.calls.length < 2; i++) await sleep(50);
	assert.deepEqual(f.calls, ["select:Open repo file", "select:Open file (session, then repo)"]);
});

test("Space e / Space E open the dashboard window / popup directly (never a prompt); /sessions is Space e", { skip }, async () => {
	// Outside tmux: say so.
	const out = fakePi();
	leader.registerLeader(out.pi);
	await out.start();
	assert.equal(out.emit("sessions"), true);
	for (let i = 0; i < 100 && !out.notes.length; i++) await sleep(10);
	assert.deepEqual(out.notes, [["pi-fleet: the dashboard needs tmux (try `pi-fleet ls`)", "warning"]]);
	assert.deepEqual(out.sent, []);

	// In tmux: the window (= `pi-fleet dashboard --window --pane $TMUX_PANE`) or the popup, for this pane.
	const f = fakePi();
	const calls: string[] = [];
	const run = {
		window: async (pane: string | undefined) => void calls.push(`window ${pane}`),
		popup: async (pane: string) => void calls.push(`popup ${pane}`),
	};
	process.env.TMUX = "/tmp/fleettest-none,1,0";
	process.env.TMUX_PANE = "%7";
	try {
		leader.registerLeader(f.pi, {
			sessions: (pi, ctx) => sv.openDashboard(pi, ctx, "window", run),
			"sessions-popup": (pi, ctx) => sv.openDashboard(pi, ctx, "popup", run),
		});
		await f.start();
		assert.equal(f.emit("sessions"), true);
		assert.equal(f.emit("sessions-popup"), true);
		for (let i = 0; i < 100 && calls.length < 2; i++) await sleep(10);
		assert.deepEqual(calls, ["window %7", "popup %7"]);
		assert.deepEqual(f.notes, []);
		assert.deepEqual(f.sent, []);
		// A failing tmux call is reported, not thrown.
		await sv.openDashboard(f.pi, f.ctx, "popup", { popup: async () => Promise.reject(new Error("no client")) });
		assert.deepEqual(f.notes.at(-1), ["pi-fleet: dashboard: no client", "error"]);
	} finally {
		delete process.env.TMUX;
		delete process.env.TMUX_PANE;
	}
	// /sessions is a command now (no view of its own).
	const commands: Record<string, { description: string }> = {};
	sv.register({ registerCommand: (name: string, c: { description: string }) => (commands[name] = c) } as never);
	assert.match(commands.sessions!.description, /dashboard window/);
	// Space E is prefix G: display-popup -E -w 95% -h 90% pi-fleet dashboard, with the fleet env.
	const args = cli.dashboardPopupArgs("%7", { PI_FLEET_BIN: "/x/pi-fleet", PI_FLEET_STATE_DIR: "/s it's" });
	assert.deepEqual(args.slice(0, -1), ["display-popup", "-E", "-w", "95%", "-h", "90%", "-t", "%7"]);
	assert.equal(args.at(-1), `env 'PI_FLEET_BIN=/x/pi-fleet' 'PI_FLEET_STATE_DIR=/s it'\\''s' '/x/pi-fleet' dashboard`);
});

test("Space f h: commands then built-ins; the choice goes into the prompt", { skip }, async () => {
	assert.deepEqual(leader.BUILTIN_COMMANDS, builtins.map((b) => ({ name: b.name, description: b.description })), "BUILTIN_COMMANDS out of date with the installed pi");
	const choices = leader.commandChoices([
		{ name: "sessions", description: "pi-fleet: sessions\n  on this node" },
		{ name: "skill:foo" },
		{ name: "new", description: "pi-fleet new" },
	]);
	assert.deepEqual(choices.slice(0, 3), [
		{ name: "sessions", label: "/sessions - pi-fleet: sessions on this node" },
		{ name: "skill:foo", label: "/skill:foo" },
		{ name: "new", label: "/new - pi-fleet new" },
	]);
	assert.equal(choices.filter((c) => c.name === "new").length, 1);
	assert.ok(choices.some((c) => c.name === "model"));

	assert.equal(leader.withCommand("view", ""), "/view ");
	assert.equal(leader.withCommand("view", "src/x.py"), "/view src/x.py");
	assert.equal(leader.withCommand("view", "/vi"), "/view ");
	assert.equal(leader.withCommand("view", "/resume abc"), "/view abc");
	// A draft that starts with an absolute path is text, not a command.
	assert.equal(leader.withCommand("view", "/tmp/build.log shows a crash"), "/view /tmp/build.log shows a crash");
	assert.equal(leader.withCommand("view", "/"), "/view ");

	const f = fakePi({ commands: [{ name: "view", description: "Open a file", source: "extension" }] });
	f.ctx.ui.choose = (options: string[]) => options.find((o) => o.startsWith("/view "));
	f.editor.set("src/x.py:3");
	leader.registerLeader(f.pi);
	await f.start();
	f.emit("commands");
	for (let i = 0; i < 50 && !f.calls.length; i++) await sleep(10);
	await sleep(10);
	assert.deepEqual(f.calls, ["select:Slash command"]);
	assert.equal(f.editor.get(), "/view src/x.py:3");
	assert.equal(fleetOf(f.pi).ownPrompts, 0);
});

const hasNvim = spawnSync("nvim", ["--version"], { stdio: "ignore" }).status === 0;

test("Space g s: :Git runs in the paired nvim (args as data); a missing :Git is reported", { skip: skip || (!hasNvim && "nvim not on PATH") }, async () => {
	const f = fakePi();
	leader.registerLeader(f.pi);
	await f.start();
	// No nvim (and no tmux to pair one): a notice.
	f.emit("git-status");
	await sleep(50);
	assert.deepEqual(f.notes, [["pi-fleet: no paired nvim (needs tmux)", "warning"]]);
	f.notes.length = 0;

	const { nvimSockPath } = await import("../../pi/extensions/fleet/cli.ts");
	const { nvimRequest } = await import("../../pi/extensions/fleet/nvim.ts");
	const sock = nvimSockPath("sid-leader");
	const start = (cmd: string): ChildProcess =>
		spawn("nvim", ["--headless", "--clean", "-n", "--listen", sock, "-c", cmd], { stdio: "ignore" });
	const ready = async () => {
		for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(50);
		await nvimRequest(sock, "nvim_get_api_info", [], 3000);
	};
	let nvim = start("command! Git let g:git_ran = get(g:, 'git_ran', 0) + 1");
	try {
		await ready();
		f.emit("git-status");
		let ran: unknown = 0;
		for (let i = 0; i < 50 && ran !== 1; i++) {
			await sleep(50);
			ran = await nvimRequest(sock, "nvim_eval", ["get(g:, 'git_ran', 0)"], 3000);
		}
		assert.equal(ran, 1);
		assert.deepEqual(f.notes, []);
	} finally {
		nvim.kill();
	}
	await sleep(200);
	rmSync(sock, { force: true });
	nvim = start("let g:nothing = 1");
	try {
		await ready();
		f.emit("git-status");
		for (let i = 0; i < 50 && !f.notes.length; i++) await sleep(50);
		assert.deepEqual(f.notes, [["pi-fleet: :Git is not available in nvim (vim-fugitive missing?)", "warning"]]);
	} finally {
		nvim.kill();
	}
});
