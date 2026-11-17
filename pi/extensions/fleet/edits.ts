/**
 * fleet/edits: delivery of the user's saves in the paired nvim to the agent (design §11, phase 7).
 *
 * Input: nvim.ts validates `user_edit` control-socket lines and re-emits them on pi.events as
 * USER_EDIT_EVENT ("pi-fleet:user-edit", payload protocol.ts UserEditMessage). Main sessions only.
 *
 * Policy (the §11 table, with the user's decisions):
 *
 *   | save         | agent idle                  | working, path touched this run | working, other path |
 *   | `:w!`  note  | pending: next user message  | steer (before its next step)   | pending             |
 *   | `:w!!` steer | steer + triggerTurn (a turn)| steer                          | steer               |
 *
 *   - Saves of one path are coalesced: a per-path debounce (2 s for notes, STEER_COALESCE_MS for
 *     `:w!!`, which the user wants "immediately"). Several saves become one net diff when the
 *     earlier text can be rebuilt by reverse-applying the diffs to the file on disk; otherwise
 *     the diffs are listed save by save. A net-empty change is dropped.
 *   - Cap: a diff over MAX_DIFF_LINES lines, or one nvim cut short (`truncated`), is replaced by
 *     a summary of the changed line ranges and "Read the file".
 *   - A pending note also turns into a steer as soon as the running agent calls read/edit/write
 *     on that path.
 *   - Write guard: an `edit` or `write` tool call on a file the user saved after the agent last
 *     `read` it is blocked with a reason telling it to read the file again. (The user extended
 *     the §11 guard from `write` to `edit` as well.)
 *   - Widget "pi-fleet-edits" above the editor lists undelivered edits.
 *
 * Mechanisms (pi 1.5.2, checked in dist/core/agent-session.js):
 *   - Notes are kept here, not queued in pi with deliverAs:"nextTurn": a queued nextTurn message
 *     can be neither coalesced with a later save nor observed for the widget. They are attached
 *     by `before_agent_start` (returned `message`, placed right after the starting user message
 *     of the run, for any run start) or, when the user's next message is a steer/follow-up typed
 *     while the agent works, by an `input` transform that appends them to that message. A
 *     separate queued custom message would instead take its own turn (steering/follow-up queues
 *     drain one message per turn by default), delaying the user's own message by one step.
 *   - Steers use pi.sendMessage(…, {deliverAs:"steer", triggerTurn:true}): while streaming it is
 *     queued on the agent and lands after the running tool calls, before the next LLM call (a
 *     running tool is never aborted); while idle it starts a run.
 *   - The guard is a `tool_call` handler returning {block, reason}.
 *
 * No module-level mutable state (fleetOf(pi) / register()'s closure only): subagents load this
 * extension in the same process.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { toolPath, USER_EDIT_EVENT } from "./nvim.ts";
import type { UserEditMessage, UserEditMode } from "./protocol.ts";
import { fleetOf } from "./shared.ts";

/** customType of the messages the agent gets (also the pi.events channel name used by nvim.ts). */
export const CUSTOM_TYPE = "pi-fleet:user-edit";
export const WIDGET_KEY = "pi-fleet-edits";
export const NOTE_COALESCE_MS = 2000;
export const STEER_COALESCE_MS = 500;
export const MAX_DIFF_LINES = 120;
const WIDGET_MAX = 5;
const SUMMARY_MAX_RANGES = 12;
/** LCS table cells for the net diff of coalesced saves; bigger changes are listed per save. */
const DIFF_MAX_CELLS = 2_000_000;

// ---------------------------------------------------------------- policy (pure)

export type Delivery = "steer" | "note";

/** The §11 table: how a save (after coalescing) reaches the agent. */
export function deliveryFor(mode: UserEditMode, running: boolean, touchedThisRun: boolean): Delivery {
	if (mode === "steer") return "steer";
	return running && touchedThisRun ? "steer" : "note";
}

/** The write guard: block `edit`/`write` when the user saved after the agent's last read. */
export function guardBlocks(toolName: string, userChangedAt: number | undefined, lastReadAt: number | undefined): boolean {
	if (toolName !== "edit" && toolName !== "write") return false;
	if (userChangedAt === undefined) return false;
	return lastReadAt === undefined || userChangedAt > lastReadAt;
}

export function clock(ms: number): string {
	const d = new Date(ms);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function guardReason(display: string, changedAt: number, toolName: string): string {
	return (
		`Blocked: the user edited ${display} in their editor at ${clock(changedAt)}, after you last read it. ` +
		`Read the file again, then redo this ${toolName} against its current content.`
	);
}

/** `path` relative to cwd when inside it, else absolute. */
export function displayPath(path: string, cwd: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

// ---------------------------------------------------------------- diffs (pure)

interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(diff: string): Hunk[] | undefined {
	const hunks: Hunk[] = [];
	let cur: Hunk | undefined;
	for (const line of diff.split("\n")) {
		const m = HUNK_RE.exec(line);
		if (m) {
			cur = {
				oldStart: Number(m[1]),
				oldLines: m[2] === undefined ? 1 : Number(m[2]),
				newStart: Number(m[3]),
				newLines: m[4] === undefined ? 1 : Number(m[4]),
				lines: [],
			};
			hunks.push(cur);
		} else if (cur && line !== "" && " +-\\".includes(line[0])) {
			cur.lines.push(line);
		} else if (line.startsWith("---") || line.startsWith("+++") || line === "") {
			continue;
		} else if (!cur) {
			continue;
		} else {
			return undefined;
		}
	}
	return hunks;
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** The text before `diff` was applied, given the text after it; undefined when they don't match. */
export function reverseApply(text: string, diff: string): string | undefined {
	const hunks = parseHunks(diff);
	if (!hunks) return undefined;
	const lines = splitLines(text);
	const out: string[] = [];
	let pos = 0;
	for (const h of hunks) {
		let idx = h.newLines === 0 ? h.newStart : h.newStart - 1;
		if (idx < pos || idx > lines.length) return undefined;
		out.push(...lines.slice(pos, idx));
		for (const l of h.lines) {
			const body = l.slice(1);
			if (l[0] === " ") {
				if (lines[idx] !== body) return undefined;
				out.push(body);
				idx++;
			} else if (l[0] === "+") {
				if (lines[idx] !== body) return undefined;
				idx++;
			} else if (l[0] === "-") {
				out.push(body);
			}
		}
		pos = idx;
	}
	out.push(...lines.slice(pos));
	return out.length ? out.join("\n") + (text.endsWith("\n") || text === "" ? "\n" : "") : "";
}

/** Unified diff body (hunks only, no file header) from `a` to `b`; undefined when too large. */
export function unifiedDiff(a: string, b: string, context = 3): string | undefined {
	const x = splitLines(a);
	const y = splitLines(b);
	let pre = 0;
	while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
	let suf = 0;
	while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
	const xm = x.slice(pre, x.length - suf);
	const ym = y.slice(pre, y.length - suf);
	const n = xm.length;
	const m = ym.length;
	if ((n + 1) * (m + 1) > DIFF_MAX_CELLS) return undefined;
	// LCS lengths of suffixes, then walk forwards.
	const w = m + 1;
	const t = new Uint32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			t[i * w + j] = xm[i] === ym[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
	type Op = { k: " " | "-" | "+"; s: string };
	const ops: Op[] = x.slice(0, pre).map((s) => ({ k: " " as const, s }));
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && xm[i] === ym[j]) {
			ops.push({ k: " ", s: xm[i++] });
			j++;
		} else if (i < n && (j >= m || t[(i + 1) * w + j] >= t[i * w + j + 1])) ops.push({ k: "-", s: xm[i++] });
		else ops.push({ k: "+", s: ym[j++] });
	}
	for (const s of x.slice(x.length - suf)) ops.push({ k: " ", s });

	const out: string[] = [];
	let oldLine = 1;
	let newLine = 1;
	const lineAt: { o: number; n: number }[] = [];
	for (const op of ops) {
		lineAt.push({ o: oldLine, n: newLine });
		if (op.k !== "+") oldLine++;
		if (op.k !== "-") newLine++;
	}
	let k = 0;
	while (k < ops.length) {
		if (ops[k].k === " ") {
			k++;
			continue;
		}
		const start = Math.max(0, k - context);
		let end = k;
		// extend while changes are within 2*context of each other
		for (;;) {
			while (end < ops.length && ops[end].k !== " ") end++;
			let gap = end;
			while (gap < ops.length && ops[gap].k === " ") gap++;
			if (gap < ops.length && gap - end <= 2 * context) end = gap;
			else break;
		}
		const stop = Math.min(ops.length, end + context);
		const slice = ops.slice(start, stop);
		const oc = slice.filter((o) => o.k !== "+").length;
		const nc = slice.filter((o) => o.k !== "-").length;
		const os = oc === 0 ? lineAt[start].o - 1 : lineAt[start].o;
		const ns = nc === 0 ? lineAt[start].n - 1 : lineAt[start].n;
		out.push(`@@ -${os},${oc} +${ns},${nc} @@`);
		for (const o of slice) out.push(o.k + o.s);
		k = stop;
	}
	return out.length ? out.join("\n") + "\n" : "";
}

export function countDiff(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const l of diff.split("\n")) {
		if (l.startsWith("+") && !l.startsWith("+++")) added++;
		else if (l.startsWith("-") && !l.startsWith("---")) removed++;
	}
	return { added, removed };
}

export interface Save {
	diff: string;
	added: number;
	removed: number;
	created: boolean;
	truncated: boolean;
}

/** One file's coalesced change: a single diff, or (when no net diff could be built) one per save. */
export interface Combined {
	diffs: string[];
	added: number;
	removed: number;
	created: boolean;
	truncated: boolean;
}

/**
 * Coalesce consecutive saves of one file. With several saves, rebuild the text before the
 * first save by reverse-applying every diff to `finalText` (the file now) and diff that against
 * it; if that fails, keep the diffs save by save. Undefined when nothing changed.
 */
export function combine(saves: Save[], finalText: string | undefined): Combined | undefined {
	const created = saves[0]?.created ?? false;
	const truncated = saves.some((s) => s.truncated);
	if (saves.length === 1) {
		const s = saves[0];
		if (!s.diff.trim() && !s.created && !s.truncated) return undefined;
		return { diffs: [s.diff], added: s.added, removed: s.removed, created, truncated };
	}
	if (!truncated && finalText !== undefined) {
		let base: string | undefined = finalText;
		for (let i = saves.length - 1; i >= 0 && base !== undefined; i--) base = reverseApply(base, saves[i].diff);
		const net = base === undefined ? undefined : unifiedDiff(base, finalText);
		if (net !== undefined) {
			if (!net.trim()) return undefined;
			return { diffs: [net], ...countDiff(net), created, truncated: false };
		}
	}
	const kept = saves.filter((s) => s.diff.trim() || s.truncated);
	if (!kept.length) return undefined;
	return {
		diffs: kept.map((s) => s.diff),
		added: kept.reduce((n, s) => n + s.added, 0),
		removed: kept.reduce((n, s) => n + s.removed, 0),
		created,
		truncated,
	};
}

function trimEnd(diff: string): string {
	return diff.replace(/\n+$/, "");
}

function diffLineCount(diffs: string[]): number {
	return diffs.reduce((n, d) => n + (trimEnd(d) ? trimEnd(d).split("\n").length : 0), 0);
}

/** New-side line ranges of the hunks, e.g. "10–16, 40–52". */
export function changedRanges(diffs: string[], max = SUMMARY_MAX_RANGES): string {
	const ranges: string[] = [];
	for (const d of diffs)
		for (const h of parseHunks(d) ?? []) {
			const last = h.newStart + Math.max(h.newLines, 1) - 1;
			ranges.push(h.newLines <= 1 ? `${h.newStart}` : `${h.newStart}–${last}`);
		}
	if (ranges.length > max) return `${ranges.slice(0, max).join(", ")}, …`;
	return ranges.join(", ");
}

/** The paragraph for one file in the message the agent gets. */
export function formatEdit(display: string, c: Combined, maxLines = MAX_DIFF_LINES): string {
	const head = `The user ${c.created ? "created" : "edited"} ${display} in their editor (+${c.added} −${c.removed})`;
	const lines = diffLineCount(c.diffs);
	if (c.truncated || lines > maxLines) {
		const why = c.truncated ? "The diff is too large to show here" : `The diff is too long to show here (${lines} lines)`;
		const ranges = changedRanges(c.diffs);
		const where = ranges ? `; changed lines${c.truncated ? " include" : ""}: ${ranges}` : "";
		return `${head}. ${why}${where}. Read the file before you continue working on it.`;
	}
	if (c.diffs.length === 1) return `${head}:\n\`\`\`diff\n${trimEnd(c.diffs[0])}\n\`\`\``;
	const parts = c.diffs.map((d, i) => `Save ${i + 1} of ${c.diffs.length}:\n\`\`\`diff\n${trimEnd(d)}\n\`\`\``);
	return `${head}, over ${c.diffs.length} saves:\n${parts.join("\n")}`;
}

/** Closing line naming the files the write guard still protects. */
export function guardHint(displays: string[]): string {
	if (!displays.length) return "";
	if (displays.length === 1)
		return `Read ${displays[0]} again before you edit or write it: pi blocks edits and writes to a file the user changed after you last read it.`;
	return `Read ${displays.join(", ")} again before you edit or write them: pi blocks edits and writes to a file the user changed after you last read it.`;
}

export function formatMessage(parts: string[], guarded: string[]): string {
	const hint = guardHint(guarded);
	return [...parts, ...(hint ? [hint] : [])].join("\n\n");
}

export interface WidgetEntry {
	display: string;
	added: number;
	removed: number;
	mode: UserEditMode;
}

export function widgetLines(entries: WidgetEntry[]): string[] | undefined {
	if (!entries.length) return undefined;
	const lines = entries
		.slice(0, WIDGET_MAX)
		.map((e) => `✎ ${e.display} (+${e.added} −${e.removed}) ${e.mode === "steer" ? "goes to pi now" : "goes with your next message"}`);
	if (entries.length > WIDGET_MAX) lines.push(`✎ … ${entries.length - WIDGET_MAX} more edited files`);
	return lines;
}

// ---------------------------------------------------------------- register

export interface EditsOptions {
	noteMs?: number;
	steerMs?: number;
	now?: () => number;
}

interface Pending {
	path: string;
	mode: UserEditMode;
	saves: Save[];
	/** Debounce timer; undefined once the entry is ready (coalescing window over). */
	timer: ReturnType<typeof setTimeout> | undefined;
}

function canon(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function register(pi: ExtensionAPI): void {
	registerEdits(pi);
}

export function registerEdits(pi: ExtensionAPI, opts: EditsOptions = {}): void {
	const shared = fleetOf(pi);
	const noteMs = opts.noteMs ?? NOTE_COALESCE_MS;
	const steerMs = opts.steerMs ?? STEER_COALESCE_MS;
	const now = opts.now ?? Date.now;

	let ctx: ExtensionContext | undefined;
	let cwd = process.cwd();
	let running = false;
	const pending = new Map<string, Pending>();
	/** Paths the agent called read/edit/write on in the current run (until agent_settled). */
	const touched = new Set<string>();
	/** Write guard: when the user last saved a path, and when the agent's last successful read began. */
	const changedAt = new Map<string, number>();
	const readAt = new Map<string, number>();
	const readCalls = new Map<string, { path: string; at: number }>();

	const isRunning = (): boolean => {
		try {
			if (ctx) return !ctx.isIdle();
		} catch {
			// stale ctx: fall back to the event-tracked flag
		}
		return running;
	};

	const guarded = (path: string) => guardBlocks("write", changedAt.get(path), readAt.get(path));

	const updateWidget = () => {
		if (!ctx?.hasUI) return;
		const entries: WidgetEntry[] = [...pending.values()].map((p) => ({
			display: displayPath(p.path, cwd),
			added: p.saves.reduce((n, s) => n + s.added, 0),
			removed: p.saves.reduce((n, s) => n + s.removed, 0),
			mode: p.mode,
		}));
		try {
			ctx.ui.setWidget(WIDGET_KEY, widgetLines(entries));
		} catch {
			// UI gone (shutdown)
		}
	};

	/** Take entries out of `pending` and build the message text; undefined when all were empty. */
	const take = (entries: Pending[]) => {
		const parts: string[] = [];
		const files: { path: string; added: number; removed: number; saves: number; mode: UserEditMode }[] = [];
		const guardedDisplays: string[] = [];
		for (const p of entries) {
			if (p.timer) clearTimeout(p.timer);
			pending.delete(p.path);
			let text: string | undefined;
			if (p.saves.length > 1) {
				try {
					text = readFileSync(p.path, "utf8");
				} catch {
					text = undefined;
				}
			}
			const c = combine(p.saves, text);
			if (!c) continue;
			const display = displayPath(p.path, cwd);
			parts.push(formatEdit(display, c));
			files.push({ path: p.path, added: c.added, removed: c.removed, saves: p.saves.length, mode: p.mode });
			if (guarded(p.path)) guardedDisplays.push(display);
		}
		updateWidget();
		if (!parts.length) return undefined;
		return { text: formatMessage(parts, guardedDisplays), files };
	};

	const steer = (entries: Pending[]) => {
		const msg = take(entries);
		if (!msg) return;
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content: msg.text, display: true, details: { files: msg.files } },
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	const flush = (p: Pending) => {
		p.timer = undefined;
		if (pending.get(p.path) !== p) return;
		if (deliveryFor(p.mode, isRunning(), touched.has(p.path)) === "steer") steer([p]);
		else updateWidget();
	};

	const onUserEdit = (raw: unknown) => {
		if (!shared.main) return;
		const msg = raw as UserEditMessage;
		if (!msg || typeof msg.path !== "string" || typeof msg.diff !== "string") return;
		const path = canon(msg.path);
		// truncated with an empty diff = too large to diff in nvim (>4 MiB): still a change.
		const empty = !msg.diff.trim() && !msg.created && !msg.truncated;
		if (empty && !pending.has(path)) return; // nothing changed: no note, no guard
		changedAt.set(path, now());
		let p = pending.get(path);
		if (!p) {
			p = { path, mode: msg.mode, saves: [], timer: undefined };
			pending.set(path, p);
		}
		if (msg.mode === "steer") p.mode = "steer";
		if (!empty) p.saves.push({ diff: msg.diff, added: msg.added, removed: msg.removed, created: msg.created, truncated: msg.truncated });
		if (p.timer) clearTimeout(p.timer);
		const entry = p;
		p.timer = setTimeout(() => flush(entry), p.mode === "steer" ? steerMs : noteMs);
		p.timer.unref?.();
		updateWidget();
	};

	pi.events.on(USER_EDIT_EVENT, onUserEdit);

	const reset = () => {
		for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
		pending.clear();
		touched.clear();
		changedAt.clear();
		readAt.clear();
		readCalls.clear();
		running = false;
	};

	pi.on("session_start", async (_event, c) => {
		reset();
		ctx = c;
		cwd = c.cwd;
		if (shared.main) updateWidget();
	});

	pi.on("session_shutdown", async () => {
		reset();
		ctx = undefined;
	});

	pi.on("agent_start", async () => {
		running = true;
	});

	pi.on("agent_settled", async () => {
		running = false;
		touched.clear();
	});

	// Notes go with the next run, whatever started it (a user prompt, sendUserMessage, a custom
	// message with triggerTurn). Placed right after the run's starting message.
	pi.on("before_agent_start", async () => {
		if (!shared.main || !pending.size) return;
		const msg = take([...pending.values()]);
		if (!msg) return;
		return { message: { customType: CUSTOM_TYPE, content: msg.text, display: true, details: { files: msg.files } } };
	});

	// A message typed while the agent works (steer or follow-up) carries the notes itself.
	pi.on("input", async (event) => {
		if (!shared.main || !event.streamingBehavior || !pending.size) return;
		const msg = take([...pending.values()]);
		if (!msg) return;
		return { action: "transform", text: `${event.text}\n\n${msg.text}`, images: event.images };
	});

	pi.on("tool_call", async (event, c) => {
		if (!shared.main) return;
		const name = event.toolName;
		if (name !== "read" && name !== "edit" && name !== "write") return;
		const input = event.input as { path?: unknown; file_path?: unknown } | undefined;
		const abs = toolPath(input?.path ?? input?.file_path, c.cwd);
		if (!abs) return;
		const path = canon(abs);
		touched.add(path);
		if (name === "read") readCalls.set(event.toolCallId, { path, at: now() });
		// The agent works on a file with an undelivered note: tell it before its next step.
		const p = pending.get(path);
		if (p && !p.timer) steer([p]);
		if (guardBlocks(name, changedAt.get(path), readAt.get(path)))
			return { block: true, reason: guardReason(displayPath(path, c.cwd), changedAt.get(path)!, name) };
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		if (!shared.main || event.toolName !== "read") return;
		const call = readCalls.get(event.toolCallId);
		readCalls.delete(event.toolCallId);
		if (call && !event.isError) readAt.set(call.path, Math.max(readAt.get(call.path) ?? 0, call.at));
	});
}
