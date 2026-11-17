/**
 * fleet/leader: runs vim-mode's Space leader maps (design §12; phase 8).
 *
 * vim-mode (NORMAL mode only) emits `pi.events.emit("pi-fleet:action", { name, handled })`; this
 * module sets `handled = true` synchronously when it takes the action (vim-mode shows
 * "pi-fleet not loaded" otherwise) and runs it with the UI context saved at session_start.
 *
 *   sessions        Space e     /sessions (sessions-view.ts openSessions)
 *   files           Space f f   file picker: session files, then the repo
 *   git-files       Space f g   repo (git) files only
 *   session-files   Space f b   files touched in this session only
 *   grep            Space f s   `Grep >` input, then rg hits
 *   commands        Space f h   select a slash command; it goes into the prompt
 *   git-status      Space g s   :Git (fugitive) in the paired nvim, then focus it
 *   tool-output     Space t     tool output picker
 *
 * Main sessions only (fleetOf(pi).main). No module-level mutable state: the context lives in
 * register()'s closure.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { focusPane, inTmux } from "./cli.ts";
import { NvimUnreachable, nvimRequest, resolveNvim, type NvimPeer } from "./nvim.ts";
import { fleetOf, ownPrompt } from "./shared.ts";
import { openSessions } from "./sessions-view.ts";
import { openFilePicker, openGrepPicker, openToolPicker, pairNew } from "./view.ts";

export const ACTION_EVENT = "pi-fleet:action";

export interface ActionEvent {
	name: string;
	/** Set synchronously by the handler that takes the action. */
	handled?: boolean;
}

/**
 * pi's built-in slash commands (pi 1.5.2's BUILTIN_SLASH_COMMANDS, which pi does not export).
 * tests/pi-fleet/leader.test.ts checks this against the installed pi.
 */
export const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "thinking", description: "Set thinking level" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import a JSONL session, preserving its ID and working directory" },
	{ name: "share", description: "Share session via a Radius artifact or a GitHub gist" },
	{ name: "bug", description: "Report a bug to the Pi developers" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume another session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: "Quit pi" },
];

/** Select-list entries for `Space f h`: extension commands, prompts and skills, then built-ins (first name wins). */
export function commandChoices(commands: ReadonlyArray<{ name: string; description?: string }>): { label: string; name: string }[] {
	const seen = new Set<string>();
	const out: { label: string; name: string }[] = [];
	for (const c of [...commands, ...BUILTIN_COMMANDS]) {
		if (!c.name || seen.has(c.name)) continue;
		seen.add(c.name);
		const desc = (c.description ?? "").replace(/\s+/g, " ").trim();
		out.push({ name: c.name, label: desc ? `/${c.name} - ${desc}` : `/${c.name}` });
	}
	return out;
}

/** The prompt after choosing `/name`: a typed `/command` is replaced, other draft text becomes its arguments. */
export function withCommand(name: string, draft: string): string {
	// Only a leading `/word` without another slash is a command; `/tmp/x.log ...` is draft text.
	const rest = /^\/[^\s/]*(\s|$)/.test(draft) ? draft.replace(/^\/\S*\s*/, "") : draft;
	return `/${name} ${rest.trimStart()}`;
}

// ---------------------------------------------------------------- :Git in nvim

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GIT_TIMEOUT_MS = 10_000;
const PAIR_WAIT_MS = 5_000;
// An unknown command: nvim_cmd says "Command not found: Git", Ex says "E492".
const NO_COMMAND = /Command not found|E492/;

async function pairedNvim(pi: ExtensionAPI, ctx: ExtensionContext): Promise<{ peer: NvimPeer; fresh: boolean } | undefined> {
	// Never call nvim without a socket; only a freshly paired nvim is waited for (gitStatus).
	const peer = await resolveNvim(ctx.sessionManager.getSessionId()).catch(() => undefined);
	if (peer?.sock) return { peer, fresh: false };
	const fresh = await pairNew(pi, ctx);
	return fresh?.sock ? { peer: fresh, fresh: true } : undefined;
}

/** `:Git` (fugitive) in the paired nvim (pairing one if needed), then focus its pane. */
export async function gitStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const found = await pairedNvim(pi, ctx);
	if (!found) return ctx.ui.notify("pi-fleet: no paired nvim (needs tmux)", "warning");
	const { peer, fresh } = found;
	// A just-split nvim may still be starting (no socket yet, or plugins not loaded).
	const end = Date.now() + (fresh ? PAIR_WAIT_MS : 0);
	for (;;) {
		try {
			await nvimRequest(peer.sock, "nvim_cmd", [{ cmd: "Git" }, { output: false }], GIT_TIMEOUT_MS);
			break;
		} catch (error) {
			const message = (error as Error).message;
			const retry = fresh && Date.now() < end && (error instanceof NvimUnreachable ? error.code !== "ETIMEDOUT" : NO_COMMAND.test(message));
			if (retry) {
				await sleep(100);
				continue;
			}
			if (NO_COMMAND.test(message)) return ctx.ui.notify("pi-fleet: :Git is not available in nvim (vim-fugitive missing?)", "warning");
			return ctx.ui.notify(`pi-fleet: :Git failed: ${message}`, "error");
		}
	}
	if (peer.pane && inTmux()) await focusPane(peer.pane).catch(() => {});
}

// ---------------------------------------------------------------- actions

/** `Space f h`: pick a slash command and put it into the prompt. */
export async function pickCommand(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const choices = commandChoices(pi.getCommands());
	const label = await ownPrompt(pi, () => ctx.ui.select("Slash command", choices.map((c) => c.label)));
	const choice = choices.find((c) => c.label === label);
	if (choice) ctx.ui.setEditorText(withCommand(choice.name, ctx.ui.getEditorText()));
}

export type Action = (pi: ExtensionAPI, ctx: ExtensionContext) => unknown;

export const ACTIONS: Readonly<Record<string, Action>> = {
	// Space e: the /sessions view, opened directly (even while the agent works; never a prompt).
	sessions: openSessions,
	files: (pi, ctx) => openFilePicker(pi, ctx, { scope: "all" }),
	"git-files": (pi, ctx) => openFilePicker(pi, ctx, { scope: "git" }),
	"session-files": (pi, ctx) => openFilePicker(pi, ctx, { scope: "session" }),
	grep: (pi, ctx) => openGrepPicker(pi, ctx),
	commands: pickCommand,
	"git-status": gitStatus,
	"tool-output": (pi, ctx) => openToolPicker(pi, ctx),
};

export function register(pi: ExtensionAPI): void {
	registerLeader(pi);
}

/** register() with replaceable actions (tests stub the openers). */
export function registerLeader(pi: ExtensionAPI, actions: Readonly<Record<string, Action>> = ACTIONS): void {
	let uiCtx: ExtensionContext | undefined;
	pi.on("session_start", async (_event, ctx) => {
		uiCtx = fleetOf(pi).main && ctx.hasUI ? ctx : undefined;
	});
	pi.on("session_shutdown", async () => {
		uiCtx = undefined;
	});
	pi.events.on(ACTION_EVENT, (data) => {
		const event = data as ActionEvent | undefined;
		const ctx = uiCtx;
		if (!ctx || !event || typeof event.name !== "string" || !fleetOf(pi).main) return;
		event.handled = true;
		const action = Object.hasOwn(actions, event.name) ? actions[event.name] : undefined;
		if (!action) return ctx.ui.notify(`pi-fleet: unknown action ${event.name}`, "warning");
		// Errors are reported here; nothing awaits the event handler.
		Promise.resolve()
			.then(() => action(pi, ctx))
			.catch((error) => ctx.ui.notify(`pi-fleet: ${event.name}: ${(error as Error).message}`, "error"));
	});
}
