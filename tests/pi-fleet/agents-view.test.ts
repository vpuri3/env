// fleet/agents-view.ts + subagent-viewer.ts (pi-deck-design.md §16), end to end: a real pi TUI with the
// fleet extension, subagent-viewer and the pinned pi-subagent-manager, in a throwaway tmux server
// (support/deck-rig.ts: `tmux -L decktest-<pid>-p3-<n>-solo`, never `default` or `pifleet`). Two finished
// subagents are restored from a stored session's registry entry (the package's own format). Over the
// control socket:
//   agents-view /root/alpha  → the package's LiveAgentView for alpha (ok:true), as `/agents tree` → Enter
//   agents-view again        → already:true;  agents-view /root/beta → alpha's overlay closed, beta's shown
//   agents-close             → closed (untouched);  after a key reached it → not closed, Esc → tree → main
//   agents-view /root/gone   → ok:false (unknown), and no overlay is left open
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { DeckRig, fleetDir, repo, skipDeck, sleep, waitFor } from "./support/deck-rig.ts";

const PACKAGE = join(process.env.PI_SUBAGENT_MANAGER_DIR ?? join(homedir(), ".pi/agent/npm/node_modules/pi-subagent-manager"));
const skip = skipDeck || (existsSync(join(PACKAGE, "src/index.ts")) ? false : "pi-subagent-manager not installed");

/**
 * A stored session with two completed subagents in pi-subagent-manager's registry format
 * (orch/registry.ts, SavedThread). Written before pi starts: a registry appended at runtime would be
 * superseded by the package's own (empty) registry on /reload.
 */
function sessionWithAgents(dir: string, cwd: string): string {
	mkdirSync(dir, { recursive: true });
	const id = "01a1ea29-0000-7000-8000-00000000a9e5";
	const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	const ts = new Date().toISOString();
	const now = Date.now();
	const thread = (name: string, i: number) => ({
		view: { path: `/root/${name}`, parent: "/root", owner: "/root", type: "coder", state: "completed", task: `task of ${name}`, status: "done", output: `output of ${name}`, createdAt: now - i, updatedAt: now - i, lastStartedAt: now - i },
		definition: { name: "coder", description: "test coder", systemPrompt: "" },
	});
	const entries = [
		{ type: "session", version: 3, id, timestamp: ts, cwd },
		{ type: "message", id: "a1", parentId: null, timestamp: ts, message: { role: "user", content: "hi", timestamp: now } },
		{ type: "custom", customType: "pi-subagent:registry:v1", data: { version: 1, rootSessionId: id, threads: [thread("alpha", 1), thread("beta", 2)] }, id: "r1", parentId: "a1", timestamp: ts },
	];
	writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return file;
}

const rigs: DeckRig[] = [];
after(() => {
	for (const r of rigs) r.close();
});

function request(sock: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const c = createConnection(sock);
		let buf = "";
		c.setEncoding("utf8");
		c.on("error", reject);
		c.on("data", (d: string) => {
			buf += d;
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				c.end();
				resolve(JSON.parse(buf.slice(0, nl)));
			}
		});
		c.write(`${JSON.stringify(message)}\n`);
	});
}

test("agents-view shows a subagent's LiveAgentView; agents-close only when untouched; unknown paths fail", { skip, timeout: 180_000 }, async () => {
	const d = new DeckRig();
	rigs.push(d);
	const stored = sessionWithAgents(join(d.sessions, "x"), d.work);
	// The fleet extension with agents-view registered on the same pi (until fleet/index.ts registers it;
	// registering twice only replaces the control handlers).
	const fleet = join(d.root, "fleet-with-agents-view.ts");
	writeFileSync(
		fleet,
		`import fleet from ${JSON.stringify(join(fleetDir, "index.ts"))};\nimport { register } from ${JSON.stringify(join(fleetDir, "agents-view.ts"))};\nexport default function (pi) { fleet(pi); register(pi); }\n`,
	);
	const base = d.piArgv.map((a) => (a === fleetDir ? fleet : a));
	const argv = [...base, "-e", join(repo, "pi/extensions/subagent-viewer.ts"), "-e", PACKAGE, "--session", stored];
	const S = "solo";
	d.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "main", "-x", "160", "-y", "48", "-c", d.work, "--", ...argv], S);
	const pane = d.tmux(["display-message", "-p", "-t", "main:", "#{pane_id}"], S);
	const show = () => d.screen(pane, S);
	await d.ready(pane, S);


	const run = join(d.env.PI_FLEET_RUNTIME_DIR!);
	const sock = await waitFor("the control socket", () => {
		const f = readdirSync(run).find((n) => n.endsWith(".pi.sock") && !n.startsWith("."));
		return f ? join(run, f) : undefined;
	}, 20_000);
	const call = async (m: Record<string, unknown>) => {
		for (let i = 0; ; i++) {
			try {
				return await request(sock, m);
			} catch (error) {
				if (i > 20) throw error;
				await sleep(200);
			}
		}
	};
	// The overlays are fullscreen: the main editor's mode line shows only without one.
	const mainShown = () => / (INSERT|NORMAL)\s*$/m.test(show()) && !show().includes("Agents tree");
	const inAgentView = (name: string) => () => {
		const s = show();
		// LiveAgentView's header, steer input and footer (with subagent-viewer's Ctrl+T rewrite).
		return s.includes(`/root/${name} · `) && s.includes("Steer >") && s.includes("Ctrl+T thinking") && s.includes("Esc tree") && !mainShown();
	};

	let r = await call({ type: "agents-view", path: "/root/alpha" });
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.equal(r.already, false);
	await waitFor("alpha's agent view", inAgentView("alpha"), 5_000, show);
	assert.match(show(), /output of alpha|task of alpha/);

	r = await call({ type: "agents-view", path: "/root/alpha" });
	assert.deepEqual([r.ok, r.already], [true, true], JSON.stringify(r));

	r = await call({ type: "agents-view", path: "/root/beta" });
	assert.equal(r.ok, true, JSON.stringify(r));
	await waitFor("beta's agent view", inAgentView("beta"), 5_000, show);

	// Untouched: agents-close closes it; the main editor is back.
	r = await call({ type: "agents-close" });
	assert.deepEqual([r.ok, r.closed], [true, true], JSON.stringify(r));
	await waitFor("main again", mainShown, 5_000, show);
	r = await call({ type: "agents-close" });
	assert.deepEqual([r.ok, r.closed], [true, false], "nothing open");

	// Touched: a key reached the overlay, so agents-close leaves it; Esc → tree, Esc → main (the package's own).
	r = await call({ type: "agents-view", path: "/root/alpha" });
	assert.equal(r.ok, true, JSON.stringify(r));
	await waitFor("alpha's agent view", inAgentView("alpha"), 5_000, show);
	await d.keys(pane, ["PageUp"], S);
	r = await call({ type: "agents-close" });
	assert.deepEqual([r.ok, r.closed], [true, false], JSON.stringify(r));
	assert.ok(show().includes("/root/alpha"), show());
	await d.keys(pane, ["Escape"], S);
	await waitFor("the agents tree", () => show().includes("Agents tree"), 5_000, show);
	assert.ok(show().includes("/root/beta"), "the tree lists both agents");
	await d.keys(pane, ["Escape"], S);
	await waitFor("main again", mainShown, 5_000, show);

	// Unknown (reaped / never existed): ok:false and no overlay left behind.
	r = await call({ type: "agents-view", path: "/root/gone" });
	assert.equal(r.ok, false, JSON.stringify(r));
	assert.match(String(r.error), /unknown agent \/root\/gone/);
	await sleep(300);
	assert.ok(mainShown(), show());
	r = await call({ type: "agents-close" });
	assert.equal(r.closed, false);

	// Bad requests.
	r = await call({ type: "agents-view", path: "not a path" });
	assert.equal(r.ok, false);
});
