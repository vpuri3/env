// The deck's list (deck-view.ts, `pi-fleet deck`) end to end on throwaway tmux servers
// (support/deck-harness.ts: `tmux -L decktest-v<pid>-<n>`, never `default` or `pifleet`; the CLI runs with
// PI_FLEET_TMUX_GUARD=1). pi is the node stub; keys go to the list pane with send-keys, results come from
// capture-pane, list-panes and a tmux wrapper that logs the list's tmux calls. The popup test uses the §11
// harness: a harness server whose pane runs a real client of an outer server, which opens the deck popup.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locatePiPackages } from "../../pi/extensions/fleet/cli.ts";
import { Deck, haveTmux, realTmux, sleep, socketDir, waitFor } from "./support/deck-harness.ts";

const skip = !haveTmux ? "tmux not installed" : !locatePiPackages() ? "pi's pi-tui not found (pi not on PATH)" : false;
const live: Deck[] = [];
after(() => {
	for (const d of live) d.close();
});
function deck(opts: { pathPrefix?: string } = {}): Deck {
	const d = new Deck(opts);
	live.push(d);
	return d;
}

/** A tmux wrapper on the deck server's PATH that logs every call (the list's included). */
function tmuxLogger(): { dir: string; log: string; calls(label: string): string[]; clear(): void; remove(): void } {
	const dir = mkdtempSync(join(tmpdir(), "pdvw-"));
	const log = join(dir, "calls.log");
	writeFileSync(join(dir, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realTmux}' "$@"\n`);
	chmodSync(join(dir, "tmux"), 0o755);
	writeFileSync(log, "");
	return {
		dir,
		log,
		calls: (label) => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith(`-L ${label} `)),
		clear: () => writeFileSync(log, ""),
		remove: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** waitFor, and on a timeout the list's screen in the error. */
async function waitList<T>(d: Deck, what: string, probe: () => T | undefined | false, timeoutMs?: number): Promise<T> {
	try {
		return await waitFor(what, probe, timeoutMs);
	} catch (error) {
		throw new Error(`${(error as Error).message}; the list:\n${d.tryTmux(["capture-pane", "-p", "-t", "=deck:=deck.0"]) ?? "(gone)"}`);
	}
}

/** List rows of the stub sessions (no status files: "new session"), the status line not counted. */
const rowCount = (d: Deck) => (d.listScreen().match(/^. ⟳ new session/gm) ?? []).length;

test("j/k swap the real slot (a burst is one swap-pane), Enter focuses it, a dead slot pi gives way to the next row", { skip, timeout: 90_000 }, async () => {
	const logger = tmuxLogger();
	const d = deck({ pathPrefix: logger.dir });
	try {
		d.start();
		const s1 = await d.open();
		const s2 = await d.open();
		const s3 = await d.open();
		// The list selects what `open` showed; three rows without status files yet ("new session"),
		// newest first: s3 s2 s1.
		await waitFor("three rows", () => rowCount(d) === 3);
		assert.equal(d.slot().session, s3.id);
		assert.match(d.listScreen().split("\n")[1]!, /^› ⟳ new session/);
		d.keys("j");
		await waitFor("s2 in the slot", () => d.slot().session === s2.id);
		await sleep(300);
		logger.clear();
		// Five moves in one burst: s1 s2 s1 s2 s1 → one swap.
		d.keys("j", "k", "j", "k", "j");
		await waitFor("s1 in the slot", () => d.slot().session === s1.id);
		await sleep(400);
		const swaps = logger.calls(d.label).filter((l) => /swap-pane/.test(l));
		assert.equal(swaps.length, 1, swaps.join("\n"));
		// A highlight is one read and one write, no node spawned per key (the wrapper sees tmux only).
		assert.ok(logger.calls(d.label).length <= 3, logger.calls(d.label).join("\n"));
		d.tmux(["select-pane", "-t", "=deck:=deck.0"]);
		d.keys("Enter");
		await waitFor("slot focused", () => d.activeIndex() === "1");
		// s2 shown, then its pi exits: the slot shows the next row's pi (s1), s2's pane goes.
		d.keys("k");
		await waitFor("s2 in the slot", () => d.slot().session === s2.id);
		writeFileSync(join(d.stub, `${s2.id}.exit`), "0\n");
		await waitFor("s1 replaces s2", () => d.slot().session === s1.id && !d.panes().some((p) => p.pane === s2.pane));
		await waitFor("two rows left", () => rowCount(d) === 2);
		// The selection follows the replacement: the second of the two rows (s3 s1).
		assert.match(d.listScreen().split("\n")[2]!, /^› ⟳ new session/);
	} finally {
		d.close();
		logger.remove();
	}
});

test("status writes reach the list within 300 ms (fs.watch); the outer @pi_deck_bar follows and is cleared on exit; 1 s watched acks", { skip, timeout: 90_000 }, async () => {
	const d = deck();
	try {
		d.start();
		const s = await d.open();
		// An outer server for the bar (what @deck_outer names after a popup attach).
		d.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "main", "/bin/sh"], "outer");
		const outer = d.tmux(["display-message", "-p", "#{socket_path}"], "outer");
		d.tmux(["set", "-g", "@deck_outer", `${outer}|/dev/fake`]);
		await sleep(300);
		const t0 = Date.now();
		d.writeStatus(s.id, { name: "bar test", state: "running", sub: "tool:bash", pid: d.stubPid(s.id) });
		await waitFor("the row renamed", () => d.listScreen().includes("bar test"), 3000, 10);
		const ms = Date.now() - t0;
		assert.ok(ms < 300, `list updated after ${ms} ms`);
		assert.equal(d.tryTmux(["show", "-gv", "@pi_deck_bar"], "outer") ?? "", "", "nothing needs the user yet");
		// It finishes (waiting, run r1): the bar shows it. Nobody is attached: no ack.
		d.writeStatus(s.id, { name: "bar test", state: "waiting", acked: false, runId: "r1", pid: d.stubPid(s.id) });
		await waitFor("the outer bar", () => d.tryTmux(["show", "-gv", "@pi_deck_bar"], "outer") === "π #[fg=yellow]1◐#[default] ", 3000);
		await sleep(1300);
		assert.equal(existsSync(join(d.statusDir, `${s.id}.seen`)), false, "no client attached: not seen");
		// A client attaches (resize → the ack re-arms): after 1 s shown, acknowledged.
		d.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "h", "-x", "150", "-y", "40", `env -u TMUX ${realTmux} -L ${d.label} attach -t deck`], "h");
		await waitFor("the deck client", () => d.tmux(["list-clients", "-F", "#{client_name}"]) !== "");
		const attached = Date.now();
		const seen = await waitFor("the .seen file", () => (existsSync(join(d.statusDir, `${s.id}.seen`)) ? Date.now() : undefined), 5000, 20);
		assert.ok(seen - attached >= 900, `acked after ${seen - attached} ms`);
		assert.deepEqual(JSON.parse(readFileSync(join(d.statusDir, `${s.id}.seen`), "utf8")), { runId: "r1" });
		// The list exits with the server: the bar is cleared.
		d.tmux(["kill-server"]);
		await waitFor("bar cleared", () => (d.tryTmux(["show", "-gv", "@pi_deck_bar"], "outer") ?? "") === "", 5000);
	} finally {
		d.close();
	}
});

test("a subagent row previews its transcript in the holder (fs.watch on its JSONL refreshes it)", { skip, timeout: 60_000 }, async () => {
	const d = deck();
	try {
		// A closed session (old run) with one subagent thread, /runner, and that thread's transcript.
		const root = "00000000-0000-7000-8000-0000000f0001";
		const dir = join(d.sessions, "--work--");
		mkdirSync(dir, { recursive: true });
		const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
		writeFileSync(
			join(dir, `2026-11-17T10-00-00-000Z_${root}.jsonl`),
			line({ type: "session", version: 3, id: root, timestamp: "2026-11-17T10:00:00.000Z", cwd: d.work }) +
				line({ type: "session_info", id: "a1", parentId: null, name: "old run" }) +
				line({ type: "custom", customType: "pi-subagent:registry:v1", id: "a2", parentId: "a1", data: { version: 1, rootSessionId: root, threads: [{ view: { path: "/runner", type: "coder", state: "completed", task: "run it" } }] } }),
		);
		const sub = join(dir, "2026-11-17T10-00-01-000Z_00000000-0000-7000-8000-0000000f0002.jsonl");
		const transcript = readFileSync(new URL("./fixtures/subagent-transcript.jsonl", import.meta.url), "utf8").replaceAll("00000000-0000-7000-8000-00000000a003", root);
		writeFileSync(sub, transcript);
		d.start();
		// Its repo has only closed sessions: a group of its own, folded.
		await waitList(d, "the closed-only repo group", () => /^.▸ .*\(1 closed\)/m.test(d.listScreen()));
		// Search it (a search shows folded rows), back to NORMAL, Space: its subagents.
		d.keys("/", "old run", "Escape");
		await waitList(d, "old run selected, NORMAL", () => /^› .*old run/m.test(d.listScreen()) && /^ NORMAL /m.test(d.listScreen()));
		d.keys("Space");
		await waitList(d, "the /runner row", () => /\/runner/.test(d.listScreen()));
		d.keys("j");
		await waitList(d, "the holder shows the transcript", () => d.slot().role === "preview" && /Checking the logs/.test(d.slotScreen()));
		assert.match(d.slotScreen(), /loss 0\.12/);
		// The subagent writes on: the holder follows (fs.watch on its JSONL, no timer).
		appendFileSync(sub, line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "fresh tail line" }] }, id: "t9", parentId: "t0000004" }));
		await waitList(d, "the new tail", () => /fresh tail line/.test(d.slotScreen()), 3000);
	} finally {
		d.close();
	}
});

/**
 * The §11 harness: an outer server (prefix C-s, a shell pane, plus a window with a hand-started "pi")
 * and a harness server whose pane runs a real client of it; keys typed there reach the outer client.
 */
async function harness(d: Deck): Promise<{ keys: (...k: string[]) => void; outerSocket: string }> {
	const outerConf = join(d.root, "outer.conf");
	writeFileSync(outerConf, ["set -g prefix C-s", "unbind C-b", "bind C-s send-prefix", "set -s escape-time 0", "set -g status off"].join("\n"));
	d.tmux(["-f", outerConf, "new-session", "-d", "-s", "main", "-x", "160", "-y", "48", "/bin/sh"], "outer");
	const outerSocket = d.tmux(["display-message", "-p", "#{socket_path}"], "outer");
	d.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "h", "-x", "160", "-y", "48", `env -u TMUX ${realTmux} -L ${d.label}-outer attach -t main`], "h");
	d.tmux(["set", "-g", "escape-time", "0"], "h");
	await waitList(d, "the outer client", () => d.tmux(["list-clients", "-F", "#{client_name}"], "outer") !== "");
	await sleep(300);
	return { keys: (...k: string[]) => void d.tmux(["send-keys", "-t", "h", ...k], "h"), outerSocket };
}

test("popup: q detaches; an outside row previews its pane in the holder; Enter closes the popup and jumps the outer client there", { skip, timeout: 120_000 }, async () => {
	const d = deck();
	try {
		d.start();
		const s = await d.open();
		const h = await harness(d);
		// A pi started by hand in the outer tmux (window 1): its status file names the outer pane.
		const outsidePane = d.tmux(["new-window", "-d", "-t", "main:1", "-P", "-F", "#{pane_id}", "/bin/sh"], "outer");
		d.tmux(["send-keys", "-t", outsidePane, "echo OUTSIDE-MARK $((40+2))", "Enter"], "outer");
		const out = "00000000-0000-7000-8000-0000000f00d1";
		d.writeStatus(out, { name: "notes outside", state: "waiting", acked: false, runId: "r1", tmux: { socket: h.outerSocket, piPane: outsidePane, windowIndex: 1 } });
		h.keys("pi-fleet attach", "Enter");
		await waitList(d, "the deck client in the popup", () => d.tmux(["list-clients", "-F", "#{client_name}"]) !== "", 15_000);
		const outerClient = d.tmux(["list-clients", "-F", "#{client_name}"], "outer");
		await waitList(d, "the outside group", () => /outside \(your tmux\)/.test(d.listScreen()) && /notes outside/.test(d.listScreen()));
		// `open` focused the slot (the stub pi): C-h back to the list, q detaches; the popup closes, the deck stays.
		h.keys("C-h");
		await waitList(d, "the list focused", () => d.activeIndex() === "0");
		h.keys("q");
		await waitList(d, "deck client gone", () => d.tmux(["list-clients", "-F", "#{client_name}"]) === "");
		assert.ok(d.tryTmux(["has-session", "-t", "=deck"]) !== undefined, "detaching never stops the deck");
		await sleep(300);
		h.keys("pi-fleet attach", "Enter");
		await waitList(d, "the popup again", () => d.tmux(["list-clients", "-F", "#{client_name}"]) !== "", 15_000);
		// Search the outside row: the holder shows its card and one capture of its pane.
		h.keys("/", "notes");
		await waitList(d, "the outside pane's capture in the holder", () => d.slot().role === "preview" && /notes outside/.test(d.slotScreen()) && /OUTSIDE-MARK 42/.test(d.slotScreen()));
		// Enter: the popup closes and the outer client lands on that pane.
		h.keys("Enter");
		await waitList(d, "deck client gone", () => d.tmux(["list-clients", "-F", "#{client_name}"]) === "");
		await waitList(d, "the outer client jumped", () => d.tmux(["list-clients", "-F", "#{client_name} #{pane_id}"], "outer") === `${outerClient} ${outsidePane}`);
		assert.equal(d.tryTmux(["show", "-gv", "@deck_jump"]) ?? "", "", "@deck_jump consumed");
		// The deck session is untouched.
		assert.ok(d.panes().some((p) => p.session === s.id && p.role === "pi"));
	} finally {
		d.close();
	}
});

test("leftover throwaway sockets of this run are gone", { skip: !haveTmux }, () => {
	for (const d of live) d.close();
	const mine = readdirSync(socketDir).filter((n) => n.startsWith(`decktest-v${process.pid}-`));
	assert.deepEqual(mine, []);
});
