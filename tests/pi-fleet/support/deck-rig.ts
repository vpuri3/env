// A throwaway pi deck for the phase-3 integration tests (deck-integration.test.ts, leader-tmux.test.ts):
// `tmux -L decktest-<pid>-p3-<n>` as the deck (never `default` or `pifleet`: the harness refuses them and
// everything runs with PI_FLEET_TMUX_GUARD=1), an optional outer server with a real client (the §11
// harness: `…-outer`, attached from a pane of `…-h`), temp HOME/state/runtime/agent/session dirs.
//
// Pool pis are REAL pis (fleet + vim-mode + a faux provider, PI_FLEET_PI_CMD); pool nvims load
// nvconf.pi_fleet (PI_FLEET_NVIM_CMD). The list process is the phase-1 server layer alone
// (deck.ts startDeckList, through a PI_FLEET_BIN wrapper for `pi-fleet deck`), so these tests do not
// depend on the list TUI; deck.sock is the contract.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killServers } from "./tmux-cleanup.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
export const repo = join(here, "../../..");
export const fleetDir = join(repo, "pi/extensions/fleet");
export const vimMode = join(repo, "pi/extensions/vim-mode.ts");
export const piCmd = process.env.PI_FLEET_TEST_PI ?? "pi";
const socketDir = `${process.env.TMUX_TMPDIR || "/tmp"}/tmux-${process.getuid?.() ?? 0}`;

function ok(cmd: string, args: string[]): boolean {
	return spawnSync(cmd, args, { stdio: "ignore", timeout: 20_000, env: { ...process.env, PI_CODING_AGENT_DIR: tmpdir() } }).status === 0;
}
export const haveTmux = ok("tmux", ["-V"]);
export const haveNvim = ok("nvim", ["--version"]);
export const havePi = ok(piCmd, ["--version"]);
export const realTmux = haveTmux ? execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim() : "tmux";
export const skipDeck = !haveTmux ? "tmux not installed" : !havePi ? "pi not on PATH" : !haveNvim ? "nvim not installed" : false;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 20_000, show?: () => string): Promise<T> {
	const end = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		try {
			const value = await probe();
			if (value !== undefined && value !== false) return value as T;
		} catch (error) {
			last = error;
		}
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? ` (${last})` : ""}${show ? `\n${show()}` : ""}`);
		await sleep(100);
	}
}

/** Refuse tmux without a throwaway socket. */
function guard(args: string[]): void {
	if ((args[0] !== "-L" && args[0] !== "-S") || !args[1] || ["default", "pifleet"].includes(basename(args[1]))) {
		throw new Error(`test harness refuses tmux without a throwaway socket: ${args.join(" ")}`);
	}
}

/**
 * The faux model: "please write FILE" → a `write` tool call putting "agent wrote" into FILE, else
 * "done". `/switch-to FILE` resumes like /resume's picker does (ctx.switchSession).
 */
const FAUX_EXT = `
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
export default function (pi) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const reply = async (context) => {
		faux.appendResponses([reply]);
		const last = context.messages.at(-1);
		const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b) => b.text ?? "").join("");
		const m = last?.role === "user" && /please write (\\S+)/.exec(text);
		if (m) return fauxAssistantMessage(fauxToolCall("write", { path: m[1], content: "agent wrote\\n" }), { stopReason: "toolUse" });
		return fauxAssistantMessage("done");
	};
	faux.setResponses([reply]);
	pi.registerProvider(faux.provider);
	pi.registerCommand("switch-to", { handler: async (args, ctx) => { await ctx.switchSession(args.trim()); } });
}
`;

/** nvconf/init.lua's paired check (as in nvim.test.ts). */
const PAIRED_LUA =
	"if (vim.env.PI_FLEET_SESSION or '') ~= '' and (vim.env.PI_FLEET_CTL_SOCK or '') ~= '' and (vim.env.NVIM or '') == '' then require('nvconf.pi_fleet').setup() end";

export interface DeckPaneRow {
	pane: string;
	where: string;
	role: string;
	session: string;
	peer: string;
	nvimSock: string;
	dead: boolean;
}

let serial = 0;

export class DeckRig {
	readonly root = mkdtempSync(join(tmpdir(), "pdk3-"));
	readonly label = `decktest-${process.pid}-p3-${++serial}`;
	readonly work = join(this.root, "work");
	readonly sessions = join(this.root, "sessions");
	readonly statusDir = join(this.root, "state", "status");
	readonly env: NodeJS.ProcessEnv;
	readonly servers = new Set<string>();
	/** The pi command line of a hand-started pi (same extensions as the pool pis). */
	readonly piArgv: string[];

	constructor() {
		for (const d of ["work", "home", "agent", "sessions", "bin", "xdg"]) mkdirSync(join(this.root, d), { recursive: true });
		const faux = join(this.root, "faux-ext.ts");
		writeFileSync(faux, FAUX_EXT);
		const init = join(this.root, "init.lua");
		writeFileSync(init, `vim.opt.rtp:prepend(${JSON.stringify(join(repo, "nvim"))})\n${PAIRED_LUA}\n`);
		// PI_FLEET_BIN: `deck` runs the server layer's list (no TUI); everything else is the real CLI.
		const bin = join(this.root, "bin", "pi-fleet");
		const list = `const d = await import(${JSON.stringify(join(fleetDir, "deck.ts"))}); const l = await d.startDeckList(); const stop = async () => { await l.close(); process.exit(0); }; process.on("SIGTERM", stop); process.on("SIGHUP", stop); setInterval(() => {}, 1 << 30);`;
		writeFileSync(bin, `#!/bin/sh\nif [ "$1" = deck ]; then exec ${JSON.stringify(process.execPath)} --input-type=module -e '${list}'; fi\nexec ${JSON.stringify(join(repo, "bin/pi-fleet"))} "$@"\n`);
		chmodSync(bin, 0o755);
		symlinkSync(join(repo, "bin/pi-deck-attach"), join(this.root, "bin", "pi-deck-attach"));
		this.piArgv = [piCmd, "-ne", "-e", fleetDir, "-e", vimMode, "-e", faux, "--offline", "--provider", "faux", "--model", "faux-1", "--session-dir", this.sessions, "-ns", "-np", "-nc"];
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: join(this.root, "home"),
			XDG_STATE_HOME: join(this.root, "xdg"),
			XDG_DATA_HOME: join(this.root, "xdg"),
			XDG_CACHE_HOME: join(this.root, "xdg"),
			PATH: `${join(repo, "bin")}:${process.env.PATH}`,
			PI_CODING_AGENT_DIR: join(this.root, "agent"),
			PI_FLEET_STATE_DIR: join(this.root, "state"),
			PI_FLEET_RUNTIME_DIR: join(this.root, "run"),
			PI_FLEET_BIN: bin,
			PI_FLEET_PI_CMD: this.piArgv.join(" "),
			PI_FLEET_NVIM_CMD: `nvim -n -u ${init}`,
			PI_FLEET_TMUX_GUARD: "1",
			PI_FLEET_DECK_SOCKET: this.label,
			PI_FLEET_DECK_START_WAIT_MS: "30000", // deck-start waits 3 s for the list; a loaded machine (parallel runs) needs more
			PI_OFFLINE: "1",
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
		};
		for (const k of ["TMUX", "TMUX_PANE", "PI_FLEET_SESSION", "PI_FLEET_TMUX_SOCKET", "PI_FLEET_DECK", "PI_FLEET_DECK_CONF", "PI_FLEET_CTL_SOCK", "PI_FLEET_PI_PANE", "NVIM"]) delete env[k];
		this.env = env;
		this.servers.add(this.label);
	}

	/** tmux on one of this rig's servers: the deck (default), or `<label>-<suffix>`. */
	tmux(args: string[], suffix = ""): string {
		const full = ["-L", suffix ? `${this.label}-${suffix}` : this.label, ...args];
		guard(full);
		this.servers.add(full[1]!);
		return execFileSync("tmux", full, { env: this.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");
	}
	tryTmux(args: string[], suffix = ""): string | undefined {
		try {
			return this.tmux(args, suffix);
		} catch {
			return undefined;
		}
	}
	cli(args: string[]): { code: number; out: string; err: string } {
		const r = spawnSync(join(repo, "bin/pi-fleet"), args, { env: this.env, encoding: "utf8", timeout: 30_000 });
		return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
	}
	start(): void {
		const r = this.cli(["deck-start"]);
		assert.equal(r.code, 0, r.err);
	}
	/** `open --deck` a new session in work/; resolves when its pi shows its editor. */
	async open(): Promise<{ id: string; pane: string }> {
		const r = this.cli(["open", "--deck", "--cwd", this.work, "--json"]);
		assert.equal(r.code, 0, r.err + r.out);
		const reply = JSON.parse(r.out);
		assert.equal(reply.ok, true, r.out);
		await this.ready(reply.pane);
		return { id: reply.session, pane: reply.pane };
	}
	panes(): DeckPaneRow[] {
		const out = this.tryTmux(["list-panes", "-a", "-F", "#{pane_id}\t#{session_name}:#{window_name}.#{pane_index}\t#{@pi_fleet_role}\t#{@pi_fleet_session}\t#{@pi_fleet_peer}\t#{@pi_fleet_nvim_sock}\t#{pane_dead}"]) ?? "";
		return out
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const f = l.split("\t");
				return { pane: f[0]!, where: f[1]!, role: f[2]!, session: f[3]!, peer: f[4]!, nvimSock: f[5]!, dead: f[6] === "1" };
			});
	}
	slot(): DeckPaneRow | undefined {
		return this.panes().find((p) => p.where === "deck:deck.3");
	}
	/** The terminal slot (bottom-left). */
	termSlot(): DeckPaneRow | undefined {
		return this.panes().find((p) => p.where === "deck:deck.2");
	}
	/** The nvim slot (below the list). */
	nvimSlot(): DeckPaneRow | undefined {
		return this.panes().find((p) => p.where === "deck:deck.1");
	}
	activeIndex(): string {
		return this.tmux(["display-message", "-p", "-t", "=deck:=deck", "#{pane_index}"]);
	}
	clients(): string[] {
		return (this.tryTmux(["list-clients", "-F", "#{client_name}"]) ?? "").split("\n").filter(Boolean);
	}
	screen(pane: string, suffix = ""): string {
		return this.tryTmux(["capture-pane", "-p", "-J", "-t", pane], suffix) ?? "";
	}
	status(id: string): any {
		try {
			return JSON.parse(readFileSync(join(this.statusDir, `${id}.json`), "utf8"));
		} catch {
			return undefined;
		}
	}
	/** A pi (vim-mode) is ready when it shows its INSERT mode line. */
	async ready(pane: string, suffix = ""): Promise<void> {
		await waitFor(`pi in ${pane} to start`, () => / INSERT\s*$/m.test(this.screen(pane, suffix)), 60_000, () => this.screen(pane, suffix));
		await sleep(300);
	}
	/** pi's prompt editor: the text between its two borders (the last two `─` rules), or undefined. */
	editor(pane: string, suffix = ""): string | undefined {
		const lines = this.screen(pane, suffix).split("\n");
		const rules = lines.map((l, i) => (/^─{10}/.test(l) ? i : -1)).filter((i) => i >= 0);
		if (rules.length < 2) return undefined;
		const [top, bottom] = rules.slice(-2) as [number, number];
		return lines.slice(top + 1, bottom).map((l) => l.trim()).filter(Boolean).join("\n");
	}
	/**
	 * Type a line into a pi and press Enter. The first Enter may only accept an autocomplete
	 * suggestion; Enter again while the editor still holds the line.
	 */
	async type(pane: string, text: string, suffix = ""): Promise<void> {
		// Compared without whitespace: a long line wraps in the editor.
		const flat = (s: string | undefined) => s?.replace(/\s+/g, "") ?? "";
		const holds = () => flat(this.editor(pane, suffix)).includes(flat(text));
		this.tmux(["send-keys", "-t", pane, "-l", text], suffix);
		await waitFor(`"${text}" in the editor`, holds, 10_000, () => this.screen(pane, suffix));
		for (let i = 0; i < 3; i++) {
			this.tmux(["send-keys", "-t", pane, "Enter"], suffix);
			await sleep(600);
			if (!holds()) return;
		}
	}
	async keys(pane: string, keys: string[], suffix = ""): Promise<void> {
		for (const k of keys) {
			this.tmux(["send-keys", "-t", pane, k], suffix);
			await sleep(150);
		}
	}
	/** A stored session file (header + one user message), for /resume. */
	sessionFile(id: string): string {
		const dir = join(this.sessions, "x");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
		const ts = new Date().toISOString();
		writeFileSync(
			file,
			[
				{ type: "session", version: 3, id, timestamp: ts, cwd: this.work },
				{ type: "message", id: "a1", parentId: null, timestamp: ts, message: { role: "user", content: "hi", timestamp: Date.now() } },
			].map((e) => JSON.stringify(e)).join("\n") + "\n",
		);
		return file;
	}

	/**
	 * The §11 harness: an outer server (prefix C-s) whose `main` session a real client shows, run from a
	 * pane of the harness server, so display-popup has a client. Returns the outer socket and client.
	 */
	async harness(): Promise<{ outerSocket: string; outerClient: string }> {
		const conf = join(this.root, "outer.conf");
		writeFileSync(conf, ["set -g prefix C-s", "unbind C-b", "set -s escape-time 0", "set -g status off"].join("\n"));
		this.tmux(["-f", conf, "new-session", "-d", "-s", "main", "-x", "160", "-y", "48", "/bin/sh"], "outer");
		const outerSocket = this.tmux(["display-message", "-p", "#{socket_path}"], "outer");
		this.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "h", "-x", "160", "-y", "48", `env -u TMUX ${realTmux} -L ${this.label}-outer attach -t main`], "h");
		const outerClient = await waitFor("the outer client", () => this.tmux(["list-clients", "-F", "#{client_name}"], "outer") || undefined);
		await sleep(300);
		return { outerSocket, outerClient };
	}

	close(): void {
		killServers(this.servers, { tmux: "tmux", env: this.env, socketDir });
		this.servers.clear();
		rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

