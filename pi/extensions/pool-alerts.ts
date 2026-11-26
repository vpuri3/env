/**
 * pool-alerts: wakes the main pi session of a repo when an `sjob pool` writes new alerts.
 *
 * Polls (no fs.watch; Lustre) the registry `${XDG_STATE_HOME:-~/.local/state}/sjob-pool/*.pool`
 * (lines `dir=` and `repo=`) and each pool's `alerts.jsonl` every 20 s. Each file starts at its
 * end at session start, so only new alerts count; truncation/rotation restarts from 0.
 * Delivers only if this session's cwd (realpath) is the pool's repo or inside it, and only in
 * the main session: subagents are recognised by fleet/registry.ts isSubagentSession
 * (pi-subagent-manager thread entry, or parentSession + `<type> /<path>` name).
 * Alerts arriving within 10 s are batched into one follow-up message that triggers a turn.
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentSession } from "./fleet/registry.ts";

export const POLL_MS = 20_000;
export const BATCH_MS = 10_000;
export const MAX_LINES = 20;

export interface Alert { pool: string; kind: string; item: string; msg: string; dir: string }
export interface PoolEntry { dir: string; repo: string }

export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "sjob-pool");
}

export function parseRegistry(text: string): PoolEntry | undefined {
	let dir = "", repo = "";
	for (const line of text.split("\n")) {
		const m = /^(dir|repo)=(.*)$/.exec(line.trim());
		if (m) { if (m[1] === "dir") dir = m[2]; else repo = m[2]; }
	}
	return dir && repo ? { dir, repo } : undefined;
}

/** Parse complete JSONL lines; malformed or non-object lines are skipped. */
export function parseAlerts(text: string, dir = ""): Alert[] {
	const out: Alert[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const o = JSON.parse(line);
			if (!o || typeof o !== "object" || Array.isArray(o)) continue;
			const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
			out.push({ pool: s(o.pool), kind: s(o.kind), item: s(o.item), msg: s(o.msg), dir: s(o.dir) || dir });
		} catch { /* skip */ }
	}
	return out;
}

export function formatBatch(alerts: Alert[]): string {
	const lines = alerts.slice(0, MAX_LINES).map((a) => `[pool ${a.pool}] ${a.kind} ${a.item}: ${a.msg}`);
	if (alerts.length > MAX_LINES) lines.push(`${alerts.length - MAX_LINES} more`);
	const dir = alerts[0]?.dir ?? "";
	lines.push(`Details: sjob pool status ${dir} · ack: sjob pool alerts ${dir} --ack`);
	return lines.join("\n");
}

export function cwdInRepo(cwd: string, repo: string): boolean {
	try {
		const rel = relative(realpathSync(repo), realpathSync(cwd));
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	} catch { return false; }
}

/** Reads new complete lines since `offset`. Returns text and new offset; resets on truncation. */
export function readNew(file: string, offset: number): { text: string; offset: number } {
	let size: number;
	try { size = statSync(file).size; } catch { return { text: "", offset }; }
	if (size < offset) offset = 0;
	if (size === offset) return { text: "", offset };
	const buf = Buffer.alloc(size - offset);
	const fd = openSync(file, "r");
	let n = 0;
	try { n = readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
	const text = buf.subarray(0, n).toString("utf8");
	const end = text.lastIndexOf("\n");
	if (end < 0) return { text: "", offset }; // partial line: wait
	return { text: text.slice(0, end + 1), offset: offset + Buffer.byteLength(text.slice(0, end + 1)) };
}

export default function (pi: ExtensionAPI) {
	let poll: ReturnType<typeof setInterval> | undefined;
	let flush: ReturnType<typeof setTimeout> | undefined;
	let pending: Alert[] = [];
	const offsets = new Map<string, number>();

	const stop = () => {
		if (poll) clearInterval(poll);
		if (flush) clearTimeout(flush);
		poll = flush = undefined;
		pending = [];
		offsets.clear();
	};

	const scan = (cwd: string) => {
		const reg = registryDir();
		let names: string[] = [];
		try { names = readdirSync(reg).filter((n) => n.endsWith(".pool")); } catch { /* none */ }
		const seen = new Set<string>();
		for (const n of names) {
			try {
				const e = parseRegistry(readFileSync(join(reg, n), "utf8"));
				if (!e) continue;
				const file = join(e.dir, "alerts.jsonl");
				seen.add(file);
				const known = offsets.has(file);
				if (!known) {
					// new pool: start at its end (only alerts after we noticed it)
					let size = 0;
					try { size = statSync(file).size; } catch { /* not yet */ }
					offsets.set(file, size);
					continue;
				}
				const r = readNew(file, offsets.get(file)!);
				offsets.set(file, r.offset);
				if (!r.text || !cwdInRepo(cwd, e.repo)) continue;
				pending.push(...parseAlerts(r.text, e.dir));
			} catch { /* never throw */ }
		}
		for (const f of [...offsets.keys()]) if (!seen.has(f)) offsets.delete(f);
		if (pending.length && !flush) {
			flush = setTimeout(() => {
				flush = undefined;
				const batch = pending;
				pending = [];
				if (!batch.length) return;
				try {
					pi.sendMessage(
						{ customType: "pool-alert", content: formatBatch(batch), display: true },
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				} catch { /* session gone */ }
			}, BATCH_MS);
		}
	};

	pi.on("session_start", async (_event, c) => {
		stop();
		if (c.mode !== "tui" && c.mode !== "rpc") return;
		if (isSubagentSession(c.sessionManager as any)) return;
		const cwd = c.cwd;
		scan(cwd);
		poll = setInterval(() => {
			try { scan(cwd); } catch { /* ignore */ }
		}, POLL_MS);
		poll.unref?.();
	});

	pi.on("session_shutdown", async () => stop());
}
