/**
 * ask-timeout: optional `timeoutSeconds` for rpiv-ask-user-question's `ask_user_question`.
 *
 * For agents the user has told to work on their own: the agent may still ask, but if
 * nobody answers within `timeoutSeconds` the dialog closes with each question's
 * "(Recommended)" option(s). A question without one gets no answer.
 *   - The dialog shows a countdown line at the top ("auto-selects Recommended in 4:32").
 *   - Any keypress cancels the countdown for good (the user is there); the key itself
 *     still does what it normally does.
 *   - On timeout the tool result says so ("No response within N s; auto-selected ...
 *     The user did not see/confirm this.") instead of "User has answered".
 * Without `timeoutSeconds` the tool behaves exactly as the package ships it.
 *
 * No copy of the package's tool. This extension
 *   1. adds the `timeoutSeconds` property to the package's parameter schema on
 *      session_start (the schema object pi.getAllTools() returns is the registered one),
 *   2. reads `timeoutSeconds` per call from the `tool_call` event,
 *   3. pairs each dialog the package opens (ctx.ui.custom, found by call stack as in
 *      jk-nav.ts) with its tool call through the package's public `rpiv:ask-user:prompt` /
 *      `rpiv:ask-user:blocked` events, and wraps that dialog's component and `done`,
 *   4. rewrites the result text in `tool_result` for calls that timed out.
 * If a package update breaks one of these, the parameter is either missing (step 1 warns)
 * or ignored, and the dialog simply waits as before. RPC hosts (no ctx.ui.custom) ignore it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, truncateToWidth } from "@earendil-works/pi-tui";

const TOOL = "ask_user_question";
const PACKAGE = "/rpiv-ask-user-question/";
const PROMPT_EVENT = "rpiv:ask-user:prompt";
const BLOCKED_EVENT = "rpiv:ask-user:blocked";
const MAX_SECONDS = 86400;

export const TIMEOUT_PARAM = {
	type: "integer",
	minimum: 1,
	maximum: MAX_SECONDS,
	description:
		"Optional. Use ONLY when the user has authorized you to make decisions autonomously (e.g. they may be away). " +
		"Seconds to wait for an answer (e.g. 300); if the user does not respond, the dialog closes and each question " +
		'is answered with its option(s) whose label ends in "(Recommended)" — so put your recommended option first ' +
		'and mark it "(Recommended)". A question with no Recommended option gets no answer. Any keypress by the user ' +
		"cancels the countdown. The result tells you when this happened; then tell the user in chat which options were " +
		"auto-selected. Omit to wait for the user indefinitely.",
};

interface Option {
	label: string;
	description?: string;
	preview?: string;
}
interface Question {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options: Option[];
}

export function isRecommended(label: string): boolean {
	return /\(recommended\)\s*$/i.test(label);
}

/** The questionnaire result the package's dialog would produce had the user picked the Recommended options. */
export function recommendedResult(questions: readonly Question[]) {
	const answers: any[] = [];
	questions.forEach((q, questionIndex) => {
		const picked = q.options.filter((o) => isRecommended(o.label));
		if (picked.length === 0) return;
		const base = { questionIndex, question: q.question };
		if (q.multiSelect) {
			answers.push({ ...base, kind: "multi", answer: null, selected: picked.map((o) => o.label) });
		} else {
			const o = picked[0]!;
			answers.push({ ...base, kind: "option", answer: o.label, ...(o.preview ? { preview: o.preview } : {}) });
		}
	});
	return { answers, cancelled: false };
}

/** The tool result text for a call that timed out. */
export function timeoutText(seconds: number, questions: readonly Question[]): string {
	const chosen: string[] = [];
	const none: string[] = [];
	questions.forEach((q) => {
		const picked = q.options.filter((o) => isRecommended(o.label)).map((o) => o.label);
		if (picked.length > 0) {
			chosen.push(`"${q.question}"="${q.multiSelect ? picked.join(", ") : picked[0]}"`);
		} else none.push(`"${q.question}"`);
	});
	const parts = [`No response within ${seconds} s;`];
	if (chosen.length > 0) parts.push(`auto-selected the recommended option(s): ${chosen.join("; ")}.`);
	else parts.push("no option was marked (Recommended), so nothing was selected.");
	if (chosen.length > 0 && none.length > 0) {
		parts.push(`No answer (no Recommended option) for: ${none.join(", ")}.`);
	}
	parts.push(
		"The user did not see/confirm this. Proceed on that basis and tell the user in chat what was auto-selected so they can revisit it.",
	);
	return parts.join(" ");
}

export function formatClock(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function stackHere(): string {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 50;
	try {
		return new Error().stack ?? "";
	} finally {
		Error.stackTraceLimit = limit;
	}
}

export function calledFromPackage(stack: string): boolean {
	return stack
		.split("\n")
		.slice(1)
		.filter((line) => !line.includes("ask-timeout"))
		.some((line) => line.includes(PACKAGE));
}

/** One open questionnaire, from its prompt event to its `blocked: false` event. */
interface Entry {
	toolCallId: string;
	questions: Question[];
	seconds?: number;
	deadline?: number;
	mounted: boolean;
	cancelled: boolean;
}

export function createAskTimeout(now: () => number = Date.now) {
	const seconds = new Map<string, number>(); // from tool_call, until the prompt event
	const open: Entry[] = []; // in prompt order; dialogs mount in the same order
	const timedOut = new Map<string, { seconds: number; questions: Question[] }>();

	function onToolCall(toolName: string, toolCallId: string, input: any): void {
		if (toolName !== TOOL) return;
		const s = input?.timeoutSeconds;
		if (Number.isInteger(s) && s > 0) seconds.set(toolCallId, Math.min(s, MAX_SECONDS));
	}

	function onPrompt(payload: any): void {
		const id = payload?.toolCallId;
		if (typeof id !== "string") return;
		open.push({
			toolCallId: id,
			questions: Array.isArray(payload.questions) ? payload.questions : [],
			seconds: seconds.get(id),
			mounted: false,
			cancelled: false,
		});
		seconds.delete(id);
	}

	function onBlocked(payload: any): void {
		if (payload?.active !== false) return;
		const i = open.findIndex((e) => e.toolCallId === payload.toolCallId);
		if (i >= 0) open.splice(i, 1);
	}

	/** Patch content of a timed-out call's result; undefined leaves it alone. */
	function onToolResult(toolName: string, toolCallId: string, details: any) {
		if (toolName !== TOOL) return undefined;
		const t = timedOut.get(toolCallId);
		if (!t) return undefined;
		timedOut.delete(toolCallId);
		return {
			content: [{ type: "text" as const, text: timeoutText(t.seconds, t.questions) }],
			details: { ...(details ?? {}), timedOut: { seconds: t.seconds } },
		};
	}

	/** Wrap one dialog factory of the package with the countdown, if its call asked for one. */
	function wrapFactory(ui: any, factory: any): { factory: any; settled: () => void } {
		const entry = open.find((e) => !e.mounted);
		if (!entry) return { factory, settled: () => {} };
		entry.mounted = true;
		const settled = () => {
			entry.mounted = false;
		};
		if (!entry.seconds || entry.cancelled) return { factory, settled };

		const wrapped = (tui: any, theme: any, keybindings: any, done: (r: any) => void) => {
			let finished = false;
			let timer: ReturnType<typeof setInterval> | undefined;
			let removeListener: (() => void) | undefined;
			const stop = () => {
				if (timer) clearInterval(timer);
				timer = undefined;
				removeListener?.();
				removeListener = undefined;
			};
			const finish = (result: any) => {
				if (finished) return;
				finished = true;
				stop();
				done(result);
			};
			const component = factory(tui, theme, keybindings, finish);
			// Closed while mounting (answered from outside, or yielding to an overlay).
			if (finished || !component || typeof component.render !== "function") return component;

			entry.deadline ??= now() + entry.seconds! * 1000;
			const cancel = () => {
				if (entry.cancelled) return;
				entry.cancelled = true;
				stop();
				tui?.requestRender?.();
			};
			const tick = () => {
				if (finished || entry.cancelled) return stop();
				if (now() >= entry.deadline!) {
					timedOut.set(entry.toolCallId, { seconds: entry.seconds!, questions: entry.questions });
					finish(recommendedResult(entry.questions));
				} else tui?.requestRender?.();
			};

			const render = component.render;
			component.render = function (this: any, width: number): string[] {
				const lines: string[] = render.call(this, width);
				if (finished || entry.cancelled) return lines;
				const left = formatClock(entry.deadline! - now());
				const text = `⏱ No answer: auto-selects Recommended in ${left} · any key cancels`;
				const line = truncateToWidth(theme?.fg ? theme.fg("warning", text) : text, Math.max(1, width));
				return [line, ...lines];
			};
			const handleInput = component.handleInput;
			if (typeof handleInput === "function") {
				component.handleInput = function (this: any, data: string): void {
					if (!isKeyRelease(data)) cancel();
					return handleInput.call(this, data);
				};
			}
			// Also catches keys while the overlay is collapsed (its handleInput is unreachable then).
			if (typeof ui.onTerminalInput === "function") {
				removeListener = ui.onTerminalInput((data: string) => {
					if (!isKeyRelease(data)) cancel();
					return undefined;
				});
			}
			timer = setInterval(tick, 1000);
			(timer as any).unref?.();
			return component;
		};
		return { factory: wrapped, settled };
	}

	function hookCustom(ui: any): void {
		if (!ui || ui.__askTimeout || typeof ui.custom !== "function") return;
		ui.__askTimeout = true;
		const custom = ui.custom;
		ui.custom = function (this: any, factory: any, options?: any) {
			if (!calledFromPackage(stackHere())) return custom.call(this, factory, options);
			const { factory: f, settled } = wrapFactory(ui, factory);
			const result = custom.call(this, f, options);
			Promise.resolve(result).then(settled, settled);
			return result;
		};
	}

	return { onToolCall, onPrompt, onBlocked, onToolResult, hookCustom, open, timedOut };
}

/** Add `timeoutSeconds` to the registered schema. True if it is there afterwards. */
export function extendSchema(parameters: any): boolean {
	const props = parameters?.properties;
	if (!props || typeof props !== "object" || !props.questions) return false;
	if (!props.timeoutSeconds) props.timeoutSeconds = { ...TIMEOUT_PARAM };
	return true;
}

export default function (pi: ExtensionAPI) {
	const state = createAskTimeout();
	pi.events.on(PROMPT_EVENT, (data: unknown) => state.onPrompt(data));
	pi.events.on(BLOCKED_EVENT, (data: unknown) => state.onBlocked(data));
	pi.on("tool_call", (event) => {
		state.onToolCall(event.toolName, event.toolCallId, event.input);
	});
	pi.on("tool_result", (event) => state.onToolResult(event.toolName, event.toolCallId, event.details));
	pi.on("session_start", (_event, ctx) => {
		const tool = pi.getAllTools().find((t) => t.name === TOOL);
		if (tool && !extendSchema(tool.parameters) && ctx.hasUI) {
			ctx.ui.notify(`ask-timeout: ${TOOL} schema changed; timeoutSeconds is not available`, "warning");
		}
		if (ctx.hasUI) state.hookCustom(ctx.ui);
	});
}
