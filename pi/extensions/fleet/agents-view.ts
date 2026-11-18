/**
 * fleet/agents-view: the deck shows a live subagent the way `/agents tree` → Enter does
 * (docs/pi-deck-design.md §16). The deck swaps this session's pi into the pi slot and asks, over
 * the control socket (control.ts):
 *
 *   {"type":"agents-view","path":"/root/x"}
 *       → {"ok":true,"path":P,"already":bool}    P's LiveAgentView is mounted (already: it was)
 *       → {"ok":false,"error":E}                 E: "unknown agent <P>" (not in the tree: reaped,
 *                                                never existed), "timeout", "no UI", "agents tree
 *                                                unavailable" (package or subagent-viewer missing,
 *                                                or the package's internals changed), "cancelled"
 *   {"type":"agents-close"}
 *       → {"ok":true,"closed":bool}              closed only an overlay agents-view opened that no
 *                                                key has reached since (the user never used it)
 *
 * agents-view closes any navigation overlay already open on another agent (or the tree), asks
 * subagent-viewer.ts to give the next tree mount with P selected one Enter, and runs
 * `/agents tree P` (pi-subagent-manager's command; extension commands run at once, even while
 * the agent streams). From there everything is the package's own UI: Esc → the tree, Esc → main.
 *
 * Main sessions with a TUI only. State lives in register()'s closure (shared.ts: no module state).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VIEWER_API_EVENT, type ViewerApi } from "../subagent-viewer.ts";
import { fleetOf } from "./shared.ts";

/** How long agents-view waits for the agent's view to be mounted. */
export const AGENTS_VIEW_TIMEOUT_MS = 1000;
/** After closing an overlay: let the package's controller settle (its `opening` promise clears). */
const CLOSE_SETTLE_MS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function viewerApi(pi: ExtensionAPI): ViewerApi | undefined {
	const request: { api?: ViewerApi } = {};
	pi.events.emit(VIEWER_API_EVENT, request);
	return request.api;
}

/** A subagent path as the package spells it: absolute, no whitespace (it goes on a command line). */
function agentPath(value: unknown): string {
	if (typeof value !== "string" || !/^\/\S+$/.test(value) || value === "/root" || value.length > 512) throw new Error("path must be an agent path like /root/x");
	return value;
}

export function register(pi: ExtensionAPI): void {
	const shared = fleetOf(pi);
	let tui = false;

	pi.on("session_start", async (_event, ctx) => {
		// RPC mode has a UI too, but no overlays: there the view times out (ok:false).
		tui = ctx.hasUI;
	});
	pi.on("session_shutdown", async () => {
		tui = false;
	});

	const agentsCommand = () => pi.getCommands().some((c) => c.name === "agents" && c.source === "extension");

	shared.control.on("agents-view", async (message) => {
		const path = agentPath(message.path);
		if (!shared.main || !tui) return { ok: false, error: "no UI" };
		const api = viewerApi(pi);
		// Without the command, sendUserMessage would send "/agents tree …" to the model as a prompt.
		if (!api || !agentsCommand()) return { ok: false, error: "agents tree unavailable" };
		const now = api.current();
		if (now?.kind === "agent" && now.path === path) return { path, already: true };
		if (now) {
			api.close();
			await sleep(CLOSE_SETTLE_MS);
		}
		const shown = api.expect(path);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((r) => {
			timer = setTimeout(() => r("timeout"), AGENTS_VIEW_TIMEOUT_MS);
		});
		pi.sendUserMessage(`/agents tree ${path}`, { expandPromptTemplates: true });
		const result = await Promise.race([shown, timeout]);
		clearTimeout(timer);
		if (result === "mounted") return { path, already: false };
		if (result === "timeout") api.cancel();
		const error = result === "unknown" ? `unknown agent ${path}` : result === "unsupported" ? "agents tree unavailable" : result;
		return { ok: false, error };
	});

	shared.control.on("agents-close", async () => {
		const api = viewerApi(pi);
		if (!api) return { closed: false };
		// A view still on its way (a newer highlight moved on): drop it.
		api.cancel();
		const now = api.current();
		if (!now?.deckOpened || now.touched) return { closed: false };
		return { closed: api.close() };
	});
}
