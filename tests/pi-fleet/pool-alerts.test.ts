import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdInRepo, formatBatch, parseAlerts, parseRegistry, readNew } from "../../pi/extensions/pool-alerts.ts";

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
	assert.deepEqual(parseRegistry("dir=/a\nrepo=/b\n"), { dir: "/a", repo: "/b" });
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
