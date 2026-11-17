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
 * A tool call's full output opens with `/view tool:N` from the fleet extension
 * (fleet/tool-output.ts, fleet/view.ts), which reuses describe/textOf/shortPath from here.
 *
 * Setting "hideToolOutput" (settings.json, global or project): the ctrl+o state pi starts in.
 *   true (pi's default) = collapsed, false = expanded.
 * /hide-tool-output [on|off]   toggle ctrl+o now (or set it) and save the choice as the setting.
 */

import { type ExtensionAPI, getAgentDir, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
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

export function textOf(result: Result | undefined): string {
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

export function shortPath(p: unknown, cwd: string | undefined): string {
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
export function describe(tool: string, args: any, result: Result | undefined, ctx: any): [string, string[]] {
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

const HIDE_KEY = "hideToolOutput";

/** Write one key into the global settings.json, keeping everything else. */
function saveGlobalSetting(key: string, value: unknown): void {
	const file = path.join(getAgentDir(), "settings.json");
	let settings: Record<string, unknown> = {};
	if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
	settings[key] = value;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
}

export default function (pi: ExtensionAPI) {
	// Start in the ctrl+o state from settings; later /new, /resume, /reload keep the current state.
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" || !ctx.hasUI) return;
		const hide = (pi.getSettings() as Record<string, unknown>)[HIDE_KEY];
		if (typeof hide === "boolean") ctx.ui.setToolsExpanded(!hide);
	});

	pi.registerCommand("hide-tool-output", {
		description: "Collapse/expand tool output like ctrl+o and save it as the default (/hide-tool-output on|off)",
		handler: async (args: string, ctx: any) => {
			if (!ctx.hasUI) return;
			const arg = String(args ?? "").trim().toLowerCase();
			let hide: boolean;
			if (arg === "") hide = ctx.ui.getToolsExpanded();
			else if (["on", "true", "yes", "1"].includes(arg)) hide = true;
			else if (["off", "false", "no", "0"].includes(arg)) hide = false;
			else return ctx.ui.notify("/hide-tool-output: use on, off, or no argument to toggle", "error");
			ctx.ui.setToolsExpanded(!hide);
			try {
				saveGlobalSetting(HIDE_KEY, hide);
			} catch (e) {
				return ctx.ui.notify(`Could not save ${HIDE_KEY}: ${(e as Error).message}`, "error");
			}
			ctx.ui.notify(`Tool output ${hide ? "hidden" : "shown"} (saved "${HIDE_KEY}": ${hide})`, "info");
		},
	});

	pi.registerToolRenderer((toolName, next) => {
		// Tools without any renderer (e.g. unconnected MCP tools) use the generic fallbacks above.
		return wrap(toolName, next() ?? {});
	});
}
