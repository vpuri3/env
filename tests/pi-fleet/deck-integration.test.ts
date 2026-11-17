// pi and nvim in the pi deck (docs/pi-deck-design.md §7, §8, phase 3), end to end with real pis (fleet +
// vim-mode + faux provider) and real nvims (nvconf.pi_fleet loaded) in a throwaway deck
// (support/deck-rig.ts: `tmux -L decktest-<pid>-p3-<n>`, PI_FLEET_TMUX_GUARD=1, the list is the phase-1
// server layer). Checks:
//   - a deck pi's /new and /resume open pool panes over deck.sock, shown and focused; the original pi keeps
//     running; /resume of a session in the deck selects it;
//   - a pi started by hand in the user's tmux (a throwaway outer server with a real client) creates the
//     session in the deck (starting the deck) and pops the deck up on that client; Space e does too;
//   - nvim starts on first use only: /view (file shown in the slot) and Space v (slot toggles to nvim);
//     :PiFocus swaps back; an agent edit reloads the hidden nvim; :w!! from the deck nvim reaches pi.
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
	assert.equal(d.activeIndex(), "1", "and focused");
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
	// No nvim was started by any of this.
	assert.equal(d.panes().filter((p) => p.role === "nvim").length, 0);
});

test("hand-started pi in the user's tmux: /new and /resume create the session in the deck and pop the deck up; Space e pops it up", { skip: skipDeck, timeout: 180_000 }, async () => {
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

	// Space e (vim-mode NORMAL): the deck popup.
	d.tmux(["detach-client", "-s", "=deck"]);
	await waitFor("popup closed", () => d.clients().length === 0);
	await d.keys(pane, ["Escape"], "outer");
	await waitFor("NORMAL", () => / NORMAL\s*$/m.test(d.screen(pane, "outer")));
	await d.keys(pane, ["Space", "e"], "outer");
	await waitFor("Space e pops the deck up", () => d.clients().length === 1, 15_000, () => d.screen(pane, "outer"));
	assert.equal(d.slot()?.pane, resumed.pane, "the selection is kept");
});

test("deck nvim: /view and Space v start it on first use and show it in the slot; :PiFocus swaps back; a hidden nvim reloads agent edits; :w!! reaches pi", { skip: skipDeck, timeout: 240_000 }, async () => {
	const d = rig();
	const file = join(d.work, "x.py");
	writeFileSync(file, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
	d.start();
	const a = await d.open();
	await sleep(1000);
	assert.equal(d.panes().filter((p) => p.role === "nvim").length, 0, "no nvim at session start");

	// /view FILE:LINE: the nvim is created in the pool, opens the file, and replaces the pi in the slot.
	await d.type(a.pane, "/view x.py:7");
	const nvim = await waitFor("nvim in the slot", () => (d.slot()?.role === "nvim" ? d.slot() : undefined), 30_000, () => d.screen(a.pane));
	assert.equal(nvim.session, a.id);
	assert.equal(nvim.peer, a.pane);
	assert.equal(d.activeIndex(), "1", "the slot (now nvim) is focused");
	const sock = nvim.nvimSock;
	const cur = async () => (await nvimRequest(sock, "nvim_exec_lua", ["return { vim.api.nvim_buf_get_name(0), vim.api.nvim_win_get_cursor(0)[1] }", []], 3000)) as [string, number];
	await waitFor("x.py at line 7", async () => {
		const [name, line] = await cur();
		return name === file && line === 7;
	});
	assert.equal(d.status(a.id)?.nvimSock, sock);
	assert.equal(d.status(a.id)?.tmux?.nvimPane, nvim.pane);
	assert.equal(await nvimRequest(sock, "nvim_exec_lua", ["return vim.fn.exists(':PiFocus')", []]), 2, "nvconf.pi_fleet is loaded");

	// :PiFocus: the pi is swapped back into the slot; the nvim waits hidden in the pool.
	await d.keys(nvim.pane, [":PiFocus", "Enter"]);
	await waitFor("pi back in the slot", () => d.slot()?.pane === a.pane);
	assert.match(d.panes().find((p) => p.pane === nvim.pane)!.where, /^pool:/);
	assert.equal(d.activeIndex(), "1");

	// An agent edit reaches the hidden nvim: the unmodified buffer reloads.
	await d.type(a.pane, `please write ${file}`);
	await waitFor("the agent's write in the hidden nvim", async () => {
		const lines = (await nvimRequest(sock, "nvim_exec_lua", ["return vim.api.nvim_buf_get_lines(0, 0, -1, false)", []], 3000)) as string[];
		return lines.length === 1 && lines[0] === "agent wrote";
	}, 30_000, () => d.screen(a.pane));
	assert.equal(d.slot()?.pane, a.pane, "the reload does not show the nvim");

	// Space v: the slot toggles to the (existing) nvim.
	await waitFor("pi idle", () => d.status(a.id)?.state !== "running");
	await d.keys(a.pane, ["Escape"]);
	await waitFor("NORMAL", () => / NORMAL\s*$/m.test(d.screen(a.pane)));
	await d.keys(a.pane, ["Space", "v"]);
	await waitFor("nvim shown by Space v", () => d.slot()?.pane === nvim.pane, 15_000, () => d.screen(a.pane));
	assert.equal(d.panes().filter((p) => p.role === "nvim").length, 1, "no second nvim");

	// :w!! in the deck nvim reaches pi over its control socket (a steer: pi runs a turn with the diff).
	await nvimRequest(sock, "nvim_exec_lua", ["vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'user wrote' })", []]);
	await d.keys(nvim.pane, [":w!!", "Enter"]);
	await waitFor("the file saved", () => readFileSync(file, "utf8") === "user wrote\n");
	const sessionFile = d.status(a.id)?.sessionFile as string;
	await waitFor("the user's edit in pi's session", () => existsSync(sessionFile) && readFileSync(sessionFile, "utf8").includes("pi-fleet:user-edit") && readFileSync(sessionFile, "utf8").includes("user wrote"), 30_000, () => d.screen(nvim.pane));

	// Space v in a second session: nvim made on first use, shown in the slot.
	const b = await d.open();
	assert.equal(d.panes().filter((p) => p.role === "nvim" && p.session === b.id).length, 0);
	await d.keys(b.pane, ["Escape"]);
	await waitFor("NORMAL", () => / NORMAL\s*$/m.test(d.screen(b.pane)));
	await d.keys(b.pane, ["Space", "v"]);
	const nvimB = await waitFor("b's nvim in the slot", () => (d.slot()?.role === "nvim" && d.slot()?.session === b.id ? d.slot() : undefined), 30_000, () => d.screen(b.pane));
	assert.equal(nvimB.peer, b.pane);
	assert.equal(d.panes().find((p) => p.pane === b.pane)?.peer, nvimB.pane);
	await waitFor("b's status records it", () => d.status(b.id)?.tmux?.nvimPane === nvimB.pane);
	// prefix e (the deck's toggle) brings b's pi back.
	await waitFor("b's nvim socket", () => existsSync(nvimB.nvimSock));
	await d.keys(nvimB.pane, [":PiFocus", "Enter"]);
	await waitFor("b's pi back", () => d.slot()?.pane === b.pane);
});
