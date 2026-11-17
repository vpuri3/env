/**
 * fleet/protocol: message schema on the control socket <id>.pi.sock (§10, §11).
 *
 * One JSON object per line (NDJSON), at most CONTROL_MAX_LINE bytes per line. control.ts
 * (phase 3) owns the socket server and dispatches on `type`; nvim.ts registers the
 * USER_EDIT handler; edits.ts (phase 7) owns the delivery policy.
 *
 * Senders:
 *   - nvim/lua/nvconf/pi_fleet.lua: `user_edit` after `:w!` (mode "note") or `:w!!` (mode "steer").
 *   - the dashboard: `ping`, `kill`.
 *
 * Pure types and validators only: no state, no imports with side effects.
 */

export const CONTROL_MAX_LINE = 64 * 1024;

export const USER_EDIT = "user_edit";

/** `note` = `:w!` (goes with the next message), `steer` = `:w!!` (interrupts now). */
export type UserEditMode = "note" | "steer";

export interface UserEditMessage {
	type: typeof USER_EDIT;
	v: 1;
	mode: UserEditMode;
	/** Absolute path of the written file (resolved by nvim). */
	path: string;
	/**
	 * Unified diff (vim.text.diff, no file header), old disk text → new text. nvim does not send
	 * unchanged writes. `truncated && diff === ""` means the file was too large to diff (over
	 * 4 MiB before or after the write) or no diff could be built: the change is unknown, read
	 * the file.
	 */
	diff: string;
	/** Lines added / removed in `diff`. */
	added: number;
	removed: number;
	/** True when the file did not exist before this write. */
	created: boolean;
	/**
	 * True when `diff` was cut in nvim (48 KiB, then further to fit CONTROL_MAX_LINE; the line
	 * cap of 120 is edits.ts's job), or is "" because the file was too large (see `diff`).
	 */
	truncated: boolean;
	/** $PI_FLEET_SESSION of the sending nvim; receivers may drop messages for another session. */
	session: string;
	/** Unix time in ms when nvim wrote the file. */
	time: number;
}

export interface PingMessage {
	type: "ping";
}

export interface KillMessage {
	type: "kill";
}

export type ControlMessage = UserEditMessage | PingMessage | KillMessage;

/**
 * One-line reply written back by the socket server for every line. nvim (pi_fleet.lua
 * M.send) reads it within its 1 s budget and warns with `error` on ok:false.
 */
export interface ControlReply {
	ok: boolean;
	error?: string;
}

/** Validate an already-parsed JSON value as a UserEditMessage; returns undefined if malformed. */
export function parseUserEdit(value: unknown): UserEditMessage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const m = value as Record<string, unknown>;
	if (m.type !== USER_EDIT) return undefined;
	if (m.mode !== "note" && m.mode !== "steer") return undefined;
	if (typeof m.path !== "string" || !m.path.startsWith("/")) return undefined;
	if (typeof m.diff !== "string") return undefined;
	const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
	return {
		type: USER_EDIT,
		v: 1,
		mode: m.mode,
		path: m.path,
		diff: m.diff,
		added: num(m.added),
		removed: num(m.removed),
		created: m.created === true,
		truncated: m.truncated === true,
		session: typeof m.session === "string" ? m.session : "",
		time: num(m.time) || Date.now(),
	};
}

/**
 * Calls from pi into the paired nvim (nvim.ts → pi_fleet.lua). Each is a Lua function on
 * require("nvconf.pi_fleet"), invoked over nvim's msgpack-RPC `nvim_exec_lua` with the
 * argument passed as data (never spliced into code).
 */
export type NvimCall =
	| { fn: "agent_changed"; arg: string[] }
	| { fn: "checktime_all"; arg: null };
