// vim-mode's keys end to end (design §12; pi-deck-design.md §15): a real pi TUI with vim-mode and the
// fleet extension, started by hand in a throwaway tmux server (support/deck-rig.ts:
// `tmux -L decktest-<pid>-p3-<n>-outer`, never `default` or `pifleet`, PI_FLEET_TMUX_GUARD=1).
// In INSERT mode Space and `,` are typed; Escape, `,` shows `,…` in the mode line and any other key
// cancels it; Space starts a selection (VISUAL) and `v` toggles it to whole lines (V-LINE). Space
// opens nothing: no deck, no popup, no new window.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DeckRig, skipDeck, waitFor } from "./support/deck-rig.ts";

const rigs: DeckRig[] = [];
after(() => {
	for (const r of rigs) r.close();
});

test("vim-mode in a real pi: , is the leader, Space selects, v toggles char <-> line", { skip: skipDeck, timeout: 120_000 }, async () => {
	const d = new DeckRig();
	rigs.push(d);
	await d.harness();
	const pane = d.tmux(["new-window", "-P", "-F", "#{pane_id}", "-t", "main:", "-c", d.work, "--", ...d.piArgv], "outer");
	const show = () => d.screen(pane, "outer");
	await d.ready(pane, "outer");
	const windows = d.tmux(["list-windows", "-t", "main", "-F", "#{window_id}"], "outer");

	// INSERT mode: Space and , are typed into the prompt.
	d.tmux(["send-keys", "-t", pane, "-l", "x ,e"], "outer");
	await waitFor("typed text", () => d.editor(pane, "outer")?.includes("x ,e"), 5_000, show);
	await d.keys(pane, ["C-u"], "outer");

	// NORMAL: , is the pending leader; an unmapped key cancels it.
	await d.keys(pane, ["Escape"], "outer");
	await waitFor("NORMAL mode", () => / NORMAL\s*$/m.test(show()), 5_000, show);
	await d.keys(pane, [","], "outer");
	await waitFor("the pending leader", () => / ,…\s*$/m.test(show()), 5_000, show);
	await d.keys(pane, ["e"], "outer");
	await waitFor("leader cancelled", () => / NORMAL\s*$/m.test(show()), 5_000, show);

	// Space: a selection, not a leader; v: whole lines, v again: characters.
	await d.keys(pane, ["Space"], "outer");
	await waitFor("VISUAL", () => / VISUAL\s*$/m.test(show()), 5_000, show);
	await d.keys(pane, ["v"], "outer");
	await waitFor("V-LINE", () => / V-LINE\s*$/m.test(show()), 5_000, show);
	await d.keys(pane, ["v"], "outer");
	await waitFor("VISUAL again", () => / VISUAL\s*$/m.test(show()), 5_000, show);
	await d.keys(pane, ["Escape"], "outer");
	await waitFor("NORMAL again", () => / NORMAL\s*$/m.test(show()), 5_000, show);

	assert.equal(d.tryTmux(["has-session", "-t", "=deck"]), undefined, "no deck");
	assert.equal(d.clients().length, 0, "no popup");
	assert.equal(d.tmux(["list-windows", "-t", "main", "-F", "#{window_id}"], "outer"), windows, "no new window");
});
