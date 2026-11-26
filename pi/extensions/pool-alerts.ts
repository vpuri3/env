/**
 * pool-alerts: wakes the main pi session of a repo when an `sjob pool` writes new alerts.
 *
 * Polls (no fs.watch; Lustre) the registry `${XDG_STATE_HOME:-~/.local/state}/sjob-pool/*.pool`
 * (lines `dir=` and `repo=`) and each pool's `alerts.jsonl` every 20 s. Each file starts at its
 * end at session start, so only new alerts count; truncation/rotation restarts from 0.
 * Session id: PI_FLEET_SESSION, else PI_SESSION_ID, else ctx sessionManager.getSessionId().
 * Alerts route by `owners` (fallback: scope/cwd); stale pools (driver.hb+watchdog.hb >10 min) alert once.
 * Delivers only if this session's cwd (realpath) is the pool's repo or inside it, and only in
 * the main session: subagents are recognised by fleet/registry.ts isSubagentSession
 * (pi-subagent-manager thread entry, or parentSession + `<type> /<path>` name).
 * Alerts arriving within 10 s are batched into one follow-up message that triggers a turn.
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, isAbsolute } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagentSession } from "./fleet/registry.ts";

export const POLL_MS = 20_000;
export const BATCH_MS = 10_000;
export const MAX_LINES = 20;

export const STALE_MS = 10 * 60_000;

export interface Alert { pool: string; kind: string; item: string; msg: string; dir: string; owners: string[]; off?: number }
export type Scope = "session" | "repo" | "cluster";
export interface PoolEntry { dir: string; repo: string; scope: Scope; owner: string }

export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "sjob-pool");
}

export function parseRegistry(text: string): PoolEntry | undefined {
	let dir = "", repo = "", scope = "", owner = "";
	for (const line of text.split("\n")) {
		const m = /^(dir|repo|scope|owner)=(.*)$/.exec(line.trim());
		if (!m) continue;
		if (m[1] === "dir") dir = m[2]; else if (m[1] === "repo") repo = m[2];
		else if (m[1] === "scope") scope = m[2]; else owner = m[2];
	}
	const sc: Scope = scope === "session" || scope === "cluster" ? scope : "repo";
	return dir && repo ? { dir, repo, scope: sc, owner } : undefined;
}

/** Delivery rule: id in owners, else (no owners) fallback by scope + cwd-in-repo. */
export function shouldDeliver(owners: string[], me: string, scope: Scope, inRepo: boolean): boolean {
	if (owners.length) return !!me && owners.includes(me);
	return scope !== "cluster" && inRepo;
}

/** Does this session receive pool-level alerts for the pool? */
export function receivesPoolAlerts(e: PoolEntry, me: string, inRepo: boolean, ownsItem: boolean): boolean {
	if (ownsItem) return true;
	if (e.scope === "session" && e.owner) return !!me && e.owner === me;
	return e.scope !== "cluster" && inRepo;
}

/** `# pool-owner:` from the first 3 lines of item text. */
export function parsePoolOwner(text: string): string {
	for (const l of text.split("\n").slice(0, 3)) {
		const m = /^#\s*pool-owner:\s*(\S+)/.exec(l);
		if (m) return m[1];
	}
	return "";
}

/** Staleness episode: returns fire=true once when both heartbeats are old; resets when one is fresh. */
export function staleStep(wasStale: boolean, driverAge: number, watchdogAge: number): { stale: boolean; fire: boolean } {
	const stale = driverAge > STALE_MS && watchdogAge > STALE_MS;
	return { stale, fire: stale && !wasStale };
}

/** Parse complete JSONL lines; malformed or non-object lines are skipped. */
export function parseAlerts(text: string, dir = "", base = 0): Alert[] {
	const out: Alert[] = [];
	let pos = base;
	for (const line of text.split("\n")) {
		const off = pos;
		pos += Buffer.byteLength(line) + 1;
		if (!line.trim()) continue;
		try {
			const o = JSON.parse(line);
			if (!o || typeof o !== "object" || Array.isArray(o)) continue;
			const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
			out.push({ pool: s(o.pool), kind: s(o.kind), item: s(o.item), msg: s(o.msg), dir: s(o.dir) || dir,
				owners: Array.isArray(o.owners) ? o.owners.map(s).filter(Boolean) : [], off });
		} catch { /* skip */ }
	}
	return out;
}

/** Byte offset stored by `sjob pool alerts DIR --ack` in DIR/alerts.ack (0 if missing/invalid). */
export function readAckOffset(dir: string): number {
	try { const n = parseInt(readFileSync(join(dir, "alerts.ack"), "utf8").trim(), 10); return Number.isFinite(n) && n > 0 ? n : 0; } catch { return 0; }
}

/** Drop alerts whose line starts before the pool's acked offset (alerts without `off`, e.g. stale, are kept). */
export function dropAcked(alerts: Alert[], ackOf: (dir: string) => number): Alert[] {
	const cache = new Map<string, number>();
	return alerts.filter((a) => {
		if (a.off == null) return true;
		if (!cache.has(a.dir)) cache.set(a.dir, ackOf(a.dir));
		return a.off >= cache.get(a.dir)!;
	});
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
	const staleNow = new Map<string, boolean>();

	const stop = () => {
		if (poll) clearInterval(poll);
		if (flush) clearTimeout(flush);
		poll = flush = undefined;
		pending = [];
		offsets.clear();
		staleNow.clear();
	};

	const age = (f: string) => { try { return Date.now() - statSync(f).mtimeMs; } catch { return Infinity; } };
	const ownsItem = (dir: string, me: string) => {
		if (!me) return false;
		for (const sub of ["queue", "running"]) {
			let names: string[] = [];
			try { names = readdirSync(join(dir, sub)); } catch { continue; }
			for (const n of names) {
				try {
					const fd = openSync(join(dir, sub, n), "r");
					const b = Buffer.alloc(512);
					let k = 0;
					try { k = readSync(fd, b, 0, 512, 0); } finally { closeSync(fd); }
					if (parsePoolOwner(b.subarray(0, k).toString("utf8")) === me) return true;
				} catch { /* skip */ }
			}
		}
		return false;
	};

	const scan = (cwd: string, me: string) => {
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
				const inRepo = cwdInRepo(cwd, e.repo);
				try {
					if (receivesPoolAlerts(e, me, inRepo, ownsItem(e.dir, me))) {
						const st = staleStep(staleNow.get(e.dir) ?? false, age(join(e.dir, "driver.hb")), age(join(e.dir, "watchdog.hb")));
						staleNow.set(e.dir, st.stale);
						if (st.fire) {
							let host = "";
							try { host = readFileSync(join(e.dir, "driver.host"), "utf8").trim(); } catch { /* none */ }
							pending.push({ pool: basename(e.dir), kind: "stale", item: "", dir: e.dir, owners: [],
								msg: `driver+watchdog dead on ${host}; restart: sjob pool start ${e.dir}` });
						}
					}
				} catch { /* ignore */ }
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
				if (!r.text) continue;
				pending.push(...parseAlerts(r.text, e.dir, r.offset - Buffer.byteLength(r.text)).filter((a) => shouldDeliver(a.owners, me, e.scope, inRepo)));
			} catch { /* never throw */ }
		}
		for (const f of [...offsets.keys()]) if (!seen.has(f)) offsets.delete(f);
		if (pending.length && !flush) {
			flush = setTimeout(() => {
				flush = undefined;
				const batch = dropAcked(pending, readAckOffset);
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
		let me = process.env.PI_FLEET_SESSION || process.env.PI_SESSION_ID || "";
		if (!me) { try { me = (c.sessionManager as any).getSessionId?.() || ""; } catch { /* none */ } }
		scan(cwd, me);
		poll = setInterval(() => {
			try { scan(cwd, me); } catch { /* ignore */ }
		}, POLL_MS);
		poll.unref?.();
	});

	pi.on("session_shutdown", async () => stop());
}
