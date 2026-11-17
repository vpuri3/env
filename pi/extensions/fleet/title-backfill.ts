/**
 * `pi-fleet title-backfill [--limit N] [--dry-run] [--model PROVIDER/ID]`: give recent closed
 * sessions without a name an LLM title, as the fleet extension (title.ts) does for live ones.
 *
 * Candidates: main sessions (not subagents) from the session index, newest first, whose file
 * has no `session_info` entry at all (a name the user set, or cleared, is never touched), has a
 * user message, was not modified in the last MIN_AGE_MS, and is not claimed by a status file of
 * a pi that is alive or on another host. At most `limit` (default 20) are titled, one at a time.
 *
 * The title is written with pi's own SessionManager (appendSessionInfo + appendCustomEntry of the
 * `pi-fleet:title` marker), so the file gets exactly the entries `/name` and title.ts write. The
 * file's size and mtime are checked again right before writing. Models come from pi's
 * ModelRuntime (same auth as pi): the cheap model of the session's last provider, as title.ts.
 * Needs pi's packages (cli.ts resolves them with usePiPackages before importing this).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SessionIndex, branchOf, parseJsonl } from "./registry.ts";
import { liveness, statusDir, type StatusFile } from "./status.ts";
import {
	TITLE_ENTRY,
	generateTitle,
	pickTitleModels,
	titleInput,
	titleState,
	userTurns,
	type ModelLike,
	type TitleModels,
} from "./title.ts";

export const MIN_AGE_MS = 10 * 60_000;
export const DEFAULT_LIMIT = 20;

/** Session ids and files claimed by a pi that may still be running (alive here, or elsewhere). */
export function claimedSessions(env: NodeJS.ProcessEnv = process.env): Set<string> {
	const out = new Set<string>();
	let names: string[] = [];
	try {
		names = readdirSync(statusDir(env));
	} catch {
		return out;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const status = JSON.parse(readFileSync(join(statusDir(env), name), "utf8")) as StatusFile;
			if (liveness(status) === "crashed") continue;
			if (status.sessionId) out.add(status.sessionId);
			if (status.sessionFile) out.add(status.sessionFile);
		} catch {
			// unreadable: the file's age check still applies
		}
	}
	return out;
}

/** The provider/model of the last assistant message: the session's model when it closed. */
export function lastModel(entries: readonly any[]): { provider: string; id: string } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i]?.type === "message" ? entries[i].message : undefined;
		if (m?.role === "assistant" && typeof m.provider === "string" && typeof m.model === "string") return { provider: m.provider, id: m.model };
		const e = entries[i];
		if (e?.type === "model_change" && typeof e.provider === "string" && typeof e.modelId === "string") return { provider: e.provider, id: e.modelId };
	}
	return undefined;
}

export interface BackfillDeps<M extends ModelLike> {
	models: TitleModels<M>;
	/** Append the title entries to a closed session file (pi's SessionManager in production). */
	write(path: string, title: string, data: Record<string, unknown>): void;
	now?: () => number;
	log?: (line: string) => void;
}

export interface BackfillOptions {
	limit?: number;
	dryRun?: boolean;
	model?: string;
	minAgeMs?: number;
}

export interface BackfillResult {
	titled: { path: string; title: string; model?: string }[];
	failed: { path: string; error: string }[];
}

export async function backfill<M extends ModelLike>(
	opts: BackfillOptions,
	deps: BackfillDeps<M>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<BackfillResult> {
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const minAge = opts.minAgeMs ?? MIN_AGE_MS;
	const now = deps.now ?? Date.now;
	const log = deps.log ?? (() => {});
	const override = opts.model ?? env.PI_FLEET_TITLE_MODEL;
	const claimed = claimedSessions(env);
	const result: BackfillResult = { titled: [], failed: [] };
	const files = new SessionIndex(env)
		.scan()
		.filter((e) => !e.subagent && !e.name)
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	let picked = 0;
	for (const entry of files) {
		if (picked >= limit) break;
		if (now() - entry.mtimeMs < minAge) continue;
		if (claimed.has(entry.path) || (entry.id && claimed.has(entry.id))) continue;
		let text: string;
		try {
			text = readFileSync(entry.path, "utf8");
		} catch {
			continue;
		}
		const entries = parseJsonl(text);
		const state = titleState(entries);
		if (entries.some((e) => e.type === "session_info") || state.titles || userTurns(entries) < 1) continue;
		const branch = branchOf(entries);
		const input = titleInput(branch);
		if (!input) continue;
		picked++;
		const last = lastModel(branch);
		const current = last ? deps.models.find(last.provider, last.id) : undefined;
		const candidates = pickTitleModels(deps.models, current, override);
		if (!candidates.length) {
			result.failed.push({ path: entry.path, error: last ? `model ${last.provider}/${last.id} unknown` : "no model" });
			log(`fail ${entry.path}: no model`);
			continue;
		}
		if (opts.dryRun) {
			log(`would title ${entry.path} with ${candidates[0]!.provider}/${candidates[0]!.id}`);
			continue;
		}
		const r = await generateTitle(deps.models, candidates, input);
		if (!r.title) {
			result.failed.push({ path: entry.path, error: r.errors.join("; ") });
			log(`fail ${entry.path}: ${r.errors.join("; ")}`);
			continue;
		}
		// Opened or changed while the model ran: leave it to the live pi.
		let st;
		try {
			st = statSync(entry.path);
		} catch {
			continue;
		}
		const claimedNow = claimedSessions(env);
		if (st.size !== Buffer.byteLength(text) || st.mtimeMs !== entry.mtimeMs || claimedNow.has(entry.path) || (entry.id && claimedNow.has(entry.id))) {
			result.failed.push({ path: entry.path, error: "changed meanwhile" });
			continue;
		}
		try {
			deps.write(entry.path, r.title, { turns: userTurns(entries), model: r.model, backfill: true });
			result.titled.push({ path: entry.path, title: r.title, model: r.model });
			log(`${r.title}\t${entry.path}`);
		} catch (error) {
			result.failed.push({ path: entry.path, error: String((error as Error)?.message ?? error) });
		}
	}
	return result;
}

/** Appends the title the way pi does: pi's SessionManager on the closed file. */
export async function piSessionWriter(): Promise<BackfillDeps<any>["write"]> {
	const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as any;
	return (path, title, data) => {
		const sm = SessionManager.open(path);
		const entryId = sm.appendSessionInfo(title);
		sm.appendCustomEntry(TITLE_ENTRY, { entryId, name: title, ...data });
	};
}

/** The production deps: pi's ModelRuntime (pi's auth) and SessionManager. */
export async function piDeps(log: (line: string) => void): Promise<BackfillDeps<any>> {
	const pi: any = await import("@earendil-works/pi-coding-agent");
	const runtime = await pi.ModelRuntime.create();
	await runtime.getAvailable();
	return { models: new pi.ModelRegistry(runtime), log, write: await piSessionWriter() };
}
