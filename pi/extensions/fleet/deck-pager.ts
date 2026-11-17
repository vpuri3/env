/**
 * Transcripts in the deck (docs/pi-deck-design.md §6): what a closed session (or a subagent) said,
 * for the hover preview and for the C-l pager. Used by deck-view.ts (the list process).
 *
 * parseConversation() turns session JSONL into turns along the active branch (branchOf):
 * user messages, assistant text, thinking (folded to its first lines), one-line tool calls with
 * their result mark and the first lines of their output, `!` commands, compactions, branch
 * summaries, displayed extension messages. Context edits that omit an entry are honoured.
 *   - previewLines(): the hover preview under a closed row's card: the last turns, compact (tool
 *     calls one line, no output). ConversationTails reads only the last TAIL_BYTES of the file,
 *     cached by (size, mtime), like registry.ts's TranscriptTails.
 *   - pagerText(): the whole active branch as ANSI text, pre-wrapped to the slot width.
 *
 * The pager is `less` run in the preview holder (the slot's `sleep` pane, deck.ts): C-l renders the
 * transcript in-process to <runtime dir>/deck-pager-<pid>.txt, then one tmux call shows the holder,
 * `respawn-pane -k`s it with PAGER_SH (less, then back to HOLDER_CMD), marks it
 * (@pi_fleet_pager=<token>) and focuses the slot. The pane id, its role and the deck window's two
 * panes never change, so reconcile and pane-died see nothing. When less exits, PAGER_SH unmarks the
 * pane, sets @deck_pager_exit `<token>:<status>`, focuses the list, sends the list SIGUSR2 (as
 * pane-died does) and execs the holder again; the list reads and clears @deck_pager_exit
 * (pagerExit). Enter in less quits with status PAGER_RESUME (a lesskey `quit R`, less >= 582):
 * the list then resumes the session. Moving the list to another row restores the holder first
 * (closePager: respawn-pane -k with HOLDER_CMD), so frames never land in a running less.
 */

import { execFile } from "node:child_process";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { runtimeDir } from "./cli.ts";
import { HOLDER_CMD, LIST_TARGET, SLOT_TARGET, deckPanes, deckTmux, ensureHolder, showPaneArgs } from "./deck.ts";
import { TAIL_BYTES, branchOf, toolCallLine, type EntryLike } from "./registry.ts";
import { THINKING_LINES, oneLine, tilde, type ViewStyle } from "./sessions-view.ts";

// ---------------------------------------------------------------- the conversation

/** Thinking shows this many lines in the pager (the rest folded). */
export const PAGER_THINKING_LINES = 3;
/** Tool output shows this many lines in the pager, each cut to TOOL_LINE_CHARS. */
export const TOOL_OUTPUT_LINES = 8;
export const TOOL_LINE_CHARS = 300;
/** A user message, a summary or an extension message longer than this is cut (pasted logs). */
export const MESSAGE_LINES = 400;
const NOTE_LINES = 6;

/** Some lines of a longer text: `lines` kept, `more` dropped. */
interface Cut {
	lines: string[];
	more: number;
}

export type Turn =
	| { kind: "user"; text: Cut; at?: string }
	/** An assistant message after a user one (or the start): the speaker header. */
	| { kind: "assistant"; at?: string; model?: string }
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: Cut }
	| { kind: "tool"; call: string; result?: "ok" | "error"; output?: Cut }
	| { kind: "bash"; command: string; exitCode?: number; output: Cut }
	| { kind: "note"; title: string; body?: Cut; tone?: "error" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cut(text: string, max: number, chars = Infinity): Cut {
	const all = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
	const lines = all.slice(0, max).map((l) => (l.length > chars ? `${l.slice(0, chars - 1)}…` : l));
	return { lines, more: all.length - lines.length };
}

/** The text of message content: a string or text/image blocks. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content) {
		if (!isObject(b)) continue;
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

const clock = (ts: unknown): string | undefined => {
	if (typeof ts !== "string" && typeof ts !== "number") return undefined;
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return undefined;
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** `"id":"…","parentId":…` at the end of an entry line (pi writes them after the data). */
const CUSTOM_LINK = /"id":"([^"]+)","parentId":(?:null|"([^"]+)")(?:,"timestamp":"[^"]*")?\}$/;

/**
 * The turns of session JSONL `text` along its active branch (`cut`: `text` is the end of a file,
 * its first line may be partial and is dropped).
 */
export function parseConversation(text: string, cutStart = false): Turn[] {
	const entries: EntryLike[] = [];
	let first = true;
	for (const line of text.split("\n")) {
		if (first && cutStart) {
			first = false;
			continue;
		}
		first = false;
		if (!line.trim()) continue;
		// Extension state (`custom`: subagent registries, often 100s of KB a line) is never shown:
		// only its place in the tree is needed, read off the end of the line.
		if (line.startsWith('{"type":"custom",')) {
			const m = CUSTOM_LINK.exec(line.slice(-300));
			if (m) {
				entries.push({ type: "custom", id: m[1], parentId: m[2] ?? null } as EntryLike);
				continue;
			}
		}
		try {
			const value = JSON.parse(line);
			if (isObject(value) && typeof value.type === "string") entries.push(value as EntryLike);
		} catch {
			// a partial line
		}
	}
	let branch = branchOf(entries);
	if (!branch.length) branch = entries;
	// Context edits: replacement null omits the target, else replaces its content (the last edit wins).
	const edits = new Map<string, unknown>();
	for (const e of branch) if (e.type === "context_edit" && typeof e.targetId === "string") edits.set(e.targetId, e.replacement);
	const turns: Turn[] = [];
	const calls = new Map<string, Extract<Turn, { kind: "tool" }>>();
	let speaker: "user" | "assistant" | undefined;
	for (const e of branch) {
		const id = typeof e.id === "string" ? e.id : "";
		if (edits.has(id) && edits.get(id) === null) continue;
		switch (e.type) {
			case "message": {
				if (!isObject(e.message)) break;
				const m = e.message as Record<string, unknown>;
				const content = edits.has(id) ? edits.get(id) : m.content;
				if (m.role === "user") {
					const t = contentText(content);
					if (!t.trim()) break;
					turns.push({ kind: "user", text: cut(t.trim(), MESSAGE_LINES), at: clock(e.timestamp) });
					speaker = "user";
				} else if (m.role === "assistant") {
					if (speaker !== "assistant") turns.push({ kind: "assistant", at: clock(e.timestamp), model: typeof m.model === "string" ? m.model : undefined });
					speaker = "assistant";
					const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
					for (const b of blocks) {
						if (!isObject(b)) continue;
						if (b.type === "text" && typeof b.text === "string" && b.text.trim()) turns.push({ kind: "text", text: b.text.trim() });
						else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) turns.push({ kind: "thinking", text: cut(b.thinking.trim(), Infinity) });
						else if (b.type === "toolCall" && typeof b.name === "string") {
							const turn: Extract<Turn, { kind: "tool" }> = { kind: "tool", call: toolCallLine(b.name, b.arguments) };
							if (typeof b.id === "string") calls.set(b.id, turn);
							turns.push(turn);
						}
					}
					if ((m.stopReason === "error" || m.stopReason === "aborted") && typeof m.errorMessage === "string")
						turns.push({ kind: "note", title: m.stopReason === "aborted" ? "aborted" : "error", body: cut(m.errorMessage, NOTE_LINES, TOOL_LINE_CHARS), tone: "error" });
					else if (m.stopReason === "aborted") turns.push({ kind: "note", title: "aborted", tone: "error" });
				} else if (m.role === "toolResult") {
					const call = typeof m.toolCallId === "string" ? calls.get(m.toolCallId) : undefined;
					if (!call) break;
					call.result = m.isError ? "error" : "ok";
					const out = contentText(content);
					if (out.trim()) call.output = cut(out, TOOL_OUTPUT_LINES, TOOL_LINE_CHARS);
				} else if (m.role === "bashExecution") {
					turns.push({
						kind: "bash",
						command: typeof m.command === "string" ? m.command : "",
						exitCode: typeof m.exitCode === "number" ? m.exitCode : undefined,
						output: cut(typeof m.output === "string" ? m.output : "", TOOL_OUTPUT_LINES, TOOL_LINE_CHARS),
					});
					speaker = "user";
				} else if (m.role === "custom" && m.display !== false) {
					turns.push({ kind: "note", title: typeof m.customType === "string" ? m.customType : "message", body: cut(contentText(content), NOTE_LINES, TOOL_LINE_CHARS) });
				}
				break;
			}
			case "custom_message":
				if (e.display === false) break;
				turns.push({ kind: "note", title: typeof e.customType === "string" ? e.customType : "message", body: cut(contentText(e.content), NOTE_LINES, TOOL_LINE_CHARS) });
				break;
			case "compaction":
				turns.push({ kind: "note", title: `compacted${typeof e.tokensBefore === "number" ? ` (${Math.round(e.tokensBefore / 1000)}k tokens)` : ""}`, body: cut(String(e.summary ?? ""), MESSAGE_LINES) });
				speaker = undefined;
				break;
			case "branch_summary":
				turns.push({ kind: "note", title: "branch summary", body: cut(String(e.summary ?? ""), MESSAGE_LINES) });
				speaker = undefined;
				break;
			case "model_change":
				if (typeof e.modelId === "string") turns.push({ kind: "note", title: `model ${typeof e.provider === "string" ? `${e.provider}/` : ""}${e.modelId}` });
				break;
		}
	}
	return turns;
}

/** A tail with fewer turns than this is read again, 4x as long, up to TAIL_MAX_BYTES. */
export const TAIL_MIN_TURNS = 12;
export const TAIL_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The conversation at the end of session files: the last TAIL_BYTES (more while it has fewer
 * than TAIL_MIN_TURNS turns), parsed once per (size, mtime). One per list (no module-level state).
 */
export class ConversationTails {
	private cache = new Map<string, { size: number; mtimeMs: number; turns: Turn[] }>();
	private bytes: number;

	constructor(opts: { bytes?: number } = {}) {
		this.bytes = opts.bytes ?? TAIL_BYTES;
	}

	async get(path: string): Promise<Turn[] | undefined> {
		let fh: Awaited<ReturnType<typeof open>> | undefined;
		try {
			fh = await open(path, "r");
			const st = await fh.stat();
			const hit = this.cache.get(path);
			if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.turns;
			// The end of a file can be one huge registry line: read further back until there are turns.
			let turns: Turn[] = [];
			for (let bytes = this.bytes; ; bytes *= 4) {
				const start = Math.max(0, st.size - bytes);
				const buf = Buffer.alloc(st.size - start);
				const { bytesRead } = await fh.read(buf, 0, buf.length, start);
				turns = parseConversation(buf.subarray(0, bytesRead).toString("utf8"), start > 0);
				if (turns.length >= TAIL_MIN_TURNS || start === 0 || bytes >= TAIL_MAX_BYTES) break;
			}
			this.cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, turns });
			return turns;
		} catch {
			return undefined;
		} finally {
			await fh?.close().catch(() => {});
		}
	}
}

// ---------------------------------------------------------------- rendering

/** `text` (untrusted, any line breaks) wrapped to `width`, every line (continuations too) after `indent`; blank lines kept, runs of them squeezed. */
function block(text: string | string[], width: number, indent: string, paint: (s: string) => string = (s) => s): string[] {
	const out: string[] = [];
	const room = Math.max(10, width - visibleWidth(indent));
	let blank = false;
	for (const raw of Array.isArray(text) ? text : text.split("\n")) {
		const clean = oneLine(raw).trimEnd();
		if (!clean.trim()) {
			if (out.length && !blank) out.push("");
			blank = true;
			continue;
		}
		blank = false;
		for (const l of wrapTextWithAnsi(clean, room)) out.push(`${indent}${paint(l)}`);
	}
	while (out.at(-1) === "") out.pop();
	return out;
}

const fit = (s: string, width: number) => truncateToWidth(s, Math.max(0, width), "…");
const more = (n: number, what: string) => `… ${n} more line${n === 1 ? "" : "s"}${what}`;

function toolMark(result: "ok" | "error" | undefined, style: ViewStyle): string {
	return result === "error" ? style.fg("error", "✗") : result === "ok" ? style.fg("success", "✓") : style.fg("dim", "…");
}

/** A header for the pager: the session's name, then facts. */
export interface PagerHead {
	title: string;
	facts?: string[];
}

/** The whole conversation as ANSI text for `less -R`, wrapped to `width`. */
export function pagerText(turns: Turn[], width: number, style: ViewStyle, head: PagerHead): string {
	const w = Math.max(20, width);
	const out: string[] = [];
	const title = ` ${oneLine(head.title)} `;
	out.push(fit(style.fg("border", "──") + style.bold(title) + style.fg("border", "─".repeat(Math.max(0, w - 2 - visibleWidth(title)))), w));
	for (const f of head.facts ?? []) out.push(fit(style.fg("dim", ` ${oneLine(f)}`), w));
	if (!turns.length) out.push("", style.fg("dim", " (no messages)"));
	for (const t of turns) {
		switch (t.kind) {
			case "user":
				out.push("", style.bold(style.fg("accent", `▌ you${t.at ? style.fg("dim", ` · ${t.at}`) : ""}`)));
				out.push(...block(t.text.lines, w, "  "));
				if (t.text.more) out.push(style.fg("dim", `  ${more(t.text.more, "")}`));
				break;
			case "assistant":
				out.push("", style.bold(`● pi${t.model ? style.fg("dim", ` · ${oneLine(t.model)}`) : ""}${t.at ? style.fg("dim", ` · ${t.at}`) : ""}`));
				break;
			case "text":
				out.push(...block(t.text, w, "  "));
				break;
			case "thinking": {
				const shown = t.text.lines.slice(0, PAGER_THINKING_LINES);
				const rest = t.text.lines.length - shown.length + t.text.more;
				out.push(...block(shown, w, style.fg("dim", "  ┆ "), (s) => style.fg("dim", s)));
				if (rest) out.push(style.fg("dim", `  ┆ ${more(rest, " of thinking")}`));
				break;
			}
			case "tool":
				out.push(fit(`  ${toolMark(t.result, style)} ${style.fg("muted", oneLine(t.call))}`, w));
				if (t.output) {
					for (const l of t.output.lines) out.push(fit(style.fg("dim", `    │ ${oneLine(l)}`), w));
					if (t.output.more) out.push(style.fg("dim", `    │ ${more(t.output.more, "")}`));
				}
				break;
			case "bash": {
				const code = t.exitCode === undefined ? "" : t.exitCode === 0 ? "" : style.fg("error", ` (exit ${t.exitCode})`);
				out.push("", fit(`${style.bold(style.fg("accent", "▌ you"))} ${style.fg("muted", `$ ${oneLine(t.command)}`)}${code}`, w));
				for (const l of t.output.lines) out.push(fit(style.fg("dim", `    │ ${oneLine(l)}`), w));
				if (t.output.more) out.push(style.fg("dim", `    │ ${more(t.output.more, "")}`));
				break;
			}
			case "note": {
				const paint = (s: string) => (t.tone === "error" ? style.fg("error", s) : style.fg("dim", s));
				out.push("", fit(paint(`  ◇ ${oneLine(t.title)}`), w));
				if (t.body) {
					out.push(...block(t.body.lines, w, "    ", paint));
					if (t.body.more) out.push(paint(`    ${more(t.body.more, "")}`));
				}
				break;
			}
		}
	}
	out.push("");
	return out.map((l) => `${l}\x1b[0m`).join("\n");
}

/**
 * The end of the conversation for the hover preview, at most `rows` lines of `width`: user
 * messages (`›`, up to 3 lines), assistant text, thinking (its last THINKING_LINES, dim), tool
 * calls one line.
 */
export function previewLines(turns: Turn[], width: number, rows: number, style: ViewStyle): string[] {
	if (rows <= 0) return [];
	const out: string[] = [];
	const w = Math.max(10, width - 1);
	// Only as many turns as can show (each is at least a line).
	for (const t of turns.slice(-rows * 2)) {
		switch (t.kind) {
			case "user": {
				const lines = block(t.text.lines, w, "   ").filter((l) => l);
				const shown = lines.slice(0, 3);
				if (shown.length) shown[0] = ` ${style.fg("accent", "›")} ${shown[0]!.slice(3)}`;
				if (lines.length > 3 || t.text.more) shown[shown.length - 1] = `${shown.at(-1)} ${style.fg("dim", "…")}`;
				out.push(...shown.map((l) => style.bold(l)));
				break;
			}
			case "assistant":
				break;
			case "text":
				out.push(...block(t.text, w, " ").filter((l) => l));
				break;
			case "thinking":
				out.push(...block(t.text.lines, w, " ", (s) => style.fg("dim", s)).filter((l) => l).slice(-THINKING_LINES));
				break;
			case "tool":
				out.push(` ${toolMark(t.result, style)} ${style.fg("muted", oneLine(t.call))}`);
				break;
			case "bash":
				out.push(` ${style.fg("accent", "›")} ${style.fg("muted", `$ ${oneLine(t.command)}`)}`);
				break;
			case "note":
				out.push(t.tone === "error" ? style.fg("error", ` ◇ ${oneLine(t.title)}`) : style.fg("dim", ` ◇ ${oneLine(t.title)}`));
				break;
		}
	}
	return out.slice(-rows).map((l) => fit(l, width));
}

// ---------------------------------------------------------------- the pager in the holder

/** less quits with this status on Enter (lesskey `quit R`): resume the session. */
export const PAGER_RESUME = 82;

/** less >= 582 reads a lesskey source file (--lesskey-src), and has --mouse. */
export const LESSKEY_SRC_VERSION = 582;

/**
 * Run in the holder by respawn-pane: `sh -c PAGER_SH pager FILE LESSKEY PROMPT TOKEN HOLDER_CMD`.
 * The user's LESS and LESSOPEN are ignored (-F would quit at once on a short transcript).
 */
export const PAGER_SH = [
	'f=$1; k=$2; p=$3; t=$4; h=$5',
	'if [ -n "$k" ]; then LESS= less -R -i -L +G --mouse "--lesskey-src=$k" "-Ps$p" -- "$f"; else LESS= less -R -i -L +G "-Ps$p" -- "$f"; fi',
	"rc=$?",
	`tmux set-option -pu -t "$TMUX_PANE" @pi_fleet_pager \\; set-option -g @deck_pager_exit "$t:$rc" \\; select-pane -t '${LIST_TARGET}' 2>/dev/null`,
	'pid=$(tmux show-options -gqv @deck_tui_pid 2>/dev/null); [ -n "$pid" ] && kill -USR2 "$pid" 2>/dev/null',
	'exec sh -c "$h"',
].join("\n");

const LESSKEY = ["#command", "\\r quit R", "\\n quit R", ""].join("\n");

/** A less prompt: `?`, `:`, `.`, `%` and `\` are special there. */
export function lessPromptEscape(text: string): string {
	return oneLine(text).replace(/[?:.%\\]/g, (c) => `\\${c}`);
}

/** The installed less's version (`less 590 (…)`), 0 if it does not say, undefined without less. Cached per process. */
let lessVersion: Promise<number | undefined> | undefined;
export function installedLess(): Promise<number | undefined> {
	lessVersion ??= new Promise((res) => {
		execFile("less", ["--version"], { timeout: 3000 }, (error, stdout) => {
			if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return res(undefined);
			const m = /less\s+(\d+)/i.exec(String(stdout));
			res(m ? Number(m[1]) : 0);
		});
	});
	return lessVersion;
}

export interface PagerRequest {
	/** The session (or subagent) JSONL. */
	file: string;
	title: string;
	/** What Enter does, for the prompt (`resume`, `its session`). */
	enter: string;
	facts?: string[];
	width: number;
	/** Marks this pager run: @pi_fleet_pager on the holder, the first field of @deck_pager_exit. */
	token: string;
}

/** The text file the pager shows (one per list process). */
export function pagerFile(env: NodeJS.ProcessEnv, pid = process.pid): string {
	return join(runtimeDir(env), `deck-pager-${pid}.txt`);
}

/**
 * Render `req.file` into pagerFile, then in one tmux call: show the holder in the slot, respawn it
 * with less on that file, mark it, focus the slot. Throws if the file cannot be read or less is
 * missing.
 */
export async function openPager(req: PagerRequest, style: ViewStyle, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const version = await installedLess();
	if (version === undefined) throw new Error("no less on PATH: cannot show the transcript");
	const text = await readFile(req.file, "utf8");
	const out = pagerText(parseConversation(text), req.width, style, { title: req.title, facts: [...(req.facts ?? []), tilde(req.file)] });
	const file = pagerFile(env);
	await writeFile(file, out, { mode: 0o600 });
	let keys = "";
	if (version >= LESSKEY_SRC_VERSION) {
		keys = join(runtimeDir(env), "deck-pager.lesskey");
		await writeFile(keys, LESSKEY, { mode: 0o600 });
	}
	const enter = keys ? `⏎ ${req.enter}` : `q then ⏎ ${req.enter}`;
	// The keys must show: the title gets what is left of the width.
	const title = truncateToWidth(oneLine(req.title), Math.max(8, req.width - visibleWidth(enter) - 50), "…");
	const prompt = `${lessPromptEscape(title)} · q/C-h back · ${lessPromptEscape(enter)} · / search ?e(END):%pB\\%.`;
	const panes = await deckPanes(env);
	const holder = panes.find((p) => p.role === "preview" && !p.gone)?.pane ?? (await ensureHolder(env));
	const show = showPaneArgs(panes, holder);
	await deckTmux(
		[
			...(show ? [...show, ";"] : []),
			"respawn-pane", "-k", "-t", holder, "sh", "-c", PAGER_SH, "pager", file, keys, prompt, req.token, HOLDER_CMD, ";",
			"set-option", "-p", "-t", holder, "@pi_fleet_pager", req.token, ";",
			"select-pane", "-t", SLOT_TARGET,
		],
		env,
	);
}

/** The holder runs a pager: give it back its `sleep` (respawn-pane -k). False if it did not. */
export async function closePager(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	const out = await deckTmux(["list-panes", "-a", "-F", "#{pane_id}\t#{@pi_fleet_role}\t#{@pi_fleet_pager}"], env).catch(() => "");
	const cmds: string[] = [];
	for (const line of out.split("\n")) {
		const [pane, role, token] = line.split("\t");
		if (role !== "preview" || !token || !pane) continue;
		if (cmds.length) cmds.push(";");
		cmds.push("respawn-pane", "-k", "-t", pane, "sh", "-c", HOLDER_CMD, ";", "set-option", "-pu", "-t", pane, "@pi_fleet_pager");
	}
	if (!cmds.length) return false;
	await deckTmux(cmds, env);
	return true;
}

/** How the last pager ended (read and cleared): its token and less's exit status. */
export async function pagerExit(env: NodeJS.ProcessEnv = process.env): Promise<{ token: string; status: number } | undefined> {
	const out = await deckTmux(["show-options", "-gqv", "@deck_pager_exit", ";", "set-option", "-gu", "@deck_pager_exit"], env).catch(() => "");
	const m = /^(.*):(\d+)$/.exec(out.trim());
	return m ? { token: m[1]!, status: Number(m[2]) } : undefined;
}

/** Remove the pager's files (the list exits). */
export async function removePagerFiles(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	await unlink(pagerFile(env)).catch(() => {});
}
