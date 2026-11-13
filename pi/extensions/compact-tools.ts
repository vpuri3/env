/**
 * compact-tools: one line per tool call in the collapsed view.
 *
 *   ✓ bash   shellcheck bootstrap.sh            exit 0 · 42 lines · 1.3s
 *   ✓ edit   ~/env/pi/keybindings.json          +3 −1
 *   ✗ read   docs/missing.md
 *       ENOENT: no such file or directory ...
 *
 * ctrl+o (app.tools.expand) toggles to pi's normal full rendering, unchanged.
 * The built-in renderers are always run, so expanding is instant and their state stays current.
 *
 * /view      pick a tool call from the current branch and open its full output in nvim -R
 * /view N    open the Nth most recent call directly (/view 1 = latest)
 *   edit -> unified diff, write -> written file, read -> file contents (both with the file's
 *   name, so nvim picks the filetype), bash -> command + complete output (the untruncated log
 *   when pi spilled it to disk), others -> arguments + output.
 *   Inside tmux it opens in a new tmux window; otherwise pi suspends until you quit nvim.
 */

import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Result = { content: Array<{ type: string; text?: string }>; details?: any };

interface RowState {
	row?: Row;
	baseCall?: Component;
	baseResult?: Component;
	result?: Result;
	args?: any;
	ctx?: any;
	theme?: any;
}

const STATE_KEY = "__compactTools";

function textOf(result: Result | undefined): string {
	if (!result) return "";
	return result.content
		.filter((c) => c.type === "text" && c.text)
		.map((c) => c.text!)
		.join("\n");
}

function lineCount(text: string): number {
	const t = text.replace(/\n+$/, "");
	return t ? t.split("\n").length : 0;
}

function shortPath(p: unknown, cwd: string | undefined): string {
	if (typeof p !== "string" || !p) return "";
	let abs = p;
	if (cwd && !path.isAbsolute(p)) abs = path.resolve(cwd, p);
	if (cwd && (abs === cwd || abs.startsWith(cwd + path.sep))) return path.relative(cwd, abs) || ".";
	const home = os.homedir();
	return abs.startsWith(home) ? "~" + abs.slice(home.length) : abs;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function oneLine(s: unknown): string {
	return String(s ?? "").replace(/\s*\n\s*/g, " ⏎ ").trim();
}

function duration(ms: number | undefined): string {
	if (ms === undefined || ms < 1000) return "";
	const s = ms / 1000;
	return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

/** [target, stats] for the collapsed line. */
function describe(tool: string, args: any, result: Result | undefined, ctx: any): [string, string[]] {
	const a = args ?? {};
	const out = textOf(result);
	const done = result && !ctx?.isPartial;
	const stats: string[] = [];
	switch (tool) {
		case "bash":
		case "powershell": {
			if (done) {
				const m = out.match(/exited with code (\d+)/);
				stats.push(`exit ${m ? m[1] : ctx?.isError ? "?" : 0}`);
				const n = lineCount(out.replace(/\n*Command exited with code \d+\s*$/, ""));
				if (n) stats.push(plural(n, "line"));
			}
			const d = duration(ctx?.durationMs);
			if (d) stats.push(d);
			return [oneLine(a.command), stats];
		}
		case "read": {
			let target = shortPath(a.path, ctx?.cwd);
			if (a.offset || a.limit) target += `:${a.offset ?? 1}${a.limit ? `+${a.limit}` : ""}`;
			if (done && !ctx?.isError) stats.push(plural(lineCount(out), "line"));
			return [target, stats];
		}
		case "edit": {
			const patch: string = result?.details?.patch ?? "";
			if (done && patch) {
				let add = 0;
				let del = 0;
				for (const l of patch.split("\n")) {
					if (l.startsWith("+") && !l.startsWith("+++")) add++;
					else if (l.startsWith("-") && !l.startsWith("---")) del++;
				}
				stats.push(`+${add} −${del}`);
			}
			return [shortPath(a.path, ctx?.cwd), stats];
		}
		case "write": {
			const n = lineCount(String(a.content ?? ""));
			if (a.content !== undefined) stats.push(plural(n, "line"));
			return [shortPath(a.path, ctx?.cwd), stats];
		}
		case "grep":
		case "find":
		case "ls": {
			const target = [a.pattern, a.path ? shortPath(a.path, ctx?.cwd) : "", a.glob ?? ""]
				.filter(Boolean)
				.map(oneLine)
				.join("  ");
			if (done && !ctx?.isError) {
				const n = lineCount(out);
				stats.push(plural(n, "result"));
			}
			return [target, stats];
		}
		default: {
			const pairs = Object.entries(a)
				.map(([k, v]) => `${k}=${typeof v === "string" ? oneLine(v) : JSON.stringify(v)}`)
				.join(" ");
			return [pairs, stats];
		}
	}
}

/** Fallbacks for tools that have a definition but no renderer for a slot. */
function fallbackCall(tool: string, args: any, theme: any): Component {
	const body = Object.entries(args ?? {})
		.map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`)
		.join("\n");
	return new Text(theme.fg("toolTitle", theme.bold(tool)) + (body ? "\n" + theme.fg("muted", body) : ""), 0, 0);
}

function fallbackResult(result: Result, theme: any): Component | undefined {
	const out = textOf(result);
	return out ? new Text(theme.fg("toolOutput", out), 0, 0) : undefined;
}

class Row implements Component {
	private box?: Box;
	private tool: string;
	private st: RowState;
	private selfShell: boolean;

	constructor(tool: string, st: RowState, selfShell: boolean) {
		this.tool = tool;
		this.st = st;
		this.selfShell = selfShell;
	}

	invalidate(): void {
		this.box?.invalidate();
		this.st.baseCall?.invalidate();
		this.st.baseResult?.invalidate();
	}

	render(width: number): string[] {
		const { ctx, theme } = this.st;
		if (!ctx || !theme) return [];
		return ctx.expanded ? this.renderExpanded(width) : this.renderCollapsed(width);
	}

	private renderExpanded(width: number): string[] {
		const { ctx, theme, baseCall, baseResult } = this.st;
		const parts = [baseCall, baseResult].filter((c): c is Component => !!c);
		if (this.selfShell) return parts.flatMap((c) => c.render(width));
		// Same frame pi draws for the default shell: padded box tinted by status.
		const bg = ctx.isPartial ? "toolPendingBg" : ctx.isError ? "toolErrorBg" : "toolSuccessBg";
		this.box ??= new Box(ctx.outputPad ?? 1, 1);
		this.box.setBgFn((t: string) => theme.bg(bg, t));
		this.box.setPaddingX(ctx.outputPad ?? 1);
		this.box.clear();
		for (const c of parts) this.box.addChild(c);
		return this.box.render(width);
	}

	private renderCollapsed(width: number): string[] {
		const { ctx, theme, args, result } = this.st;
		const pad = " ".repeat(ctx.outputPad ?? 1);
		const running = !result || ctx.isPartial;
		const mark = running ? theme.fg("muted", "…") : ctx.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const [target, stats] = describe(this.tool, args, result, ctx);
		const head = `${pad}${mark} ${theme.fg("toolTitle", theme.bold(this.tool))}  `;
		const tail = stats.length ? "  " + theme.fg("dim", stats.join(" · ")) : "";
		const lines = [truncateToWidth(head + theme.fg("muted", target), width - (tail ? stats.join(" · ").length + 2 : 0)) + tail];
		if (ctx.isError && !ctx.isPartial) {
			// bash: last output line before the status line; others: first line of the error.
			const all = textOf(result).split("\n").filter((l) => l.trim());
			const shell = this.tool === "bash" || this.tool === "powershell";
			const body = shell ? all.filter((l) => !/^Command (exited with code|aborted|terminated)/.test(l)) : all;
			const err = (shell ? body[body.length - 1] : body[0]) ?? all[0] ?? "";
			if (err) lines.push(truncateToWidth(`${pad}    ${theme.fg("error", err.trim())}`, width));
		}
		return lines.map((l) => truncateToWidth(l, width));
	}
}

function wrap(tool: string, base: ToolRenderers): ToolRenderers {
	const selfShell = base.renderShell === "self";
	const stateOf = (ctx: any): RowState => (ctx.state[STATE_KEY] ??= {});
	const rowOf = (st: RowState) => (st.row ??= new Row(tool, st, selfShell));

	return {
		renderShell: "self",
		renderCall(args: any, theme: any, ctx: any) {
			const st = stateOf(ctx);
			Object.assign(st, { args, ctx, theme });
			try {
				st.baseCall = base.renderCall
					? base.renderCall(args, theme, { ...ctx, lastComponent: st.baseCall })
					: fallbackCall(tool, args, theme);
			} catch {
				st.baseCall = fallbackCall(tool, args, theme);
			}
			return rowOf(st);
		},
		renderResult(result: Result, options: any, theme: any, ctx: any) {
			const st = stateOf(ctx);
			Object.assign(st, { result, ctx, theme });
			try {
				st.baseResult = base.renderResult
					? base.renderResult(result, options, theme, { ...ctx, lastComponent: st.baseResult })
					: fallbackResult(result, theme);
			} catch {
				st.baseResult = fallbackResult(result, theme);
			}
			// Everything is drawn by the Row returned from renderCall.
			return { render: () => [], invalidate() {} };
		},
	} as ToolRenderers;
}

// ---------------------------------------------------------------------------
// /view

interface Call {
	id: string;
	name: string;
	args: any;
	result?: Result & { isError?: boolean };
}

const VIEW_ROOT = path.join(os.tmpdir(), "pi-view");

function collectCalls(ctx: any): Call[] {
	const calls: Call[] = [];
	const results = new Map<string, any>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b.type === "toolCall") calls.push({ id: b.id, name: b.name, args: b.arguments });
			}
		} else if (m.role === "toolResult") {
			results.set(m.toolCallId, m);
		}
	}
	for (const c of calls) c.result = results.get(c.id);
	return calls;
}

function label(c: Call, n: number, cwd: string): string {
	const ctx = { cwd, isError: c.result?.isError, isPartial: !c.result };
	const [target, stats] = describe(c.name, c.args, c.result, ctx);
	const mark = !c.result ? "…" : c.result.isError ? "✗" : "✓";
	const t = target.length > 70 ? target.slice(0, 69) + "…" : target;
	return `${String(n).padStart(2)}. ${mark} ${c.name}  ${t}${stats.length ? "  · " + stats.join(" · ") : ""}`;
}

/** File name (drives nvim's filetype detection) and contents for a call. */
function document(c: Call, cwd: string): { name: string; text: string } {
	const a = c.args ?? {};
	const out = textOf(c.result);
	const base = typeof a.path === "string" && a.path ? path.basename(a.path) : "";
	const argLines = Object.entries(a)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`)
		.join("\n");
	switch (c.name) {
		case "edit": {
			const patch: string | undefined = c.result?.details?.patch;
			if (patch) return { name: `${base || "edit"}.diff`, text: `# ${shortPath(a.path, cwd)}\n${patch}` };
			return { name: `${base || "edit"}.edit.txt`, text: `${argLines}\n\n--- result ---\n${out}` };
		}
		case "write":
			if (typeof a.content === "string") return { name: base || "write.txt", text: a.content };
			break;
		case "read":
			if (!c.result?.isError && out) return { name: base || "read.txt", text: out };
			break;
		case "bash":
		case "powershell": {
			let body = out;
			const full = c.result?.details?.fullOutputPath;
			if (typeof full === "string" && fs.existsSync(full)) body = fs.readFileSync(full, "utf8");
			return { name: `${c.name}.log`, text: `$ ${a.command ?? ""}\n\n${body}` };
		}
	}
	return { name: `${c.name}.txt`, text: `${argLines}\n\n--- result ---\n${out}` };
}

function hasNvim(): boolean {
	return !spawnSync("nvim", ["--version"], { stdio: "ignore" }).error;
}

async function openInNvim(file: string, title: string, ctx: any): Promise<void> {
	if (process.env.TMUX) {
		const r = spawnSync("tmux", ["new-window", "-n", title, "-c", ctx.cwd, "nvim", "-R", file], {
			stdio: "ignore",
		});
		if (!r.error && r.status === 0) return;
	}
	// Not in tmux (or tmux failed): hand the terminal to nvim, resume pi when it exits.
	await ctx.ui.custom((tui: any, _theme: any, _kb: any, done: (v: undefined) => void) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		spawnSync("nvim", ["-R", file], { stdio: "inherit", cwd: ctx.cwd });
		tui.start();
		tui.requestRender(true);
		done(undefined);
		return { render: () => [], invalidate() {} };
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("view", {
		description: "Open a tool call's full output in nvim (/view N: Nth most recent)",
		handler: async (args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			const cwd = ctx.cwd ?? ctx.sessionManager.getCwd();
			const calls = collectCalls(ctx).reverse(); // newest first
			if (calls.length === 0) return ctx.ui.notify("No tool calls in this session yet", "info");
			if (!hasNvim()) return ctx.ui.notify("nvim not found on PATH", "error");

			let index: number;
			const n = Number.parseInt(String(args ?? "").trim(), 10);
			if (Number.isFinite(n)) {
				if (n < 1 || n > calls.length) return ctx.ui.notify(`/view: pick 1..${calls.length}`, "error");
				index = n - 1;
			} else {
				const labels = calls.map((c, i) => label(c, i + 1, cwd));
				const choice = await ctx.ui.select("Open in nvim", labels);
				if (choice === undefined) return;
				index = labels.indexOf(choice);
				if (index < 0) return;
			}

			const call = calls[index]!;
			const { name, text } = document(call, cwd);
			const dir = path.join(VIEW_ROOT, String(process.pid), call.id.replace(/[^\w.-]/g, "_"));
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, name);
			fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n");
			await openInNvim(file, `pi:${call.name}`, { ...ctx, cwd, ui: ctx.ui });
		},
	});

	// Temp files are per pi process; remove them when it exits.
	pi.on("session_shutdown", () => {
		try {
			fs.rmSync(path.join(VIEW_ROOT, String(process.pid)), { recursive: true, force: true });
		} catch {}
	});

	pi.registerToolRenderer((toolName, next) => {
		// Tools without any renderer (e.g. unconnected MCP tools) use the generic fallbacks above.
		return wrap(toolName, next() ?? {});
	});
}
