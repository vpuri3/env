// vim-mode's `,` leader (design §12, phase 8; pi-deck-design.md §15) and its selection keys: key
// strings fed to the wrapped editor (pi's real CustomEditor with the vim layer) over a fake
// transcript. Checks every map emits its pi-fleet:action, the `,…` mode line, cancel on unknown
// keys / Esc / timeout without moving or selecting, Space starting a selection, `v` toggling
// characters <-> lines, INSERT mode typing Space/,/f, and "pi-fleet not loaded".
// Resolves `@earendil-works/*` from pi's install (skipped when pi is not on PATH).
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { piPackages, usePackages } from "./support/view-support.ts";

const packages = piPackages();
const skip = packages ? false : "pi's packages not found (pi not on PATH)";
let vim: typeof import("../../pi/extensions/vim-mode.ts");
let KeybindingsManager: any;
let createEventBus: () => { emit(c: string, d: unknown): void; on(c: string, h: (d: unknown) => void): () => void };

before(async () => {
	if (!packages) return;
	await usePackages(packages);
	vim = await import("../../pi/extensions/vim-mode.ts");
	const dist = join(packages, "@earendil-works", "pi-coding-agent", "dist");
	({ KeybindingsManager } = await import(pathToFileURL(join(dist, "core", "keybindings.js")).href));
	({ createEventBus } = await import(pathToFileURL(join(dist, "core", "event-bus.js")).href));
});

const ESC = "\x1b";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** vim-mode loaded into a fake pi; returns its editor over a 40-line transcript. */
function setup(opts: { fleet?: boolean } = {}) {
	const bus = createEventBus();
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	const pi: any = { on: (name: string, fn: any) => (handlers[name] = fn), events: bus, registerCommand: (name: string, opts: any) => (commands[name] = opts) };
	let idle = true;
	const actions: string[] = [];
	if (opts.fleet !== false) {
		bus.on("pi-fleet:action", (data: any) => {
			data.handled = true;
			actions.push(data.name);
		});
	}
	const notes: string[] = [];
	let factory: any;
	const ctx: any = {
		hasUI: true,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		ui: {
			getEditorComponent: () => undefined,
			setEditorComponent: (f: any) => (factory = f),
			notify: (message: string) => notes.push(message),
		},
	};
	vim.default(pi);
	handlers.session_start!({}, ctx);

	const lines = Array.from({ length: 40 }, (_, i) => `row ${i} alpha beta gamma`);
	const view = { scrollTop: 30, viewportHeight: 10 };
	const scrollBy = (d: number) => (view.scrollTop = Math.max(0, Math.min(lines.length - view.viewportHeight, view.scrollTop + d)));
	const tui: any = {
		terminal: { rows: 50, columns: 100 },
		requestRender() {},
		scrollBy,
		scrollToBottom: () => (view.scrollTop = lines.length - view.viewportHeight),
		scrollToTop: () => (view.scrollTop = 0),
		getPrimaryScrollView: () => view,
		currentLayout: {
			root: { scrollView: view, scrollContentLines: lines, rect: { x: 0, y: 0, width: 80, height: 10 }, clip: { x: 0, y: 0, width: 80, height: 10 } },
			primaryScrollView: view,
		},
		// pi-tui's mouse-selection pass; vim-mode draws its cursor and selection after it.
		applySelection: (screen: string[]) => screen,
	};
	const theme = { borderColor: (s: string) => s, selectList: {} };
	const editor = factory(tui, theme, new KeybindingsManager());
	const feed = (...keys: string[]) => keys.forEach((k) => editor.handleInput(k));
	const label = () => editor.render(80).at(-1) as string;
	const setIdle = (v: boolean) => (idle = v);
	return { editor, feed, actions, notes, label, view, tui, bus, commands, ctx, setIdle };
}

test("each leader map emits its pi-fleet:action from NORMAL mode", { skip }, () => {
	const expected: [string[], string][] = [
		[["f", "f"], "files"],
		[["f", "g"], "git-files"],
		[["f", "b"], "session-files"],
		[["f", "s"], "grep"],
		[["f", "h"], "commands"],
		[["g", "s"], "git-status"],
		[["t"], "tool-output"],
	];
	assert.equal(vim.LEADER_KEY, ",");
	assert.deepEqual(Object.keys(vim.LEADER_MAPS).sort(), expected.map(([k]) => k.join("")).sort());
	const { editor, feed, actions } = setup();
	feed(ESC);
	assert.equal(editor.mode, "normal");
	for (const [keys] of expected) feed(",", ...keys);
	assert.deepEqual(actions, expected.map(([, name]) => name));
	assert.equal(editor.mode, "normal");
	assert.equal(editor.leader, undefined);
	assert.equal(editor.anchor, undefined);
});

test("removed maps: , e / , E / , v do nothing (the deck list and nvim are always on screen)", { skip }, () => {
	const { editor, feed, actions } = setup();
	feed(ESC);
	const cursor = { ...editor.cursor };
	for (const k of ["e", "E", "v"]) feed(",", k);
	assert.deepEqual(actions, []);
	assert.equal(editor.anchor, undefined);
	assert.deepEqual(editor.cursor, cursor);
});

test("mode line shows ,… while pending; a count is dropped, not applied", { skip }, () => {
	const { editor, feed, actions, label } = setup();
	feed(ESC);
	assert.match(label(), / NORMAL $/);
	feed("3", ",");
	assert.match(label(), / ,… $/);
	feed("f");
	assert.match(label(), / ,f… $/);
	feed("f");
	assert.deepEqual(actions, ["files"]);
	assert.match(label(), / NORMAL $/);
	assert.equal(editor.count, "");
});

test(", j does nothing: no action, no move, no selection, j dropped", { skip }, () => {
	const { editor, feed, actions, label } = setup();
	feed(ESC);
	const cursor = { ...editor.cursor };
	feed(",", "j");
	assert.deepEqual(actions, []);
	assert.deepEqual(editor.cursor, cursor);
	assert.equal(editor.anchor, undefined);
	assert.equal(editor.leader, undefined);
	assert.match(label(), / NORMAL $/);
	// A prefix followed by a non-matching key cancels too (the key is not replayed).
	feed(",", "f", "j");
	assert.deepEqual(actions, []);
	assert.deepEqual(editor.cursor, cursor);
	// Afterwards keys work normally again.
	feed("k");
	assert.equal(editor.cursor.row, cursor.row - 1);
});

test("Esc cancels the leader without interrupting or leaving NORMAL", { skip }, () => {
	const { editor, feed, actions } = setup();
	let interrupted = 0;
	feed(ESC);
	editor.onEscape = () => interrupted++;
	feed(",", ESC);
	assert.equal(editor.leader, undefined);
	assert.equal(editor.mode, "normal");
	assert.equal(interrupted, 0);
	feed("t");
	assert.deepEqual(actions, []);
});

test("Space starts a character selection; Space j extends it", { skip }, () => {
	const { editor, feed, label, actions } = setup();
	feed(ESC);
	const row = editor.cursor.row;
	feed("k", " ", "j");
	assert.deepEqual(editor.anchor, { row: row - 1, col: 0 });
	assert.equal(editor.lineSelect, false);
	assert.equal(editor.cursor.row, row);
	assert.equal(editor.leader, undefined);
	assert.match(label(), / VISUAL $/);
	assert.deepEqual(actions, []);
	// Space again restarts the selection at the cursor (tmux copy-mode-vi begin-selection).
	feed("l", " ");
	assert.deepEqual(editor.anchor, editor.cursor);
	// Esc clears it.
	feed(ESC);
	assert.equal(editor.anchor, undefined);
	assert.match(label(), / NORMAL $/);
	// Space as a CSI-u key (kitty keyboard protocol) is Space too.
	feed("\x1b[32u");
	assert.ok(editor.anchor);
});

test("v toggles the selection between characters and lines (anchor kept); without one it starts a character selection", { skip }, () => {
	const { editor, feed, label } = setup();
	feed(ESC);
	const row = editor.cursor.row;
	feed("k", "v", "j");
	assert.deepEqual(editor.anchor, { row: row - 1, col: 0 });
	assert.equal(editor.lineSelect, false);
	assert.match(label(), / VISUAL $/);
	feed("v");
	assert.deepEqual(editor.anchor, { row: row - 1, col: 0 });
	assert.equal(editor.lineSelect, true);
	assert.match(label(), / V-LINE $/);
	feed("v");
	assert.deepEqual(editor.anchor, { row: row - 1, col: 0 });
	assert.equal(editor.lineSelect, false);
	assert.match(label(), / VISUAL $/);
	// From a Space selection too; V still starts a line selection at the cursor.
	feed(ESC, " ", "v");
	assert.equal(editor.lineSelect, true);
	feed(ESC, "V");
	assert.deepEqual(editor.anchor, editor.cursor);
	assert.equal(editor.lineSelect, true);
	assert.match(label(), / V-LINE $/);
});

test("the leader works with a selection active and leaves it alone", { skip }, () => {
	const { editor, feed, actions } = setup();
	feed(ESC, " ", "k", ",", "t");
	assert.deepEqual(actions, ["tool-output"]);
	assert.ok(editor.anchor);
});

test("the leader times out after 1000 ms; the next key is a normal key", { skip, timeout: 10_000 }, async () => {
	assert.equal(vim.LEADER_TIMEOUT_MS, 1000);
	const { editor, feed, actions, label } = setup();
	feed(ESC);
	feed(",");
	await sleep(600);
	feed("f"); // a prefix re-arms the timeout
	await sleep(600);
	assert.equal(editor.leader, "f");
	await sleep(600);
	assert.equal(editor.leader, undefined);
	assert.match(label(), / NORMAL $/);
	const row = editor.cursor.row;
	feed("f", "k"); // f is unmapped in NORMAL; k moves
	assert.deepEqual(actions, []);
	assert.equal(editor.cursor.row, row - 1);
});

test("INSERT mode never sees the leader: Space, comma and f are typed", { skip }, () => {
	const { editor, feed, actions } = setup();
	assert.equal(editor.mode, "insert");
	feed(" ", ",", " ", "f", "f", ",", "t");
	assert.equal(editor.getText(), " , ff,t");
	assert.deepEqual(actions, []);
	// `i` while the leader is pending is dropped, so it does not enter INSERT.
	feed(ESC, ",", "i");
	assert.equal(editor.mode, "normal");
	feed("i");
	assert.equal(editor.mode, "insert");
	feed("e");
	assert.equal(editor.getText(), " , ff,te");
});

test("without pi-fleet, a leader map says so", { skip }, () => {
	const { feed, notes } = setup({ fleet: false });
	feed(ESC, ",", "t");
	assert.deepEqual(notes, ["pi-fleet not loaded"]);
});

test("Esc in NORMAL never interrupts a working agent; ctrl+c does", { skip }, () => {
	const { editor, feed, setIdle } = setup();
	let escapes = 0;
	editor.onEscape = () => escapes++;
	setIdle(false);
	feed(ESC); // INSERT -> NORMAL
	feed(ESC, ESC); // stray Escs in NORMAL
	assert.equal(editor.mode, "normal");
	assert.equal(escapes, 0, "Esc must not reach pi's interrupt while the agent works");
	feed("\x03"); // ctrl+c
	assert.equal(escapes, 1);
	// Idle, Esc still reaches pi's Esc (abort a `!` command, leave bash mode).
	setIdle(true);
	feed(ESC);
	assert.equal(escapes, 2);
});

test("/rewind opens pi's fork selector (the editor's app.session.fork)", { skip }, async () => {
	const { editor, commands, ctx, notes } = setup();
	let forks = 0;
	editor.actionHandlers.set("app.session.fork", () => forks++);
	assert.ok(commands.rewind, "/rewind registered");
	await commands.rewind!.handler("", ctx);
	assert.equal(forks, 1);
	assert.deepEqual(notes, []);
});
