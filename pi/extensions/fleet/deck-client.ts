/**
 * fleet/deck-client: what a pi does with the deck (docs/pi-deck-design.md §7, §8; phase 3). Not an
 * extension module (index.ts does not load it): lifecycle.ts, leader.ts, view.ts and sessions-view.ts
 * call these helpers. No module-level state.
 *
 * Two places a pi can run:
 *   in the deck   a pool pane of `tmux -L pifleet` (PI_FLEET_DECK=1, $TMUX names the deck socket):
 *                 /new and /resume send `open` over deck.sock, `Space e`/`/sessions` focus the list,
 *                 nvim lives in the pool and is swapped into the right slot.
 *   outside       a pi started by hand in the user's tmux: /new and /resume start the deck if needed,
 *                 `open` the session there and pop the deck up over this client (display-popup on the
 *                 user's server, bin/pi-deck-attach); `Space e`/`Space E`/`/sessions` pop it up too.
 */

import { spawn } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { focusPane, paneInfo, tmux, tmuxBaseArgs } from "./cli.ts";
import {
	deckPair,
	deckPopupArgs,
	deckRequest,
	deckTmux,
	focusList,
	inDeck,
	initialDeckSize,
	readSlot,
	startDeck,
	type DeckPairResult,
} from "./deck.ts";

export { inDeck } from "./deck.ts";

/** The size a new deck server gets: the popup's inner size over the client showing `pane`. */
async function popupDeckSize(pane: string | undefined, env: NodeJS.ProcessEnv) {
	if (!pane) return undefined;
	const out = await tmux(["display-message", "-p", "-t", pane, "#{client_width} #{client_height}"], env).catch(() => "");
	const [w, h] = out.split(" ").map(Number);
	return w && h ? initialDeckSize(env, { width: w, height: h }) : undefined;
}

/** Start the deck server unless it runs (sized for a popup over this pane's client); waits for deck.sock. */
export async function ensureDeck(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	await startDeck({ size: inDeck(env) ? undefined : await popupDeckSize(env.TMUX_PANE, env) }, env);
}

/**
 * Open the deck popup on the user's tmux over the client showing $TMUX_PANE, without waiting for it
 * to close (display-popup -E blocks until then). An immediate failure (no client) is thrown.
 */
export function popupDeck(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	return new Promise<void>((res, rej) => {
		let base: string[];
		try {
			base = tmuxBaseArgs(env);
		} catch (error) {
			rej(error);
			return;
		}
		const child = spawn("tmux", [...base, ...deckPopupArgs(env.TMUX_PANE, env)], { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
		let err = "";
		child.stderr?.on("data", (d) => (err += d.toString("utf8")));
		const timer = setTimeout(() => {
			child.stderr?.destroy();
			child.unref();
			res();
		}, 300);
		child.once("error", (e) => {
			clearTimeout(timer);
			rej(e);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code) rej(new Error(err.trim() || `display-popup exited ${code}`));
			else res();
		});
	});
}

/**
 * `Space e`, `Space E`, `/sessions` (§7, §8): in the deck, focus the list; in the user's tmux, start
 * the deck if needed and pop it up. Returns where the user ends up.
 */
export async function enterDeck(env: NodeJS.ProcessEnv = process.env): Promise<"list" | "popup"> {
	if (inDeck(env)) {
		await focusList(env);
		return "list";
	}
	if (!(env.TMUX || env.PI_FLEET_TMUX_SOCKET) || !env.TMUX_PANE) throw new Error("the deck needs tmux here (outside tmux run `pf`)");
	await ensureDeck(env);
	await popupDeck(env);
	return "popup";
}

/** enterDeck with the result reported in pi (never throws). */
export async function openDeck(ctx: Pick<ExtensionContext, "hasUI" | "ui">, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	try {
		await enterDeck(env);
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`pi-fleet: deck: ${(error as Error).message}`, "error");
	}
}

/** Where a session `open` refused runs in the user's tmux (deck.sock's `outside`). */
export interface OutsideWhere {
	socket?: string;
	pane?: string;
	windowIndex?: number;
}

export type DeckOpenOutcome =
	| { ok: true; session: string; pane: string; popup: boolean; popupError?: string }
	| { ok: false; error: string; outside?: OutsideWhere };

/**
 * /new (`cwd`) and /resume (`session`, a file or id) (§8): `open` over deck.sock (the deck shows and
 * focuses it; the calling session keeps running). Outside the deck the deck is started first and
 * popped up over this client afterwards. Throws when the deck cannot be reached.
 */
export async function openInDeck(req: { cwd?: string; session?: string }, env: NodeJS.ProcessEnv = process.env): Promise<DeckOpenOutcome> {
	const here = inDeck(env);
	if (!here) await ensureDeck(env);
	const message: Record<string, unknown> = { type: "open", focus: true };
	if (req.session) message.session = req.session;
	else message.cwd = req.cwd;
	const reply = await deckRequest(message, env);
	if (!reply.ok) return { ok: false, error: String(reply.error ?? "open failed"), outside: reply.outside as OutsideWhere | undefined };
	const out: DeckOpenOutcome = { ok: true, session: String(reply.session), pane: String(reply.pane), popup: false };
	if (!here) {
		try {
			await popupDeck(env);
			out.popup = true;
		} catch (error) {
			out.popupError = (error as Error).message;
		}
	}
	return out;
}

/**
 * A session `open` refused because it runs in the user's tmux: jump there when that is this pi's own
 * server (a hand-started pi), else say where. Returns the notice to show, or undefined after a jump.
 */
export async function outsideNotice(outside: OutsideWhere | undefined, error: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	if (outside?.pane && !inDeck(env) && env.TMUX_PANE) {
		const info = await paneInfo(outside.pane, env);
		if (info && (!outside.socket || outside.socket === info.socket)) {
			await focusPane(outside.pane, env).catch(() => {});
			return undefined;
		}
	}
	return `pi-fleet: that session ${error}`;
}

// ---------------------------------------------------------------- nvim in the slot

/**
 * Show a deck pi's nvim in its place (the slot, when the pi is shown there). If neither is shown the
 * pi remembers it (@pi_fleet_shown=nvim), so selecting the session shows its nvim.
 */
export async function showNvim(piPane: string, nvimPane: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const slot = await readSlot(env);
	if (slot?.pane === nvimPane) return;
	if (slot?.pane === piPane) {
		await deckTmux(["swap-pane", "-d", "-s", nvimPane, "-t", piPane, ";", "select-pane", "-t", nvimPane], env);
		return;
	}
	await deckTmux(["set-option", "-p", "-t", piPane, "@pi_fleet_shown", "nvim"], env);
}

/** `Space v` in a deck pi: the slot toggles to this session's nvim (created on first use). */
export async function toggleNvim(piPane: string, env: NodeJS.ProcessEnv = process.env): Promise<DeckPairResult> {
	const r = await deckPair(piPane, { show: false }, env);
	await showNvim(r.piPane, r.nvimPane, env);
	return r;
}

/** Focus an nvim pane: in the deck show it in the slot, outside select its pane. */
export async function focusNvim(piPane: string | undefined, nvimPane: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (inDeck(env) && piPane) await showNvim(piPane, nvimPane, env);
	else await focusPane(nvimPane, env);
}
