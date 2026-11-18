// fleet/agents-view.ts and subagent-viewer.ts's navigation tracker without a TUI (pi-deck-design.md §16):
// fake DialogSessions shaped like pi-subagent-manager's (getComponent/mount/handleInput/close) and a fake
// pi whose sendUserMessage plays the package's `/agents tree P` (mounts a StatusDialog-like tree with P
// selected; Enter on it mounts a LiveAgentView-like child). The real-package path is agents-view.test.ts.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { fleetOf } from "../../pi/extensions/fleet/shared.ts";
import { piPackages, usePackages } from "./support/view-support.ts";

const packages = piPackages();
const skip = packages ? false : "pi's packages not found (pi not on PATH)";
let viewer: typeof import("../../pi/extensions/subagent-viewer.ts");
let agentsView: typeof import("../../pi/extensions/fleet/agents-view.ts");

before(async () => {
	if (!packages) return;
	await usePackages(packages);
	viewer = await import("../../pi/extensions/subagent-viewer.ts");
	agentsView = await import("../../pi/extensions/fleet/agents-view.ts");
});

// Same class names as the package: the tracker recognises views by constructor name.
class StatusDialog {
	navigation = { fullscreen: true };
	state: { selectedPath: string };
	enter: (path: string) => void;
	service: { list(): { path: string }[] } | undefined;
	constructor(selected: string, agents: string[], enter: (path: string) => void, changed = false) {
		this.state = { selectedPath: selected };
		this.enter = enter;
		this.service = changed ? undefined : { list: () => agents.map((path) => ({ path })) };
	}
	handleInput(data: string): void {
		if (data === "\r") this.enter(this.state.selectedPath);
	}
	render(): string[] {
		return [];
	}
}
class LiveAgentView {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
	handleInput(): void {}
	render(): string[] {
		return [];
	}
}

/** A DialogSession-like overlay. */
class FakeSession {
	child: any;
	closed = false;
	onClose: () => void;
	constructor(onClose: () => void) {
		this.onClose = onClose;
	}
	getComponent() {
		return this.child;
	}
	mount(factory: () => any): Promise<unknown> {
		this.child = factory();
		return new Promise(() => {});
	}
	handleInput(data: string): void {
		this.child?.handleInput?.(data);
	}
	render(): string[] {
		return [];
	}
	close(): void {
		this.closed = true;
		this.onClose();
	}
	dispose(): void {}
}

/** One pi: subagent-viewer and fleet/agents-view share its event bus; `/agents tree P` is played here. */
function rig(opts: { agents?: string[]; changed?: boolean; tree?: boolean; command?: boolean } = {}) {
	const agents = opts.agents ?? ["/root/alpha", "/root/beta"];
	const handlers: Record<string, ((e: unknown, ctx: unknown) => unknown)[]> = {};
	const bus: Record<string, ((d: unknown) => void)[]> = {};
	const notes: string[] = [];
	const sent: string[] = [];
	let open: FakeSession | undefined;
	const ui: any = {
		notify: (m: string) => notes.push(m),
		// pi's ui.custom: mounts what the factory returns.
		custom(factory: (...args: unknown[]) => any) {
			open = factory({}, {}, {}, () => {});
			return Promise.resolve();
		},
	};
	// subagent-viewer wraps ui.custom only for calls from the package: a frame named after it.
	const packageCustom = new Function("ui", "factory", "return ui.custom(factory);\n//# sourceURL=/x/pi-subagent-manager/src/ui/status-ui.ts") as (ui: any, f: any) => Promise<void>;
	const runTree = (path: string) => {
		if (open) return; // the package's controller: already open → no-op
		void packageCustom(ui, () => {
			const s = new FakeSession(() => {
				if (open === s) open = undefined;
			});
			return s;
		});
		const s: any = open;
		if (opts.tree === false) return;
		const enter = (p: string) => (agents.includes(p) ? s.mount(() => new LiveAgentView(p)) : s.close());
		void Promise.resolve().then(() => s.mount(() => new StatusDialog(path, agents, enter, opts.changed)));
	};
	const pi: any = {
		on: (name: string, fn: any) => (handlers[name] ??= []).push(fn),
		events: {
			emit: (c: string, d: unknown) => bus[c]?.forEach((h) => h(d)),
			on: (c: string, h: any) => (bus[c] ??= []).push(h),
		},
		getCommands: () => (opts.command === false ? [] : [{ name: "agents", source: "extension" }]),
		sendUserMessage: (text: string) => {
			sent.push(text);
			const m = /^\/agents tree (\S+)$/.exec(text);
			if (m) runTree(m[1]!);
		},
	};
	return { pi, ui, notes, sent, handlers, current: () => open };
}

async function start(r: ReturnType<typeof rig>) {
	viewer.default(r.pi);
	agentsView.register(r.pi);
	fleetOf(r.pi).main = true;
	for (const h of r.handlers.session_start ?? []) await h({ reason: "startup" }, { hasUI: true, ui: r.ui });
	return async (type: string, message: Record<string, unknown> = {}) => (await fleetOf(r.pi).control.get(type)!({ type, ...message })) as Record<string, unknown>;
}

test("agents-view: Enter is fed once on the tree; already shown; another path closes the first", { skip }, async () => {
	const r = rig();
	const call = await start(r);
	let reply = await call("agents-view", { path: "/root/alpha" });
	assert.deepEqual(reply, { path: "/root/alpha", already: false });
	assert.deepEqual(r.sent, ["/agents tree /root/alpha"]);
	assert.equal(r.current()?.getComponent()?.constructor.name, "LiveAgentView");
	reply = await call("agents-view", { path: "/root/alpha" });
	assert.deepEqual(reply, { path: "/root/alpha", already: true });
	assert.equal(r.sent.length, 1);
	const first = r.current()!;
	reply = await call("agents-view", { path: "/root/beta" });
	assert.deepEqual(reply, { path: "/root/beta", already: false });
	assert.equal(first.closed, true);
	assert.equal(r.current()?.getComponent()?.path, "/root/beta");
});

test("agents-close: closes only an untouched deck-opened overlay", { skip }, async () => {
	const r = rig();
	const call = await start(r);
	assert.deepEqual(await call("agents-close"), { closed: false });
	await call("agents-view", { path: "/root/alpha" });
	const s = r.current()!;
	s.handleInput("x"); // a user key
	assert.deepEqual(await call("agents-close"), { closed: false });
	assert.equal(s.closed, false);
	await call("agents-view", { path: "/root/beta" });
	assert.equal(s.closed, true, "a new highlight closes the previous overlay");
	const t = r.current()!;
	assert.deepEqual(await call("agents-close"), { closed: true });
	assert.equal(t.closed, true);
});

test("agents-view: unknown path, missing package, changed internals, timeout", { skip }, async () => {
	let r = rig();
	let call = await start(r);
	let reply = await call("agents-view", { path: "/root/gone" });
	assert.deepEqual(reply, { ok: false, error: "unknown agent /root/gone" });
	assert.equal(r.current(), undefined, "the tree it opened is closed");

	await assert.rejects(call("agents-view", { path: "x y" }), /agent path/);

	r = rig({ command: false });
	call = await start(r);
	assert.deepEqual(await call("agents-view", { path: "/root/alpha" }), { ok: false, error: "agents tree unavailable" });
	assert.deepEqual(r.sent, [], "never sent as a prompt");

	r = rig({ changed: true });
	call = await start(r);
	assert.deepEqual(await call("agents-view", { path: "/root/alpha" }), { ok: false, error: "agents tree unavailable" });
	assert.equal(r.notes.length, 1);
	assert.match(r.notes[0]!, /agent tree changed/);
	assert.equal(r.current(), undefined, "the tree it opened is closed");

	r = rig({ tree: false });
	call = await start(r);
	const t0 = Date.now();
	assert.deepEqual(await call("agents-view", { path: "/root/alpha" }), { ok: false, error: "timeout" });
	assert.ok(Date.now() - t0 >= agentsView.AGENTS_VIEW_TIMEOUT_MS - 50);
});

test("a pi without a UI (subagent sessions) hands out no API and refuses agents-view", { skip }, async () => {
	const r = rig();
	viewer.default(r.pi);
	agentsView.register(r.pi);
	for (const h of r.handlers.session_start ?? []) await h({ reason: "startup" }, { hasUI: false, ui: r.ui });
	const request: { api?: unknown } = {};
	r.pi.events.emit(viewer.VIEWER_API_EVENT, request);
	assert.equal(request.api, undefined);
	const reply = await (fleetOf(r.pi).control.get("agents-view") as any)({ type: "agents-view", path: "/root/alpha" });
	assert.deepEqual(reply, { ok: false, error: "no UI" });
});
