// §16 end to end (docs/pi-deck-design.md): the deck's list (the real `pi-fleet deck` TUI) over a real pi
// (fleet with agents-view, vim-mode, subagent-viewer, the pinned pi-subagent-manager, a faux provider) in a
// throwaway deck (support/deck-rig.ts: `tmux -L decktest-<pid>-p3-<n>`, PI_FLEET_TMUX_GUARD=1; never
// `default` or `pifleet`). The session is resumed from a stored file whose registry holds two finished
// subagents (the package's format), so the list shows them under the session. Checks:
//   - highlighting a subagent row shows the package's agent view in the session's pi (the pi slot) and marks
//     the pane deck-opened (@pi_fleet_agents_view); another row closes it again;
//   - a restarted list closes a view the previous one opened (still marked);
//   - C-l focuses the pi (the mark goes: the after-select-pane hook); moving on then leaves the view open.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { locatePiPackages } from "../../pi/extensions/fleet/cli.ts";
import { DeckRig, repo, skipDeck, sleep, waitFor } from "./support/deck-rig.ts";

const PACKAGE = join(process.env.PI_SUBAGENT_MANAGER_DIR ?? join(homedir(), ".pi/agent/npm/node_modules/pi-subagent-manager"));
const skip =
	skipDeck ||
	(!locatePiPackages() && "pi's pi-tui not found") ||
	(existsSync(join(PACKAGE, "src/index.ts")) ? false : "pi-subagent-manager not installed");

const rigs: DeckRig[] = [];
after(() => {
	for (const r of rigs) r.close();
});

/** A stored session with two completed subagents in pi-subagent-manager's registry format. */
function sessionWithAgents(dir: string, cwd: string): { id: string; file: string } {
	mkdirSync(dir, { recursive: true });
	const id = "01a1ea29-0000-7000-8000-00000000d16a";
	const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	const ts = new Date().toISOString();
	const now = Date.now();
	const thread = (name: string, i: number) => ({
		view: { path: `/root/${name}`, parent: "/root", owner: "/root", type: "coder", state: "completed", task: `task of ${name}`, status: "done", output: `output of ${name}`, createdAt: now - i, updatedAt: now - i, lastStartedAt: now - i },
		definition: { name: "coder", description: "test coder", systemPrompt: "" },
	});
	const entries = [
		{ type: "session", version: 3, id, timestamp: ts, cwd },
		{ type: "message", id: "a1", parentId: null, timestamp: ts, message: { role: "user", content: "agents deck test", timestamp: now } },
		{ type: "custom", customType: "pi-subagent:registry:v1", data: { version: 1, rootSessionId: id, threads: [thread("alpha", 1), thread("beta", 2)] }, id: "r1", parentId: "a1", timestamp: ts },
	];
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return { id, file };
}

test("§16: a live deck session's subagent row shows its agent view in the pi slot; other rows close it; C-l takes it over", { skip, timeout: 240_000 }, async () => {
	const d = new DeckRig();
	rigs.push(d);
	// The real list TUI (not the rig's server-layer stand-in), and pis with the subagent package.
	d.env.PI_FLEET_BIN = join(repo, "bin/pi-fleet");
	d.env.PI_CODING_AGENT_SESSION_DIR = d.sessions; // where the list scans for session files
	d.env.PI_FLEET_PI_CMD = [...d.piArgv, "-e", join(repo, "pi/extensions/subagent-viewer.ts"), "-e", PACKAGE].join(" ");
	const stored = sessionWithAgents(join(d.sessions, "x"), d.work);
	d.start();
	const r = d.cli(["open", "--deck", "--session", stored.file, "--json"]);
	assert.equal(r.code, 0, r.err + r.out);
	const pi: string = JSON.parse(r.out).pane;
	await d.ready(pi);
	const list = "=deck:=deck.0";
	const listScreen = () => d.screen(list);
	const piScreen = () => d.screen(pi);
	const mark = () => d.tmux(["show-options", "-pqv", "-t", pi, "@pi_fleet_agents_view"]);
	const mainShown = () => / (INSERT|NORMAL)\s*$/m.test(piScreen()) && !piScreen().includes("Agents tree");
	const inAgentView = (name: string) => () => piScreen().includes(`/root/${name}`) && !piScreen().includes("Agents tree") && !mainShown();
	const selected = () => listScreen().split("\n").find((l) => l.startsWith("›")) ?? "";
	const key = async (...k: string[]) => {
		d.tmux(["send-keys", "-t", list, ...k]);
		await sleep(150);
	};

	// The list selects the session open showed; Space shows its subagents (alpha, the newer, first).
	await waitFor("the session selected in the list", () => / 2✓/.test(selected()), 30_000, listScreen);
	d.tmux(["select-pane", "-t", list]);
	await key("Space");
	await waitFor("its subagents", () => /\/root\/alpha/.test(listScreen()) && /\/root\/beta/.test(listScreen()), 15_000, listScreen);
	await key("j");
	assert.match(selected(), /\/root\/alpha/);
	await waitFor("alpha's agent view in the pi", inAgentView("alpha"), 10_000, piScreen);
	assert.equal(d.slot()?.pane, pi, "the session's pi is in the pi slot");
	assert.equal(mark(), "/root/alpha", "deck-opened");
	assert.equal(d.activeIndex(), "0", "the list keeps the focus");

	// beta: the pi switches agents.
	await key("j");
	await waitFor("beta's agent view", inAgentView("beta"), 10_000, piScreen);
	assert.equal(mark(), "/root/beta");

	// The list restarts (a crash, /reload) while beta's view is open and untouched: the new list closes it.
	const pid = Number(d.tmux(["show", "-gv", "@deck_tui_pid"]));
	process.kill(pid, "SIGTERM");
	await waitFor("a new list", () => {
		const now = Number(d.tryTmux(["show", "-gqv", "@deck_tui_pid"]) || 0);
		return now > 1 && now !== pid;
	}, 20_000);
	await waitFor("the main conversation again", mainShown, 15_000, piScreen);
	assert.equal(mark(), "");
	await waitFor("the session selected in the new list", () => / 2✓/.test(selected()), 15_000, listScreen);
	await key("Space");
	await waitFor("its subagents", () => /\/root\/beta/.test(listScreen()), 15_000, listScreen);
	await key("j", "j");
	await waitFor("beta's agent view", inAgentView("beta"), 10_000, piScreen);

	// Another row (the session itself): the view the deck opened is closed again.
	await key("k", "k");
	await waitFor("the main conversation again", mainShown, 10_000, piScreen);
	assert.equal(mark(), "");

	// C-l on a subagent row focuses the pi; the mark goes, and moving on leaves the view to the user.
	await key("j");
	await waitFor("alpha's agent view", inAgentView("alpha"), 10_000, piScreen);
	await key("C-l");
	await waitFor("the pi slot focused", () => d.activeIndex() === "3");
	assert.equal(mark(), "", "focusing the pi took the view over");
	d.tmux(["select-pane", "-t", list]);
	await key("k");
	await sleep(1500);
	assert.ok(inAgentView("alpha")(), `the view stays: ${piScreen()}`);
	// The package's own keys from here: Esc → the tree, Esc → the main conversation.
	await d.keys(pi, ["Escape"]);
	await waitFor("the agents tree", () => piScreen().includes("Agents tree"), 10_000, piScreen);
	await d.keys(pi, ["Escape"]);
	await waitFor("main again", mainShown, 10_000, piScreen);
});
