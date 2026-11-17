/**
 * fleet/reload: pi's `/reload` also refreshes the pi deck (docs/pi-deck-design.md §8), so changes to
 * ~/env (deck.tmux.conf, the list's code, LIST_LOOP) take effect without manual steps.
 *
 * pi emits `session_start` with `reason: "reload"` to the freshly loaded extension runtime after
 * `/reload` (and `ctx.reload()`), so this runs the new code. A main session then starts
 * `pi-fleet deck-reload --debounce RELOAD_DEBOUNCE_MS` detached (its own process: fresh code, never
 * blocks or breaks pi; output and errors are dropped). deck-reload is a no-op without a deck server,
 * and the debounce (@deck_reload on the deck server) restarts the list once when several pis reload
 * together. Works from deck pis and from pis in the user's own tmux alike.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RELOAD_DEBOUNCE_MS } from "./deck.ts";
import { fleetOf } from "./shared.ts";

/** $PI_FLEET_BIN (set in pis started by run-pi), else this repo's bin/pi-fleet (the extension dir may be a symlink), else PATH. */
export function fleetBin(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_FLEET_BIN) return env.PI_FLEET_BIN;
	try {
		const repoBin = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../../bin/pi-fleet");
		if (existsSync(repoBin)) return repoBin;
	} catch {
		// not found
	}
	return "pi-fleet";
}

/** Start `pi-fleet deck-reload --debounce` detached; never throws, never waits. */
export function triggerDeckReload(env: NodeJS.ProcessEnv = process.env): void {
	try {
		const child = spawn(fleetBin(env), ["deck-reload", "--debounce", String(RELOAD_DEBOUNCE_MS)], {
			env,
			stdio: "ignore",
			detached: true,
		});
		child.on("error", () => {});
		child.unref();
	} catch {
		// no pi-fleet: nothing to reload
	}
}

export function register(pi: ExtensionAPI): void {
	pi.on("session_start", async (event) => {
		if (event.reason !== "reload" || !fleetOf(pi).main) return;
		triggerDeckReload();
	});
}
