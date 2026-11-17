// The leader end to end (design §12; pi-deck-design.md §7): a real pi TUI with vim-mode and the fleet
// extension, started by hand in a throwaway outer tmux server with a real client (support/deck-rig.ts:
// `tmux -L decktest-<pid>-p3-<n>[-outer|-h]`, never `default` or `pifleet`, PI_FLEET_TMUX_GUARD=1).
// In INSERT mode Space and e are typed; Escape, Space shows `␣…` in the mode line; `E` and `e` both
// start the (throwaway) deck if needed and open it in a popup over that client, never a window.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DeckRig, skipDeck, waitFor } from "./support/deck-rig.ts";

const rigs: DeckRig[] = [];
after(() => {
	for (const r of rigs) r.close();
});

test("vim-mode leader in pi: Space E and Space e open the deck popup (one entry story)", { skip: skipDeck, timeout: 120_000 }, async () => {
	const d = new DeckRig();
	rigs.push(d);
	const h = await d.harness();
	const pane = d.tmux(["new-window", "-P", "-F", "#{pane_id}", "-t", "main:", "-c", d.work, "--", ...d.piArgv], "outer");
	const show = () => d.screen(pane, "outer");
	await d.ready(pane, "outer");
	const windows = d.tmux(["list-windows", "-t", "main", "-F", "#{window_id}"], "outer");

	// INSERT mode: Space and e are typed into the prompt.
	d.tmux(["send-keys", "-t", pane, "-l", "x e"], "outer");
	await waitFor("typed text", () => d.editor(pane, "outer")?.includes("x e"), 5_000, show);
	assert.equal(d.tryTmux(["has-session", "-t", "=deck"]), undefined, "no deck yet");
	await d.keys(pane, ["C-u"], "outer");

	// Space E: the deck is started and popped up over the outer client.
	await d.keys(pane, ["Escape"], "outer");
	await waitFor("NORMAL mode", () => / NORMAL\s*$/m.test(show()), 5_000, show);
	await d.keys(pane, ["Space"], "outer");
	assert.match(show(), / ␣…\s*$/m);
	await d.keys(pane, ["E"], "outer");
	await waitFor("the deck popup", () => d.clients().length === 1, 20_000, show);
	assert.equal(d.tmux(["show", "-gv", "@deck_outer"]), `${h.outerSocket}|${h.outerClient}`);
	assert.equal(d.tmux(["list-windows", "-t", "main", "-F", "#{window_id}"], "outer"), windows, "no new window");

	// Close it; Space e opens the same popup.
	d.tmux(["detach-client", "-s", "=deck"]);
	await waitFor("popup closed", () => d.clients().length === 0);
	await d.keys(pane, ["Space", "e"], "outer");
	await waitFor("the deck popup again", () => d.clients().length === 1, 20_000, show);
	assert.equal(d.tmux(["list-windows", "-t", "main", "-F", "#{window_id}"], "outer"), windows, "no new window");
});
