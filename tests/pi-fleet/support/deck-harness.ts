// Throwaway deck servers for the deck-view tmux tests (the same rules as deck.test.ts): every server is
// `tmux -L decktest-v<pid>-<n>[-suffix]`, the harness refuses `default` and `pifleet`, the CLI runs with
// PI_FLEET_TMUX_GUARD=1, and close() kills every server and removes its socket file. pi is the node stub
// support/deck-stub-pi.mjs; sessions, status, cache and runtime dirs live in one temp dir.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killServers } from "./tmux-cleanup.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
export const repo = join(here, "../..");
export const cliBin = join(repo, "bin/pi-fleet");
const stubPi = join(here, "support/deck-stub-pi.mjs");
export const socketDir = `${process.env.TMUX_TMPDIR || "/tmp"}/tmux-${process.getuid?.() ?? 0}`;
export const haveTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
export const realTmux = haveTmux ? execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim() : "tmux";

export function guardTmuxArgs(args: string[]): void {
	const flag = args[0];
	const name = args[1];
	if ((flag !== "-L" && flag !== "-S") || !name || ["default", "pifleet"].includes(basename(name))) {
		throw new Error(`test harness refuses tmux without a throwaway socket: ${args.join(" ")}`);
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 10_000, everyMs = 50): Promise<T> {
	const end = Date.now() + timeoutMs;
	let last: unknown;
	for (;;) {
		let value: T | undefined | false;
		try {
			value = probe();
		} catch (e) {
			value = undefined;
			last = `threw ${(e as Error)?.message ?? e}`;
		}
		if (value === undefined || value === false) last = value === undefined && typeof last === "string" ? last : value;
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (last observed: ${String(last)})`);
		await sleep(everyMs);
	}
}

export interface Pane {
	pane: string;
	where: string;
	role: string;
	session: string;
	dead: boolean;
	tty: string;
}

let serial = 0;

export class Deck {
	readonly root = mkdtempSync(join(tmpdir(), "pdv-"));
	readonly label = `decktest-v${process.pid}-${++serial}`;
	readonly stub = join(this.root, "stub");
	readonly work = join(this.root, "work");
	readonly sessions = join(this.root, "sessions");
	readonly statusDir = join(this.root, "state", "status");
	readonly env: NodeJS.ProcessEnv;
	readonly servers = new Set<string>();

	constructor(opts: { pathPrefix?: string } = {}) {
		for (const d of [this.stub, this.work, this.sessions, this.statusDir, join(this.root, "home")]) mkdirSync(d, { recursive: true });
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: join(this.root, "home"),
			PATH: `${opts.pathPrefix ? `${opts.pathPrefix}:` : ""}${join(repo, "bin")}:${process.env.PATH}`,
			PI_FLEET_STATE_DIR: join(this.root, "state"),
			PI_FLEET_RUNTIME_DIR: join(this.root, "run"),
			PI_FLEET_CACHE_DIR: join(this.root, "cache"),
			PI_CODING_AGENT_SESSION_DIR: this.sessions,
			PI_FLEET_STUB_DIR: this.stub,
			PI_FLEET_PI_CMD: `${process.execPath} ${stubPi}`,
			PI_FLEET_NVIM_CMD: "nvim --clean -n",
			PI_FLEET_TMUX_GUARD: "1",
			PI_FLEET_DECK_SOCKET: this.label,
			PI_FLEET_DECK_START_WAIT_MS: "30000", // deck-start waits 3 s for the list; a loaded machine (parallel runs) needs more
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
		};
		for (const k of ["TMUX", "TMUX_PANE", "PI_FLEET_SESSION", "PI_FLEET_TMUX_SOCKET", "PI_FLEET_DECK", "PI_FLEET_DECK_CONF", "PI_CODING_AGENT_DIR"]) delete env[k];
		this.env = env;
		this.servers.add(this.label);
	}

	tmux(args: string[], suffix = ""): string {
		const name = suffix ? `${this.label}-${suffix}` : this.label;
		const full = ["-L", name, ...args];
		guardTmuxArgs(full);
		this.servers.add(name);
		// The real tmux, not a logging wrapper on the deck's PATH: the logs hold the deck's calls only.
		return execFileSync(realTmux, full, { env: this.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");
	}
	tryTmux(args: string[], suffix = ""): string | undefined {
		try {
			return this.tmux(args, suffix);
		} catch {
			return undefined;
		}
	}
	cli(args: string[]): { code: number; out: string; err: string } {
		const r = spawnSync(cliBin, args, { env: this.env, encoding: "utf8", timeout: 30_000 });
		return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
	}
	panes(): Pane[] {
		const out = this.tmux(["list-panes", "-a", "-F", "#{pane_id}\t#{session_name}:#{window_name}.#{pane_index}\t#{@pi_fleet_role}\t#{@pi_fleet_session}\t#{pane_dead}\t#{pane_tty}"]);
		return out.split("\n").map((l) => {
			const f = l.split("\t");
			return { pane: f[0]!, where: f[1]!, role: f[2]!, session: f[3]!, dead: f[4] === "1", tty: f[5]! };
		});
	}
	/** The pi slot (right half). */
	slot(): Pane {
		return this.panes().find((p) => p.where === "deck:deck.3")!;
	}
	/** The terminal slot (bottom-left). */
	termSlot(): Pane {
		return this.panes().find((p) => p.where === "deck:deck.2")!;
	}
	/** The nvim slot (below the list). */
	nvimSlot(): Pane {
		return this.panes().find((p) => p.where === "deck:deck.1")!;
	}
	activeIndex(): string {
		return this.tmux(["display-message", "-p", "-t", "=deck:=deck", "#{pane_index}"]);
	}
	/** The list pane's screen (plain text). */
	listScreen(): string {
		return this.tmux(["capture-pane", "-p", "-t", "=deck:=deck.0"]);
	}
	slotScreen(): string {
		return this.tmux(["capture-pane", "-p", "-t", "=deck:=deck.3"]);
	}
	/** Keys typed into the list pane. */
	keys(...k: string[]): void {
		this.tmux(["send-keys", "-t", "=deck:=deck.0", ...k]);
	}
	file(id: string, ext: string): string {
		const f = join(this.stub, `${id}.${ext}`);
		return existsSync(f) ? readFileSync(f, "utf8") : "";
	}
	stubPid(id: string): number {
		return Number(this.file(id, "runs").trim().split("\n").at(-1)!.split(" ")[0]);
	}
	start(): void {
		const r = this.cli(["deck-start"]);
		assert.equal(r.code, 0, r.err);
	}
	async open(extra: string[] = []): Promise<{ id: string; pane: string }> {
		const r = this.cli(["open", "--deck", "--cwd", this.work, "--json", ...extra]);
		assert.equal(r.code, 0, r.err + r.out);
		const reply = JSON.parse(r.out);
		assert.equal(reply.ok, true, r.out);
		await waitFor("stub pi to start", () => this.file(reply.session, "runs") !== "");
		return { id: reply.session, pane: reply.pane };
	}
	/** A status file as a pi writes it (tmp + rename), with fresh times. */
	writeStatus(id: string, fields: Record<string, unknown>): void {
		const now = new Date().toISOString();
		const status = { v: 1, sessionId: id, cwd: this.work, repo: this.work, host: hostname(), pid: process.pid, state: "idle", acked: true, since: now, heartbeat: now, subagents: { working: 0, waiting: 0, done: 0, error: 0 }, ...fields };
		const tmp = join(this.statusDir, `.${id}.tmp`);
		writeFileSync(tmp, JSON.stringify(status));
		renameSync(tmp, join(this.statusDir, `${id}.json`));
	}
	close(): void {
		killServers(this.servers, { tmux: realTmux, env: this.env, socketDir });
		this.servers.clear();
		rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}
