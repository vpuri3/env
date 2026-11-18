// pi and nvim in the pi deck (docs/pi-deck-design.md §7, §8, §15), end to end with real pis (fleet +
// vim-mode + faux provider) and real nvims (nvconf.pi_fleet loaded) in a throwaway deck
// (support/deck-rig.ts: `tmux -L decktest-<pid>-p3-<n>`, PI_FLEET_TMUX_GUARD=1, the list is the phase-1
// server layer). Checks:
//   - a deck pi's /new and /resume open pool panes over deck.sock, shown (pi and its nvim) and focused; the
//     original pi keeps running; /resume of a session in the deck selects it;
//   - a pi started by hand in the user's tmux (a throwaway outer server with a real client) creates the
//     session in the deck (starting the deck) and pops the deck up on that client; /sessions does too;
//   - each session's nvim is made on its first show and sits in the nvim slot below the list: /view opens
//     the file there and focuses it; :PiFocus focuses the pi; an agent edit reloads a hidden nvim; :w!!
//     from the deck nvim reaches pi; selecting the session again brings its own nvim back.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nvimRequest } from "../../pi/extensions/fleet/nvim.ts";
import { DeckRig, skipDeck, sleep, waitFor } from "./support/deck-rig.ts";

const rigs: DeckRig[] = [];
after(() => {
	for (const r of rigs) r.close();
});
function rig(): DeckRig {
	const r = new DeckRig();
	rigs.push(r);
	return r;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("deck pi: /new and /resume open pool panes over deck.sock (shown, focused); the original keeps running", { skip: skipDeck, timeout: 180_000 }, async () => {
	const d = rig();
	d.start();
	const a = await d.open();
	assert.equal(d.slot()?.pane, a.pane);
	// One exchange, so a's session file exists (pi writes it with the first message).
	await d.type(a.pane, "hello");
	const stA = await waitFor("a's session file", () => d.status(a.id)?.sessionFile && existsSync(d.status(a.id).sessionFile) && d.status(a.id)?.state !== "running" && d.status(a.id), 30_000, () => d.screen(a.pane));

	// /new: a second pool pi in the same cwd, shown in the slot and focused.
	await d.type(a.pane, "/new");
	const b = await waitFor("a pool pi from /new", () => d.panes().find((p) => p.role === "pi" && p.session && p.session !== a.id), 30_000, () => d.screen(a.pane));
	await waitFor("b in the slot", () => d.slot()?.pane === b.pane);
	assert.equal(d.activeIndex(), "2", "and focused");
	await d.ready(b.pane);
	const stB = await waitFor("status of b", () => d.status(b.session)?.pid && d.status(b.session));
	assert.equal(stB.cwd, d.work);
	// The original: same pi process, same session, its pane alive in the pool.
	assert.equal(d.status(a.id)?.pid, stA.pid);
	assert.ok(alive(stA.pid));
	const paneA = d.panes().find((p) => p.pane === a.pane)!;
	assert.equal(paneA.session, a.id);
	assert.equal(paneA.dead, false);
	assert.match(paneA.where, /^pool:/);

	// /resume (as from the picker) of a session in the deck: selected, no new pane.
	const count = d.panes().filter((p) => p.role === "pi").length;
	await d.type(b.pane, `/switch-to ${stA.sessionFile}`);
	await waitFor("a selected again", () => d.slot()?.pane === a.pane, 20_000, () => d.screen(b.pane));
	assert.equal(d.panes().filter((p) => p.role === "pi").length, count);
	assert.equal(d.status(b.session)?.pid, stB.pid, "b keeps running");

	// /resume of a stored session: a new pool pi running `--session <file>`.
	const storedId = "11111111-2222-7333-8444-555555555555";
	const stored = d.sessionFile(storedId);
	await d.type(a.pane, `/switch-to ${stored}`);
	const c = await waitFor("a pool pi for the stored session", () => d.panes().find((p) => p.role === "pi" && p.session === storedId), 30_000, () => d.screen(a.pane));
	await waitFor("it is shown", () => d.slot()?.pane === c.pane);
	await waitFor("its pi runs", () => d.status(storedId)?.pid);
	assert.equal(d.status(a.id)?.pid, stA.pid, "a keeps running");
	assert.equal(d.status(b.session)?.pid, stB.pid, "b keeps running");
	// Every session shown got its own nvim (on its first show), and the shown one is below the list.
	const pis = d.panes().filter((p) => p.role === "pi");
	for (const p of pis) assert.equal(d.panes().find((q) => q.pane === p.peer)?.role, "nvim", `${p.session}'s nvim`);
	assert.equal(d.panes().filter((p) => p.role === "nvim").length, pis.length);
	await waitFor("c's nvim in the nvim slot", () => d.nvimSlot()?.session === storedId && d.nvimSlot()?.role === "nvim");
});

test("hand-started pi in the user's tmux: /new and /resume create the session in the deck and pop the deck up; /sessions pops it up", { skip: skipDeck, timeout: 180_000 }, async () => {
	const d = rig();
	const h = await d.harness();
	// A pi started by hand in the outer server (its env names the throwaway deck); no deck runs yet.
	const pane = d.tmux(["new-window", "-P", "-F", "#{pane_id}", "-t", "main:", "-c", d.work, "--", ...d.piArgv], "outer");
	await d.ready(pane, "outer");
	assert.equal(d.tryTmux(["has-session", "-t", "=deck"]), undefined, "no deck yet");
	const id = await waitFor("the hand-started pi's session", () => d.tryTmux(["display-message", "-p", "-t", pane, "#{@pi_fleet_session}"], "outer") || undefined);
	const pid = (await waitFor("its status", () => d.status(id)?.pid && d.status(id))).pid;

	await d.type(pane, "/new", "outer");
	const fresh = await waitFor("the new session in the deck", () => d.panes().find((p) => p.role === "pi" && p.session && p.session !== id), 30_000, () => d.screen(pane, "outer"));
	await waitFor("shown in the slot", () => d.slot()?.pane === fresh.pane);
	await waitFor("the deck popup on the outer client", () => d.clients().length === 1, 15_000, () => d.screen("h", "h"));
	assert.equal(d.tmux(["show", "-gv", "@deck_outer"]), `${h.outerSocket}|${h.outerClient}`);
	await d.ready(fresh.pane);
	assert.equal(d.status(id)?.pid, pid, "the hand-started pi keeps running");
	assert.ok(alive(pid));
	assert.equal(d.tmux(["list-windows", "-t", "main", "-F", "#{window_id}"], "outer").split("\n").length, 2, "no new outer window");

	// Close the popup (detach the deck client), then /resume of a stored session: in the deck, popped up.
	d.tmux(["detach-client", "-s", "=deck"]);
	await waitFor("popup closed", () => d.clients().length === 0);
	const storedId = "22222222-2222-7333-8444-555555555555";
	await d.type(pane, `/switch-to ${d.sessionFile(storedId)}`, "outer");
	const resumed = await waitFor("the resumed session in the deck", () => d.panes().find((p) => p.role === "pi" && p.session === storedId), 30_000, () => d.screen(pane, "outer"));
	await waitFor("shown", () => d.slot()?.pane === resumed.pane);
	await waitFor("popped up again", () => d.clients().length === 1);

	// /sessions: the deck popup.
	d.tmux(["detach-client", "-s", "=deck"]);
	await waitFor("popup closed", () => d.clients().length === 0);
	await d.type(pane, "/sessions", "outer");
	await waitFor("/sessions pops the deck up", () => d.clients().length === 1, 15_000, () => d.screen(pane, "outer"));
	assert.equal(d.slot()?.pane, resumed.pane, "the selection is kept");
});

test("deck nvim: made on first show below the list; /view opens the file there and focuses it; :PiFocus; a hidden nvim reloads agent edits; :w!! reaches pi", { skip: skipDeck, timeout: 240_000 }, async () => {
	const d = rig();
	const file = join(d.work, "x.py");
	writeFileSync(file, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
	d.start();
	const a = await d.open();
	// Shown, so its nvim was made at once, in the nvim slot; the pi keeps the focus.
	const nvim = await waitFor("a's nvim in the nvim slot", () => (d.nvimSlot()?.role === "nvim" ? d.nvimSlot() : undefined), 30_000);
	assert.equal(nvim.session, a.id);
	assert.equal(nvim.peer, a.pane);
	assert.equal(d.panes().find((p) => p.pane === a.pane)?.peer, nvim.pane);
	assert.equal(d.activeIndex(), "2");
	const sock = nvim.nvimSock;
	await waitFor("nvim's socket", () => existsSync(sock));

	// /view FILE:LINE: opened in that nvim, which gets the focus; nothing moves.
	await d.type(a.pane, "/view x.py:7");
	const cur = async () => (await nvimRequest(sock, "nvim_exec_lua", ["return { vim.api.nvim_buf_get_name(0), vim.api.nvim_win_get_cursor(0)[1] }", []], 3000)) as [string, number];
	await waitFor("x.py at line 7", async () => {
		const [name, line] = await cur();
		return name === file && line === 7;
	}, 30_000, () => d.screen(a.pane));
	await waitFor("the nvim slot focused", () => d.activeIndex() === "1");
	assert.equal(d.nvimSlot()?.pane, nvim.pane);
	assert.equal(d.slot()?.pane, a.pane);
	assert.equal(d.panes().filter((p) => p.role === "nvim").length, 1, "no second nvim");
	await waitFor("the status records it", () => d.status(a.id)?.nvimSock === sock && d.status(a.id)?.tmux?.nvimPane === nvim.pane);
	assert.equal(await nvimRequest(sock, "nvim_exec_lua", ["return vim.fn.exists(':PiFocus')", []]), 2, "nvconf.pi_fleet is loaded");

	// :PiFocus: the pi beside it gets the focus; both stay where they are.
	await d.keys(nvim.pane, [":PiFocus", "Enter"]);
	await waitFor("the pi focused", () => d.activeIndex() === "2");
	assert.equal(d.nvimSlot()?.pane, nvim.pane);
	assert.equal(d.slot()?.pane, a.pane);

	// A second session: its own nvim (first show) replaces a's below the list; a's waits hidden in the pool.
	const b = await d.open();
	const nvimB = await waitFor("b's nvim in the nvim slot", () => (d.nvimSlot()?.role === "nvim" && d.nvimSlot()?.session === b.id ? d.nvimSlot() : undefined), 30_000);
	assert.equal(nvimB.peer, b.pane);
	assert.match(d.panes().find((p) => p.pane === nvim.pane)!.where, /^pool:/);

	// An agent edit in the hidden a reaches its hidden nvim: the unmodified buffer reloads.
	await d.type(a.pane, `please write ${file}`);
	await waitFor("the agent's write in the hidden nvim", async () => {
		const lines = (await nvimRequest(sock, "nvim_exec_lua", ["return vim.api.nvim_buf_get_lines(0, 0, -1, false)", []], 3000)) as string[];
		return lines.length === 1 && lines[0] === "agent wrote";
	}, 30_000, () => `${d.screen(a.pane)}\n--- file: ${readFileSync(file, "utf8")}\n--- nvim:\n${d.screen(nvim.pane)}`);
	assert.equal(d.nvimSlot()?.pane, nvimB.pane, "the reload does not show the nvim");

	await waitFor("pi idle", () => d.status(a.id)?.state !== "running", 30_000);

	// Selecting a again brings back a's pi and a's own nvim.
	const sel = d.cli(["open", "--deck", "--session", a.id, "--json"]);
	assert.equal(JSON.parse(sel.out).created, false, sel.out + sel.err);
	await waitFor("a and its nvim shown", () => d.slot()?.pane === a.pane && d.nvimSlot()?.pane === nvim.pane);
	assert.equal(d.panes().filter((p) => p.role === "nvim").length, 2);
	await waitFor("pi idle", () => d.status(a.id)?.state !== "running", 30_000);

	// :w!! in the deck nvim reaches pi over its control socket (a steer: pi runs a turn with the diff).
	await nvimRequest(sock, "nvim_exec_lua", ["vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'user wrote' })", []]);
	await d.keys(nvim.pane, [":w!!", "Enter"]);
	await waitFor("the file saved", () => readFileSync(file, "utf8") === "user wrote\n");
	const sessionFile = d.status(a.id)?.sessionFile as string;
	await waitFor("the user's edit in pi's session", () => existsSync(sessionFile) && readFileSync(sessionFile, "utf8").includes("pi-fleet:user-edit") && readFileSync(sessionFile, "utf8").includes("user wrote"), 30_000, () => d.screen(nvim.pane));
	await waitFor("pi idle", () => d.status(a.id)?.state !== "running", 30_000);
});
