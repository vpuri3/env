/**
 * fleet/shared: state shared by the fleet modules of ONE extension instance.
 *
 * index.ts only calls `register(pi)` on each module, so modules find each other through this
 * WeakMap keyed by the `pi` object. Never use module-level mutable state in the fleet modules:
 * pi-subagent-manager runs subagents in the same process and loads this extension for each of
 * them, so module globals would be shared between the main session and its subagents.
 *
 * status.ts registers first and sets `main` on session_start; every other module must check
 * `fleetOf(pi).main` (false in subagent sessions and print/json modes) before acting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { StatusFile } from "./status.ts";

export interface StatusHandle {
	/** Merge fields owned by other modules (tmux ids, sockets, slurmJobs, ...) and schedule a write. */
	patch(fields: Partial<StatusFile>): void;
	/** Mark the current waiting/error state as seen by the user. */
	ack(): void;
	/** The status object as it would be written now. */
	current(): StatusFile | undefined;
}

export interface FleetShared {
	/** True for a main session in TUI or RPC mode; set by status.ts on session_start. */
	main: boolean;
	status: StatusHandle | undefined;
	/** >0 while a fleet picker/dialog is open: its ui_prompt_start does not mean "question". */
	ownPrompts: number;
}

const instances = new WeakMap<object, FleetShared>();

export function fleetOf(pi: ExtensionAPI): FleetShared {
	let shared = instances.get(pi);
	if (!shared) {
		shared = { main: false, status: undefined, ownPrompts: 0 };
		instances.set(pi, shared);
	}
	return shared;
}

/** Run a fleet-owned dialog (ctx.ui.select/custom/...) without flipping the status to `question`. */
export async function ownPrompt<T>(pi: ExtensionAPI, open: () => Promise<T>): Promise<T> {
	const shared = fleetOf(pi);
	shared.ownPrompts++;
	try {
		return await open();
	} finally {
		shared.ownPrompts--;
	}
}
