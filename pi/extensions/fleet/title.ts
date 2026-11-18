/**
 * fleet/title: an LLM-written session name ("Fix deck kill confirm"), so the deck list and
 * /resume show what a session is about instead of its first prompt.
 *
 * After the first settled run of a main session with no name, a cheap model writes a 10–16 word
 * title from the first user messages plus a short tail of the conversation (a few KB), and it
 * becomes the pi session name (pi.setSessionName: a `session_info` entry, as `/name` writes).
 * Once the session has REFRESH_TURNS user messages the title is rewritten once more. So at most
 * two titles per session (a failed attempt is retried at the next settle, at most MAX_TRIES).
 *
 * Ours vs the user's: each title we set is followed by a `pi-fleet:title` custom entry holding
 * the id of the `session_info` entry pi wrote for it. We only (re)title while the latest
 * `session_info` entry is one of ours, or there is none. A name from `/name`, `--name` or RPC
 * (including an empty one, which clears the name) is never replaced.
 *
 * Model: $PI_FLEET_TITLE_MODEL (`provider/id`), else the cheapest available haiku/flash/mini/
 * nano/lite model of the session's provider, else the session model; on failure the next one
 * is tried. The call runs detached from the turn (never awaited by a handler), times out after
 * TIMEOUT_MS and fails silently; with $PI_FLEET_TITLE_DEBUG=<file> failures are appended there.
 *
 * Only main sessions (fleetOf(pi).main: not subagents, not print/json mode) in TUI mode are
 * titled; $PI_FLEET_TITLE=on also titles RPC-mode sessions, =off disables titling.
 *
 * The helpers (pickTitleModels, titleInput, cleanTitle, generateTitle, titleState) take plain
 * data, so `pi-fleet title-backfill` (cli.ts) and the tests use them outside pi.
 */

import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSubagentSession } from "./registry.ts";
import { fleetOf } from "./shared.ts";

export const TITLE_ENTRY = "pi-fleet:title";
/** User messages after which the title is rewritten once. */
export const REFRESH_TURNS = 6;
export const TIMEOUT_MS = 15_000;
/** Failed attempts per session process before giving up. */
export const MAX_TRIES = 3;
/** Titles are clamped to this many words / chars (the prompt asks for 10 to 16 words). */
export const TITLE_MAX_WORDS = 16;
export const TITLE_MAX_CHARS = 160;
/** Marker in the system prompt (tests' faux provider answers title requests by it). */
export const TITLE_MARKER = "pi-fleet session title";

const SYSTEM_PROMPT = `You write the ${TITLE_MARKER} for a conversation between a user and a coding agent.
Reply with the title only: 10 to 16 words (never more than 16) naming what the session is about (the task, not the agent's actions), sentence case, no quotes, no trailing punctuation.`;

const CHEAP = /haiku|flash|mini|nano|lite/i;
const NOT_CHAT = /image|audio|tts|realtime|embed|transcribe|search|computer-use|robotics|live/i;

/** The subset of a pi-ai Model the picker reads. */
export interface ModelLike {
	id: string;
	provider: string;
	type?: string;
	input?: readonly string[];
	cost?: { input?: number; output?: number };
}

/** What titling needs from pi's ModelRegistry (ctx.modelRegistry, or one built in the CLI). */
export interface TitleModels<M extends ModelLike = ModelLike> {
	getAvailable(): readonly M[];
	find(provider: string, id: string): M | undefined;
	streamSimple(model: M, context: any, options?: any): { result(): Promise<any> };
}

/**
 * Models to try, best first: the override (if found), else cheap models of `current`'s provider
 * (by input+output price, then id descending), then `current` itself. No duplicates.
 */
export function pickTitleModels<M extends ModelLike>(
	models: Pick<TitleModels<M>, "getAvailable" | "find">,
	current: M | undefined,
	override?: string,
): M[] {
	const out: M[] = [];
	const add = (m: M | undefined) => {
		if (m && !out.some((o) => o.provider === m.provider && o.id === m.id)) out.push(m);
	};
	const spec = override?.trim();
	if (spec) {
		const slash = spec.indexOf("/");
		if (slash > 0) add(models.find(spec.slice(0, slash), spec.slice(slash + 1)));
	}
	if (current) {
		let available: readonly M[] = [];
		try {
			available = models.getAvailable();
		} catch {
			// no catalogue: the session model only
		}
		const price = (m: M) => (m.cost?.input ?? Infinity) + (m.cost?.output ?? 0);
		available
			.filter(
				(m) =>
					m.provider === current.provider &&
					(m.type === undefined || m.type === "chat") &&
					(!m.input || m.input.includes("text")) &&
					CHEAP.test(m.id) &&
					!NOT_CHAT.test(m.id),
			)
			.sort((a, b) => price(a) - price(b) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
			.forEach(add);
		add(current);
	}
	return out;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** User/assistant texts of the active branch, in order. */
export function conversation(entries: readonly any[]): { role: "user" | "assistant"; text: string }[] {
	const out: { role: "user" | "assistant"; text: string }[] = [];
	for (const e of entries) {
		const m = e?.type === "message" ? e.message : undefined;
		if (m?.role !== "user" && m?.role !== "assistant") continue;
		const text = squash(textOf(m.content));
		if (text) out.push({ role: m.role, text });
	}
	return out;
}

/**
 * The model's input: the first two user messages (≤1200 chars each) and the last six messages
 * (≤400 chars each, ≤1600 in total). Undefined when there is no user message.
 */
export function titleInput(entries: readonly any[]): string | undefined {
	const msgs = conversation(entries);
	const firstUsers = msgs.map((m, i) => [m, i] as const).filter(([m]) => m.role === "user").slice(0, 2);
	if (!firstUsers.length) return undefined;
	const used = new Set(firstUsers.map(([, i]) => i));
	const head = firstUsers.map(([m]) => `User: ${clip(m.text, 1200)}`);
	const tail: string[] = [];
	let budget = 1600;
	for (let i = msgs.length - 1; i >= 0 && tail.length < 6 && budget > 0; i--) {
		if (used.has(i)) {
			if (i <= Math.max(...used)) break;
			continue;
		}
		const line = `${msgs[i]!.role === "user" ? "User" : "Agent"}: ${clip(msgs[i]!.text, Math.min(400, budget))}`;
		budget -= line.length;
		tail.unshift(line);
	}
	const skipped = tail.length && msgs.length > used.size + tail.length ? ["[…]"] : [];
	return ["<conversation>", ...head, ...skipped, ...tail, "</conversation>"].join("\n\n");
}

/** One clean line of ≤ TITLE_MAX_WORDS words / TITLE_MAX_CHARS chars, or undefined. */
export function cleanTitle(raw: string): string | undefined {
	let line = raw
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l) ?? "";
	line = line.replace(/^#+\s*/, "").replace(/^\**\s*title\s*:\s*/i, "");
	line = line.replace(/^[*_`"'“‘«]+|[*_`"'”’»]+$/g, "").replace(/[.!?:;,]+$/, "");
	line = squash(line);
	const words = line.split(" ");
	if (words.length > TITLE_MAX_WORDS) line = words.slice(0, TITLE_MAX_WORDS).join(" ");
	if (line.length > TITLE_MAX_CHARS) line = line.slice(0, TITLE_MAX_CHARS).replace(/\s+\S*$/, "") || line.slice(0, TITLE_MAX_CHARS);
	return line || undefined;
}

export interface TitleResult {
	title?: string;
	model?: string;
	errors: string[];
}

/** Ask each model in turn (one shared deadline) until one returns a usable title. Never throws. */
export async function generateTitle<M extends ModelLike>(
	models: Pick<TitleModels<M>, "streamSimple">,
	candidates: readonly M[],
	input: string,
	opts: { timeoutMs?: number; previous?: string } = {},
): Promise<TitleResult> {
	const errors: string[] = [];
	const deadline = Date.now() + (opts.timeoutMs ?? TIMEOUT_MS);
	const prompt = opts.previous ? `${input}\n\nThe current title is "${opts.previous}"; keep it if it still fits.` : input;
	for (const model of candidates) {
		const left = deadline - Date.now();
		if (left <= 0) {
			errors.push("timeout");
			break;
		}
		const name = `${model.provider}/${model.id}`;
		const abort = new AbortController();
		let timer: NodeJS.Timeout | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					abort.abort();
					reject(new Error("timeout"));
				}, left);
				timer.unref?.();
			});
			const call = (async () =>
				models
					.streamSimple(
						model,
						{
							systemPrompt: SYSTEM_PROMPT,
							messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
						},
						{ maxTokens: 1024, signal: abort.signal, cacheRetention: "none" },
					)
					.result())();
			call.catch(() => {});
			const message = await Promise.race([call, timeout]);
			if (message?.stopReason === "error" || message?.stopReason === "aborted") {
				errors.push(`${name}: ${message.errorMessage ?? message.stopReason}`);
				continue;
			}
			const title = cleanTitle(textOf(message?.content));
			if (title) return { title, model: name, errors };
			errors.push(`${name}: empty reply`);
		} catch (error) {
			errors.push(`${name}: ${(error as Error)?.message ?? error}`);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	return { errors };
}

export interface TitleState {
	/** The latest session_info entry is ours, or there is none: we may (re)title. */
	ours: boolean;
	/** Current name, if any. */
	name?: string;
	/** Titles we wrote in this session. */
	titles: number;
	/** User messages when we last titled. */
	lastTurns: number;
}

/** Read the title state from all entries of a session (file order). */
export function titleState(entries: readonly any[]): TitleState {
	let info: any;
	const ourIds = new Set<string>();
	let titles = 0;
	let lastTurns = 0;
	for (const e of entries) {
		if (e?.type === "session_info") info = e;
		else if (e?.type === "custom" && e.customType === TITLE_ENTRY && typeof e.data?.entryId === "string") {
			ourIds.add(e.data.entryId);
			titles++;
			if (typeof e.data.turns === "number") lastTurns = e.data.turns;
		}
	}
	const name = typeof info?.name === "string" ? info.name.trim() || undefined : undefined;
	return { ours: !info || ourIds.has(info.id), name, titles, lastTurns };
}

/** Should a session with this state and `turns` user messages get a (new) title now? */
export function wantsTitle(state: TitleState, turns: number): boolean {
	if (!state.ours || turns < 1) return false;
	if (state.titles === 0) return true;
	return state.titles === 1 && turns >= REFRESH_TURNS && state.lastTurns < REFRESH_TURNS;
}

export function userTurns(entries: readonly any[]): number {
	let n = 0;
	for (const e of entries) if (e?.type === "message" && e.message?.role === "user") n++;
	return n;
}

export function debugLog(text: string, env: NodeJS.ProcessEnv = process.env): void {
	const file = env.PI_FLEET_TITLE_DEBUG;
	if (!file) return;
	try {
		appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
	} catch {
		// debug only
	}
}

/** Titling mode from $PI_FLEET_TITLE: "off", "on" (TUI + RPC) or "tui" (default). */
export function titleMode(env: NodeJS.ProcessEnv = process.env): "off" | "on" | "tui" {
	const v = (env.PI_FLEET_TITLE ?? "").trim().toLowerCase();
	if (["off", "0", "no", "false"].includes(v)) return "off";
	if (["on", "1", "yes", "true"].includes(v)) return "on";
	return "tui";
}

export function register(pi: ExtensionAPI): void {
	const shared = fleetOf(pi);
	let generation = 0;
	let busy = false;
	let tries = 0;
	let enabled = false;
	/** Nothing more to do in this session: user-named, or both titles written. */
	let done = false;

	pi.on("session_start", async (_event, ctx) => {
		generation++;
		busy = false;
		tries = 0;
		done = false;
		const mode = titleMode();
		enabled = shared.main && mode !== "off" && (ctx.mode === "tui" || (ctx.mode === "rpc" && mode === "on"));
	});
	pi.on("session_shutdown", async () => {
		generation++;
		enabled = false;
	});

	const run = async (ctx: ExtensionContext, gen: number) => {
		const sm = ctx.sessionManager;
		const entries = sm.getEntries() as any[];
		if (isSubagentSession(sm as any)) return;
		const state = titleState(entries);
		if (!state.ours || state.titles >= 2) {
			done = true;
			return;
		}
		const turns = userTurns(entries);
		if (!wantsTitle(state, turns)) return;
		const input = titleInput(sm.getBranch() as any[]);
		if (!input) return;
		const candidates = pickTitleModels(ctx.modelRegistry as any, ctx.model as any, process.env.PI_FLEET_TITLE_MODEL);
		if (!candidates.length) return;
		busy = true;
		try {
			const result = await generateTitle(ctx.modelRegistry as any, candidates, input, { previous: state.titles ? state.name : undefined });
			if (gen !== generation) return;
			if (!result.title) {
				tries++;
				debugLog(`title ${sm.getSessionId()}: failed: ${result.errors.join("; ")}`);
				return;
			}
			// The user may have named the session while the model ran.
			const now = titleState(sm.getEntries() as any[]);
			if (!now.ours || now.titles !== state.titles) return;
			if (result.title !== now.name) pi.setSessionName(result.title);
			const after = sm.getEntries() as any[];
			let infoId: string | undefined;
			for (let i = after.length - 1; i >= 0 && !infoId; i--) if (after[i]?.type === "session_info") infoId = after[i].id;
			if (!infoId) return;
			pi.appendEntry(TITLE_ENTRY, { entryId: infoId, name: result.title, turns: userTurns(after), model: result.model });
			if (result.errors.length) debugLog(`title ${sm.getSessionId()}: ${result.model} after: ${result.errors.join("; ")}`);
		} catch (error) {
			// stale ctx after a session switch, or anything else: never surface it
			debugLog(`title: ${(error as Error)?.message ?? error}`);
		} finally {
			if (gen === generation) busy = false;
		}
	};

	pi.on("agent_settled", async (_event, ctx) => {
		if (!enabled || done || !shared.main || busy || tries >= MAX_TRIES) return;
		void run(ctx, generation).catch(() => {});
	});
}
