/**
 * fleet/view: the /view command and the pickers behind the leader keys (design §11, §12; phase 6).
 *
 *   /view FILE[:LINE]  open FILE in the paired nvim (cursor on LINE), then focus the nvim pane.
 *                      Completion: files touched in this session first, then the repo (files.ts).
 *                      A FILE that does not exist opens the file picker with it as the query.
 *   /view tool:N       the Nth most recent tool call's full output (tool-output.ts) as a read-only
 *                      scratch buffer in the paired nvim. `tool:` completes to labelled calls.
 *   /view              one picker: touched files, then the last 10 tool calls.
 *
 * The paired nvim is found with nvim.ts's resolveNvim; if there is none (or its socket is dead)
 * and this is a TUI pi in tmux, `pairPane` (cli.ts) splits a new one first. Calls go through
 * `nvim_exec_lua` with fixed Lua; paths, lines and buffer text travel only as arguments.
 * Without a paired nvim (outside tmux, RPC without a socket, pairing failed) it falls back to
 * compact-tools' old behaviour, with a one-line notice: `nvim -R` in a new tmux window, else in
 * place of the TUI until nvim quits ($PAGER when there is no nvim).
 *
 * Exports for phase 8 (leader.ts; `pi` is the extension's pi, `ctx` a UI context):
 *   openFilePicker(pi, ctx, { scope: "all" | "git" | "session", query? })   Space f f / f g / f b
 *   openToolPicker(pi, ctx)                                                   Space t
 *   openGrepPicker(pi, ctx, pattern?)                                         Space f s
 *   viewFile(pi, ctx, "path[:line]"), viewTool(pi, ctx, n), viewPicker(pi, ctx)
 * All dialogs run inside ownPrompt(); everything is a no-op without ctx.hasUI.
 * No module-level mutable state (per-session state: files.ts's filesOf(pi), register()'s closure).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fmtLiteral, inTmux, focusPane, pairPane } from "./cli.ts";
import {
	absPath,
	displayPath,
	displayText,
	filesOf,
	grep,
	parseTarget,
	pathList,
	queryTokens,
	rankTiers,
	scorePath,
	tiersFor,
	type PathList,
} from "./files.ts";
import { NvimUnreachable, nvimRequest, resolveNvim, type NvimPeer } from "./nvim.ts";
import { fleetOf, ownPrompt } from "./shared.ts";
import { callLabel, callSummary, parseToolRef, recentCalls, toolDocument, writeToolFile, type ToolCall } from "./tool-output.ts";

export type FileScope = "all" | "git" | "session";

const COMPLETION_LIMIT = 20;
const COMPLETION_WAIT_MS = 200;
const PICKER_TOOL_CALLS = 10;
/** `tool:` completion only offers the most recent calls. */
const COMPLETION_TOOL_CALLS = 200;
const PICKER_VISIBLE = 12;
const NVIM_OPEN_TIMEOUT_MS = 10_000;
const PAIR_WAIT_MS = 5_000;

// ---------------------------------------------------------------- nvim side (fixed Lua)

/** Pick a normal window (not a float, terminal, tree or quickfix) in the current tab. */
const TARGET_WIN_LUA = `
local function target_win()
  local function ok(w)
    local b = vim.api.nvim_win_get_buf(w)
    return vim.bo[b].buftype == '' and vim.api.nvim_win_get_config(w).relative == ''
  end
  local cur = vim.api.nvim_get_current_win()
  if ok(cur) then return cur end
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if ok(w) then return w end
  end
  return cur
end`;

/** args: absolute path, line (or nil). Returns {buffer name, cursor line}. */
export const OPEN_FILE_LUA = `${TARGET_WIN_LUA}
local path, line = ...
if vim.fn.mode() == 'i' then vim.cmd('stopinsert') end
local win = target_win()
vim.api.nvim_set_current_win(win)
local buf = vim.fn.bufadd(path)
vim.bo[buf].buflisted = true
vim.api.nvim_win_set_buf(win, buf)
if type(line) == 'number' then
  local l = math.max(1, math.min(line, vim.api.nvim_buf_line_count(buf)))
  vim.api.nvim_win_set_cursor(win, { l, 0 })
  vim.cmd('normal! zz')
end
return { vim.api.nvim_buf_get_name(buf), vim.api.nvim_win_get_cursor(win)[1] }`;

/** args: buffer name, lines, file name for filetype detection. Returns the buffer name. */
export const OPEN_SCRATCH_LUA = `${TARGET_WIN_LUA}
local name, lines, ftname = ...
local buf
for _, b in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_get_name(b) == name then buf = b break end
end
if not buf then
  buf = vim.api.nvim_create_buf(true, true)
  vim.api.nvim_buf_set_name(buf, name)
end
vim.bo[buf].bufhidden = 'hide'
vim.bo[buf].swapfile = false
vim.bo[buf].readonly = false
vim.bo[buf].modifiable = true
vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
vim.bo[buf].modifiable = false
vim.bo[buf].readonly = true
vim.bo[buf].modified = false
local ft = vim.filetype.match({ filename = ftname, buf = buf })
if ft then vim.bo[buf].filetype = ft end
local win = target_win()
vim.api.nvim_set_current_win(win)
vim.api.nvim_win_set_buf(win, buf)
vim.api.nvim_win_set_cursor(win, { 1, 0 })
return vim.api.nvim_buf_get_name(buf)`;

export type OpenOp =
	| { kind: "file"; path: string; line?: number }
	| { kind: "scratch"; name: string; text: string; ftname: string };

function textLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Run one OpenOp in the nvim at `sock`. */
export function nvimOpen(sock: string, op: OpenOp, timeoutMs = NVIM_OPEN_TIMEOUT_MS): Promise<unknown> {
	if (op.kind === "file") return nvimRequest(sock, "nvim_exec_lua", [OPEN_FILE_LUA, [op.path, op.line ?? null]], timeoutMs);
	return nvimRequest(sock, "nvim_exec_lua", [OPEN_SCRATCH_LUA, [op.name, textLines(op.text), op.ftname]], timeoutMs);
}

// ---------------------------------------------------------------- peer + fallback

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isSocket(path: string): boolean {
	try {
		return statSync(path).isSocket();
	} catch {
		return false;
	}
}

function isTui(ctx: ExtensionContext): boolean {
	return (ctx as { mode?: string }).mode === "tui";
}

/**
 * Pair a new nvim beside this pi (TUI in tmux only), wait up to 5 s for its socket and record
 * it in the status file; undefined when that is not possible. Also used by leader.ts (`Space g s`).
 */
export async function pairNew(pi: ExtensionAPI, ctx: ExtensionContext): Promise<NvimPeer | undefined> {
	const pane = process.env.TMUX_PANE;
	const sessionId = ctx.sessionManager.getSessionId();
	if (!pane || !inTmux() || !isTui(ctx) || !sessionId) return undefined;
	const r = await pairPane(pane, { session: sessionId, cwd: ctx.cwd }).catch(() => undefined);
	if (!r) return undefined;
	const end = Date.now() + PAIR_WAIT_MS;
	while (!isSocket(r.nvimSock) && Date.now() < end) await sleep(50);
	const status = fleetOf(pi).status;
	const cur = status?.current();
	if (status) {
		const fields: Record<string, unknown> = {};
		if (cur?.nvimSock !== r.nvimSock) fields.nvimSock = r.nvimSock;
		if (cur?.tmux && cur.tmux.nvimPane !== r.nvimPane) fields.tmux = { ...cur.tmux, nvimPane: r.nvimPane };
		if (Object.keys(fields).length) status.patch(fields);
	}
	return { pane: r.nvimPane, sock: r.nvimSock };
}

/**
 * Run `op` in the paired nvim, pairing (or re-pairing a dead one) when allowed, then focus it.
 * Returns false when there is no paired nvim to use (the caller falls back). nvim's own
 * errors are thrown.
 */
export async function openInPaired(pi: ExtensionAPI, ctx: ExtensionContext, op: OpenOp): Promise<boolean> {
	if (!fleetOf(pi).main) return false;
	const sessionId = ctx.sessionManager.getSessionId();
	let peer = await resolveNvim(sessionId).catch(() => undefined);
	let paired = false;
	if (!peer) {
		peer = await pairNew(pi, ctx);
		paired = true;
	}
	if (!peer) return false;
	for (let attempt = 0; ; attempt++) {
		try {
			await nvimOpen(peer.sock, op);
			break;
		} catch (error) {
			if (!(error instanceof NvimUnreachable) || error.code === "ETIMEDOUT") throw error;
			// A just-split nvim may still be starting; a dead one gets replaced once.
			if (paired && attempt < 20) {
				await sleep(100);
				continue;
			}
			if (paired) return false;
			peer = await pairNew(pi, ctx);
			paired = true;
			if (!peer) return false;
		}
	}
	if (peer.pane && inTmux()) await focusPane(peer.pane).catch(() => {});
	return true;
}

function which(cmd: string): boolean {
	return !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
}

/**
 * compact-tools' old way: `nvim -R` in a new tmux window, else in place of the TUI until it quits.
 * Uses $PAGER (default less) when nvim is missing. Returns a one-line notice, or undefined if
 * nothing could be opened.
 */
export async function openExternal(ctx: ExtensionContext, file: string, line: number | undefined, title: string): Promise<string | undefined> {
	const haveNvim = which("nvim");
	const argv = haveNvim
		? ["nvim", "-R", ...(line ? [`+${line}`] : []), file]
		: [...(process.env.PAGER || "less").split(/\s+/).filter(Boolean), file];
	if (process.env.TMUX) {
		const r = spawnSync("tmux", ["new-window", "-n", fmtLiteral(title), "-c", fmtLiteral(ctx.cwd), ...argv], { stdio: "ignore" });
		if (!r.error && r.status === 0) return `pi-fleet: no paired nvim; opened ${title} in a new tmux window`;
	}
	if (!isTui(ctx)) return undefined;
	await ctx.ui.custom<undefined>((tui, _theme, _kb, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		spawnSync(argv[0], argv.slice(1), { stdio: "inherit", cwd: ctx.cwd });
		tui.start();
		tui.requestRender(true);
		done(undefined);
		return { render: () => [], invalidate() {} };
	});
	return `pi-fleet: no paired nvim; showed ${title} with ${haveNvim ? "nvim -R" : argv[0]}`;
}

// ---------------------------------------------------------------- view actions

function notifyError(ctx: ExtensionContext, error: unknown): void {
	ctx.ui.notify(`/view: ${(error as Error)?.message ?? String(error)}`, "error");
}

/** Open `target` (`path`, `path:LINE`) in the paired nvim. Returns false if the file is missing. */
export async function viewFile(pi: ExtensionAPI, ctx: ExtensionContext, target: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	let { path, line } = parseTarget(target);
	let abs = absPath(path, ctx.cwd);
	if (!existsSync(abs)) {
		const whole = absPath(target.trim(), ctx.cwd);
		if (!existsSync(whole)) return false;
		abs = whole;
		line = undefined;
	}
	filesOf(pi).touched.touch(abs);
	try {
		if (await openInPaired(pi, ctx, { kind: "file", path: abs, line })) return true;
		const notice = await openExternal(ctx, abs, line, displayPath(abs, ctx.cwd));
		ctx.ui.notify(notice ?? "/view: no paired nvim and no terminal to open it in", notice ? "info" : "error");
	} catch (error) {
		notifyError(ctx, error);
	}
	return true;
}

function callsOf(ctx: ExtensionContext): ToolCall[] {
	try {
		return recentCalls(ctx.sessionManager.getBranch() as any[]);
	} catch {
		return [];
	}
}

/** Open tool call N (1 = most recent) as a read-only scratch buffer in the paired nvim. */
export async function viewTool(pi: ExtensionAPI, ctx: ExtensionContext, n: number, calls = callsOf(ctx)): Promise<void> {
	if (!ctx.hasUI) return;
	if (calls.length === 0) return ctx.ui.notify("No tool calls in this session yet", "info");
	if (!Number.isInteger(n) || n < 1 || n > calls.length) return ctx.ui.notify(`/view: pick tool:1..tool:${calls.length}`, "error");
	const call = calls[n - 1];
	const doc = toolDocument(call, ctx.cwd);
	const short = call.id.replace(/[^\w.-]/g, "_").slice(-12);
	try {
		if (await openInPaired(pi, ctx, { kind: "scratch", name: `pi://tool/${short}/${doc.name}`, text: doc.text, ftname: doc.name })) return;
		const file = writeToolFile(call, doc);
		const notice = await openExternal(ctx, file, undefined, `pi:${call.name}`);
		ctx.ui.notify(notice ?? "/view: no paired nvim and no terminal to open it in", notice ? "info" : "error");
	} catch (error) {
		notifyError(ctx, error);
	}
}

// ---------------------------------------------------------------- picker component

export interface PickItem {
	value: string;
	label: string;
	description?: string;
}

interface PickerTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface KeyMatcher {
	matches(data: string, id: string): boolean;
}

/**
 * A fuzzy picker: a query line over a ranked list. `source(query)` must be fast (it runs on every
 * keystroke); `refresh` (e.g. the repo listing finishing) re-runs it.
 */
export class FuzzyPicker implements Component, Focusable {
	private readonly input: Input;
	private items: PickItem[] = [];
	private selected = 0;
	private query: string;
	private loading = false;
	private _focused = false;
	private readonly title: string;
	private readonly source: (query: string) => PickItem[];
	private readonly theme: PickerTheme;
	private readonly keys: KeyMatcher;
	private readonly done: (item: PickItem | undefined) => void;
	private readonly requestRender: () => void;

	constructor(opts: {
		title: string;
		source: (query: string) => PickItem[];
		theme: PickerTheme;
		keys: KeyMatcher;
		done: (item: PickItem | undefined) => void;
		requestRender: () => void;
		query?: string;
		loading?: Promise<unknown>;
	}) {
		this.title = opts.title;
		this.source = opts.source;
		this.theme = opts.theme;
		this.keys = opts.keys;
		this.done = opts.done;
		this.requestRender = opts.requestRender;
		this.input = new Input({ prompt: "> " });
		this.query = opts.query ?? "";
		this.input.setValue(this.query);
		this.update();
		if (opts.loading) {
			this.loading = true;
			opts.loading
				.catch(() => undefined)
				.then(() => {
					this.loading = false;
					this.update();
					this.requestRender();
				});
		}
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	private update(): void {
		this.items = this.source(this.query);
		if (this.selected >= this.items.length) this.selected = Math.max(0, this.items.length - 1);
	}

	selectedItem(): PickItem | undefined {
		return this.items[this.selected];
	}

	handleInput(data: string): void {
		const k = this.keys;
		if (k.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (k.matches(data, "tui.select.down")) this.selected = Math.min(this.items.length - 1, this.selected + 1);
		else if (k.matches(data, "tui.select.pageUp")) this.selected = Math.max(0, this.selected - PICKER_VISIBLE);
		else if (k.matches(data, "tui.select.pageDown")) this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + PICKER_VISIBLE));
		else if (k.matches(data, "tui.select.confirm")) return this.done(this.selectedItem());
		else if (k.matches(data, "tui.select.cancel")) return this.done(undefined);
		else {
			this.input.handleInput(data);
			const q = this.input.getValue();
			if (q !== this.query) {
				this.query = q;
				this.selected = 0;
				this.update();
			}
		}
		this.requestRender();
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const t = this.theme;
		const w = Math.max(10, width);
		const out: string[] = [t.fg("border", "─".repeat(w))];
		const count = this.loading ? "loading…" : `${this.items.length}${this.items.length >= 200 ? "+" : ""}`;
		out.push(truncateToWidth(` ${t.fg("accent", t.bold(this.title))}  ${t.fg("muted", count)}`, w));
		out.push(...this.input.render(w - 1).map((l) => " " + l));
		const start = Math.max(0, Math.min(this.selected - Math.floor(PICKER_VISIBLE / 2), this.items.length - PICKER_VISIBLE));
		const end = Math.min(this.items.length, start + PICKER_VISIBLE);
		if (this.items.length === 0) out.push(t.fg("muted", this.loading ? "   loading files…" : "   no matches"));
		for (let i = start; i < end; i++) {
			const it = this.items[i];
			const desc = it.description ? "  " + t.fg("dim", it.description) : "";
			const line = i === this.selected ? t.fg("accent", ` → ${it.label}`) + desc : `   ${it.label}${desc}`;
			out.push(truncateToWidth(line, w));
		}
		out.push(t.fg("dim", truncateToWidth(" ↑↓ move · enter open · esc cancel · type to filter", w)));
		out.push(t.fg("border", "─".repeat(w)));
		return out;
	}
}

/** Show a FuzzyPicker (TUI) or, in other modes, a plain select over its first results. */
async function pick(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { title: string; source: (q: string) => PickItem[]; query?: string; loading?: Promise<unknown> },
): Promise<PickItem | undefined> {
	if (!ctx.hasUI) return undefined;
	if (!isTui(ctx)) {
		if (opts.loading) await opts.loading.catch(() => undefined);
		const items = opts.source(opts.query ?? "");
		if (!items.length) return undefined;
		const labels = items.map((it) => (it.description ? `${it.label}  · ${it.description}` : it.label));
		const choice = await ownPrompt(pi, () => ctx.ui.select(opts.title, labels));
		const i = choice === undefined ? -1 : labels.indexOf(choice);
		return i >= 0 ? items[i] : undefined;
	}
	return ownPrompt(pi, () =>
		ctx.ui.custom<PickItem | undefined>((tui: TUI, theme, kb, done) =>
			new FuzzyPicker({
				title: opts.title,
				source: opts.source,
				query: opts.query,
				loading: opts.loading,
				theme: theme as unknown as PickerTheme,
				keys: kb as unknown as KeyMatcher,
				done,
				requestRender: () => tui.requestRender(),
			}),
		),
	);
}

/** Small lists: keep items whose text matches every token, best first (stable on ties). */
export function filterItems<T>(items: T[], query: string, text: (item: T) => string): T[] {
	const tokens = queryTokens(query);
	if (!tokens.length) return items;
	const scored: { item: T; score: number; i: number }[] = [];
	items.forEach((item, i) => {
		const score = scorePath(tokens, text(item).toLowerCase());
		if (score !== undefined) scored.push({ item, score, i });
	});
	return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((s) => s.item);
}

// ---------------------------------------------------------------- pickers (phase 8 API)

const PICKER_LIMIT = 200;

/** Ranked file items for `query` in `scope` (sync; the repo tier may still be loading). */
export function fileItems(pi: ExtensionAPI, cwd: string, scope: FileScope, query: string, limit = PICKER_LIMIT): PickItem[] {
	const { touched, repo } = tiersFor(filesOf(pi), cwd, scope);
	const tiers: PathList[] = [touched ?? pathList([]), repo ?? pathList([])];
	return rankTiers(query, tiers, limit).map((r) => ({
		value: r.path,
		label: displayText(r.path),
		description: r.tier === 0 ? "session" : undefined,
	}));
}

const SCOPE_TITLES: Record<FileScope, string> = {
	all: "Open file (session, then repo)",
	git: "Open repo file",
	session: "Open session file",
};

/** File picker for `Space f f` (all), `f g` (git/repo files), `f b` (session files). */
export async function openFilePicker(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { scope?: FileScope; query?: string } = {},
): Promise<void> {
	if (!ctx.hasUI) return;
	const scope = opts.scope ?? "all";
	const state = filesOf(pi);
	const loading = scope === "session" || state.repo.peek(ctx.cwd) ? undefined : state.repo.refresh(ctx.cwd);
	const item = await pick(pi, ctx, {
		title: SCOPE_TITLES[scope],
		query: opts.query,
		loading,
		source: (q) => fileItems(pi, ctx.cwd, scope, parseTarget(q).path, PICKER_LIMIT),
	});
	if (!item) return;
	if (!(await viewFile(pi, ctx, item.value))) ctx.ui.notify(`/view: ${item.value} no longer exists`, "error");
}

function toolItems(calls: ToolCall[], cwd: string, limit: number): PickItem[] {
	return calls.slice(0, limit).map((c, i) => ({ value: `tool:${i + 1}`, label: displayText(callLabel(c, i + 1, cwd)) }));
}

/** Tool output picker for `Space t`: every call on the branch, newest first. */
export async function openToolPicker(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const calls = callsOf(ctx);
	if (calls.length === 0) return ctx.ui.notify("No tool calls in this session yet", "info");
	const all = toolItems(calls, ctx.cwd, calls.length);
	const item = await pick(pi, ctx, { title: "Open tool output", source: (q) => filterItems(all, q, (it) => it.label) });
	const n = item ? parseToolRef(item.value) : undefined;
	if (n) await viewTool(pi, ctx, n, calls);
}

/** Bare /view: touched files, then the last 10 tool calls. */
export async function viewPicker(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const calls = callsOf(ctx);
	const tools = toolItems(calls, ctx.cwd, PICKER_TOOL_CALLS);
	const source = (q: string): PickItem[] => [
		...fileItems(pi, ctx.cwd, "session", q, PICKER_LIMIT),
		...filterItems(tools, q, (it) => it.label),
	];
	if (!source("").length) return ctx.ui.notify("/view: no files touched and no tool calls yet; try /view FILE", "info");
	const item = await pick(pi, ctx, { title: "View", source });
	if (!item) return;
	const n = parseToolRef(item.value);
	if (n) return viewTool(pi, ctx, n, calls);
	if (!(await viewFile(pi, ctx, item.value))) ctx.ui.notify(`/view: ${item.value} no longer exists`, "error");
}

/** `Space f s`: a `Grep >` input, then `rg --vimgrep` hits; the chosen hit opens at its line. */
export async function openGrepPicker(pi: ExtensionAPI, ctx: ExtensionContext, pattern?: string): Promise<void> {
	if (!ctx.hasUI) return;
	const pat = pattern ?? (await ownPrompt(pi, () => ctx.ui.input("Grep >", "rg pattern")));
	if (!pat?.trim()) return;
	const hits = await grep(ctx.cwd, pat);
	if (!hits.length) return ctx.ui.notify(`/view: no matches for ${pat}`, "info");
	const all: PickItem[] = hits.map((h) => ({
		value: `${h.path}:${h.line}`,
		label: displayText(`${h.path}:${h.line}`),
		description: displayText(h.text).trim(),
	}));
	const item = await pick(pi, ctx, {
		title: `Grep: ${pat}`,
		source: (q) => filterItems(all, q, (it) => `${it.label} ${it.description ?? ""}`),
	});
	if (item && !(await viewFile(pi, ctx, item.value))) ctx.ui.notify(`/view: ${item.value} no longer exists`, "error");
}

// ---------------------------------------------------------------- completion

/** `/view` argument completions: tool:N items, or tiered files (keeping a typed `:LINE`). */
export async function viewCompletions(
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
	prefix: string,
	waitMs = COMPLETION_WAIT_MS,
): Promise<PickItem[] | null> {
	const state = filesOf(pi);
	const cwd = ctx?.cwd ?? state.cwd;
	if (prefix.startsWith("tool:")) {
		if (!ctx) return null;
		const calls = callsOf(ctx).slice(0, COMPLETION_TOOL_CALLS);
		const rest = prefix.slice(5).trim();
		const item = (i: number) => ({ value: `tool:${i + 1}`, label: `tool:${i + 1}`, description: displayText(callSummary(calls[i], cwd, 50)) });
		let items: PickItem[];
		if (/^\d+$/.test(rest)) {
			// Filter by number first; only the survivors get summarised.
			const idx: number[] = [];
			for (let i = 0; i < calls.length && idx.length < COMPLETION_LIMIT; i++) if (String(i + 1).startsWith(rest)) idx.push(i);
			items = idx.map(item);
		} else {
			items = filterItems(calls.map((_, i) => item(i)), rest, (it) => it.description ?? "").slice(0, COMPLETION_LIMIT);
		}
		return items.length ? items : null;
	}
	const { path, line } = parseTarget(prefix);
	const suffix = line ? `:${line}` : "";
	// The first completion may wait briefly for the repo listing; later ones never wait.
	if (!state.repo.peek(cwd)) await state.repo.get(cwd, waitMs);
	const items = fileItems(pi, cwd, "all", path, COMPLETION_LIMIT).map((it) => ({ ...it, value: it.value + suffix }));
	return items.length ? items : null;
}

// ---------------------------------------------------------------- register

export function register(pi: ExtensionAPI): void {
	let sessionCtx: ExtensionContext | undefined;

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
	});
	pi.on("session_shutdown", async () => {
		sessionCtx = undefined;
	});

	pi.registerCommand("view", {
		description: "Open a file (/view FILE[:LINE]) or tool output (/view tool:N) in the paired nvim",
		getArgumentCompletions: (prefix: string) => viewCompletions(pi, sessionCtx, prefix),
		handler: async (args: string, ctx) => {
			if (!ctx.hasUI) return;
			const arg = String(args ?? "").trim();
			if (!arg) return viewPicker(pi, ctx);
			const n = parseToolRef(arg);
			if (n !== undefined) return viewTool(pi, ctx, n);
			if (arg === "tool:" || arg === "tool") return openToolPicker(pi, ctx);
			if (await viewFile(pi, ctx, arg)) return;
			// Not a file: let the user pick, starting from what they typed.
			if (isTui(ctx)) return openFilePicker(pi, ctx, { scope: "all", query: parseTarget(arg).path });
			ctx.ui.notify(`/view: no such file: ${arg}`, "error");
		},
	});
}
