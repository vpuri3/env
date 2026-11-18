// capture-pane plumbing in sessions-view.ts (the deck list's outside-row preview): control-character
// stripping, gone-vs-slow classification, capturePane against fake tmux binaries.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { locatePiPackages, usePiPackages } from "../../pi/extensions/fleet/cli.ts";
import { IDS, buildFixture, plainStyle, type Fixture } from "./support/sessions-fixture.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../..");
const cliBin = join(repo, "bin/pi-fleet");
const stubPi = join(here, "support/stub-pi.sh");
const packages = locatePiPackages();
const haveTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const skip = packages ? false : "pi's pi-tui not found (pi not on PATH)";
const skipTmux = skip || (haveTmux ? false : "tmux not found");

let sv: typeof import("../../pi/extensions/fleet/sessions-view.ts");
let tui: typeof import("@earendil-works/pi-tui");
let fx: Fixture;

before(async () => {
	fx = buildFixture();
	if (!packages) return;
	await usePiPackages(packages);
	sv = await import("../../pi/extensions/fleet/sessions-view.ts");
	tui = await import("@earendil-works/pi-tui");
});
after(() => fx.cleanup());

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** agent-deck's default_socket_guard idea: tmux args must name a throwaway socket. */
function guardTmuxArgs(args: string[]): void {
	if ((args[0] !== "-L" && args[0] !== "-S") || !args[1] || basename(args[1]) === "default") {
		throw new Error(`test harness refuses tmux without a throwaway socket: ${args.join(" ")}`);
	}
}

// ---------------------------------------------------------------- preview plumbing

test("stripControlPreserveSgr keeps SGR, drops other escapes and control characters", { skip }, () => {
	const raw = "\x1b[1;32mok\x1b[0m\x1b[2K\x1b]8;;http://x\x07link\x1b]8;;\x1b\\\x07\ta\x00b\x1b(B\x1b[38:5:1mz";
	assert.equal(sv.stripControlPreserveSgr(raw), "\x1b[1;32mok\x1b[0mlink ab\x1b[38:5:1mz");
	assert.deepEqual(sv.previewLines("a\nb\n\x1b[0m\n\n", 5), ["a", "b"]);
	assert.deepEqual(sv.previewLines("1\n2\n3\n4\n", 2), ["3", "4"]);
});

test("gone vs slow: tmux's can't-find/no-server errors are gone, anything else is not", { skip }, () => {
	for (const m of ["can't find pane: %9", "can't find session: x", "no server running on /tmp/x", "error connecting to /tmp/x (No such file or directory)"]) {
		assert.equal(sv.isGoneError(m), true, m);
	}
	for (const m of ["Command failed: tmux", "server version is too old", ""]) assert.equal(sv.isGoneError(m), false, m);
});

test("capturePane: a timeout or an unknown error is slow, never gone", { skip }, async () => {
	const bin = join(fx.root, "fakebin");
	mkdirSync(bin, { recursive: true });
	const env = (script: string) => {
		writeFileSync(join(bin, "tmux"), `#!/bin/sh\n${script}\n`);
		chmodSync(join(bin, "tmux"), 0o755);
		return { ...fx.env, PATH: `${bin}:${process.env.PATH}` };
	};
	const opts = { socket: join(fx.root, "fake.sock") };
	assert.deepEqual(await sv.capturePane("%1", 5, { ...opts, env: env("sleep 5"), timeoutMs: 300 }), { kind: "slow", reason: "timeout" });
	assert.deepEqual(await sv.capturePane("%1", 5, { ...opts, env: env("echo 'lost connection' >&2; exit 1") }), { kind: "slow", reason: "lost connection" });
	assert.equal((await sv.capturePane("%1", 5, { ...opts, env: env("echo \"can't find pane: %1\" >&2; exit 1") })).kind, "gone");
	// The harness guard: the default socket is refused (as slow: nothing was captured).
	const guarded = await sv.capturePane("%1", 5, { socket: "/tmp/tmux-1/default", env: fx.env });
	assert.equal(guarded.kind, "slow");
});
