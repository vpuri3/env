/**
 * fleet/control: the control socket <runtime dir>/<sessionId>.pi.sock of a main session (§10, §13).
 *
 * A generic NDJSON dispatcher: each line is one JSON object, dispatched on its `type` (`cmd` is
 * accepted as an alias) to the handler registered with `fleetOf(pi).control.on(type, fn)`
 * (shared.ts). Every line gets a one-line reply: `{"ok":true,...}` merged with the handler's
 * returned object, or `{"ok":false,"error"}`. Built in: `ping` → `{ok,pid,host,sessionId}`.
 * lifecycle.ts registers `kill`; nvim.ts/edits.ts register `user_edit` (schema: protocol.ts).
 *
 * Hygiene (adapted from agent-deck's wake socket, see below):
 *   - The runtime dir comes from cli.ts runtimeDir(): 0700, lstat-checked (no symlink, ours).
 *   - Bind at a private path in that dir, chmod 0600, then rename over the public path, so a
 *     client never sees a half-set-up socket; the last starter wins.
 *   - Only the owner unlinks: on shutdown the public path is removed only if it is still the
 *     inode we bound.
 *   - A line longer than 64 KB (CONTROL_MAX_LINE) closes the connection; so does 2 s idle.
 *   - Not bound while lifecycle.ts's duplicate guard sees another live pi on this session:
 *     that pi keeps its socket.
 * Main sessions only (fleetOf(pi).main); subagent sessions in the same process bind nothing.
 *
 * Portions adapted from agent-deck (github.com/asheshgoplani/agent-deck, MIT, commit 80494e5):
 * the socket hygiene of the wake socket in internal/session/assets/pi/agent-deck.ts.
 * See THIRD_PARTY_LICENSES.
 */

import { chmodSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ctlSockPath } from "./cli.ts";
import { CONTROL_MAX_LINE } from "./protocol.ts";
import { fleetOf, type FleetShared } from "./shared.ts";
import { liveness } from "./status.ts";

export const MAX_LINE = CONTROL_MAX_LINE;
export const IDLE_MS = 2000;

/**
 * The live pi that already runs this session (another pid on this host, or another host with
 * a fresh heartbeat), from the status file status.ts found at session_start.
 */
export function duplicateOf(shared: FleetShared): FleetShared["prior"] {
	const prior = shared.prior;
	if (!prior) return undefined;
	const live = liveness(prior);
	return live === "live" || live === "remote" ? prior : undefined;
}

/** Dispatch one parsed message to the registry; never throws. */
export async function dispatch(shared: FleetShared, message: unknown, self: () => Record<string, unknown>): Promise<Record<string, unknown>> {
	if (!message || typeof message !== "object" || Array.isArray(message)) return { ok: false, error: "not a JSON object" };
	const m = message as Record<string, unknown>;
	const type = typeof m.type === "string" ? m.type : typeof m.cmd === "string" ? m.cmd : undefined;
	if (!type) return { ok: false, error: "missing type" };
	if (type === "ping") return { ok: true, ...self() };
	const handler = shared.control.get(type);
	if (!handler) return { ok: false, error: `unknown type ${type}` };
	try {
		const result = await handler(m);
		return result && typeof result === "object" && !Array.isArray(result) ? { ok: true, ...(result as object) } : { ok: true };
	} catch (error) {
		return { ok: false, error: (error as Error)?.message ?? String(error) };
	}
}

function serve(sock: Socket, shared: FleetShared, self: () => Record<string, unknown>): void {
	let buf = "";
	let chain: Promise<void> = Promise.resolve();
	sock.setEncoding("utf8");
	sock.setTimeout(IDLE_MS, () => sock.destroy());
	sock.on("error", () => sock.destroy());
	const reply = (obj: Record<string, unknown>) => {
		if (!sock.destroyed) sock.write(`${JSON.stringify(obj)}\n`);
	};
	// A client may send its last line without "\n" and close (end) right away.
	sock.on("end", () => {
		const line = buf.trim();
		buf = "";
		if (line && Buffer.byteLength(line) <= MAX_LINE) {
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			chain = chain.then(async () => {
				reply(await dispatch(shared, message, self));
			});
		}
		void chain.then(() => sock.end());
	});
	sock.on("data", (chunk: string) => {
		buf += chunk;
		for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (Buffer.byteLength(line) > MAX_LINE) {
				reply({ ok: false, error: "line too long" });
				sock.end();
				return;
			}
			if (!line.trim()) continue;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				chain = chain.then(() => reply({ ok: false, error: "bad JSON" }));
				continue;
			}
			// Replies keep the order of the requests.
			chain = chain.then(async () => reply(await dispatch(shared, message, self)));
		}
		if (Buffer.byteLength(buf) > MAX_LINE) {
			reply({ ok: false, error: "line too long" });
			sock.end();
			buf = "";
		}
	});
}

function inode(path: string): string | undefined {
	try {
		const st = lstatSync(path);
		return st.isSocket() ? `${st.dev}:${st.ino}` : undefined;
	} catch {
		return undefined;
	}
}

export function register(pi: ExtensionAPI): void {
	const shared = fleetOf(pi);
	let server: Server | undefined;
	let publicPath: string | undefined;
	let boundInode: string | undefined;
	let generation = 0;

	const close = () => {
		generation++;
		const s = server;
		const path = publicPath;
		const ino = boundInode;
		server = undefined;
		publicPath = boundInode = undefined;
		if (!s) return;
		s.close();
		// Only the owner unlinks: a later starter may have renamed its socket over ours.
		if (path && ino && inode(path) === ino) {
			try {
				unlinkSync(path);
			} catch {
				// gone
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		close();
		if (!shared.main || duplicateOf(shared)) return;
		const sessionId = ctx.sessionManager.getSessionId();
		let path: string;
		try {
			path = ctlSockPath(sessionId);
		} catch {
			return;
		}
		const tmp = join(dirname(path), `.${sessionId}.${process.pid}.${Date.now()}.sock`);
		const self = () => ({ pid: process.pid, host: hostname(), sessionId });
		const s = createServer({ allowHalfOpen: true }, (sock) => serve(sock, shared, self));
		s.on("error", () => {});
		const gen = ++generation;
		const ok = await new Promise<boolean>((res) => {
			s.once("error", () => res(false));
			s.listen(tmp, () => res(true));
		});
		if (!ok || gen !== generation || !shared.main) {
			s.close();
			try {
				unlinkSync(tmp);
			} catch {
				// not created
			}
			return;
		}
		try {
			chmodSync(tmp, 0o600);
			renameSync(tmp, path);
		} catch {
			s.close();
			try {
				unlinkSync(tmp);
			} catch {
				// gone
			}
			return;
		}
		s.unref();
		server = s;
		publicPath = path;
		boundInode = inode(path);
		shared.status?.patch({ ctlSock: path });
	});

	pi.on("session_shutdown", async () => close());
}
