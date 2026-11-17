/**
 * fleet/nvim: the bridge between this pi and its paired nvim (design §11, phase 5).
 *
 * pi → nvim: after a successful `edit`/`write` tool call, call
 *   require("nvconf.pi_fleet").agent_changed({path}) in the paired nvim, and on
 *   every agent_settled checktime_all() (edits made through bash or by subagents). Calls go over the nvim's
 *   --listen socket as msgpack-RPC `nvim_exec_lua` requests; the function name and paths
 *   travel as RPC arguments (data), never spliced into code or a shell string.
 *   If the nvim is gone (no socket / refused) and this is a TUI pi in tmux, the next agent edit
 *   re-pairs (`pairPane`, as `pi-fleet pair` does; §13) and the status file gets the new
 *   nvimPane/nvimSock. This module is also the only one that pairs at session start (§7):
 *   TUI mode only (never RPC/print/json), and only when no live peer exists.
 *
 * nvim → pi: the lua side sends `user_edit` lines (protocol.ts) to the control socket owned
 *   by control.ts (phase 3). This module registers the handler on control's registry
 *   (fleetOf(pi).control.on, if present), validates the message and re-emits it on
 *   pi.events as USER_EDIT_EVENT for edits.ts (phase 7, delivery policy).
 *
 * Exports for other modules (stateless): resolveNvim, nvimRequest, nvimCall.
 * No module-level mutable state: everything per session lives in register()'s closure.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { inTmux, livePeer, nvimSockPath, pairPane } from "./cli.ts";
import { parseUserEdit, USER_EDIT, type NvimCall, type UserEditMessage } from "./protocol.ts";
import { fleetOf } from "./shared.ts";

/** pi.events channel carrying validated UserEditMessage objects (consumed by edits.ts). */
export const USER_EDIT_EVENT = "pi-fleet:user-edit";

const RPC_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------- msgpack (subset)

function encode(value: unknown, out: Buffer[]): void {
	if (value === null || value === undefined) {
		out.push(Buffer.from([0xc0]));
	} else if (value === true || value === false) {
		out.push(Buffer.from([value ? 0xc3 : 0xc2]));
	} else if (typeof value === "number") {
		if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
			if (value < 0x80) out.push(Buffer.from([value]));
			else if (value <= 0xff) out.push(Buffer.from([0xcc, value]));
			else if (value <= 0xffff) out.push(Buffer.from([0xcd, value >> 8, value & 0xff]));
			else {
				const b = Buffer.alloc(5);
				b[0] = 0xce;
				b.writeUInt32BE(value, 1);
				out.push(b);
			}
		} else if (Number.isInteger(value) && value < 0 && value >= -0x80000000) {
			if (value >= -32) out.push(Buffer.from([value & 0xff]));
			else {
				const b = Buffer.alloc(5);
				b[0] = 0xd2;
				b.writeInt32BE(value, 1);
				out.push(b);
			}
		} else {
			const b = Buffer.alloc(9);
			b[0] = 0xcb;
			b.writeDoubleBE(value, 1);
			out.push(b);
		}
	} else if (typeof value === "string") {
		const s = Buffer.from(value, "utf8");
		const n = s.length;
		if (n < 32) out.push(Buffer.from([0xa0 | n]));
		else if (n <= 0xff) out.push(Buffer.from([0xd9, n]));
		else if (n <= 0xffff) out.push(Buffer.from([0xda, n >> 8, n & 0xff]));
		else {
			const b = Buffer.alloc(5);
			b[0] = 0xdb;
			b.writeUInt32BE(n, 1);
			out.push(b);
		}
		out.push(s);
	} else if (Array.isArray(value)) {
		const n = value.length;
		if (n < 16) out.push(Buffer.from([0x90 | n]));
		else if (n <= 0xffff) out.push(Buffer.from([0xdc, n >> 8, n & 0xff]));
		else {
			const b = Buffer.alloc(5);
			b[0] = 0xdd;
			b.writeUInt32BE(n, 1);
			out.push(b);
		}
		for (const v of value) encode(v, out);
	} else if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
		const n = entries.length;
		if (n < 16) out.push(Buffer.from([0x80 | n]));
		else if (n <= 0xffff) out.push(Buffer.from([0xde, n >> 8, n & 0xff]));
		else {
			const b = Buffer.alloc(5);
			b[0] = 0xdf;
			b.writeUInt32BE(n, 1);
			out.push(b);
		}
		for (const [k, v] of entries) {
			encode(k, out);
			encode(v, out);
		}
	} else {
		throw new Error(`msgpack: cannot encode ${typeof value}`);
	}
}

export function msgpackEncode(value: unknown): Buffer {
	const out: Buffer[] = [];
	encode(value, out);
	return Buffer.concat(out);
}

class Incomplete extends Error {}

/** Decode one value at `pos`; throws Incomplete if the buffer ends early. ext types → {ext, data}. */
function decodeAt(buf: Buffer, pos: number): [unknown, number] {
	const need = (n: number) => {
		if (pos + n > buf.length) throw new Incomplete();
	};
	need(1);
	const t = buf[pos++];
	const seq = (n: number, isMap: boolean): [unknown, number] => {
		if (isMap) {
			const obj: Record<string, unknown> = {};
			for (let i = 0; i < n; i++) {
				const [k, p1] = decodeAt(buf, pos);
				const [v, p2] = decodeAt(buf, p1);
				obj[String(k)] = v;
				pos = p2;
			}
			return [obj, pos];
		}
		const arr: unknown[] = [];
		for (let i = 0; i < n; i++) {
			const [v, p] = decodeAt(buf, pos);
			arr.push(v);
			pos = p;
		}
		return [arr, pos];
	};
	const bytes = (n: number): Buffer => {
		need(n);
		const b = buf.subarray(pos, pos + n);
		pos += n;
		return b;
	};
	const ext = (n: number): [unknown, number] => {
		need(1);
		const type = buf.readInt8(pos++);
		return [{ ext: type, data: Buffer.from(bytes(n)) }, pos];
	};
	if (t < 0x80) return [t, pos];
	if (t >= 0xe0) return [t - 0x100, pos];
	if ((t & 0xf0) === 0x80) return seq(t & 0x0f, true);
	if ((t & 0xf0) === 0x90) return seq(t & 0x0f, false);
	if ((t & 0xe0) === 0xa0) return [bytes(t & 0x1f).toString("utf8"), pos];
	switch (t) {
		case 0xc0:
			return [null, pos];
		case 0xc2:
			return [false, pos];
		case 0xc3:
			return [true, pos];
		case 0xc4:
			need(1);
			return [Buffer.from(bytes(buf[pos++])), pos];
		case 0xc5:
			need(2);
			pos += 2;
			return [Buffer.from(bytes(buf.readUInt16BE(pos - 2))), pos];
		case 0xc6:
			need(4);
			pos += 4;
			return [Buffer.from(bytes(buf.readUInt32BE(pos - 4))), pos];
		case 0xc7:
			need(1);
			return ext(buf[pos++]);
		case 0xc8:
			need(2);
			pos += 2;
			return ext(buf.readUInt16BE(pos - 2));
		case 0xc9:
			need(4);
			pos += 4;
			return ext(buf.readUInt32BE(pos - 4));
		case 0xca:
			return [bytes(4).readFloatBE(0), pos];
		case 0xcb:
			return [bytes(8).readDoubleBE(0), pos];
		case 0xcc:
			return [bytes(1)[0], pos];
		case 0xcd:
			return [bytes(2).readUInt16BE(0), pos];
		case 0xce:
			return [bytes(4).readUInt32BE(0), pos];
		case 0xcf:
			return [Number(bytes(8).readBigUInt64BE(0)), pos];
		case 0xd0:
			return [bytes(1).readInt8(0), pos];
		case 0xd1:
			return [bytes(2).readInt16BE(0), pos];
		case 0xd2:
			return [bytes(4).readInt32BE(0), pos];
		case 0xd3:
			return [Number(bytes(8).readBigInt64BE(0)), pos];
		case 0xd4:
			return ext(1);
		case 0xd5:
			return ext(2);
		case 0xd6:
			return ext(4);
		case 0xd7:
			return ext(8);
		case 0xd8:
			return ext(16);
		case 0xd9:
			return [bytes(bytes(1)[0]).toString("utf8"), pos];
		case 0xda:
			return [bytes(bytes(2).readUInt16BE(0)).toString("utf8"), pos];
		case 0xdb:
			return [bytes(bytes(4).readUInt32BE(0)).toString("utf8"), pos];
		case 0xdc:
			return seq(bytes(2).readUInt16BE(0), false);
		case 0xdd:
			return seq(bytes(4).readUInt32BE(0), false);
		case 0xde:
			return seq(bytes(2).readUInt16BE(0), true);
		case 0xdf:
			return seq(bytes(4).readUInt32BE(0), true);
		default:
			throw new Error(`msgpack: bad type byte 0x${t.toString(16)}`);
	}
}

/** Decode one complete value from the start of `buf`: [value, bytesUsed], or undefined if incomplete. */
export function msgpackDecode(buf: Buffer): [unknown, number] | undefined {
	try {
		return decodeAt(buf, 0);
	} catch (error) {
		if (error instanceof Incomplete) return undefined;
		throw error;
	}
}

// ---------------------------------------------------------------- RPC

export class NvimUnreachable extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * One msgpack-RPC request to an nvim --listen socket (one connection per call).
 * Rejects with NvimUnreachable when the socket is missing/refused/timed out, and with a
 * plain Error carrying nvim's message when the call itself failed.
 */
export function nvimRequest(
	sock: string,
	method: string,
	params: unknown[],
	timeoutMs = RPC_TIMEOUT_MS,
): Promise<unknown> {
	return new Promise((resolvePromise, reject) => {
		const msgid = 1;
		let buf = Buffer.alloc(0);
		let settled = false;
		const conn = createConnection(sock);
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			conn.destroy();
			fn();
		};
		const timer = setTimeout(
			() => finish(() => reject(new NvimUnreachable("ETIMEDOUT", `nvim at ${sock}: no answer in ${timeoutMs} ms`))),
			timeoutMs,
		);
		timer.unref?.();
		conn.on("error", (error: NodeJS.ErrnoException) =>
			finish(() => reject(new NvimUnreachable(error.code || "EIO", `nvim at ${sock}: ${error.message}`))),
		);
		conn.on("close", () =>
			finish(() => reject(new NvimUnreachable("ECONNRESET", `nvim at ${sock} closed the connection`))),
		);
		conn.on("connect", () => conn.write(msgpackEncode([0, msgid, method, params])));
		conn.on("data", (chunk: Buffer) => {
			buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
			for (;;) {
				let decoded: [unknown, number] | undefined;
				try {
					decoded = msgpackDecode(buf);
				} catch (error) {
					return finish(() => reject(error as Error));
				}
				if (!decoded) return;
				buf = buf.subarray(decoded[1]);
				const msg = decoded[0];
				// Only our response matters: [1, msgid, error, result]. Skip notifications.
				if (Array.isArray(msg) && msg[0] === 1 && msg[1] === msgid) {
					const err = msg[2];
					if (err !== null && err !== undefined) {
						const text = Array.isArray(err) ? String(err[1]) : String(err);
						return finish(() => reject(new Error(`nvim: ${text}`)));
					}
					return finish(() => resolvePromise(msg[3]));
				}
			}
		});
	});
}

/** Lua run by nvimCall: the function name and argument arrive as `...` (data, not code). */
const CALL_LUA = [
	"local fn, arg = ...",
	"local ok, m = pcall(require, 'nvconf.pi_fleet')",
	"if not ok or type(m) ~= 'table' or type(m[fn]) ~= 'function' then return vim.NIL end",
	"return m[fn](arg)",
].join("\n");

/** Call require("nvconf.pi_fleet")[fn](arg) in the nvim at `sock`. */
export function nvimCall(sock: string, call: NvimCall, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
	return nvimRequest(sock, "nvim_exec_lua", [CALL_LUA, [call.fn, call.arg]], timeoutMs);
}

// ---------------------------------------------------------------- peer

export interface NvimPeer {
	/** tmux pane id of the nvim, when paired in tmux. */
	pane?: string;
	sock: string;
}

function isSocket(path: string): boolean {
	try {
		return lstatSync(path).isSocket();
	} catch {
		return false;
	}
}

/**
 * Find this pi's nvim: in tmux, the live @pi_fleet_peer of $TMUX_PANE and its
 * @pi_fleet_nvim_sock; otherwise (or without a sock option) <runtime>/<id>.nvim.sock if a
 * socket is there. Undefined when there is none.
 */
export async function resolveNvim(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<NvimPeer | undefined> {
	const pane = env.TMUX_PANE;
	if (pane && inTmux(env)) {
		const peer = await livePeer(pane, env).catch(() => undefined);
		if (peer?.role === "nvim") return { pane: peer.pane, sock: peer.nvimSock || nvimSockPath(sessionId, env) };
		return undefined;
	}
	if (!sessionId) return undefined;
	let sock: string;
	try {
		sock = nvimSockPath(sessionId, env);
	} catch {
		return undefined;
	}
	return isSocket(sock) ? { sock } : undefined;
}

/** Absolute path of a tool's `path` argument (pi strips a leading @ and expands ~). */
export function toolPath(raw: unknown, cwd: string): string | undefined {
	if (typeof raw !== "string" || !raw) return undefined;
	let p = raw.startsWith("@") ? raw.slice(1) : raw;
	if (p === "~" || p.startsWith("~/")) p = homedir() + p.slice(1);
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

// ---------------------------------------------------------------- user_edit

/**
 * Handler for `user_edit` lines from the control socket. Validates and forwards to edits.ts
 * via pi.events (USER_EDIT_EVENT). Phase 7 owns what happens next (§11 delivery table).
 * Returns false for messages it drops.
 */
export function handleUserEdit(pi: ExtensionAPI, raw: unknown, sessionId: string | undefined): boolean {
	if (!fleetOf(pi).main) return false;
	const msg: UserEditMessage | undefined = parseUserEdit(raw);
	if (!msg) return false;
	if (msg.session && sessionId && msg.session !== sessionId) return false;
	pi.events.emit(USER_EDIT_EVENT, msg);
	return true;
}

/** Structural view of shared.ts's ControlRegistry (phase 3), so this module works before and after it. */
interface ControlRegistry {
	on(type: string, handler: (msg: Record<string, unknown>) => unknown): unknown;
}

// ---------------------------------------------------------------- register

export function register(pi: ExtensionAPI): void {
	const shared = fleetOf(pi);
	let sessionId = "";
	let cwd = process.cwd();
	let tui = false;
	let peer: NvimPeer | undefined;
	let pairing: Promise<NvimPeer | undefined> | undefined;
	let generation = 0;
	let registeredWith: unknown;

	const registerControl = () => {
		const control = (shared as unknown as { control?: ControlRegistry }).control;
		if (!control || typeof control.on !== "function" || control === registeredWith) return;
		registeredWith = control;
		// control.ts replies {"ok":true} on return and {"ok":false,error} on a throw.
		control.on(USER_EDIT, (msg) => {
			if (!handleUserEdit(pi, msg, sessionId)) throw new Error("user_edit dropped: malformed, other session, or not a main session");
			return undefined;
		});
	};

	const patchStatus = (p: NvimPeer) => {
		const status = shared.status;
		if (!status) return;
		const cur = status.current();
		const fields: Record<string, unknown> = {};
		if (cur?.nvimSock !== p.sock) fields.nvimSock = p.sock;
		if (p.pane && cur?.tmux && cur.tmux.nvimPane !== p.pane) fields.tmux = { ...cur.tmux, nvimPane: p.pane };
		if (Object.keys(fields).length) status.patch(fields);
	};

	/** The peer, re-resolved; with `repair`, pair a new nvim when in tmux and none is alive. */
	const findPeer = async (repair: boolean): Promise<NvimPeer | undefined> => {
		const gen = generation;
		const found = await resolveNvim(sessionId);
		if (gen !== generation) return undefined;
		if (found) {
			peer = found;
			patchStatus(found);
			return found;
		}
		peer = undefined;
		const pane = process.env.TMUX_PANE;
		if (!repair || !tui || !pane || !inTmux() || !sessionId) return undefined;
		pairing ??= pairPane(pane, { session: sessionId, cwd })
			.then((r) => {
				if (gen !== generation) return undefined;
				peer = { pane: r.nvimPane, sock: r.nvimSock };
				patchStatus(peer);
				return peer;
			})
			.catch(() => undefined)
			.finally(() => {
				pairing = undefined;
			});
		return pairing;
	};

	/** Call into the nvim; on an unreachable socket re-resolve once, re-pairing if `repair`. */
	const call = async (c: NvimCall, repair: boolean): Promise<void> => {
		if (!shared.main) return;
		const gen = generation;
		const target = peer ?? (await findPeer(repair));
		if (!target || gen !== generation) return;
		try {
			await nvimCall(target.sock, c);
		} catch (error) {
			if (!(error instanceof NvimUnreachable) || gen !== generation) return;
			if (error.code === "ETIMEDOUT") return; // busy nvim: keep it, skip this reload
			const again = await findPeer(repair);
			// A freshly paired nvim reads files from disk anyway; only retry an existing one.
			if (again && again.sock !== target.sock && !pairing) await nvimCall(again.sock, c).catch(() => {});
		}
	};

	registerControl();

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		generation++;
		peer = undefined;
		pairing = undefined;
		registerControl();
		if (!shared.main) return;
		sessionId = ctx.sessionManager.getSessionId();
		cwd = ctx.cwd;
		tui = (ctx as { mode?: string }).mode === "tui";
		// §7: a TUI pi in tmux without a live nvim peer gets one now (this module is the only
		// one that pairs at session start). Never in RPC/print/json mode. Idempotent:
		// pairPane returns the live peer instead of splitting again, and `pairing` dedupes.
		void findPeer(tui);
	});

	pi.on("session_shutdown", async () => {
		generation++;
		peer = undefined;
		pairing = undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!shared.main || event.isError) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const path = toolPath((event.input as { path?: unknown } | undefined)?.path, ctx.cwd);
		if (!path) return;
		// Never delay the tool result: fire and forget.
		void call({ fn: "agent_changed", arg: [path] }, true).catch(() => {});
	});

	// Edits made through bash (or by subagents) show up when the run settles.
	pi.on("agent_settled", async () => {
		if (!shared.main) return;
		// Never pairs: only an agent edit brings a dead nvim back (§13).
		void call({ fn: "checktime_all", arg: null }, false).catch(() => {});
	});
}
