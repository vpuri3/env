/**
 * footer: a smaller footer under the prompt box, replacing pi's built-in one.
 *
 *   line 1: env (master)                                   (provider) model • thinking
 *   line 2: context 12.3%/1M · cache 94% · git +1 ~3 ?2 ↑2 · lanes: 1 working, 2 to merge
 *                                                            <other extensions' statuses>
 *
 * Line 1: the repo's name (the main checkout's, also inside a lane; the cwd's name outside git)
 * and branch; the full path is in the deck's session list.
 * Line 2: context use (warning above 70 %, error above 90 %, as pi's footer), the latest
 * response's cache hit rate (cache read / prompt tokens), then git (git.ts). Costs and token
 * totals live in the deck's session list; pi-subagent-manager's `subagent_cost` status is
 * dropped for that reason, other ctx.ui.setStatus texts go on line 2's right side.
 *
 * Git is read off the render path: at session start, on a branch change, after edit/write/bash
 * tool calls (debounced), at the end of each run, and polled (every 5 s, slower when git is
 * slow: 20× the last read) for changes made elsewhere (other lanes' agents, the editor). Reads
 * never overlap; a request during a read runs once more after it.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatGit, readGit, type GitState } from "./git.ts";

const HIDDEN_STATUSES = new Set(["subagent_cost"]);
const POLL_MS = 5_000;
const TOOL_DEBOUNCE_MS = 300;
const GIT_TOOLS = new Set(["edit", "write", "bash"]);

function tokens(n: number): string {
	if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return `${n}`;
}

/** `left` then `right` flush with the edge; the right side is cut first when both don't fit. */
function spread(left: string, right: string, width: number): string {
	const l = truncateToWidth(left, width, "…");
	const room = width - visibleWidth(l) - 2;
	if (!right || room < 1) return l;
	const r = truncateToWidth(right, room, "…");
	return l + " ".repeat(width - visibleWidth(l) - visibleWidth(r)) + r;
}

/** Cache hit rate of the latest assistant response on the branch, in percent. */
function cacheHitRate(ctx: ExtensionContext): number | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e: any = branch[i];
		if (e.type !== "message" || e.message?.role !== "assistant" || !e.message.usage) continue;
		const u = e.message.usage;
		const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		if (!(u.cacheRead || u.cacheWrite) || !prompt) return undefined;
		return (u.cacheRead / prompt) * 100;
	}
	return undefined;
}

/** Git reads for one footer: single-flight, coalesced, polled with backoff. */
class GitWatch {
	state: GitState | undefined;
	private running = false;
	private again = false;
	private disposed = false;
	private lastMs = 0;
	private poll?: NodeJS.Timeout;
	private debounce?: NodeJS.Timeout;

	constructor(
		private cwd: string,
		private onChange: () => void,
	) {
		this.refresh();
	}

	refresh(): void {
		if (this.disposed) return;
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		void this.loop();
	}

	soon(): void {
		clearTimeout(this.debounce);
		this.debounce = setTimeout(() => this.refresh(), TOOL_DEBOUNCE_MS);
		this.debounce.unref?.();
	}

	private async loop(): Promise<void> {
		try {
			do {
				this.again = false;
				const t0 = Date.now();
				const next = await readGit(this.cwd).catch(() => undefined);
				this.lastMs = Date.now() - t0;
				if (this.disposed) return;
				const changed = JSON.stringify(next) !== JSON.stringify(this.state);
				this.state = next;
				if (changed) this.onChange();
			} while (this.again && !this.disposed);
		} finally {
			this.running = false;
			this.schedule();
		}
	}

	private schedule(): void {
		if (this.disposed) return;
		clearTimeout(this.poll);
		this.poll = setTimeout(() => this.refresh(), Math.max(POLL_MS, this.lastMs * 20));
		this.poll.unref?.();
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.poll);
		clearTimeout(this.debounce);
	}
}

let current: GitWatch | undefined;

function install(pi: ExtensionAPI, ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		const cwd = ctx.sessionManager.getCwd();
		const git = new GitWatch(cwd, () => tui.requestRender());
		current = git;
		const unsub = footerData.onBranchChange(() => {
			git.refresh();
			tui.requestRender();
		});
		const sep = theme.fg("dim", " · ");
		return {
			dispose() {
				git.dispose();
				unsub();
				if (current === git) current = undefined;
			},
			invalidate() {},
			render(width: number): string[] {
				const g = git.state;
				const branch = footerData.getGitBranch();
				const where = `${g?.repo ?? basename(cwd)}${branch ? ` (${branch})` : ""}`;
				const model = ctx.model;
				let modelText = model?.id ?? "no model";
				if (model?.reasoning) {
					const level = pi.getThinkingLevel();
					modelText += level === "off" ? " • thinking off" : ` • ${level}`;
				}
				if (model && footerData.getAvailableProviderCount() > 1) modelText = `(${model.provider}) ${modelText}`;
				const line1 = theme.fg("dim", spread(where, modelText, width));

				const usage = ctx.getContextUsage();
				const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
				const pct = usage?.percent;
				const ctxText = `context ${pct == null ? "?" : `${pct.toFixed(1)}%`}/${tokens(window)}`;
				const left = [pct != null && pct > 90 ? theme.fg("error", ctxText) : pct != null && pct > 70 ? theme.fg("warning", ctxText) : theme.fg("dim", ctxText)];
				const hit = cacheHitRate(ctx);
				if (hit !== undefined) left.push(theme.fg("dim", `cache ${hit.toFixed(0)}%`));
				if (g) for (const group of formatGit(g)) left.push(group.map((p) => theme.fg(p.tone, p.text)).join(" "));
				const statuses = [...footerData.getExtensionStatuses().entries()]
					.filter(([key]) => !HIDDEN_STATUSES.has(key))
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => text.replace(/[\r\n\t]+/g, " ").trim())
					.filter(Boolean)
					.join(" ");
				return [line1, spread(left.join(sep), statuses, width)];
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) install(pi, ctx);
	});
	pi.on("tool_execution_end", (event: any) => {
		if (GIT_TOOLS.has(event.toolName)) current?.soon();
	});
	// A run may have committed, merged or made lanes.
	pi.on("agent_end", () => current?.refresh());
}
