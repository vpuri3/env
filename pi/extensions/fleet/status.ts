/**
 * fleet/status: the live status file of a main pi session (design §5).
 *
 *   <state dir>/status/<sessionId>.json   state dir = $PI_FLEET_STATE_DIR or ~/.local/state/pi-fleet
 *
 * Written atomically (tmp + rename, 0600, dir 0700) on change (debounced 250 ms) and as a 15 s
 * heartbeat. Deleted when the session ends (quit, or replaced by /new, /resume, /fork), kept
 * across /reload. Subagent sessions (in-process children of pi-subagent-manager, which load
 * this extension too) and print/json modes write nothing.
 *
 * State model: a pure reducer (reduce/derive) over events taken from pi:
 *   session_start→starting, then idle once startup finished
 *   agent_start/turn_start→running (sub `tool:<name>` while a tool runs)
 *   ui_prompt_start during a run (not the fleet's own pickers) or a running ask_user_question
 *   →question (a dialog the user opens while idle is not the agent asking)
 *   agent_settled of the current run→waiting (acked=false), or error after a failed run;
 *   an aborted run (Esc) settles as already acknowledged
 *   ack: the next user `input`, or `pi-fleet seen` → idle
 *   idle/waiting while subagents work→running with sub `bg N` (background-work substate)
 * A run id ("r1", "r2", ...) is minted at the first agent_start of a run; a settle carrying
 * another run's id is ignored, and an ack can name the run it saw.
 * Entering waiting, question or error rings BEL (TUI mode only; stdout is the protocol in RPC).
 *
 * `pi-fleet seen` (phase 2 CLI) acks by writing <state dir>/status/<sessionId>.seen containing
 * `{"runId":"r7"}` (see writeSeen); this module polls for it every second while waiting and
 * deletes it. A `.seen` left over from an earlier, already acknowledged run is deleted when the
 * next run settles. The control socket (§10) deliberately has no `seen` command.
 *
 * Readers (ls, the deck list) derive `crashed`/`remote` with liveness().
 *
 * Portions adapted from agent-deck (github.com/asheshgoplani/agent-deck, MIT, commit 80494e5):
 * the event→state mapping and per-run id guard (internal/session/assets/pi/agent-deck.ts) and
 * the waiting/idle acknowledgement and background-work substate
 * (internal/sessionstatus/sessionstatus.go, session/instance_status.go).
 * See THIRD_PARTY_LICENSES.
 *
 * The reducer and helpers are pure (type-only imports), so node runs them directly in tests
 * and the CLI can import the path and liveness helpers.
 */

import { execFile } from "node:child_process";
import { mkdirSync, chmodSync, readFileSync, unlinkSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RegistryFold, isSubagentSession, type SubagentCounts } from "./registry.ts";
import { fleetOf } from "./shared.ts";

// ---------------------------------------------------------------- schema and paths

export type FleetState = "starting" | "running" | "question" | "waiting" | "idle" | "error";

export const GLYPHS: Record<FleetState | "crashed", string> = {
	starting: "⟳",
	running: "●",
	question: "?",
	waiting: "◐",
	idle: "○",
	error: "✕",
	crashed: "✕",
};

export interface StatusFile {
	v: 1;
	sessionId: string;
	sessionFile?: string;
	name?: string;
	cwd: string;
	repo?: string;
	host: string;
	pid: number;
	runId?: string;
	tmux?: { socket?: string; window?: string; windowIndex?: number; piPane?: string; nvimPane?: string };
	nvimSock?: string;
	ctlSock?: string;
	state: FleetState;
	sub?: string;
	acked: boolean;
	since: string;
	lastAssistant?: string;
	model?: string;
	costUsd?: number;
	contextPct?: number;
	subagents: SubagentCounts;
	slurmJobs?: string[];
	/** Set from `/run-autonomously` until `/autonomous off` (lifecycle.ts); absent otherwise. */
	autonomous?: boolean;
	heartbeat: string;
}

export const DEBOUNCE_MS = 250;
export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 60_000;
export const FOLD_MS = 3_000;

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_FLEET_STATE_DIR || join(homedir(), ".local", "state", "pi-fleet");
}
export function statusDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(stateDir(env), "status");
}
export function statusPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(statusDir(env), `${sessionId}.json`);
}
export function seenPath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(statusDir(env), `${sessionId}.seen`);
}

/** Create the state and status dirs with mode 0700 (fixing the mode if they exist). */
export function ensureStatusDir(env: NodeJS.ProcessEnv = process.env): string {
	const root = stateDir(env);
	const dir = statusDir(env);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const d of [root, dir]) {
		try {
			chmodSync(d, 0o700);
		} catch {
			// not ours: leave it
		}
	}
	return dir;
}

/** What `pi-fleet seen` writes: acknowledges `runId` (or whatever is waiting if omitted). */
export async function writeSeen(sessionId: string, runId?: string, env = process.env): Promise<void> {
	const dir = ensureStatusDir(env);
	const path = join(dir, `${sessionId}.seen`);
	const tmp = `${path}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify(runId ? { runId } : {}), { mode: 0o600 });
	await rename(tmp, path);
}

export type Liveness = "live" | "crashed" | "remote" | "stale";

/**
 * Derived states for readers (§5): same host and pid dead, or heartbeat older than 60 s →
 * crashed; another host with a fresh heartbeat → remote; another host and stale → stale.
 */
export function liveness(
	status: Pick<StatusFile, "host" | "pid" | "heartbeat">,
	opts: { now?: number; host?: string; pidAlive?: (pid: number) => boolean } = {},
): Liveness {
	const now = opts.now ?? Date.now();
	const host = opts.host ?? hostname();
	const fresh = now - Date.parse(status.heartbeat) <= STALE_MS;
	if (status.host !== host) return fresh ? "remote" : "stale";
	if (!fresh) return "crashed";
	return (opts.pidAlive ?? pidAlive)(status.pid) ? "live" : "crashed";
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// ---------------------------------------------------------------- reducer

export interface Model {
	/** session_start handled and startup finished. */
	ready: boolean;
	runActive: boolean;
	runSeq: number;
	runId: string | undefined;
	/** The current or last run ended with an error stop reason. */
	failed: boolean;
	/** A run has settled since session start. */
	settled: boolean;
	acked: boolean;
	/** A (non-fleet) UI prompt span is open. */
	prompt: boolean;
	/** Running tools, oldest first: [toolCallId, toolName]. */
	tools: [string, string][];
	/** Subagents working (starting/running). */
	working: number;
}

export type FleetEvent =
	| { type: "session_start" }
	| { type: "ready" }
	| { type: "input" }
	| { type: "seen"; runId?: string }
	| { type: "agent_start" }
	| { type: "turn_start" }
	| { type: "tool_start"; id: string; name: string }
	| { type: "tool_end"; id: string }
	| { type: "turn_end"; error?: boolean }
	| { type: "agent_settled"; runId: string | undefined; aborted?: boolean }
	| { type: "prompt_start" }
	| { type: "prompt_end" }
	| { type: "subagents"; working: number };

export function initialModel(): Model {
	return {
		ready: false,
		runActive: false,
		runSeq: 0,
		runId: undefined,
		failed: false,
		settled: false,
		acked: true,
		prompt: false,
		tools: [],
		working: 0,
	};
}

/** Tools whose running means the agent is asking the user. */
export const ASK_TOOLS = new Set(["ask_user_question"]);

export function reduce(m: Model, e: FleetEvent): Model {
	switch (e.type) {
		case "session_start":
			return { ...initialModel(), runSeq: m.runSeq, working: m.working };
		case "ready":
			return { ...m, ready: true };
		case "input":
			// The user typed: whatever was waiting has been seen.
			return { ...m, ready: true, acked: true };
		case "seen":
			if (e.runId !== undefined && e.runId !== m.runId) return m;
			return { ...m, acked: true };
		case "agent_start":
			if (m.runActive) return m;
			return {
				...m,
				ready: true,
				runActive: true,
				runSeq: m.runSeq + 1,
				runId: `r${m.runSeq + 1}`,
				failed: false,
				acked: true,
				tools: [],
			};
		case "turn_start":
			// A turn outside a run should not happen; treat it as the start of one.
			return m.runActive ? m : reduce(m, { type: "agent_start" });
		case "tool_start":
			return { ...m, tools: [...m.tools.filter(([id]) => id !== e.id), [e.id, e.name]] };
		case "tool_end":
			return { ...m, tools: m.tools.filter(([id]) => id !== e.id) };
		case "turn_end":
			return { ...m, failed: !!e.error };
		case "agent_settled":
			// Run-id guard: a late settle must not overwrite a newer run.
			if (!m.runActive || e.runId !== m.runId) return m;
			return {
				...m,
				runActive: false,
				settled: true,
				acked: !!e.aborted,
				failed: e.aborted ? false : m.failed,
				tools: [],
			};
		case "prompt_start":
			return { ...m, prompt: true };
		case "prompt_end":
			return { ...m, prompt: false };
		case "subagents":
			return { ...m, working: e.working };
	}
}

export interface Derived {
	state: FleetState;
	sub?: string;
	acked: boolean;
}

export function derive(m: Model): Derived {
	const asking = m.tools.some(([, name]) => ASK_TOOLS.has(name));
	if (m.prompt || asking) return { state: "question", sub: asking ? "ask" : undefined, acked: false };
	if (m.runActive) {
		const tool = m.tools.at(-1)?.[1];
		return { state: "running", sub: tool ? `tool:${tool}` : undefined, acked: true };
	}
	if (m.settled && !m.acked && m.failed) return { state: "error", acked: false };
	if (m.working > 0) return { state: "running", sub: `bg ${m.working}`, acked: m.acked };
	if (!m.ready) return { state: "starting", acked: true };
	if (m.settled && !m.acked) return { state: "waiting", acked: false };
	return { state: "idle", acked: true };
}

/** States that ring the terminal bell when entered. */
export const BELL_STATES = new Set<FleetState>(["waiting", "question", "error"]);

export function shouldBell(before: Derived, after: Derived): boolean {
	return before.state !== after.state && BELL_STATES.has(after.state);
}

// ---------------------------------------------------------------- extension

function assistantText(message: any): string | undefined {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return text ? text.slice(0, 200) : undefined;
}

function messageCost(message: any): number {
	const total = message?.role === "assistant" ? message.usage?.cost?.total : undefined;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

function modelName(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as any;
	return model ? `${model.provider}/${model.id}` : undefined;
}

function gitRoot(cwd: string): Promise<string> {
	return new Promise((resolve) => {
		execFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 }, (error, stdout) =>
			resolve(error ? cwd : stdout.trim() || cwd),
		);
	});
}

function tmuxWindow(pane: string): Promise<{ window?: string; windowIndex?: number }> {
	return new Promise((resolve) => {
		execFile(
			"tmux",
			["display-message", "-p", "-t", pane, "#{window_id} #{window_index}"],
			{ timeout: 2000 },
			(error, stdout) => {
				if (error) return resolve({});
				const [window, index] = stdout.trim().split(" ");
				resolve({ window, windowIndex: Number(index) });
			},
		);
	});
}

export function register(pi: ExtensionAPI): void {
	const shared = fleetOf(pi);
	let ctx: ExtensionContext | undefined;
	let model = initialModel();
	let derived = derive(model);
	let since = new Date().toISOString();
	let file: StatusFile | undefined;
	let path: string | undefined;
	let seenFile: string | undefined;
	let bell = false;
	const fold = new RegistryFold();
	let debounce: NodeJS.Timeout | undefined;
	let ticker: NodeJS.Timeout | undefined;
	let ticks = 0;
	let writing: Promise<void> = Promise.resolve();
	let ownSpan = false;
	let generation = 0;
	/** A checkSeen read is in flight (ticks must not overlap on slow NFS). */
	let seenBusy = false;
	/** Bumped when a run settles: a .seen read that started before it is stale. */
	let settleEpoch = 0;

	const active = () => shared.main && !!file;

	const flush = () => {
		if (debounce) clearTimeout(debounce);
		debounce = undefined;
		if (!file || !path) return;
		file.heartbeat = new Date().toISOString();
		const body = JSON.stringify(file) + "\n";
		const target = path;
		const gen = generation;
		writing = writing.then(async () => {
			if (gen !== generation) return;
			const tmp = `${target}.${process.pid}.tmp`;
			try {
				await writeFile(tmp, body, { mode: 0o600 });
				await rename(tmp, target);
			} catch {
				await unlink(tmp).catch(() => {});
			}
		});
	};
	const schedule = () => {
		if (!active() || debounce) return;
		debounce = setTimeout(flush, DEBOUNCE_MS);
		debounce.unref?.();
	};

	const apply = (event: FleetEvent) => {
		if (!active()) return;
		const before = derived;
		model = reduce(model, event);
		derived = derive(model);
		if (!file) return;
		if (derived.state !== before.state || derived.sub !== before.sub) since = new Date().toISOString();
		if (bell && shouldBell(before, derived)) process.stdout.write("\x07");
		Object.assign(file, {
			state: derived.state,
			sub: derived.sub,
			acked: derived.acked,
			since,
			runId: model.runId,
		});
		if (derived.sub === undefined) delete file.sub;
		schedule();
	};

	const refreshSubagents = () => {
		if (!active() || !ctx) return;
		try {
			fold.update(ctx.sessionManager.getBranch() as any);
		} catch {
			return;
		}
		file!.subagents = fold.counts(true);
		if (fold.formatError) file!.subagents.unknown = Math.max(1, file!.subagents.unknown ?? 0);
		if (file!.subagents.working !== model.working) apply({ type: "subagents", working: file!.subagents.working });
		else schedule();
	};

	const refreshMeta = () => {
		if (!active() || !ctx) return;
		file!.model = modelName(ctx);
		try {
			const pct = ctx.getContextUsage()?.percent;
			if (typeof pct === "number") file!.contextPct = Math.round(pct);
		} catch {
			// no model yet
		}
	};

	/** Never awaited by shutdown; a result that arrives after stop() or a settle is dropped. */
	const checkSeen = async () => {
		const target = seenFile;
		if (!target || derived.acked || seenBusy) return;
		const gen = generation;
		const epoch = settleEpoch;
		seenBusy = true;
		try {
			let text: string;
			try {
				text = await readFile(target, "utf8");
			} catch {
				return;
			}
			await unlink(target).catch(() => {});
			if (gen !== generation || epoch !== settleEpoch) return;
			let runId: string | undefined;
			try {
				const data = JSON.parse(text);
				if (typeof data?.runId === "string") runId = data.runId;
			} catch {
				// an empty or odd file acks whatever is waiting
			}
			apply({ type: "seen", runId });
		} catch {
			// never let a poll crash pi
		} finally {
			seenBusy = false;
		}
	};

	const stop = () => {
		generation++;
		if (debounce) clearTimeout(debounce);
		if (ticker) clearInterval(ticker);
		debounce = ticker = undefined;
	};

	pi.on("session_start", async (_event, c) => {
		stop();
		ctx = c;
		shared.main = false;
		shared.status = undefined;
		shared.prior = undefined;
		file = undefined;
		const sm = c.sessionManager;
		if (c.mode !== "tui" && c.mode !== "rpc") return;
		if (isSubagentSession(sm as any)) return;
		shared.main = true;
		bell = c.mode === "tui";
		let dir: string;
		try {
			dir = ensureStatusDir();
		} catch {
			shared.main = false;
			return;
		}
		const sessionId = sm.getSessionId();
		path = join(dir, `${sessionId}.json`);
		seenFile = join(dir, `${sessionId}.seen`);
		// Another process's claim on this id, read before ours replaces it (lifecycle.ts duplicate guard).
		try {
			const prior = JSON.parse(readFileSync(path, "utf8")) as StatusFile;
			if (prior?.sessionId === sessionId && (prior.pid !== process.pid || prior.host !== hostname())) shared.prior = prior;
		} catch {
			// none or unreadable
		}
		try {
			unlinkSync(seenFile);
		} catch {
			// none
		}
		const generationAtStart = ++generation;
		fold.reset();
		model = reduce(model, { type: "session_start" });
		derived = derive(model);
		since = new Date().toISOString();
		let cost = 0;
		for (const entry of sm.getEntries() as any[]) {
			if (entry.type === "message") cost += messageCost(entry.message);
		}
		let last: string | undefined;
		try {
			const branch = sm.getBranch() as any[];
			for (let i = branch.length - 1; i >= 0 && last === undefined; i--) {
				if (branch[i]?.type === "message") last = assistantText(branch[i].message);
			}
		} catch {
			// no branch: no lastAssistant
		}
		const pane = process.env.TMUX_PANE;
		const socket = process.env.TMUX?.split(",")[0];
		file = {
			v: 1,
			sessionId,
			sessionFile: sm.getSessionFile(),
			name: sm.getSessionName(),
			cwd: c.cwd,
			host: hostname(),
			pid: process.pid,
			...(socket && pane ? { tmux: { socket, piPane: pane } } : {}),
			state: derived.state,
			acked: derived.acked,
			since,
			lastAssistant: last,
			costUsd: Math.round(cost * 100) / 100,
			subagents: { working: 0, waiting: 0, done: 0, error: 0 },
			heartbeat: since,
		};
		shared.status = {
			patch: (fields) => {
				if (!file) return;
				Object.assign(file, fields);
				schedule();
			},
			ack: () => apply({ type: "seen" }),
			current: () => (file ? { ...file } : undefined),
		};
		refreshMeta();
		try {
			fold.update(sm.getBranch() as any);
		} catch {
			// refreshSubagents retries
		}
		// Threads a previous (crashed) process left running are not running now (registry.ts).
		fold.markInterrupted();
		refreshSubagents();
		flush();
		void gitRoot(c.cwd).then((repo) => {
			if (generation !== generationAtStart || !file) return;
			file.repo = repo;
			schedule();
		});
		if (socket && pane) {
			void tmuxWindow(pane).then((win) => {
				if (generation !== generationAtStart || !file?.tmux) return;
				Object.assign(file.tmux, win);
				schedule();
			});
		}
		ticks = 0;
		ticker = setInterval(() => {
			ticks++;
			void checkSeen();
			if (ticks % (FOLD_MS / 1000) === 0 && (model.working > 0 || model.runActive)) refreshSubagents();
			if (ticks % (HEARTBEAT_MS / 1000) === 0) flush();
		}, 1000);
		ticker.unref?.();
		// Startup is over once session_start handlers have run.
		setTimeout(() => {
			if (generation === generationAtStart) apply({ type: "ready" });
		}, 0).unref?.();
	});

	pi.on("session_shutdown", async (event) => {
		const target = path;
		const seen = seenFile;
		const wasMain = shared.main && !!file;
		stop();
		file = undefined;
		shared.status = undefined;
		await writing.catch(() => {});
		if (!wasMain || !target || event.reason === "reload") return;
		for (const p of [target, seen]) {
			if (!p) continue;
			try {
				unlinkSync(p);
			} catch {
				// already gone
			}
		}
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") apply({ type: "input" });
	});
	pi.on("agent_start", async () => apply({ type: "agent_start" }));
	pi.on("turn_start", async () => apply({ type: "turn_start" }));
	pi.on("tool_execution_start", async (event) =>
		apply({ type: "tool_start", id: event.toolCallId, name: event.toolName }),
	);
	pi.on("tool_execution_end", async (event) => apply({ type: "tool_end", id: event.toolCallId }));
	pi.on("message_end", async (event) => {
		if (!active()) return;
		const message: any = event.message;
		const text = assistantText(message);
		if (text) file!.lastAssistant = text;
		const cost = messageCost(message);
		if (cost) file!.costUsd = Math.round(((file!.costUsd ?? 0) + cost) * 100) / 100;
		if (text || cost) schedule();
	});
	pi.on("turn_end", async (event, c) => {
		ctx = c;
		apply({ type: "turn_end", error: (event.message as any)?.stopReason === "error" });
		refreshMeta();
		refreshSubagents();
	});
	pi.on("agent_settled", async (event, c) => {
		// A .seen not consumed yet belongs to an earlier, acknowledged run: it must not ack this one.
		const runId = model.runId;
		settleEpoch++;
		if (active() && seenFile) await unlink(seenFile).catch(() => {});
		ctx = c;
		refreshMeta();
		refreshSubagents();
		apply({ type: "agent_settled", runId, aborted: event.aborted });
	});
	pi.on("ui_prompt_start", async () => {
		if (shared.ownPrompts > 0) {
			ownSpan = true;
			return;
		}
		// Only the agent asks: a dialog the user opens while idle is not a question (§5).
		if (model.runActive) apply({ type: "prompt_start" });
	});
	pi.on("ui_prompt_end", async () => {
		if (ownSpan) {
			ownSpan = false;
			return;
		}
		apply({ type: "prompt_end" });
	});
	pi.on("session_info_changed", async (event) => {
		if (!active()) return;
		file!.name = event.name;
		schedule();
	});
	pi.on("model_select", async (_event, c) => {
		ctx = c;
		refreshMeta();
		schedule();
	});
}
