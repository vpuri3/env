// Registry contract test (design §13, §15): the private pi-subagent-manager format the fleet
// folds (registry.ts) and classifies (session index, §6) must match the installed package's
// source. Rerun before upgrading pi-subagent-manager (pinned in pi/packages.txt). Reads the
// installed package only: $PI_FLEET_SUBAGENT_MANAGER, else ~/.pi/agent/npm/node_modules/
// pi-subagent-manager; skipped if neither exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REGISTRY_DELTA_ENTRY, REGISTRY_ENTRY, THREAD_ENTRY, THREAD_STATES } from "../../pi/extensions/fleet/registry.ts";

const pkg = process.env.PI_FLEET_SUBAGENT_MANAGER || join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagent-manager");
const skip = existsSync(join(pkg, "src", "types.ts")) ? false : `pi-subagent-manager not installed at ${pkg}`;
const src = (file: string) => readFileSync(join(pkg, "src", file), "utf8");

test("the installed version is the pinned one", { skip }, () => {
	const pinned = readFileSync(new URL("../../pi/packages.txt", import.meta.url), "utf8").match(/npm:pi-subagent-manager@(\S+)/)?.[1];
	const installed = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
	assert.equal(installed, pinned, "installed pi-subagent-manager differs from pi/packages.txt; check this contract before pinning it");
});

test("ThreadState is the set the fold maps (starting/running/paused/completed/failed/stopped)", { skip }, () => {
	const union = src("types.ts").match(/export type ThreadState\s*=\s*([^;]+);/)?.[1];
	assert.ok(union, "ThreadState not found in src/types.ts");
	const states = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
	assert.deepEqual(states, [...THREAD_STATES].sort());
});

test("ThreadView still has the fields the fold reads (path, type, state, task, updatedAt)", { skip }, () => {
	const types = src("types.ts");
	const view = types.slice(types.indexOf("export interface ThreadView"));
	const body = view.slice(0, view.indexOf("\n}"));
	for (const field of ["path: string", "type: string", "state: ThreadState", "task: string", "updatedAt"]) {
		assert.ok(body.includes(field), `ThreadView lacks ${field}`);
	}
});

test("registry entry types and the delta shape ({thread} or {path, view})", { skip }, () => {
	const registry = src("orch/registry.ts");
	assert.ok(registry.includes(`REGISTRY_ENTRY = "${REGISTRY_ENTRY}"`));
	assert.ok(registry.includes(`REGISTRY_DELTA_ENTRY = "${REGISTRY_DELTA_ENTRY}"`));
	assert.match(registry, /rootSessionId/);
	assert.match(registry, /version:\s*1/);
});

test("subagent sessions: thread ownership entry {rootId, threadPath} and the `<type> <path>` name", { skip }, () => {
	const runtime = src("orch/runtime.ts");
	assert.ok(runtime.includes(`THREAD_OWNERSHIP_TYPE = "${THREAD_ENTRY}"`));
	assert.match(runtime, /appendCustomEntry\(THREAD_OWNERSHIP_TYPE, \{\s*rootId,/);
	assert.match(runtime, /threadPath/);
	// registry.ts SUBAGENT_NAME (/^\S+ \/\S*$/) relies on this name format.
	assert.match(runtime, /appendSessionInfo\(`\$\{options\.type\.name\} \$\{options\.path\}`\)/);
});
