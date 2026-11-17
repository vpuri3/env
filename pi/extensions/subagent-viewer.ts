/**
 * subagent-viewer: defaults for pi-subagent-manager's live agent viewer
 * (/agents tree -> Enter on an agent).
 *
 *   Tool calls start collapsed to one line each ("compact"); thinking blocks start shown in
 *   full. The package ties both to one Ctrl+O level, so this splits them:
 *   Ctrl+O                    cycles tool detail  compact -> preview -> full -> compact
 *   app.thinking.toggle       shows / hides thinking blocks (ctrl+t or alt+o here)
 * Both choices are kept per agent while pi runs, like the package's own scroll position.
 *
 * Works by adjusting the package's LiveAgentView instance when the tree mounts it, so it
 * depends on that class's internals (viewport.detail, blockLines(), markdown(), invalidate()).
 * If a package update changes them, pi shows a warning and the viewer keeps the package's
 * own behavior.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

const PACKAGE = "/pi-subagent-manager/";
const TOOL_CYCLE = ["compact", "preview", "full"] as const;

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

function stackHere(): string {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 50;
	try {
		return new Error().stack ?? "";
	} finally {
		Error.stackTraceLimit = limit;
	}
}

function calledFromPackage(stack: string): boolean {
	return stack
		.split("\n")
		.slice(1)
		.some((line) => line.includes(PACKAGE));
}

/** True if `view` still has every member this extension relies on. */
function looksLikeViewer(view: any): boolean {
	const proto = Object.getPrototypeOf(view);
	return (
		!!view.viewport &&
		typeof view.viewport === "object" &&
		typeof proto?.blockLines === "function" &&
		typeof proto?.markdown === "function" &&
		typeof proto?.handleInput === "function" &&
		typeof proto?.render === "function" &&
		typeof view.invalidate === "function" &&
		!!view.host &&
		!!view.theme
	);
}

/** Apply the defaults and split toggles to one LiveAgentView instance. */
export function adjustViewer(view: any, keys: any, notify: Notify): void {
	if (!view || view.__subagentViewer) return;
	view.__subagentViewer = true;
	if (!looksLikeViewer(view)) {
		notify("subagent-viewer: pi-subagent-manager's viewer changed; tool/thinking defaults not applied", "warning");
		return;
	}
	const proto = Object.getPrototypeOf(view);
	const viewport = view.viewport;
	viewport.detail ??= "compact";
	viewport.hideThinking ??= false;

	view.blockLines = function (this: any, value: any, width: number): string[] {
		if (value?.type !== "thinking") return proto.blockLines.call(this, value, width);
		if (this.viewport.hideThinking) {
			return [this.theme.fg("dim", "[Thinking hidden · Ctrl+T shows]")];
		}
		return this.markdown(String(value.thinking ?? "[redacted thinking]"), width, true);
	};

	const refresh = () => {
		view.invalidate();
		view.host.requestRender();
	};
	view.handleInput = function (this: any, data: string): void {
		if (!this.pasting) {
			if (keys?.matches?.(data, "app.thinking.toggle")) {
				this.viewport.hideThinking = !this.viewport.hideThinking;
				return refresh();
			}
			if (matchesKey(data, "ctrl+o")) {
				const i = TOOL_CYCLE.indexOf(this.viewport.detail);
				this.viewport.detail = TOOL_CYCLE[(i + 1) % TOOL_CYCLE.length];
				return refresh();
			}
		}
		return proto.handleInput.call(this, data);
	};

	view.render = function (this: any, width: number): string[] {
		// Footer: say what Ctrl+O controls now, and name the thinking toggle.
		return proto.render
			.call(this, width)
			.map((line: string) => line.replace("Ctrl+O view:", "Ctrl+T thinking · Ctrl+O tools:"));
	};
}

/** Watch a DialogSession-like component for a LiveAgentView child. */
function watchSession(session: any, keys: any, notify: Notify): any {
	if (!session || typeof session.getComponent !== "function" || session.__subagentViewer) return session;
	session.__subagentViewer = true;
	const check = () => {
		const child = session.getComponent();
		if (child?.constructor?.name === "LiveAgentView") adjustViewer(child, keys, notify);
	};
	for (const method of ["render", "handleInput"]) {
		const original = session[method];
		if (typeof original !== "function") continue;
		session[method] = function (this: any, ...args: any[]) {
			check();
			return original.apply(this, args);
		};
	}
	return session;
}

function hookCustom(ui: any): void {
	if (!ui || ui.__subagentViewer || typeof ui.custom !== "function") return;
	ui.__subagentViewer = true;
	const custom = ui.custom;
	const notify: Notify = (message, type) => ui.notify?.(message, type);
	ui.custom = function (this: any, factory: any, options?: any) {
		if (!calledFromPackage(stackHere())) return custom.call(this, factory, options);
		const wrapped = (...args: any[]) => {
			const keys = args[2];
			const made = factory(...args);
			const watch = (c: any) => watchSession(c, keys, notify);
			return made && typeof made.then === "function" ? made.then(watch) : watch(made);
		};
		return custom.call(this, wrapped, options);
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) hookCustom(ctx.ui);
	});
}
