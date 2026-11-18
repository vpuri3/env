// Tests for pi/extensions/fleet/title-backfill.ts (`pi-fleet title-backfill`): which closed
// sessions get a title, with fake models; and the write through pi's real SessionManager.
// Everything lives in a temp dir (sessions, status, cache); nothing touches the user's state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { locatePiPackages, usePiPackages } from "../../pi/extensions/fleet/cli.ts";
import { backfill, lastModel, piSessionWriter } from "../../pi/extensions/fleet/title-backfill.ts";
import { TITLE_ENTRY, titleState } from "../../pi/extensions/fleet/title.ts";
import { parseJsonl } from "../../pi/extensions/fleet/registry.ts";

const HOUR = 3_600_000;
let seq = 0;
const id8 = () => (++seq).toString(16).padStart(8, "0");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-fleet-backfill-"));
	const sessions = join(root, "sessions");
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: root,
		PI_CODING_AGENT_SESSION_DIR: sessions,
		PI_FLEET_STATE_DIR: join(root, "state"),
		PI_FLEET_CACHE_DIR: join(root, "cache"),
	};
	mkdirSync(join(sessions, "--work--"), { recursive: true });
	mkdirSync(join(root, "state", "status"), { recursive: true });
	const now = Date.now();
	const write = (name: string, opts: { ageMs?: number; entries?: any[]; header?: any } = {}) => {
		const id = `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}`;
		const ts = new Date(now - (opts.ageMs ?? HOUR)).toISOString();
		let parent: string | null = null;
		const lines = [{ type: "session", version: 3, id, timestamp: ts, cwd: "/work", ...opts.header }];
		for (const e of opts.entries ?? [userMsg(`about ${name}`), agentMsg("ok")]) {
			const eid = id8();
			lines.push({ ...e, id: eid, parentId: parent, timestamp: ts });
			parent = eid;
		}
		const path = join(sessions, "--work--", `${name}_${id}.jsonl`);
		writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		const t = (now - (opts.ageMs ?? HOUR)) / 1000;
		utimesSync(path, t, t);
		return { id, path };
	};
	const status = (id: string, path: string, pid: number) =>
		writeFileSync(
			join(root, "state", "status", `${id}.json`),
			JSON.stringify({ v: 1, sessionId: id, sessionFile: path, cwd: "/work", host: hostname(), pid, state: "idle", acked: true, since: "", subagents: {}, heartbeat: new Date().toISOString() }),
		);
	return { root, env, now, write, status, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const userMsg = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const agentMsg = (text: string, provider = "faux", model = "faux-1") => ({ type: "message", message: { role: "assistant", provider, model, content: [{ type: "text", text }] } });

function fakeModels() {
	const all = [
		{ provider: "faux", id: "faux-1" },
		{ provider: "faux", id: "faux-mini", cost: { input: 0.1, output: 0.4 } },
	];
	const calls: { model: string; prompt: string }[] = [];
	return {
		calls,
		models: {
			getAvailable: () => all,
			find: (p: string, id: string) => all.find((m) => m.provider === p && m.id === id),
			streamSimple: (m: any, ctx: any) => {
				const prompt = ctx.messages[0].content[0].text as string;
				calls.push({ model: `${m.provider}/${m.id}`, prompt });
				const about = prompt.match(/about (\w+)/)?.[1] ?? "x";
				return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: `Title for ${about}` }] }) };
			},
		},
	};
}

test("backfill: titles the newest closed unnamed mains only, up to the limit", async () => {
	const f = fixture();
	try {
		const old = f.write("old", { ageMs: 5 * HOUR });
		const newer = f.write("newer", { ageMs: 2 * HOUR });
		const newest = f.write("newest", { ageMs: 1 * HOUR });
		const named = f.write("named", { entries: [userMsg("about named"), agentMsg("ok"), { type: "session_info", name: "mine" }] });
		const cleared = f.write("cleared", { entries: [userMsg("about cleared"), { type: "session_info", name: "" }] });
		const recent = f.write("recent", { ageMs: 60_000 });
		const live = f.write("live");
		f.status(live.id, live.path, process.pid);
		const crashed = f.write("crashed", { ageMs: 3 * HOUR });
		f.status(crashed.id, crashed.path, 2 ** 22 + 12345); // no such pid: crashed, so closed
		const sub = f.write("sub", {
			header: { parentSession: "/x.jsonl" },
			entries: [{ type: "custom", customType: "pi-subagent:thread:v1", data: { rootId: "R", threadPath: "/a" } }, userMsg("about sub")],
		});
		const empty = f.write("empty", { entries: [agentMsg("no user")] });
		const fm = fakeModels();
		const writes: [string, string, any][] = [];
		const r = await backfill({ limit: 3 }, { models: fm.models, write: (p, t, d) => writes.push([p, t, d]) }, f.env);
		assert.deepEqual(writes.map(([p, t]) => [p, t]), [
			[newest.path, "Title for newest"],
			[newer.path, "Title for newer"],
			[crashed.path, "Title for crashed"],
		]);
		assert.deepEqual(r.failed, []);
		assert.ok(fm.calls.every((c) => c.model === "faux/faux-mini"));
		assert.equal(writes[0]![2].turns, 1);
		// Limit 10: the old one too, still none of the others.
		const writes2: string[] = [];
		await backfill({ limit: 10 }, { models: fm.models, write: (p) => writes2.push(p) }, f.env);
		assert.ok(writes2.includes(old.path));
		for (const skip of [named, cleared, recent, live, sub, empty]) assert.ok(!writes2.includes(skip.path), skip.path);
		// Dry run writes nothing.
		const writes3: string[] = [];
		await backfill({ limit: 10, dryRun: true }, { models: fm.models, write: (p) => writes3.push(p) }, f.env);
		assert.deepEqual(writes3, []);
	} finally {
		f.cleanup();
	}
});

test("backfill --retitle: rewrites our titles and unnamed sessions, never a user's name", async () => {
	const f = fixture();
	try {
		const ours = f.write("ours", {
			entries: [userMsg("about ours"), agentMsg("ok"), { type: "session_info", name: "Old" }, { type: "custom", customType: TITLE_ENTRY, data: { entryId: "PLACEHOLDER" } }],
		});
		// Point the marker at the session_info entry's real id.
		const lines = readFileSync(ours.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		lines[4].data.entryId = lines[3].id;
		writeFileSync(ours.path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
		utimesSync(ours.path, (f.now - HOUR) / 1000, (f.now - HOUR) / 1000);
		const unnamed = f.write("unnamed");
		const named = f.write("named", { entries: [userMsg("about named"), { type: "session_info", name: "mine" }] });
		const fm = fakeModels();
		const plain: string[] = [];
		await backfill({}, { models: fm.models, write: (p) => plain.push(p) }, f.env);
		assert.deepEqual(plain, [unnamed.path]);
		const writes: [string, string][] = [];
		await backfill({ retitle: true }, { models: fm.models, write: (p, t) => writes.push([p, t]) }, f.env);
		assert.deepEqual(writes.sort(), [[ours.path, "Title for ours"], [unnamed.path, "Title for unnamed"]].sort());
		assert.ok(!writes.some(([p]) => p === named.path));
	} finally {
		f.cleanup();
	}
});

test("backfill: model failures are reported, not written", async () => {
	const f = fixture();
	try {
		f.write("a");
		const models = { ...fakeModels().models, streamSimple: () => ({ result: async () => ({ stopReason: "error", errorMessage: "nope", content: [] }) }) };
		const writes: string[] = [];
		const r = await backfill({}, { models, write: (p) => writes.push(p) }, f.env);
		assert.deepEqual(writes, []);
		assert.equal(r.failed.length, 1);
		assert.match(r.failed[0]!.error, /nope/);
	} finally {
		f.cleanup();
	}
});

test("lastModel: last assistant message, else model_change", () => {
	assert.deepEqual(lastModel([agentMsg("x", "anthropic", "claude-opus-5-5"), userMsg("y")]), { provider: "anthropic", id: "claude-opus-5-5" });
	assert.deepEqual(lastModel([{ type: "model_change", provider: "openai", modelId: "gpt-5" }]), { provider: "openai", id: "gpt-5" });
	assert.equal(lastModel([userMsg("y")]), undefined);
});

const packages = locatePiPackages();
test("piSessionWriter: pi's SessionManager appends a session_info pi reads back, marked as ours", { skip: !packages && "pi packages not found" }, async () => {
	await usePiPackages(packages!);
	const f = fixture();
	try {
		const s = f.write("w");
		const before = readFileSync(s.path, "utf8");
		const write = await piSessionWriter();
		write(s.path, "Backfilled title", { turns: 1, backfill: true });
		const after = readFileSync(s.path, "utf8");
		assert.ok(after.startsWith(before), "only appended");
		const entries = parseJsonl(after);
		const info = entries.filter((e) => e.type === "session_info");
		assert.equal(info.length, 1);
		assert.equal(info[0]!.name, "Backfilled title");
		assert.equal(info[0]!.parentId, parseJsonl(before).at(-1)!.id);
		assert.equal(entries.at(-1)!.customType, TITLE_ENTRY);
		assert.deepEqual(titleState(entries), { ours: true, name: "Backfilled title", titles: 1, lastTurns: 1 });
		const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as any;
		assert.equal(SessionManager.open(s.path).getSessionName(), "Backfilled title");
	} finally {
		f.cleanup();
	}
});
