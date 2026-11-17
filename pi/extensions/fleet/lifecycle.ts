/**
 * fleet/lifecycle: session commands of a main pi in tmux (design §7, §8, §16).
 *
 *   /new, /resume  `session_before_switch` → `{cancel:true}` and an `open` in the pi deck
 *                  (docs/pi-deck-design.md §8, deck-client.ts openInDeck): /new opens a new
 *                  session in this cwd, /resume the target (selected if it is in the deck
 *                  already), as a pool pane that the deck shows and focuses. In a deck pi that
 *                  is all; in a pi started by hand in the user's tmux the deck is started if
 *                  needed and popped up over this client. A target running in the user's tmux
 *                  is jumped to (same server) or named. If the deck cannot be reached, a hand-
 *                  started pi falls back to cli.ts openSession (a new window), with a notice.
 *                  The current session (and its subagents) is never torn down.
 *                  Outside tmux pi's own behaviour stays, with a one-line notice. /import (a
 *                  "resume" whose target file does not exist yet) imports in place, with a notice.
 *                  Anything else that switches sessions through pi in a TUI pi
 *                  (ctx.newSession/switchSession from another extension) goes the same way.
 *   /fork, /clone  If subagents are working: confirm that this replaces the session and stops them.
 *                  The fork replaces the session in this window (§8), so on session_start a pane
 *                  paired for another id is re-keyed: pane options and the nvim's
 *                  $PI_FLEET_SESSION/$PI_FLEET_CTL_SOCK (nvim.ts nvimRequest) get the new id.
 *   /kill          Dialog listing the running agent, working subagents (stopped by
 *                  pi-subagent-manager on shutdown; transcripts stay) and this session's Slurm
 *                  jobs still in squeue; the default leaves the jobs running. No dialog for an
 *                  empty session with nothing running. Then abort + ctx.shutdown(): exit 0, so
 *                  `pi-fleet run-pi` closes nvim (unless modified) and the window.
 *                  The control socket's `kill` opens the same dialog, unless it says
 *                  `"confirmed":true` (the dashboard's `d` asked already): then
 *                  it kills at once, and scancels only with `"scancel":true`.
 *   Autonomous     `/run-autonomously` (the prompt template, seen in the `input` event; also its
 *                  old name `/leavemealone`, for sessions started before the rename) marks the
 *                  session autonomous: `autonomous: true` in the status file (the views show a
 *                  working session as "auto") and a "pi-fleet:autonomous" entry, so a resumed
 *                  session keeps it. `/autonomous off` ends it; `/autonomous` shows it.
 *   Slurm capture  `Submitted batch job N` in a bash tool result → appendEntry("pi-fleet:slurm-job")
 *                  and the status file's `slurmJobs`; restored from the session on start.
 *   Duplicate guard  If another live pi (other pid, or other host with a fresh heartbeat) had
 *                  the status file of this session: `Jump there / Quit`; both quit this pi, and
 *                  its status file is put back. control.ts does not bind the socket meanwhile.
 *   TUI only       /new, /resume, the /fork guard and the duplicate guard act only in an
 *                  interactive TUI pi (ctx.mode "tui"). RPC/print/json pis keep pi's own behaviour
 *                  even with $TMUX set: programs never open windows in the user's tmux, and a
 *                  dialog nobody answers cannot hold a pi. /kill and the control socket stay.
 *   Window names   A pi started by hand in tmux (TUI, not in the deck) marks its window
 *                  @pi_fleet_named=1, so `pi-fleet bar` gives it glyph names, unless the user
 *                  renamed the window (automatic-rename off). Its nvim is created on first use
 *                  (view.ts, leader.ts), never at session start.
 *
 * No module-level state: in-process subagents load this extension too; everything checks
 * fleetOf(pi).main.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ctlSockPath, focusPane, inTmux, livePeer, openSession, paneInfo, tmux } from "./cli.ts";
import { duplicateOf } from "./control.ts";
import { inDeck, openInDeck, outsideNotice } from "./deck-client.ts";
import { nvimRequest } from "./nvim.ts";
import { RegistryFold } from "./registry.ts";
import { fleetOf, ownPrompt } from "./shared.ts";
import { pidAlive, statusPath, type StatusFile } from "./status.ts";

export const SLURM_ENTRY = "pi-fleet:slurm-job";
export const AUTONOMOUS_ENTRY = "pi-fleet:autonomous";
const SUBMITTED = /Submitted batch job (\d+)/g;
const REKEY_LUA = "local id, sock = ...\nvim.env.PI_FLEET_SESSION = id\nvim.env.PI_FLEET_CTL_SOCK = sock\nreturn true";
const IMPORT_NOTICE = "pi-fleet: import happens in this window; use /resume to open it elsewhere";
/** globalThis slot: the session file a TUI /import switches to (see session_before_switch). */
const IMPORTING = Symbol.for("pi-fleet.importing");
/** squeue is asked about the most recent job ids only. */
const SQUEUE_MAX = 100;

export interface SlurmJob {
	id: string;
	state: string;
	time: string;
}

/** Job ids in a bash result's text, in order, without duplicates. */
export function submittedJobs(text: string): string[] {
	const ids: string[] = [];
	for (const m of text.matchAll(SUBMITTED)) if (!ids.includes(m[1])) ids.push(m[1]);
	return ids;
}

/** The user input that starts autonomous mode: the `/run-autonomously` prompt template (or its old name). */
export function startsAutonomous(text: string): boolean {
	return /^\/(?:run-autonomously|leavemealone)(?:\s|$)/.test(text.trimStart());
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
	return new Promise((res) => {
		execFile(cmd, args, { timeout: 10_000 }, (error, stdout, stderr) => {
			const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 127) : 0;
			res({ code, out: String(stdout), err: String(stderr) });
		});
	});
}

/** Jobs among `ids` still in squeue; undefined if squeue failed or is missing. */
export async function queuedJobs(ids: string[]): Promise<SlurmJob[] | undefined> {
	if (!ids.length) return [];
	const r = await run("squeue", ["-h", "-j", ids.slice(-SQUEUE_MAX).join(","), "-o", "%i %T %M"]);
	// Every id finished: Slurm answers "Invalid job id specified".
	if (r.code !== 0) return /invalid job id/i.test(r.err) ? [] : undefined;
	const jobs: SlurmJob[] = [];
	for (const line of r.out.split("\n")) {
		const [raw, state, time] = line.trim().split(/\s+/);
		// Array tasks (123_4, 123_[5-10]) and het components (456+0): listed once, as the base job.
		const id = raw?.split(/[_+]/)[0];
		if (id && ids.includes(id) && !jobs.some((j) => j.id === id)) jobs.push({ id, state: state ?? "?", time: time ?? "" });
	}
	return jobs;
}

export interface KillPlan {
	title: string;
	options: string[];
	/** Option label → what it does. */
	actions: Map<string, "kill" | "scancel" | "cancel">;
}

/** The /kill dialog (§8); undefined when the session is empty and nothing runs (no dialog). */
export function killPlan(opts: {
	label: string;
	busy: boolean;
	hasMessages: boolean;
	subagents: string[];
	jobs: SlurmJob[] | undefined;
	submitted: string[];
}): KillPlan | undefined {
	const { label, busy, hasMessages, subagents, jobs, submitted } = opts;
	const jobIds = jobs ? jobs.map((j) => j.id) : submitted;
	if (!busy && !hasMessages && !subagents.length && !jobIds.length) return undefined;
	const lines = [`Kill session "${label}"?${busy ? "   (agent is working: its run will be aborted)" : ""}`];
	if (subagents.length) {
		const n = subagents.length;
		lines.push(`  ${n} subagent${n === 1 ? "" : "s"} working (${subagents.join(", ")}) will be stopped; transcripts are kept.`);
	}
	if (jobs?.length) {
		const list = jobs.map((j) => `${j.id} (${j.state}${j.time ? ` ${j.time}` : ""})`).join(", ");
		lines.push(`  Slurm jobs from this session still queued/running: ${list}`);
	} else if (!jobs && submitted.length) {
		lines.push(`  Slurm jobs from this session (squeue failed, state unknown): ${submitted.join(", ")}`);
	}
	const actions = new Map<string, "kill" | "scancel" | "cancel">();
	if (jobIds.length && (jobs?.length || !jobs)) {
		actions.set("Kill, leave Slurm jobs running", "kill");
		actions.set(`Kill and scancel ${jobIds.join(" ")}`, "scancel");
	} else {
		actions.set("Kill", "kill");
	}
	actions.set("Cancel", "cancel");
	return { title: lines.join("\n"), options: [...actions.keys()], actions };
}

/** Interactive TUI pi: only then do the window-opening interceptions and guards apply (§8). */
export function interactive(c: Pick<ExtensionContext, "mode" | "hasUI">): boolean {
	return c.mode === "tui" && c.hasUI;
}

export type SwitchAction = "native" | "not-tmux" | "import" | "open-new" | "open-target";

/**
 * What session_before_switch does (§8): "native" lets pi switch here silently, "not-tmux" and
 * "import" let it switch here with a notice, "open-*" cancel and open a window. /import emits a
 * "resume" whose target (the copy in the session dir) does not exist yet.
 */
export function switchAction(o: { tui: boolean; tmux: boolean; reason: string; target?: string; targetExists?: boolean }): SwitchAction {
	if (!o.tui) return "native";
	if (!o.tmux) return "not-tmux";
	if (o.reason === "new") return "open-new";
	if (o.reason !== "resume" || !o.target) return "native";
	return o.targetExists ? "open-target" : "import";
}

/**
 * After a duplicate pi quit: put the other pi's status file back (status.ts removed "ours"),
 * unless that pi rewrote it already or died meanwhile on this host.
 */
export async function restoreStatus(other: StatusFile): Promise<boolean> {
	if (other.host === hostname() && !pidAlive(other.pid)) return false;
	const path = statusPath(other.sessionId);
	if (existsSync(path)) return false;
	const tmp = `${path}.${process.pid}.restore.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(other)}\n`, { mode: 0o600 });
		await rename(tmp, path);
		return true;
	} catch {
		// its next heartbeat writes it
		return false;
	}
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b?.type === "text" && typeof b.text === "string")
		.map((b: any) => b.text)
		.join("\n");
}

function sessionLabel(ctx: ExtensionContext, status: StatusFile | undefined): string {
	return ctx.sessionManager.getSessionName() || status?.name || basename(status?.repo || ctx.cwd) || "pi";
}

export function register(pi: ExtensionAPI): void {
	const shared = fleetOf(pi);
	let ctx: ExtensionContext | undefined;
	let jobs: string[] = [];
	const fold = new RegistryFold();
	let killing = false;
	let autonomous = false;
	/** Set when this pi quits as a duplicate: the other pi's status file to put back. */
	let restore: StatusFile | undefined;
	let generation = 0;

	const notify = (c: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info") => {
		if (c.hasUI) c.ui.notify(text, level);
	};

	const workingSubagents = (c: ExtensionContext): string[] => {
		try {
			fold.update(c.sessionManager.getBranch() as any);
		} catch {
			return [];
		}
		return [...fold.threads.values()].filter((t) => t.state === "starting" || t.state === "running").map((t) => t.path);
	};

	const publishJobs = () => {
		if (jobs.length) shared.status?.patch({ slurmJobs: [...jobs] });
	};

	const publishAutonomous = () => shared.status?.patch({ autonomous: autonomous || undefined });
	const setAutonomous = (on: boolean) => {
		autonomous = on;
		pi.appendEntry(AUTONOMOUS_ENTRY, { on, time: new Date().toISOString() });
		publishAutonomous();
	};

	/** `confirmed`: the user already chose in the dashboard (no dialog here). */
	const kill = async (c: ExtensionContext, confirmed?: { scancel: boolean }): Promise<boolean> => {
		if (killing) return false;
		killing = true;
		try {
			let action: "kill" | "scancel" | "cancel" = "kill";
			let queued: SlurmJob[] | undefined = [];
			if (confirmed) {
				if (confirmed.scancel && jobs.length) {
					queued = await queuedJobs(jobs);
					action = "scancel";
				}
			} else {
				const subagents = workingSubagents(c);
				queued = await queuedJobs(jobs);
				const hasMessages = c.sessionManager.getEntries().some((e: any) => e.type === "message");
				const plan = killPlan({
					label: sessionLabel(c, shared.status?.current()),
					busy: !c.isIdle(),
					hasMessages,
					subagents,
					jobs: queued,
					submitted: jobs,
				});
				if (plan) {
					const choice = await ownPrompt(pi, () => c.ui.select(plan.title, plan.options));
					action = (choice && plan.actions.get(choice)) || "cancel";
				}
			}
			if (action === "cancel") return false;
			if (action === "scancel") {
				const ids = queued ? queued.map((j) => j.id) : jobs;
				const r = ids.length ? await run("scancel", ids) : { code: 0, err: "" };
				if (r.code !== 0) notify(c, `pi-fleet: scancel failed: ${r.err.trim() || `exit ${r.code}`}`, "error");
			}
			// Subagents: pi-subagent-manager stops them on session_shutdown (transcripts stay).
			if (!c.isIdle()) c.abort();
			c.shutdown();
			return true;
		} finally {
			killing = false;
		}
	};

	const duplicateGuard = async (c: ExtensionContext, other: StatusFile, gen: number) => {
		let pane: string | undefined;
		let windowIndex: number | undefined;
		if (other.tmux?.piPane && inTmux()) {
			const info = await paneInfo(other.tmux.piPane);
			if (info && (!other.tmux.socket || other.tmux.socket === info.socket)) ({ pane, windowIndex } = info);
		}
		if (gen !== generation) return;
		const where = other.host !== shared.status?.current()?.host ? `on ${other.host}` : `as pid ${other.pid}${pane ? ` (window ${windowIndex ?? pane})` : ""}`;
		const title = `Session "${sessionLabel(c, other)}" is already running ${where}.\nTwo pis on one session would overwrite each other.`;
		const options = pane ? ["Jump there", "Quit"] : ["Quit"];
		const choice = c.hasUI ? await ownPrompt(pi, () => c.ui.select(title, options)) : undefined;
		if (gen !== generation) return;
		if (choice === "Jump there" && pane) await focusPane(pane).catch(() => {});
		restore = other;
		c.shutdown();
	};

	/** Mark a hand-started pi's window for glyph names, unless the user named it. */
	const markWindow = async (pane: string) => {
		try {
			const [autoRename, named] = (await tmux(["display-message", "-p", "-t", pane, "#{automatic-rename}\t#{@pi_fleet_named}"])).split("\t");
			if (autoRename === "1" && named !== "1") await tmux(["set-option", "-w", "-t", pane, "@pi_fleet_named", "1"]);
		} catch {
			// pane gone or no tmux: nothing to name
		}
	};

	/**
	 * A TUI pi's pane is marked @pi_fleet_role=pi / @pi_fleet_session (its nvim comes later, on
	 * first use, and `prefix e` / `pi-fleet pair` find the session there). A pane paired for
	 * another session id (after /fork or /clone, which replace the session in place, or a pi run
	 * again by hand in a paired pane) is re-keyed: the pane options and the paired nvim's
	 * $PI_FLEET_SESSION / $PI_FLEET_CTL_SOCK, so its saves reach this session's socket.
	 */
	const rekeyPair = async (pane: string, sessionId: string, tui: boolean) => {
		try {
			const me = await paneInfo(pane);
			if (!me) return;
			if (!me.role && tui) {
				await tmux(["set-option", "-p", "-t", pane, "@pi_fleet_role", "pi", ";", "set-option", "-p", "-t", pane, "@pi_fleet_session", sessionId]);
				return;
			}
			if (me.role !== "pi" || me.fleetSession === sessionId) return;
			const peer = await livePeer(pane);
			const args = ["set-option", "-p", "-t", pane, "@pi_fleet_session", sessionId];
			if (peer) args.push(";", "set-option", "-p", "-t", peer.pane, "@pi_fleet_session", sessionId);
			await tmux(args);
			if (process.env.PI_FLEET_SESSION) process.env.PI_FLEET_SESSION = sessionId;
			if (peer?.role === "nvim" && peer.nvimSock) {
				// Values travel as data (`...`), never spliced into the Lua code.
				await nvimRequest(peer.nvimSock, "nvim_exec_lua", [REKEY_LUA, [sessionId, ctlSockPath(sessionId)]]);
			}
		} catch {
			// no tmux, pane gone, or nvim unreachable (nvim.ts re-pairs on the next call)
		}
	};

	shared.control.on("kill", (message) => {
		const c = ctx;
		if (!c || !shared.main) throw new Error("no session");
		const confirmed = message.confirmed === true ? { scancel: message.scancel === true } : undefined;
		void kill(c, confirmed).catch(() => {});
		return {};
	});

	pi.on("session_start", async (_event, c) => {
		const gen = ++generation;
		ctx = undefined;
		jobs = [];
		autonomous = false;
		restore = undefined;
		fold.reset();
		if (!shared.main) return;
		ctx = c;
		const sm = c.sessionManager;
		const g = globalThis as Record<symbol, unknown>;
		if (g[IMPORTING] && g[IMPORTING] === sm.getSessionFile()) {
			delete g[IMPORTING];
			// After pi has rebuilt the chat of the imported session.
			setTimeout(() => gen === generation && notify(c, IMPORT_NOTICE), 0);
		}
		for (const entry of sm.getEntries() as any[]) {
			if (entry.type !== "custom") continue;
			if (entry.customType === AUTONOMOUS_ENTRY) autonomous = entry.data?.on === true;
			if (entry.customType !== SLURM_ENTRY) continue;
			const id = entry.data?.jobId;
			if (typeof id === "string" && /^\d+$/.test(id) && !jobs.includes(id)) jobs.push(id);
		}
		publishJobs();
		if (autonomous) publishAutonomous();
		try {
			fold.update(sm.getBranch() as any);
		} catch {
			// workingSubagents retries
		}
		// Threads a previous (crashed) process left running are not running now.
		fold.markInterrupted();
		const other = interactive(c) ? duplicateOf(shared) : undefined;
		if (other) {
			// After session_start: dialogs and shutdown need a started session.
			setTimeout(() => void duplicateGuard(c, other, gen).catch(() => {}), 0);
			return;
		}
		const pane = process.env.TMUX_PANE;
		if (process.env.TMUX && pane) {
			void rekeyPair(pane, sm.getSessionId(), c.mode === "tui");
			if (c.mode === "tui" && !inDeck()) void markWindow(pane);
		}
	});

	pi.on("session_shutdown", async () => {
		generation++;
		ctx = undefined;
		const other = restore;
		restore = undefined;
		if (other) await restoreStatus(other);
	});

	pi.on("session_before_switch", async (event, c) => {
		if (!shared.main) return;
		const target = event.targetSessionFile;
		const action = switchAction({ tui: interactive(c), tmux: inTmux(), reason: event.reason, target, targetExists: !!target && existsSync(target) });
		if (action === "native") return;
		if (action === "not-tmux") {
			notify(c, `pi-fleet: not in tmux, so /${event.reason} replaces this session here`);
			return;
		}
		if (action === "import") {
			// The notice is shown in the imported session: one sent now goes with this session's
			// chat, and the extension instance is replaced too, hence the process-wide slot.
			(globalThis as Record<symbol, unknown>)[IMPORTING] = target;
			return;
		}
		const req = action === "open-new" ? { cwd: c.cwd } : { session: target! };
		try {
			const r = await openInDeck(req);
			if (r.ok) {
				if (r.popupError) notify(c, `pi-fleet: opened in the deck, but no popup here (${r.popupError}); \`pf\` attaches it`, "warning");
			} else {
				const notice = await outsideNotice(r.outside, r.error);
				if (notice) notify(c, notice, "warning");
			}
		} catch (error) {
			const why = (error as Error).message;
			if (inDeck()) {
				notify(c, `pi-fleet: deck: ${why}`, "error");
			} else {
				// The deck is unreachable: the window of old (pi-fleet-design.md §8).
				try {
					const result = await openSession({ ...req, target: process.env.TMUX_PANE });
					notify(c, `pi-fleet: the deck is unavailable (${why}); ${result.action === "refused" ? `that session is ${result.reason}` : "opened a window instead"}`, "warning");
				} catch (error2) {
					notify(c, `pi-fleet: could not open the session: ${why}; ${(error2 as Error).message}`, "error");
				}
			}
		}
		// Never tear this session down: the other one lives in its own pane.
		return { cancel: true };
	});

	pi.on("session_before_fork", async (event, c) => {
		if (!shared.main) return;
		const working = workingSubagents(c);
		if (!working.length || !interactive(c)) return;
		const n = working.length;
		const what = event.position === "at" ? "Clone" : "Fork";
		const ok = await ownPrompt(pi, () =>
			c.ui.confirm(
				`${what} with ${n} subagent${n === 1 ? "" : "s"} working?`,
				`${what === "Fork" ? "Forking" : "Cloning"} replaces this session in this window and stops ${working.join(", ")}.`,
			),
		);
		if (!ok) return { cancel: true };
	});

	pi.on("input", async (event) => {
		if (shared.main && ctx && !autonomous && startsAutonomous(event.text)) setAutonomous(true);
	});

	pi.on("tool_result", async (event) => {
		if (!shared.main || event.toolName !== "bash") return;
		for (const id of submittedJobs(textOf(event.content))) {
			if (jobs.includes(id)) continue;
			jobs.push(id);
			pi.appendEntry(SLURM_ENTRY, { jobId: id, time: new Date().toISOString() });
		}
		publishJobs();
	});

	pi.registerCommand("autonomous", {
		description: "pi-fleet: show autonomous mode (set by /run-autonomously); /autonomous off ends it",
		getArgumentCompletions: (prefix: string) => ("off".startsWith(prefix.trim()) ? [{ value: "off", label: "off" }] : null),
		handler: async (args, c) => {
			if (!shared.main) {
				notify(c, "pi-fleet: /autonomous works in a main session only", "warning");
				return;
			}
			const arg = String(args ?? "").trim();
			if (arg === "off") {
				if (autonomous) setAutonomous(false);
				notify(c, "pi-fleet: autonomous mode off");
			} else if (!arg) {
				notify(c, autonomous ? "pi-fleet: autonomous (since /run-autonomously); /autonomous off ends it" : "pi-fleet: not autonomous (/run-autonomously starts it)");
			} else {
				notify(c, "pi-fleet: usage: /autonomous [off]", "warning");
			}
		},
	});

	pi.registerCommand("kill", {
		description: "End this session (asks first if anything runs; Slurm jobs keep running by default)",
		handler: async (_args, c) => {
			if (!shared.main) {
				c.ui.notify("pi-fleet: /kill works in a main session only", "warning");
				return;
			}
			await kill(c);
		},
	});
}
