/**
 * subagent-viewer: defaults for pi-subagent-manager's live agent viewer
 * (/agents tree -> Enter on an agent).
 *
 *   Tool calls start collapsed to one line each ("compact"); thinking blocks start shown in
 *   full. The package ties both to one Ctrl+O level, so this splits them:
 *   Ctrl+O                    cycles tool detail  compact -> preview -> full -> compact
 *   app.thinking.toggle       shows / hides thinking blocks (ctrl+t here)
 * Both choices are kept per agent while pi runs, like the package's own scroll position.
 *
 * Works by adjusting the package's LiveAgentView instance when the tree mounts it, so it
 * depends on that class's internals (viewport.detail, blockLines(), markdown(), invalidate()).
 * If a package update changes them, pi shows a warning and the viewer keeps the package's
 * own behavior.
 *
 * It also tracks the package's navigation overlay (the /agents tree DialogSession) for pi-fleet's
 * deck (docs/pi-deck-design.md §16, fleet/agents-view.ts), through a small API handed out on
 * pi.events: emit VIEWER_API_EVENT with `{}` and read `.api` (a ViewerApi) synchronously.
 *   current()     the open navigation overlay: kind (tree | agent | other), agent path, whether
 *                 the deck opened it and whether any key reached it since
 *   expect(path)  the next tree mount with `path` selected gets one Enter (so the package's own
 *                 loop opens that agent's LiveAgentView); resolves "mounted" once it is shown,
 *                 "unknown" when the tree does not list `path` (reaped, never existed),
 *                 "unsupported" when the package's internals changed, "cancelled" on cancel()
 *   close()       close the navigation overlay (DialogSession.close: the package's own exit)
 * The newest instance always owns the ui.custom hook (re-wrapped from the original on every
 * session_start), so /reload never leaves a stale tracker behind.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

const PACKAGE = "/pi-subagent-manager/";
/** pi.events channel: `{ api?: ViewerApi }`, filled synchronously by the instance that owns the UI hook. */
export const VIEWER_API_EVENT = "subagent-viewer:api";
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

export type NavKind = "tree" | "agent" | "other";
export type ExpectResult = "mounted" | "unknown" | "unsupported" | "cancelled";

export interface NavState {
	kind: NavKind;
	/** The agent shown (kind agent) or selected in the tree (kind tree). */
	path: string | undefined;
	/** Opened through expect() and shown. */
	deckOpened: boolean;
	/** A key (or mouse/focus event) reached the overlay since it was shown by expect(). */
	touched: boolean;
}

export interface ViewerApi {
	current(): NavState | undefined;
	expect(path: string): Promise<ExpectResult>;
	/** Resolve a pending expect() with "cancelled"; close the overlay it opened if still untouched. */
	cancel(): void;
	/** Close the navigation overlay; true if one was open. */
	close(): boolean;
}

interface Pending {
	path: string;
	resolve(result: ExpectResult): void;
	/** The session whose tree got the Enter. */
	session?: any;
}

/** The package's navigation tree (StatusDialog with navigation state), checked member by member. */
function treeOf(child: any): { selected: string | undefined; known(path: string): boolean } | undefined | "changed" {
	if (child?.constructor?.name !== "StatusDialog" || !child.navigation) return undefined;
	if (typeof child.handleInput !== "function" || typeof child.service?.list !== "function") return "changed";
	return {
		selected: typeof child.state?.selectedPath === "string" ? child.state.selectedPath : undefined,
		known: (path) => {
			try {
				return child.service.list().some((t: any) => t?.path === path);
			} catch {
				return false;
			}
		},
	};
}

/** Navigation overlays of one pi UI; owned by the extension instance that hooked ctx.ui last. */
class NavTracker implements ViewerApi {
	private sessions: any[] = [];
	private pending: Pending | undefined;
	private warned = false;

	private notify: Notify;

	constructor(notify: Notify) {
		this.notify = notify;
	}

	add(session: any): void {
		this.sessions.push(session);
	}

	remove(session: any): void {
		this.sessions = this.sessions.filter((s) => s !== session);
		if (this.pending?.session === session) this.settle("cancelled");
	}

	private nav(): any {
		for (let i = this.sessions.length - 1; i >= 0; i--) if (this.sessions[i].__navKind) return this.sessions[i];
		return undefined;
	}

	private settle(result: ExpectResult): Pending | undefined {
		const p = this.pending;
		this.pending = undefined;
		p?.resolve(result);
		return p;
	}

	private degrade(): void {
		if (!this.warned) this.notify("subagent-viewer: pi-subagent-manager's agent tree changed; the deck cannot open agents", "warning");
		this.warned = true;
		this.settle("unsupported");
	}

	/** A session mounted or showed a child: classify it and drive a pending expect(). */
	check(session: any): void {
		const child = session.getComponent?.();
		if (!child || child === session.__navChild) return;
		session.__navChild = child;
		if (child.constructor?.name === "LiveAgentView") {
			session.__navKind = "agent";
			session.__navPath = typeof child.path === "string" ? child.path : undefined;
			const p = this.pending;
			if (p && p.session === session && session.__navPath === p.path) {
				this.settle("mounted");
				session.__deckOpened = true;
				session.__touched = false;
			}
			return;
		}
		const tree = treeOf(child);
		if (tree === "changed") {
			// The tree expect() asked for: close it again, the deck falls back to its own preview.
			if (this.pending && !this.pending.session) {
				this.degrade();
				session.close?.();
			}
			return;
		}
		if (!tree) {
			if (session.__navKind) session.__navKind = "other";
			return;
		}
		session.__navKind = "tree";
		session.__navPath = tree.selected;
		const p = this.pending;
		if (!p || p.session || tree.selected !== p.path) return;
		p.session = session;
		if (!tree.known(p.path)) {
			this.settle("unknown");
			session.close?.();
			return;
		}
		// After the mount settles: the package's loop then mounts the agent's LiveAgentView.
		void Promise.resolve().then(() => {
			if (this.pending === p && session.getComponent?.() === child) child.handleInput("\r");
		});
	}

	current(): NavState | undefined {
		const s = this.nav();
		if (!s) return undefined;
		const child = s.getComponent?.();
		if (child && child !== s.__navChild) this.check(s);
		const tree = treeOf(child);
		const path = tree && tree !== "changed" ? tree.selected : s.__navPath;
		return { kind: s.__navKind, path, deckOpened: !!s.__deckOpened, touched: !!s.__touched };
	}

	expect(path: string): Promise<ExpectResult> {
		this.settle("cancelled");
		return new Promise((resolve) => {
			this.pending = { path, resolve };
		});
	}

	cancel(): void {
		const p = this.settle("cancelled");
		if (p?.session && !p.session.__touched && this.sessions.includes(p.session)) p.session.close?.();
	}

	close(): boolean {
		const s = this.nav();
		if (!s) return false;
		s.close?.();
		this.remove(s);
		return true;
	}
}

/** Watch a DialogSession-like component for a LiveAgentView child and for navigation views. */
function watchSession(session: any, keys: any, notify: Notify, tracker: NavTracker): any {
	if (!session || typeof session.getComponent !== "function" || session.__subagentViewer) return session;
	session.__subagentViewer = true;
	tracker.add(session);
	const check = () => {
		const child = session.getComponent();
		if (child?.constructor?.name === "LiveAgentView") adjustViewer(child, keys, notify);
		tracker.check(session);
	};
	for (const method of ["render", "handleInput", "handleMouse"]) {
		const original = session[method];
		if (typeof original !== "function") continue;
		session[method] = function (this: any, ...args: any[]) {
			// Input from the host is the user's: the deck must not close this overlay any more.
			if (method !== "render") session.__touched = true;
			check();
			return original.apply(this, args);
		};
	}
	// mount() installs a synchronous factory's view before it returns: classify it at once.
	if (typeof session.mount === "function") {
		const mount = session.mount;
		session.mount = function (this: any, ...args: any[]) {
			const result = mount.apply(this, args);
			check();
			return result;
		};
	}
	for (const method of ["close", "dispose"]) {
		const original = session[method];
		if (typeof original !== "function") continue;
		session[method] = function (this: any, ...args: any[]) {
			tracker.remove(session);
			return original.apply(this, args);
		};
	}
	return session;
}

/** Wrap ui.custom for calls from the package; always from the original, so the newest hook wins. */
function hookCustom(ui: any, tracker: NavTracker): boolean {
	if (!ui || typeof ui.custom !== "function") return false;
	const custom = ui.__subagentViewerOriginal ?? ui.custom;
	ui.__subagentViewerOriginal = custom;
	const notify: Notify = (message, type) => ui.notify?.(message, type);
	ui.custom = function (this: any, factory: any, options?: any) {
		if (!calledFromPackage(stackHere())) return custom.call(this, factory, options);
		const wrapped = (...args: any[]) => {
			const keys = args[2];
			const made = factory(...args);
			const watch = (c: any) => watchSession(c, keys, notify, tracker);
			return made && typeof made.then === "function" ? made.then(watch) : watch(made);
		};
		return custom.call(this, wrapped, options);
	};
	return true;
}

export default function (pi: ExtensionAPI) {
	let tracker: NavTracker | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const ui: any = ctx.ui;
		const next = new NavTracker((message, type) => ui.notify?.(message, type));
		if (hookCustom(ui, next)) tracker = next;
	});
	// Only the instance that owns a UI hook answers (subagent sessions in this process do not).
	pi.events.on(VIEWER_API_EVENT, (request: any) => {
		if (tracker && request && typeof request === "object" && !request.api) request.api = tracker;
	});
}
