/**
 * jk-nav: j / k move down / up in list dialogs that have no text box focused.
 *
 * Applies only to dialogs opened (ctx.ui.custom) by these packages:
 *   pi-subagent-manager           /agents tree, status, menus, settings; Tab-browse mode
 *                                 of the live agent viewer (j/k scroll the transcript)
 *   rpiv-ask-user-question        the ask_user_question dialog
 * j and k become Down / Up, so they do whatever the arrows do there.
 *
 * "Text box focused" means the dialog's last frame contains pi-tui's CURSOR_MARKER, which
 * a focused Input / Editor emits for the hardware cursor. Then j and k stay letters: the
 * "Type something." row and notes editor of ask_user_question, the viewer's "Steer >"
 * input, and the fuzzy-search fields of the subagent model / tool pickers.
 *
 * Not done with keybindings.json on purpose: binding j/k to tui.select.down/up would make
 * them unusable in every pi picker with a search field (/resume, /model, ...), and plain
 * letters must never be bound there (see ~/env/AGENTS.md).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

// Package directory names, matched in the stack of the ctx.ui.custom() call.
const PACKAGES = ["/pi-subagent-manager/", "/rpiv-ask-user-question/"];

const DOWN = "\x1b[B";
const UP = "\x1b[A";

/** Which call site opened the dialog: true if a listed package is on the stack. */
export function calledFromPackage(stack: string | undefined): boolean {
	if (!stack) return false;
	// Skip the Error line and this extension's own frames.
	const frames = stack.split("\n").slice(1).filter((line) => !line.includes("jk-nav"));
	return frames.some((line) => PACKAGES.some((p) => line.includes(p)));
}

/** Translate j/k on a component in place, unless its last frame showed a text cursor. */
export function addJk(component: any): any {
	if (!component || component.__jkNav || typeof component.handleInput !== "function") return component;
	component.__jkNav = true;
	let textCursor = false;
	const render = component.render;
	component.render = function (this: any, width: number): string[] {
		const lines: string[] = render.call(this, width);
		textCursor = lines.some((line) => line.includes(CURSOR_MARKER));
		return lines;
	};
	const handleInput = component.handleInput;
	component.handleInput = function (this: any, data: string): void {
		if (!textCursor && !isKeyRelease(data)) {
			if (matchesKey(data, "j")) data = DOWN;
			else if (matchesKey(data, "k")) data = UP;
		}
		return handleInput.call(this, data);
	};
	return component;
}

function stackHere(): string | undefined {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 50;
	try {
		return new Error().stack;
	} finally {
		Error.stackTraceLimit = limit;
	}
}

function hookCustom(ui: any): void {
	if (!ui || ui.__jkNav || typeof ui.custom !== "function") return;
	ui.__jkNav = true;
	const custom = ui.custom;
	ui.custom = function (this: any, factory: any, options?: any) {
		if (!calledFromPackage(stackHere())) return custom.call(this, factory, options);
		const wrapped = (...args: any[]) => {
			const made = factory(...args);
			return made && typeof made.then === "function" ? made.then(addJk) : addJk(made);
		};
		return custom.call(this, wrapped, options);
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) hookCustom(ctx.ui);
	});
}
