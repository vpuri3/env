import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdInRepo, formatBatch, parseAlerts, parseRegistry, readNew, shouldDeliver, receivesPoolAlerts, staleStep, parsePoolOwner, STALE_MS } from "../../pi/extensions/pool-alerts.ts";

test("parse skips malformed lines and formats a capped batch", () => {
	const al = parseAlerts('junk\n{"pool":"p","kind":"item_failed","item":"a","msg":"boom","dir":"/d"}\n[1]\n{"pool":', "/x");
	assert.equal(al.length, 1);
	const many = Array.from({ length: 23 }, () => al[0]);
	const lines = formatBatch(many).split("\n");
	assert.equal(lines[0], "[pool p] item_failed a: boom");
	assert.equal(lines[20], "3 more");
	assert.equal(lines[21], "Details: sjob pool status /d · ack: sjob pool alerts /d --ack");
});

test("registry, cwd filter, tail with truncation", () => {
	assert.deepEqual(parseRegistry("dir=/a\nrepo=/b\n"), { dir: "/a", repo: "/b", scope: "repo", owner: "" });
	assert.equal(parseRegistry("dir=/a\n"), undefined);
	const t = mkdtempSync(join(tmpdir(), "pa-"));
	mkdirSync(join(t, "r/sub"), { recursive: true });
	assert.ok(cwdInRepo(join(t, "r/sub"), join(t, "r")));
	assert.ok(!cwdInRepo(t, join(t, "r")));
	const f = join(t, "a.jsonl");
	writeFileSync(f, "x\n");
	let r = readNew(f, 2);
	assert.equal(r.text, "");
	appendFileSync(f, "y\nzpartial");
	r = readNew(f, r.offset);
	assert.equal(r.text, "y\n");
	writeFileSync(f, "n\n"); // rotated/truncated
	assert.equal(readNew(f, r.offset).text, "n\n");
});

test("routing", () => {
	assert.ok(shouldDeliver(["me"], "me", "session", false));
	assert.ok(!shouldDeliver(["x"], "me", "repo", true));
	assert.ok(shouldDeliver([], "me", "repo", true));
	assert.ok(!shouldDeliver([], "me", "repo", false));
	assert.ok(!shouldDeliver([], "me", "cluster", true));
	assert.deepEqual(parseAlerts('{"kind":"k","owners":["a","b"]}\n{"kind":"k"}\n')
		.map((a) => a.owners), [["a", "b"], []]);
});

test("registry new fields and pool-owner", () => {
	assert.deepEqual(parseRegistry("dir=/a\nrepo=/b\nscope=session\nowner=s1\n"), { dir: "/a", repo: "/b", scope: "session", owner: "s1" });
	assert.equal(parseRegistry("dir=/a\nrepo=/b\nscope=cluster\nowner=\n")?.scope, "cluster");
	assert.equal(parsePoolOwner("#!/bin/bash\n# pool-owner: s9\necho"), "s9");
	assert.equal(parsePoolOwner("#!/bin/bash\n\n\n# pool-owner: s9"), "");
	const s = { dir: "/a", repo: "/b", scope: "session" as const, owner: "me" };
	assert.ok(receivesPoolAlerts(s, "me", false, false));
	assert.ok(!receivesPoolAlerts(s, "you", true, false));
	assert.ok(receivesPoolAlerts(s, "you", false, true));
	assert.ok(!receivesPoolAlerts({ ...s, scope: "cluster", owner: "" }, "me", true, false));
});

test("stale episode fires once and resets", () => {
	const old = STALE_MS + 1;
	let r = staleStep(false, old, old);
	assert.deepEqual(r, { stale: true, fire: true });
	r = staleStep(r.stale, old, old);
	assert.equal(r.fire, false);
	r = staleStep(r.stale, 5, old);
	assert.deepEqual(r, { stale: false, fire: false });
	assert.ok(staleStep(r.stale, old, old).fire);
});
