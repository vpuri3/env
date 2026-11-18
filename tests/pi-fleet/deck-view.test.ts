// The deck's list (deck-view.ts; docs/pi-deck-design.md §6, phase 2), headless: rows from the
// sessions fixture (support/sessions-fixture.ts) plus an outside session and a subagent transcript;
// tmux replaced by fake DeckOps that record every call; timers replaced by a manual clock, so the
// swap coalescing, the 1 s acknowledgement and the debounces are exact. One test runs the real
// DeckController with a real fs.watch on the fixture's status dir. pi-tui comes from pi's install
// (cli.ts's resolve hook); skipped without one.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { locatePiPackages, usePiPackages } from "../../pi/extensions/fleet/cli.ts";
import { IDS, buildFixture, plainStyle, type Fixture } from "./support/sessions-fixture.ts";

const packages = locatePiPackages();
const skip = packages ? false : "pi's pi-tui not found (pi not on PATH)";
type DV = typeof import("../../pi/extensions/fleet/deck-view.ts");
type Row = import("../../pi/extensions/fleet/sessions-view.ts").SessionRow;
type DeckPane = import("../../pi/extensions/fleet/deck.ts").DeckPane;
let dv: DV;
let fx: Fixture;
let subFile: string;

const OUT = "00000000-0000-7000-8000-00000000d001";
const MIN = 60_000;

before(async () => {
	fx = buildFixture();
	const iso = (ms: number) => new Date(ms).toISOString();
	// A pi started by hand in the user's tmux: waiting, not yet seen.
	fx.writeStatus(OUT, {
		v: 1,
		sessionId: OUT,
		cwd: fx.repos.beta,
		repo: fx.repos.beta,
		host: hostname(),
		pid: process.pid,
		name: "notes outside",
		state: "waiting",
		acked: false,
		runId: "r3",
		since: iso(fx.now - 5 * MIN),
		heartbeat: iso(fx.now - 5000),
		subagents: { working: 0, waiting: 0, done: 0, error: 0 },
		tmux: { socket: "/tmp/fake-outer-sock", piPane: "%7", windowIndex: 3 },
		lastAssistant: "notes written",
	});
	// ckpt (a deck session below) waits with a run id; sweep has a Slurm job.
	const ckpt = JSON.parse(readFileSync(join(fx.statusDir, `${IDS.ckpt}.json`), "utf8"));
	fx.writeStatus(IDS.ckpt, { ...ckpt, runId: "r2" });
	const sweep = JSON.parse(readFileSync(join(fx.statusDir, `${IDS.sweep}.json`), "utf8"));
	fx.writeStatus(IDS.sweep, { ...sweep, slurmJobs: ["4242"] });
	// The transcript of old run's /runner subagent (thread entry: rootId = old, threadPath /runner).
	const dir = join(fx.sessionsDir, "--subagents--");
	mkdirSync(dir, { recursive: true });
	subFile = join(dir, "2026-11-17T10-00-00-000Z_00000000-0000-7000-8000-00000000a005.jsonl");
	writeFileSync(subFile, readFileSync(new URL("./fixtures/subagent-transcript.jsonl", import.meta.url)));
	const t = fx.now / 1000;
	utimesSync(subFile, t, t);
	if (!packages) return;
	await usePiPackages(packages);
	dv = await import("../../pi/extensions/fleet/deck-view.ts");
});
after(() => fx?.cleanup());

const flush = () => new Promise((r) => setImmediate(r));

/** A manual clock for setTimeout/clearTimeout. */
class Clock {
	t = 0;
	private seq = 0;
	private tasks = new Map<number, { at: number; fn: () => void; ms: number }>();
	setTimeout = (fn: () => void, ms: number) => {
		const id = ++this.seq;
		this.tasks.set(id, { at: this.t + ms, fn, ms });
		return id;
	};
	clearTimeout = (h: unknown) => {
		this.tasks.delete(h as number);
	};
	/** Delays of the pending timers. */
	pending(): number[] {
		return [...this.tasks.values()].map((t) => t.ms);
	}
	async advance(ms: number): Promise<void> {
		const end = this.t + ms;
		for (;;) {
			let next: [number, { at: number; fn: () => void }] | undefined;
			for (const e of this.tasks) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
			if (!next) break;
			this.tasks.delete(next[0]);
			this.t = next[1].at;
			next[1].fn();
			for (let i = 0; i < 5; i++) await flush();
		}
		this.t = end;
		for (let i = 0; i < 5; i++) await flush();
	}
}

const pane = (p: Partial<DeckPane>): DeckPane =>
	({ pane: "%0", window: "@0", sessionName: "pool", windowName: "pi", index: 0, role: "pi", session: "", peer: "", nvimSock: "", shown: "", dead: false, deadStatus: undefined, width: 60, height: 20, cwd: "", tty: "", pid: 1, exited: "", gone: false, inSlot: false, isList: false, ...p }) as DeckPane;
const PANES = [pane({ pane: "%21", session: IDS.sweep, inSlot: true }), pane({ pane: "%22", session: IDS.ckpt })];

type Call = [string, ...unknown[]];
function fakeOps(panes: DeckPane[] = PANES) {
	const calls: Call[] = [];
	const watchers = new Map<string, () => void>();
	const ops = {
		panes: async () => panes,
		show: async (t: { session: string } | { holder: true }) => (calls.push(["show", "session" in t ? t.session : "holder"]), true),
		writeHolder: async (lines: string[]) => void calls.push(["frame", lines]),
		focusSession: async (id: string) => (calls.push(["focus", id]), true),
		open: async (req: unknown) => (calls.push(["open", req]), { session: IDS.ckpt, pane: "%22", created: false }),
		kill: async (row: Row, scancel: boolean) => void calls.push(["kill", row.id, scancel]),
		jump: async (row: Row) => void calls.push(["jump", row.id]),
		detach: async () => void calls.push(["detach"]),
		killDeck: async () => (calls.push(["killDeck"]), { killedServer: true, nvims: [] as { session: string; cwd: string }[] }),
		attached: async () => true,
		ack: async (id: string, runId: string) => void calls.push(["ack", id, runId]),
		capture: async (row: Row) => (calls.push(["capture", row.id]), { kind: "frame" as const, lines: ["$ captured from the outer pane"] }),
		transcript: async (file: string) => (await import("../../pi/extensions/fleet/registry.ts")).transcriptItems(readFileSync(file, "utf8"), false),
		watchFile: (file: string, cb: () => void) => {
			watchers.set(file, cb);
			calls.push(["watch", file]);
			return () => {
				watchers.delete(file);
				calls.push(["unwatch", file]);
			};
		},
		squeue: async (ids: string[]) => ids.map((id) => ({ id, state: "RUNNING", time: "1:00" })),
		conversation: async (file: string) => new (await import("../../pi/extensions/fleet/deck-pager.ts")).ConversationTails().get(file),
		openPager: async (req: { token: string }) => {
			calls.push(["pager", req]);
			pagerToken = req.token;
		},
		closePager: async () => void calls.push(["closePager"]),
		pagerExit: async () => {
			const e = exit;
			exit = undefined;
			if (e) calls.push(["pagerExit", e.status]);
			return e && { token: pagerToken!, status: e.status };
		},
		focusSlot: async () => void calls.push(["focusSlot"]),
		agentsView: (id: string, path: string) => {
			calls.push(["agentsView", id, path]);
			if (agentsGate) return agentsGate.then(() => agentsReply(path));
			return Promise.resolve(agentsReply(path));
		},
		agentsClose: async (id: string) => void calls.push(["agentsClose", id]),
	};
	/** §16: what agents-view answers (default ok), and an optional gate holding every reply until opened. */
	let agentsReply = (_path: string): { ok: boolean; error?: string } => ({ ok: true });
	let agentsGate: Promise<void> | undefined;
	const agents = {
		reply(fn: (path: string) => { ok: boolean; error?: string }) {
			agentsReply = fn;
		},
		hold(): () => void {
			let open: () => void = () => {};
			agentsGate = new Promise<void>((r) => (open = r));
			return () => {
				agentsGate = undefined;
				open();
			};
		},
	};
	let pagerToken: string | undefined;
	let exit: { status: number } | undefined;
	/** less exits with `status` (the next pagerExit reports it once). */
	const lessExits = (status: number) => (exit = { status });
	const of = (kind: string) => calls.filter((c) => c[0] === kind);
	return { ops, calls, watchers, of, agents, lessExits: (status: number) => lessExits(status) };
}

/** A style whose selection survives strip() as a leading `▌` (the full-width line in reverse video). */
const style = { ...plainStyle, selected: (line: string) => `\x1b[7m${line}\x1b[27m` };
const strip = (s: string) => s.replace(/^\x1b\[7m/, "▌").replace(/\x1b\[[0-9;]*m/g, "");

function makeView(opts: { panes?: DeckPane[]; height?: number; source?: InstanceType<DV["DeckSource"]> } = {}) {
	const clock = new Clock();
	const fake = fakeOps(opts.panes);
	const source = opts.source ?? new dv.DeckSource(fx.env);
	source.readAllStatuses();
	source.rescan();
	const view = new dv.DeckView({
		source,
		ops: fake.ops,
		style,
		height: () => opts.height ?? 20,
		requestRender: () => {},
		deckSocket: "/tmp/fake-deck-sock",
		now: () => fx.now + clock.t,
		timers: clock,
		home: "/home/me",
	});
	view.setPanes(opts.panes ?? PANES);
	view.refresh();
	return { view, clock, source, ...fake };
}
const screen = (view: { render(w: number): string[] }, width = 72) => view.render(width).map((l) => strip(l).trimEnd());
const press = (view: { handleInput(d: string): void }, ...keys: string[]) => {
	for (const k of keys) view.handleInput(k);
};
const KEY = { down: "\x1b[B", up: "\x1b[A", enter: "\r", esc: "\x1b", space: " ", ctrlN: "\x0e", ctrlP: "\x10", ctrlL: "\x0c", bs: "\x7f" };
/** Move the selection to the row whose line contains `text` (NORMAL j/k). */
function selectLine(view: InstanceType<DV["DeckView"]>, text: string): void {
	for (let i = 0; i < 40; i++) {
		const sel = screen(view).find((l) => l.startsWith("▌"));
		if (sel?.includes(text)) return;
		press(view, "j");
	}
	throw new Error(`no row ${text}`);
}

// ---------------------------------------------------------------- layout

test("layout: repo groups with their closed sessions after the live ones, then outside; full-width selection; status line, search bar, hints", { skip }, () => {
	const { view } = makeView();
	view.selectSession(IDS.sweep);
	const lines = screen(view);
	assert.equal(lines.length, 20);
	assert.deepEqual(lines.slice(0, 13), [
		" ▾ gamma (1, 1 closed)",
		"  ? flare refactor                 question 12m       $0.80           1◐",
		"  ◌ what does gamma do?            2d ago",
		" ▾ beta (2, 1 closed)",
		"  ✕ crashy                         crashed just now         1 interrupt…",
		"  ⇢ notes                          live on other-n…",
		"  ◌ forked idea                    1d ago",
		" ▾ alpha (2, 1 closed)",
		"  ◐ ckpt restart                   done 2m ago        $0.40",
		"▌› ● physicsnemo sweep              bash 4m            $3.41     2w 1◐ 3✓",
		"  ◌ start the old run              3h ago                   1✓ 1 interr…",
		" ▾ outside (your tmux) (1)",
		"  ◐ notes outside ⇱ win 3          done 5m ago",
	]);
	// Rows span the pane: the counts column ends at the right edge (right-aligned, as wide as the widest
	// counts), the name takes the rest; at 140 columns every count shows in full.
	for (const w of [100, 140]) {
		const wide = screen(view, w);
		const flare = wide.find((l) => l.includes("flare refactor"))!;
		assert.equal(flare.length, w, `flare ends at the edge (${w})`);
		assert.ok(flare.endsWith(" 1◐"), flare);
		const crashy = wide.find((l) => l.includes("crashy"))!;
		assert.equal(crashy.length, w);
		if (w === 140) assert.ok(crashy.endsWith("1 interrupted"), crashy);
		// Columns line up: every detail starts where flare's does.
		const at = flare.indexOf("question 12m");
		assert.equal(wide.find((l) => l.includes("ckpt restart"))!.indexOf("done 2m ago"), at);
		assert.ok(at > 34, "the name column grew with the width");
	}
	// The selection is padded to the full width.
	const sel = view.render(72).find((l) => l.startsWith("\x1b[7m"))!;
	assert.equal(strip(sel).length, 1 + 72);
	assert.deepEqual(lines.slice(13, 15), ["", ""]);
	// The search bar in a box: badge and count on the top border, the color legend on the bottom one.
	assert.deepEqual(lines.slice(16), [
		`╭─ NORMAL ${"─".repeat(55)} 9/9 ─╮`,
		`│ ⌕${" ".repeat(68)}│`,
		`╰─ ○ active  ● working  ◐ done  ? needs input  ✕ error  » auto ${"─".repeat(8)}╯`,
		" j/k move  ⏎/C-l open  a new  d kill  i / search  ? help  C-c detach",
	]);
	assert.equal(lines[15], " physicsnemo sweep · ● working · tool bash · for 4m · $3.41 · subagents…");
	assert.match(screen(view, 140)[15]!, /^ physicsnemo sweep · ● working · tool bash · for 4m · \$3\.41 · subagents 2w 1◐ 3✓ · \/.*\/work\/alpha$/);
});

test("stable order: status changes keep rows in place; new sessions go last in their group; a closed one stays; r sorts again and keeps the selection", { skip }, async () => {
	let patch = (rows: Row[]) => rows;
	class Source extends dv.DeckSource {
		override rows() {
			return patch(super.rows());
		}
	}
	const source = new Source(fx.env);
	const { view, clock, of } = makeView({ source, height: 30 });
	const names = () =>
		screen(view, 90)
			.slice(0, 22)
			.map((l) => l.replace(/^▌/, "").replace(/^›/, " "))
			.filter((l) => /^  [^ ▾▸]/.test(l))
			.map((l) => l.slice(4, 34).trim());
	const before = names();
	assert.deepEqual(before.slice(0, 5), ["flare refactor", "what does gamma do?", "crashy", "notes", "forked idea"]);
	const alpha = before.indexOf("ckpt restart");
	assert.deepEqual(before.slice(alpha, alpha + 3), ["ckpt restart", "physicsnemo sweep", "start the old run"]);
	view.selectSession(IDS.ckpt);
	await clock.advance(100);

	// sweep asks a question (the rules would put it first in alpha); ckpt closes; a new session starts in alpha.
	patch = (rows) => [
		...rows.map((r) =>
			r.id === IDS.sweep ? ({ ...r, state: "question" } as Row) : r.id === IDS.ckpt ? ({ ...r, state: "closed", live: undefined, status: undefined } as unknown as Row) : r,
		),
		{ ...rows.find((r) => r.id === IDS.sweep)!, id: "00000000-0000-7000-8000-0000000000ee", name: "brand new one", state: "idle", at: fx.now, status: undefined } as Row,
	];
	view.refresh();
	const after = names();
	const a2 = after.indexOf("ckpt restart");
	assert.ok(a2 >= 0, "the closed session stays in place");
	assert.deepEqual(after.slice(a2, a2 + 4), ["ckpt restart", "physicsnemo sweep", "brand new one", "start the old run"], "new live row after the known live ones");
	assert.deepEqual(after.slice(0, a2), before.slice(0, alpha), "the groups above did not move");
	assert.match(screen(view, 90).find((l) => l.startsWith("▌"))!, /ckpt restart/, "the selection did not move");

	// r: the rules again (question first in alpha, the closed ckpt among alpha's closed rows); same row selected.
	press(view, "r");
	await clock.advance(100);
	const resorted = names();
	const a3 = resorted.indexOf("physicsnemo sweep");
	assert.equal(resorted[a3 + 1], "brand new one");
	assert.ok(resorted.indexOf("ckpt restart") > resorted.indexOf("brand new one"), "closed after live");
	assert.match(screen(view, 90).find((l) => l.startsWith("▌"))!, /ckpt restart/);
	assert.match(screen(view, 140).at(-1)!, /r refresh/);
	assert.equal(of("detach").length, 0);
});

test("ANSI colors (§6): active blue 75, working purple 141 (autonomous: purple »), done green 78, needs input orange 208 bold, error red 196, closed grey 250, remote grey 244; on glyph, name and detail; 90 only for chrome", { skip }, async () => {
	const sv = await import("../../pi/extensions/fleet/sessions-view.ts");
	const clock = new Clock();
	// The outside session idles (no idle row in the fixture otherwise); a second view makes sweep autonomous.
	const make = (patch: (r: Row) => Row) => {
		class Source extends dv.DeckSource {
			override rows() {
				return super.rows().map(patch);
			}
		}
		const source = new Source(fx.env);
		source.readAllStatuses();
		source.rescan();
		const view = new dv.DeckView({ source, ops: fakeOps().ops, style: sv.ansiStyle, height: () => 22, requestRender: () => {}, deckSocket: "/tmp/fake-deck-sock", now: () => fx.now, timers: clock });
		view.setPanes(PANES);
		view.refresh();
		view.selectSession(IDS.ckpt);
		return view.render(90);
	};
	const lines = make((r) => (r.id === OUT ? { ...r, state: "idle" as const } : r));
	const raw = lines.join("\n");
	const fg = (n: number, text: string) => `\x1b[38;5;${n}m${text}\x1b[39m`;
	assert.ok(raw.includes(`${fg(141, "●")} ${fg(141, "physicsnemo sweep")}`) && raw.includes(fg(141, "bash 4m")), "working: purple glyph, name, detail");
	assert.ok(raw.includes(`${fg(78, "◐")} \x1b[1m${fg(78, "ckpt restart")}\x1b[22m`) && raw.includes(fg(78, "done 2m ago")), "done (unseen): green, bold when selected");
	assert.ok(raw.includes(`\x1b[1m${fg(208, "?")}\x1b[22m \x1b[1m${fg(208, "flare refactor")}\x1b[22m`), "needs input: orange bold");
	assert.ok(raw.includes(`${fg(196, "✕")} ${fg(196, "crashy")}`), "crashed: red");
	assert.ok(raw.includes(`${fg(75, "○")} ${fg(75, "notes outside")}`) && /\x1b\[38;5;75m\d+m ago/.test(raw), "active (live, idle): blue");
	assert.ok(raw.includes(`${fg(250, "◌")} ${fg(250, "start the old run")}`), "closed: grey 250");
	assert.ok(raw.includes(`${fg(244, "⇢")} ${fg(244, "notes")}`), "remote: grey 244");
	assert.match(raw, /\x1b\[1m\x1b\[36malpha\x1b\[39m\x1b\[22m/); // repo header bold cyan
	assert.ok(lines.some((l) => l.startsWith(sv.ANSI_SELECTED_BG) && l.includes("ckpt restart")), "the selection background");
	// The colors stay distinct: no two tones share a color but working/auto.
	const colors = Object.entries(sv.TONE_COLOR).filter(([t]) => t !== "auto").map(([, c]) => sv.ANSI_FG[c]);
	assert.equal(new Set(colors).size, colors.length, colors.join(" "));
	// Dark grey 90 is chrome only: never in the list rows, the search box or the hints.
	const body = [...lines.slice(0, 15), ...lines.slice(18)];
	assert.ok(body.every((l) => !l.includes("\x1b[90m")), body.filter((l) => l.includes("\x1b[90m")).join("\n"));
	for (const color of ["text", "muted", "dim"] as const) assert.notEqual(sv.ANSI_FG[color], "90", color);
	// The legend on the search box's bottom border, in the same colors.
	const bottom = lines.find((l) => l.includes("╰"))!;
	for (const [n, text] of [[75, "○ active"], [141, "● working"], [78, "◐ done"], [208, "? needs input"], [196, "✕ error"]] as const) assert.ok(bottom.includes(fg(n, text)), text);
	// Autonomous working: purple with its own glyph.
	const auto = make((r) => (r.id === IDS.sweep && r.status ? { ...r, status: { ...r.status, autonomous: true } } : r)).join("\n");
	assert.ok(auto.includes(`${fg(141, "»")} ${fg(141, "physicsnemo sweep")}`) && auto.includes(fg(141, "auto bash 4m")), "autonomous: purple »");
});

test("wide list: the name column takes the width the other columns leave; counts stay at the right edge", { skip }, () => {
	const { view } = makeView();
	const narrow = screen(view, 72).find((l) => l.includes("physicsnemo sweep"))!;
	const wide = screen(view, 140).find((l) => l.includes("physicsnemo sweep"))!;
	assert.ok(wide.indexOf("bash 4m") > narrow.indexOf("bash 4m") + 50, "detail column moves right in a wide list");
	assert.ok(wide.length > 120, "the row spans the pane");
	assert.ok(screen(view, 140).some((l) => l.includes("1 interrupted") && !l.includes("…")), "counts no longer cut");
});

// ---------------------------------------------------------------- modes and search

test("modes: i and / enter INSERT; fuzzy terms filter live; Esc back to NORMAL keeps the query; Esc again clears", { skip }, async () => {
	const { view, clock, of } = makeView();
	press(view, "i");
	assert.equal(view.mode, "insert");
	assert.match(screen(view)[16]!, /^╭─ INSERT ─+ 9\/9 ─╮$/);
	assert.match(screen(view)[17]!, /^│ ⌕ ▏ +│$/);
	assert.match(screen(view)[19]!, /type to search/);
	press(view, "f", "l", "r"); // a subsequence of "flare refactor"
	let lines = screen(view).filter((l) => l);
	assert.deepEqual(lines.slice(0, 2), [" ▾ gamma (1)", "▌› ? flare refactor                           question 12m       $0.80 1◐"]);
	assert.match(screen(view)[16]!, /^╭─ INSERT ─+ 1\/9 ─╮$/);
	assert.match(screen(view)[17]!, /^│ ⌕ flr▏ +│$/);
	// Every term must match (name, repo, cwd or last message).
	press(view, " ", "z", "z", "z");
	assert.match(screen(view)[0]!, /no sessions match/);
	press(view, KEY.bs, KEY.bs, KEY.bs, KEY.bs);
	press(view, KEY.esc);
	assert.equal(view.mode, "normal");
	assert.match(screen(view)[16]!, /^╭─ NORMAL ─+ 1\/9 ─╮$/);
	assert.match(screen(view)[17]!, /^│ ⌕ flr +│$/);
	// j/k work on the filtered list in NORMAL; Esc clears.
	press(view, KEY.esc);
	assert.equal(view.query, "");
	assert.match(screen(view)[16]!, / 9\/9 ─╮$/);
	// `/` too; a closed session is found under its repo; Enter in INSERT is NORMAL Enter.
	press(view, "/", "o", "l", "d", " ", "r", "u", "n");
	lines = screen(view).filter((l) => l);
	assert.deepEqual(lines.slice(0, 2), [" ▾ alpha (1 closed)", "▌› ◌ start the old run              3h ago                   1✓ 1 interr…"]);
	press(view, KEY.enter);
	assert.equal(view.mode, "normal");
	await clock.advance(50);
	assert.deepEqual(of("open")[0]![1], { session: fx.files.old, focus: true });
	// Status filters: & errors only, 0 all.
	press(view, KEY.esc, "&");
	assert.deepEqual(screen(view).filter((l) => /^▌?.? [?✕◐●○⇢⟳] /.test(l)).length, 1);
	press(view, "0");
	assert.match(screen(view)[16]!, / 9\/9 ─╮$/);
});

// ---------------------------------------------------------------- the slot follows

test("highlight swaps the slot; fast repeats are coalesced into one swap", { skip }, async () => {
	const { view, clock, of, calls } = makeView();
	view.selectSession(IDS.sweep);
	await clock.advance(100);
	calls.length = 0;
	// k: ckpt, a deck session → one show of it after SWAP_COALESCE_MS.
	press(view, "k");
	assert.equal(of("show").length, 0, "nothing before the coalescing window");
	await clock.advance(dv.SWAP_COALESCE_MS);
	assert.deepEqual(of("show"), [["show", IDS.ckpt]]);
	// Five moves 10 ms apart: one swap, for the last row.
	calls.length = 0;
	for (const k of ["j", "k", "j", "k", "k"]) {
		press(view, k);
		await clock.advance(10);
	}
	await clock.advance(dv.SWAP_COALESCE_MS);
	assert.equal(of("show").length, 1, JSON.stringify(calls));
	assert.deepEqual(of("show")[0], ["show", "holder"], "alpha's header has no pane: the holder");
	assert.match(strip((of("frame").at(-1)![1] as string[])[0]!), /── alpha /);
	// Moves further apart than the window: one swap each.
	calls.length = 0;
	press(view, "j");
	await clock.advance(40);
	press(view, "j");
	await clock.advance(40);
	assert.deepEqual(of("show"), [["show", IDS.ckpt], ["show", IDS.sweep]]);
	// No timers left running: nothing polls.
	assert.deepEqual(clock.pending(), []);
});

test("rows without a pane preview in the holder: card for closed/remote/outside; outside also gets one capture", { skip }, async () => {
	const { view, clock, of, calls } = makeView();
	view.selectSession(OUT);
	await clock.advance(50);
	assert.deepEqual(of("show"), [["show", "holder"]]);
	assert.deepEqual(of("capture"), [["capture", OUT]]);
	const frame = (of("frame").at(-1)![1] as string[]).map(strip);
	assert.match(frame[0]!, /^── notes outside ─+$/);
	assert.equal(frame.length <= 20, true);
	assert.ok(frame.every((l) => l.length <= 60), "frames fit the slot width");
	assert.ok(frame.some((l) => /runs in your tmux \(window 3\) · ⏎ jump there/.test(l)), frame.join("\n"));
	assert.ok(frame.some((l) => l.includes("$ captured from the outer pane")), frame.join("\n"));
	// A status refresh of the same state does not capture again; the remote row is a card.
	calls.length = 0;
	view.refresh();
	await clock.advance(50);
	assert.equal(of("capture").length, 0);
	view.selectSession(IDS.notes);
	await clock.advance(50);
	const remote = (of("frame").at(-1)![1] as string[]).map(strip);
	assert.ok(remote.some((l) => /runs on other-node: no preview from this node/.test(l)), remote.join("\n"));
	assert.ok(remote.some((l) => l === " notes taken"));
	// Already the holder: no second swap, just the frame.
	assert.equal(of("show").length, 0);
});

test("subagent rows: Space expands, the holder shows the transcript tail, re-read on fs.watch of its JSONL", { skip }, async () => {
	const { view, clock, of, watchers, calls } = makeView({ height: 30 });
	// old run (closed, under alpha): expand it.
	selectLine(view, "start the old run");
	press(view, KEY.space);
	selectLine(view, "/runner");
	await clock.advance(50);
	assert.deepEqual(of("watch"), [["watch", subFile]]);
	let frame = (of("frame").at(-1)![1] as string[]).map(strip);
	assert.match(frame[0]!, /^── coder \/runner · interrupted ─+$/);
	assert.deepEqual(frame.slice(2), [
		" I should look at",
		" the logs first",
		" Checking the logs.",
		" ✓ bash tail -n 5 run.log",
		" ✗ read /w/missing.py",
		" … grep loss",
		" The run finished:",
		" loss 0.12",
	]);
	// The file grows: the watcher fires, the frame follows after the debounce.
	calls.length = 0;
	const last = JSON.parse(readFileSync(subFile, "utf8").trim().split("\n").at(-1)!);
	writeFileSync(subFile, `${readFileSync(subFile, "utf8")}${JSON.stringify({ type: "message", id: "t9", parentId: last.id, message: { role: "assistant", content: [{ type: "text", text: "and one more" }] } })}\n`);
	watchers.get(subFile)!();
	watchers.get(subFile)!();
	await clock.advance(dv.TRANSCRIPT_DEBOUNCE_MS);
	frame = (of("frame").at(-1)![1] as string[]).map(strip);
	assert.equal(frame.at(-1), " and one more");
	assert.equal(of("frame").length, 1, "two events, one re-read");
	// Moving away stops watching; Enter on a subagent selects its main.
	press(view, "k");
	await clock.advance(50);
	assert.deepEqual(of("unwatch"), [["unwatch", subFile]]);
	press(view, "j", KEY.enter);
	assert.match(screen(view, 72).find((l) => l.startsWith("▌"))!, /start the old run/);
});

test("§16: a live deck session's subagent row shows its agent view in the main's pi (asked, then swapped); latest wins; other rows close it; ok:false falls back to the holder", { skip }, async () => {
	const { view, clock, of, calls, agents } = makeView({ height: 40 });
	view.selectSession(IDS.sweep);
	await clock.advance(100);
	press(view, KEY.space);
	await clock.advance(100);
	calls.length = 0;
	// The first subagent row of sweep (a deck session): agents-view for its path, then the session is shown.
	press(view, "j");
	await clock.advance(dv.SWAP_COALESCE_MS);
	const [first] = of("agentsView");
	assert.ok(first, JSON.stringify(calls));
	assert.equal(first![1], IDS.sweep);
	const path1 = first![2] as string;
	assert.match(path1, /^\/agent-\d$/);
	assert.match(screen(view, 100).find((l) => l.startsWith("▌"))!, new RegExp(path1));
	assert.deepEqual(calls.filter((c) => c[0] !== "frame"), [["agentsView", IDS.sweep, path1], ["show", IDS.sweep]]);
	assert.deepEqual([of("frame").length, of("watch").length], [0, 0], "no holder preview");
	assert.match(screen(view, 100).at(-1)!, /⏎\/C-l its agent view/);
	// C-l and Enter focus the main's pi (the view is there); no pager.
	press(view, KEY.ctrlL);
	press(view, KEY.enter);
	await clock.advance(10);
	assert.deepEqual([of("focus"), of("pager")], [[["focus", IDS.sweep], ["focus", IDS.sweep]], []]);

	// Rapid j/k over subagent rows: one agents-view, for the row that stays selected.
	calls.length = 0;
	for (const k of ["j", "j", "k", "j"]) {
		press(view, k);
		await clock.advance(10);
	}
	await clock.advance(dv.SWAP_COALESCE_MS);
	assert.equal(of("agentsView").length, 1, JSON.stringify(calls));
	const path3 = of("agentsView")[0]![2] as string;
	assert.notEqual(path3, path1);
	assert.deepEqual(of("agentsClose"), [], "same session: the pi switches agents itself");

	// A slow reply that is stale by the time it comes: ignored (no show for it); the newer row is asked next.
	calls.length = 0;
	const open = agents.hold();
	press(view, "j");
	await clock.advance(dv.SWAP_COALESCE_MS);
	assert.equal(of("agentsView").length, 1);
	press(view, "k");
	await clock.advance(dv.SWAP_COALESCE_MS);
	open();
	await clock.advance(10);
	assert.deepEqual(of("agentsView").map((c) => c[2]), [of("agentsView")[0]![2], path3]);
	assert.equal(of("show").length, 1, `one show, for the row selected now: ${JSON.stringify(calls)}`);

	// Another row (sweep itself): agents-close to sweep, then sweep's pi as usual.
	calls.length = 0;
	view.selectSession(IDS.sweep);
	await clock.advance(dv.SWAP_COALESCE_MS);
	assert.deepEqual(of("agentsClose"), [["agentsClose", IDS.sweep]]);

	// ok:false (reaped, unknown, no tree): the holder preview of that subagent, as for other sessions' subagents.
	calls.length = 0;
	agents.reply((path) => (path === path1 ? { ok: false, error: "unknown agent" } : { ok: true }));
	selectLine(view, path1);
	await clock.advance(dv.SWAP_COALESCE_MS);
	assert.deepEqual(of("agentsView").map((c) => c[2]), [path1]);
	assert.deepEqual(of("show"), [["show", "holder"]]);
	assert.ok(of("frame").length >= 1);
	assert.match(screen(view, 100).at(-1)!, /⏎ its session {2}C-l read/);
	// Its pager on C-l, like any subagent row without a view; moving on sends no agents-close (nothing open).
	calls.length = 0;
	press(view, "k");
	await clock.advance(dv.SWAP_COALESCE_MS);
	assert.deepEqual(of("agentsClose"), []);
});

test("closed sessions: under their repo after its live rows, the newest 3 then `+N closed`; closed-only repos last, folded; a search shows all", { skip }, async () => {
	const H = 3600_000;
	const closed = (id: string, name: string, repo: string, ageH: number): Row => ({ id, file: `/s/${id}.jsonl`, name, unnamed: false, cwd: repo, repo, state: "closed", at: fx.now - ageH * H, counts: { working: 0, waiting: 0, done: 0, error: 0 } });
	const extra = [
		...[1, 2, 4, 5, 6].map((h) => closed(`alpha-${h}`, `alpha closed ${h}h`, fx.repos.alpha, h)),
		closed("delta-1", "delta one", "/w/delta", 1),
		closed("delta-2", "delta two", "/w/delta", 2),
	];
	class Source extends dv.DeckSource {
		override rows() {
			return [...super.rows(), ...extra];
		}
	}
	const { view, clock, of } = makeView({ source: new Source(fx.env), height: 30 });
	const names = () => screen(view, 72).filter((l) => l && !/^( j\/k|[╭│╰])/.test(l)).slice(0, -1);
	let lines = names();
	const alpha = lines.indexOf(" ▾ alpha (2, 6 closed)");
	assert.ok(alpha >= 0, lines.join("\n"));
	assert.deepEqual(lines.slice(alpha + 1, alpha + 7).map((l) => l.slice(0, 26).trimEnd()), [
		"  ◐ ckpt restart",
		"  ● physicsnemo sweep",
		"  ◌ alpha closed 1h",
		"  ◌ alpha closed 2h",
		"  ◌ start the old run",
		"  ⋯ +3 closed",
	]);
	// The closed-only repo comes after every group with live sessions (outside included), folded.
	assert.equal(lines.at(-1), " ▸ delta (2 closed)");
	assert.ok(lines.indexOf(" ▾ outside (your tmux) (1)") < lines.length - 1);
	// Enter on `+3 closed`: all of alpha's closed sessions, the selection on the first one it showed.
	selectLine(view, "+3 closed");
	assert.match(screen(view, 72)[25]!, /^ 3 older closed sessions in alpha · ⏎\/␣ show them$/);
	press(view, KEY.enter);
	lines = names();
	assert.deepEqual(lines.slice(alpha + 5, alpha + 10).map((l) => l.slice(0, 26).trimEnd()), [
		"  ◌ start the old run",
		"▌› ◌ alpha closed 4h",
		"  ◌ alpha closed 5h",
		"  ◌ alpha closed 6h",
		"  ⋯ − hide 3 older closed",
	]);
	// Space on the toggle folds them again.
	press(view, "j", "j", "j", KEY.space);
	assert.ok(names().some((l) => l.startsWith("▌› ⋯ +3 closed")), names().join("\n"));
	// Space on the folded closed-only repo opens it.
	selectLine(view, "delta (2 closed)");
	press(view, KEY.space);
	lines = names();
	assert.deepEqual(lines.slice(-3).map((l) => l.slice(0, 26).trimEnd()), ["▌›▾ delta (2 closed)", "  ◌ delta one", "  ◌ delta two"]);
	press(view, KEY.space);
	// A search shows every match, folded or not; Enter resumes it into the deck.
	press(view, "/", "c", "l", "o", "s", "e", "d", " ", "6", "h");
	assert.deepEqual(names().slice(0, 2).map((l) => l.trimEnd()), [" ▾ alpha (1 closed)", "▌› ◌ alpha closed 6h                             6h ago"]);
	press(view, KEY.esc, KEY.esc, "/", "t", "w", "o");
	assert.ok(names().some((l) => l.startsWith("▌› ◌ delta two")), names().join("\n"));
	press(view, KEY.enter);
	await clock.advance(50);
	assert.deepEqual(of("open").at(-1)![1], { session: "/s/delta-2.jsonl", focus: true });
	// Selecting a folded closed session (deck.sock select) unfolds what hides it.
	press(view, KEY.esc, KEY.esc);
	view.selectSession("alpha-6");
	assert.ok(names().some((l) => l.startsWith("▌› ◌ alpha closed 6h")), names().join("\n"));
	// a on a closed-only repo opens a new session there.
	selectLine(view, "delta (2 closed)");
	press(view, "a");
	await clock.advance(50);
	assert.deepEqual(of("open").at(-1)![1], { cwd: "/w/delta", focus: true });
});

test("expanded subagents: unfinished ones first, then completed/stopped/failed; each most recently updated first", { skip }, () => {
	type Thread = import("../../pi/extensions/fleet/registry.ts").FoldedThread;
	const t = (path: string, state: string, updatedAt?: number): Thread => ({ path, type: "coder", state, updatedAt });
	const threads = [t("/done-old", "completed", 1), t("/run-old", "running", 2), t("/failed", "failed", 9), t("/paused", "paused", 5), t("/done-new", "completed", 8), t("/stopped", "stopped", 3), t("/run-new", "running", 7), t("/waiting", "waiting", 4), t("/starting", "starting")];
	class Source extends dv.DeckSource {
		override threads(row: Row) {
			return row.id === IDS.sweep ? threads : super.threads(row);
		}
	}
	const { view } = makeView({ source: new Source(fx.env), height: 40 });
	view.selectSession(IDS.sweep);
	press(view, KEY.space);
	const subs = screen(view, 100)
		.map((l) => /coder (\/\S+)/.exec(l)?.[1])
		.filter(Boolean);
	assert.deepEqual(subs, ["/run-new", "/paused", "/waiting", "/run-old", "/starting", "/failed", "/done-new", "/stopped", "/done-old"]);
	assert.deepEqual(threads.map((x) => x.path)[0], "/done-old", "the source's list is not reordered in place");
});

// ---------------------------------------------------------------- keys that act

test("Enter / C-l: deck row focuses the slot; outside row jumps; closed resumes; remote explains; a opens in the repo", { skip }, async () => {
	const { view, clock, of } = makeView();
	view.selectSession(IDS.ckpt);
	press(view, KEY.enter);
	await clock.advance(50);
	assert.deepEqual(of("focus"), [["focus", IDS.ckpt]]);
	press(view, KEY.ctrlL);
	await clock.advance(50);
	assert.equal(of("focus").length, 2);
	view.selectSession(OUT);
	press(view, KEY.enter);
	await clock.advance(50);
	assert.deepEqual(of("jump"), [["jump", OUT]]);
	view.selectSession(IDS.notes);
	press(view, KEY.enter);
	assert.match(screen(view)[19]!, /notes runs on other-node/);
	view.selectSession(IDS.fork);
	press(view, KEY.enter);
	await clock.advance(50);
	assert.deepEqual(of("open")[0]![1], { session: fx.files.fork, focus: true });
	// a: a new session in the highlighted row's repo (here: the deck session it selected after open).
	view.selectSession(IDS.flare);
	press(view, "a");
	await clock.advance(50);
	assert.deepEqual(of("open")[1]![1], { cwd: fx.repos.gamma, focus: true });
	// C-c detaches (closes the popup; the list keeps running); q does not any more.
	press(view, "q");
	assert.equal(of("detach").length, 0, "q is no detach");
	press(view, "\x03");
	assert.equal(of("detach").length, 1);
});

test("C-d: confirm killing every deck session and the deck (NORMAL and INSERT); n cancels, y or C-d kills; nvims with unsaved changes are named", { skip }, async () => {
	const { view, clock, ops, calls, of } = makeView();
	const killDeck: { killedServer: boolean; nvims: { session: string; cwd: string }[] }[] = [];
	let reply = { killedServer: true, nvims: [] as { session: string; cwd: string }[] };
	(ops as Record<string, unknown>).killDeck = async () => {
		calls.push(["killDeck"]);
		killDeck.push(reply);
		return reply;
	};
	view.selectSession(IDS.sweep);
	await clock.advance(100);
	// C-d asks (two deck sessions here); n cancels, nothing killed; Esc too.
	press(view, "\x04");
	let lines = screen(view, 90);
	assert.match(lines.at(-5)!, /Kill all 2 deck sessions and the deck\?/);
	assert.match(lines.at(-1)!, /y\/⏎\/C-d kill · n\/Esc cancel/);
	press(view, "j");
	assert.match(screen(view, 90).at(-5)!, /Kill all 2 deck sessions/, "other keys keep the question");
	press(view, "n");
	assert.doesNotMatch(screen(view, 90).at(-5)!, /Kill all/);
	press(view, "\x04", KEY.esc);
	assert.doesNotMatch(screen(view, 90).at(-5)!, /Kill all/);
	assert.equal(of("killDeck").length, 0);
	// INSERT mode too; y kills (the list goes with the server).
	press(view, "i", "\x04");
	assert.match(screen(view, 90).at(-5)!, /Kill all 2 deck sessions/);
	press(view, "y");
	await clock.advance(10);
	assert.equal(of("killDeck").length, 1);
	assert.equal(of("detach").length, 0);
	// The server stays up for nvims with unsaved buffers: they are named (session name, else the id).
	reply = { killedServer: false, nvims: [{ session: IDS.sweep, cwd: "/w" }, { session: "deadbeef-1111", cwd: "/x" }] };
	press(view, KEY.esc, "\x04", KEY.enter);
	await clock.advance(10);
	assert.equal(of("killDeck").length, 2);
	// C-d C-d kills too.
	press(view, "\x04", "\x04");
	await clock.advance(10);
	assert.equal(of("killDeck").length, 3);
	lines = screen(view, 140);
	assert.match(lines.at(-1)!, /unsaved changes in nvim \(physicsnemo sweep, deadbeef\): save and quit them \(:wqa\), then C-d again/);
	assert.equal(of("detach").length, 0);
});

test("closed rows: the preview is the card then the end of the conversation; C-l reads the transcript (less in the holder), q back, Enter resumes, moving on restores the holder", { skip }, async () => {
	const { view, clock, of, calls, lessExits } = makeView({ height: 30 });
	const key = `m:${IDS.old}`;
	view.selectSession(IDS.old);
	await clock.advance(50);
	assert.deepEqual(of("show"), [["show", "holder"]]);
	const frame = (of("frame").at(-1)![1] as string[]).map(strip);
	assert.match(frame[0]!, /^── start the old run ─+$/);
	assert.ok(frame.includes(" ⏎ resume it in the deck · C-l read the transcript"), frame.join("\n"));
	// The end of the conversation under the card: the user's message and the answer.
	const at = frame.findIndex((l) => /^── transcript ─+$/.test(l));
	assert.ok(at > 0, frame.join("\n"));
	assert.deepEqual(frame.slice(at + 1), [" › start the old run", " the old run finished"]);
	assert.match(screen(view, 100).at(-1)!, /⏎ resume {2}C-l read/);
	// C-l: the pager, not a resume; the list writes no frames while it is open.
	calls.length = 0;
	press(view, KEY.ctrlL);
	await clock.advance(50);
	assert.equal(of("open").length, 0);
	assert.equal(of("pager").length, 1);
	assert.deepEqual({ ...(of("pager")[0]![1] as object), token: undefined }, { file: fx.files.old, title: "start the old run", enter: "resume", facts: [join(fx.repos.alpha, "sub")], width: 60, token: undefined });
	assert.equal(view.pagerKey(), key);
	view.refresh();
	view.resized();
	await clock.advance(50);
	assert.equal(of("frame").length, 0, "no frames into less");
	assert.equal(of("closePager").length, 0);
	// Back with C-h (tmux), C-l again: the same pager, focused; not opened again.
	press(view, KEY.ctrlL);
	await clock.advance(50);
	assert.deepEqual([of("pager").length, of("focusSlot").length], [1, 1]);
	// q in less: the holder is a holder again (the list redraws its card), nothing resumed.
	lessExits(0);
	await view.checkPager();
	await clock.advance(50);
	assert.equal(view.pagerKey(), undefined);
	assert.equal(of("frame").length, 1);
	assert.match(strip((of("frame")[0]![1] as string[])[0]!), /^── start the old run/);
	assert.equal(of("open").length, 0);
	// Enter in less (PAGER_RESUME): resumed as a pi, as Enter on the row.
	press(view, KEY.ctrlL);
	await clock.advance(50);
	assert.equal(of("pager").length, 2);
	lessExits(dv.PAGER_RESUME);
	await view.checkPager();
	await clock.advance(50);
	assert.deepEqual(of("open"), [["open", { session: fx.files.old, focus: true }]]);
	// Enter on the row in the list resumes too (no pager involved).
	view.selectSession(IDS.old);
	await clock.advance(50);
	press(view, KEY.enter);
	await clock.advance(50);
	assert.equal(of("open").length, 2);
	// A pager open, the selection moves on: the holder gets its sleep back before the next frame.
	view.selectSession(IDS.old);
	await clock.advance(50);
	press(view, KEY.ctrlL);
	await clock.advance(50);
	calls.length = 0;
	view.selectSession(IDS.fork);
	await clock.advance(50);
	assert.deepEqual(calls.slice(0, 2).map((c) => c[0]), ["closePager", "frame"]);
	assert.equal(view.pagerKey(), undefined);
	assert.match(strip((of("frame")[0]![1] as string[])[0]!), /^── forked idea/);
	// A stale exit (the killed pager's) changes nothing.
	lessExits(0);
	await view.checkPager();
	assert.equal(of("pagerExit").length, 0, "no pager open: not even read");
});

test("deck-pager: the active branch; thinking folded, tool output cut, custom state skipped, escapes dropped; 10 MB renders in < 1 s", { skip }, async () => {
	const dp = await import("../../pi/extensions/fleet/deck-pager.ts");
	const lines: string[] = [];
	let n = 0;
	const add = (o: Record<string, unknown>, parent: string | null = n ? `e${n}` : null) => {
		lines.push(JSON.stringify({ ...o, id: `e${++n}`, parentId: parent }));
		return `e${n}`;
	};
	const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type: "message", message: { role, content, ...extra } });
	lines.push(JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/w" }));
	const fork = add({ type: "model_change", provider: "p", modelId: "m" });
	add(msg("user", "first question"));
	add(msg("assistant", [{ type: "text", text: "abandoned branch answer" }]));
	add(msg("user", "the real question\x1b[2J"), fork);
	add({ type: "custom", customType: "pi-subagent:registry:v1", data: { big: "x".repeat(5000), id: "nested", parentId: "nope" } });
	add(msg("assistant", [{ type: "thinking", thinking: "t1\nt2\nt3\nt4\nt5" }, { type: "text", text: "an answer" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "seq 20" } }]));
	add(msg("toolResult", [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `out ${i}`).join("\n") }], { toolCallId: "c1", toolName: "bash", isError: false }));
	const hidden = add(msg("assistant", [{ type: "text", text: "edited away" }]));
	add({ type: "context_edit", targetId: hidden, replacement: null });
	add(msg("assistant", [{ type: "text", text: "the end" }]));
	const turns = dp.parseConversation(lines.join("\n"));
	const text = dp.pagerText(turns, 60, plainStyle, { title: "t", facts: ["/w"] }).replace(/\x1b\[[0-9;]*m/g, "");
	assert.ok(!text.includes("abandoned") && !text.includes("first question"), "only the active branch");
	assert.ok(!text.includes("edited away"), "context edits honoured");
	assert.ok(text.includes("  the real question") && !text.includes("[2J"), text);
	assert.ok(text.includes("  ┆ t3") && !text.includes("t4") && text.includes("┆ … 2 more lines of thinking"), text);
	assert.ok(text.includes("  ✓ bash seq 20") && text.includes("    │ out 7") && !text.includes("out 8") && text.includes("│ … 12 more lines"), text);
	assert.ok(text.includes("  the end"));
	assert.deepEqual(dp.previewLines(turns, 40, 9, plainStyle), [" ◇ model p/m", " › the real question", " t2", " t3", " t4", " t5", " an answer", " ✓ bash seq 20", " the end"]);
	// 10 MB: mostly subagent registry lines and tool output.
	const big: string[] = [lines[0]!];
	n = 0;
	const reg = JSON.stringify({ data: "r".repeat(20_000) }).slice(1, -1);
	while (big.reduce((a, l) => a + l.length, 0) < 10_000_000) {
		big.push(`{"type":"custom","customType":"pi-subagent:registry-delta:v1",${reg},"id":"e${++n}","parentId":${n > 1 ? `"e${n - 1}"` : "null"}}`);
		big.push(JSON.stringify({ ...msg("assistant", [{ type: "text", text: "word ".repeat(200) }, { type: "toolCall", id: `c${n}`, name: "bash", arguments: { command: "ls" } }]), id: `e${++n}`, parentId: `e${n - 1}` }));
		big.push(JSON.stringify({ ...msg("toolResult", [{ type: "text", text: "line\n".repeat(2000) }], { toolCallId: `c${n}`, toolName: "bash", isError: false }), id: `e${++n}`, parentId: `e${n - 1}` }));
	}
	const t0 = Date.now();
	const bigTurns = dp.parseConversation(big.join("\n"));
	const out = dp.pagerText(bigTurns, 100, plainStyle, { title: "big" });
	const ms = Date.now() - t0;
	assert.ok(bigTurns.length > 100 && out.length > 0);
	assert.ok(ms < 1000, `10 MB in ${ms} ms`);
});

test("C-l on a subagent row reads its transcript (Enter in it: its main); deck and outside rows keep C-l = Enter", { skip }, async () => {
	const { view, clock, of, lessExits } = makeView({ height: 30 });
	selectLine(view, "start the old run");
	press(view, KEY.space);
	selectLine(view, "/runner");
	await clock.advance(50);
	assert.match(screen(view, 100).at(-1)!, /⏎ its session {2}C-l read/);
	press(view, KEY.ctrlL);
	await clock.advance(50);
	const req = of("pager")[0]![1] as { file: string; title: string; enter: string };
	assert.deepEqual([req.file, req.title, req.enter], [subFile, "coder /runner of start the old run", "its session"]);
	lessExits(dv.PAGER_RESUME);
	await view.checkPager();
	assert.match(screen(view, 72).find((l) => l.startsWith("▌"))!, /start the old run/);
	assert.equal(of("open").length, 0);
	// A deck row: C-l focuses its pi; an outside row: C-l jumps.
	view.selectSession(IDS.ckpt);
	press(view, KEY.ctrlL);
	view.selectSession(OUT);
	press(view, KEY.ctrlL);
	await clock.advance(50);
	assert.deepEqual([of("focus"), of("jump"), of("pager").length], [[["focus", IDS.ckpt]], [["jump", OUT]], 1]);
});

test("d: inline kill confirm (y or Enter kill, s kill + scancel, n or Esc cancel); never for remote or closed rows", { skip }, async () => {
	const { view, clock, of } = makeView();
	view.selectSession(IDS.ckpt);
	press(view, "d");
	let lines = screen(view);
	assert.match(lines[15]!, /^ Kill ckpt restart\?$/);
	assert.match(lines[19]!, /^ y\/⏎ kill · n\/Esc cancel$/);
	press(view, "s"); // no Slurm jobs: s does nothing
	assert.ok(view.confirming());
	press(view, "n");
	assert.equal(view.confirming(), undefined);
	press(view, "d", KEY.esc);
	assert.equal(view.confirming(), undefined);
	press(view, "d", "y");
	await clock.advance(10);
	assert.deepEqual(of("kill"), [["kill", IDS.ckpt, false]]);
	// Enter confirms like y (no scancel); Esc cancels without killing.
	press(view, "d", KEY.enter);
	await clock.advance(10);
	assert.equal(view.confirming(), undefined);
	assert.deepEqual(of("kill"), [["kill", IDS.ckpt, false], ["kill", IDS.ckpt, false]]);
	press(view, "d", KEY.esc);
	await clock.advance(10);
	assert.equal(view.confirming(), undefined);
	assert.equal(of("kill").length, 2);
	assert.equal(view.mode, "normal");
	// sweep: a Slurm job; s kills and scancels.
	view.selectSession(IDS.sweep);
	press(view, "d");
	await clock.advance(10);
	lines = screen(view, 120);
	assert.match(lines[15]!, /Kill physicsnemo sweep\? agent working · 2 subagents working · Slurm 4242 running/);
	assert.match(lines[19]!, /y\/⏎ kill · s kill\+scancel · n\/Esc cancel/);
	press(view, "s");
	await clock.advance(10);
	assert.deepEqual(of("kill")[2], ["kill", IDS.sweep, true]);
	// With Slurm jobs, Enter still kills only the session (jobs left running).
	press(view, "d");
	await clock.advance(10);
	press(view, KEY.enter);
	await clock.advance(10);
	assert.deepEqual(of("kill")[3], ["kill", IDS.sweep, false]);
	view.selectSession(IDS.notes);
	press(view, "d");
	assert.equal(view.confirming(), undefined);
	assert.match(screen(view)[19]!, /runs on other-node: kill it there/);
});

test("watching a waiting session for 1 s (client attached) acknowledges it; moving on earlier does not", { skip }, async () => {
	const { view, clock, of } = makeView();
	view.selectSession(IDS.sweep);
	await clock.advance(50);
	press(view, "k"); // ckpt: waiting, run r2, not acked
	await clock.advance(dv.SWAP_COALESCE_MS + 500);
	press(view, "j");
	await clock.advance(2000);
	assert.deepEqual(of("ack"), []);
	press(view, "k");
	await clock.advance(dv.SWAP_COALESCE_MS + dv.ACK_MS - 50);
	assert.deepEqual(of("ack"), []);
	await clock.advance(60);
	assert.deepEqual(of("ack"), [["ack", IDS.ckpt, "r2"]]);
	// Outside sessions too (the holder shows them).
	view.selectSession(OUT);
	await clock.advance(dv.SWAP_COALESCE_MS + dv.ACK_MS + 10);
	assert.deepEqual(of("ack").at(-1), ["ack", OUT, "r3"]);
});

test("reconcile's replacement: a dead nvim gives back its pi; a dead pi the next deck row", { skip }, () => {
	const { view } = makeView();
	assert.equal(view.replacementFor(IDS.sweep), "%21", "the session's own pi lives");
	const { view: v2 } = makeView({ panes: [pane({ pane: "%22", session: IDS.ckpt })] });
	assert.equal(v2.replacementFor(IDS.sweep), "%22");
	assert.equal(v2.selectedItemKey(), `m:${IDS.ckpt}`);
	const { view: v3 } = makeView({ panes: [] });
	assert.equal(v3.replacementFor(IDS.sweep), undefined, "no deck row left: the holder");
});

// ---------------------------------------------------------------- controller: watch, bar, bell, timers

test("barText: questions, unseen waiting, errors and crashes, tmux-colored", { skip }, () => {
	const source = new dv.DeckSource(fx.env);
	source.readAllStatuses();
	source.rescan();
	assert.equal(dv.barText(source.rows()), "π #[fg=colour208,bold]1?#[default] #[fg=colour78]2◐#[default] #[fg=colour196]1✕#[default] ");
	assert.equal(dv.barText([]), "");
	assert.deepEqual(dv.parseOuter("/tmp/tmux-1/default|/dev/pts/3"), { socket: "/tmp/tmux-1/default", client: "/dev/pts/3" });
	assert.equal(dv.outerBarSocket("/tmp/tmux-1/default|c", { PI_FLEET_TMUX_GUARD: "1" }), undefined, "the guard refuses the default server");
	assert.equal(dv.outerBarSocket("/tmp/tmux-1/x-outer|c", { PI_FLEET_TMUX_GUARD: "1" }), "/tmp/tmux-1/x-outer");
});

test("controller: no timer shorter than 15 s; status events debounced; bar written once per change; bell on entering waiting", { skip }, async () => {
	const { view, clock, source } = makeView();
	const intervals: number[] = [];
	const bars: string[] = [];
	let bells = 0;
	let onEvent: (name: string | null) => void = () => {};
	const controller = new dv.DeckController({
		source,
		view,
		env: fx.env,
		timers: clock,
		requestRender: () => {},
		hooks: {
			setBar: async (t) => void bars.push(t),
			bell: () => bells++,
			watchDir: (_dir, cb) => ((onEvent = cb), () => {}),
			setInterval: (_fn, ms) => (intervals.push(ms), intervals.length),
			clearInterval: () => {},
		},
	});
	controller.start();
	assert.deepEqual(intervals, [dv.LIVENESS_MS, dv.RESCAN_MS]);
	assert.ok(Math.min(...intervals) >= 15_000);
	await clock.advance(dv.BAR_DEBOUNCE_MS);
	assert.equal(bars.length, 1);
	assert.equal(bells, 0, "no bell for what was already waiting at start");
	// flare's question is answered; three events for one file → one re-read after the debounce.
	const flare = JSON.parse(readFileSync(join(fx.statusDir, `${IDS.flare}.json`), "utf8"));
	try {
		fx.writeStatus(IDS.flare, { ...flare, state: "running", sub: "tool:read" });
		for (let i = 0; i < 3; i++) onEvent(`${IDS.flare}.json`);
		onEvent(`${IDS.flare}.seen`); // not a status file
		await clock.advance(dv.STATUS_DEBOUNCE_MS - 1);
		assert.equal(view.rows.find((r) => r.id === IDS.flare)!.state, "question");
		await clock.advance(1);
		assert.equal(view.rows.find((r) => r.id === IDS.flare)!.state, "running");
		await clock.advance(dv.BAR_DEBOUNCE_MS);
		assert.equal(bars.length, 2);
		assert.doesNotMatch(bars[1]!, /\?/);
		// The same bar again: not rewritten. Entering waiting rings once.
		onEvent(`${IDS.flare}.json`);
		await clock.advance(dv.STATUS_DEBOUNCE_MS + dv.BAR_DEBOUNCE_MS);
		assert.equal(bars.length, 2);
		fx.writeStatus(IDS.flare, { ...flare, state: "waiting", runId: "r9" });
		onEvent(`${IDS.flare}.json`);
		await clock.advance(dv.STATUS_DEBOUNCE_MS);
		assert.equal(bells, 1);
	} finally {
		fx.writeStatus(IDS.flare, flare);
	}
	await controller.stop();
	assert.equal(bars.at(-1), "", "cleared on exit");
	view.dispose();
});

test("controller with a real fs.watch: a status write shows in the list within 300 ms", { skip }, async () => {
	const source = new dv.DeckSource(fx.env);
	const view = new dv.DeckView({ source, ops: fakeOps().ops, style, height: () => 20, requestRender: () => {}, deckSocket: "/tmp/fake-deck-sock" });
	view.setPanes(PANES);
	const { watch } = await import("node:fs");
	const controller = new dv.DeckController({
		source,
		view,
		env: fx.env,
		requestRender: () => {},
		hooks: {
			setBar: async () => {},
			bell: () => {},
			watchDir: (dir, cb) => {
				const w = watch(dir, { persistent: false }, (_e, name) => cb(name ? String(name) : null));
				return () => w.close();
			},
			setInterval: () => 0,
			clearInterval: () => {},
		},
	});
	controller.start();
	const NEW = "00000000-0000-7000-8000-00000000e001";
	const now = new Date().toISOString();
	const t0 = Date.now();
	const tmp = join(fx.statusDir, `.${NEW}.tmp`);
	writeFileSync(tmp, JSON.stringify({ v: 1, sessionId: NEW, cwd: fx.repos.gamma, repo: fx.repos.gamma, host: hostname(), pid: process.pid, name: "fresh one", state: "running", acked: true, since: now, heartbeat: now, subagents: {} }));
	(await import("node:fs")).renameSync(tmp, join(fx.statusDir, `${NEW}.json`));
	try {
		for (;;) {
			if (view.rows.some((r) => r.id === NEW)) break;
			if (Date.now() - t0 > 2000) throw new Error("no refresh");
			await new Promise((r) => setTimeout(r, 5));
		}
		const ms = Date.now() - t0;
		assert.ok(ms < 300, `refreshed after ${ms} ms`);
		assert.ok(screen(view).some((l) => l.includes("fresh one")));
	} finally {
		(await import("node:fs")).rmSync(join(fx.statusDir, `${NEW}.json`), { force: true });
		await controller.stop();
		view.dispose();
	}
});
