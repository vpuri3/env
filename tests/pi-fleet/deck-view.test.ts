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
	};
	const of = (kind: string) => calls.filter((c) => c[0] === kind);
	return { ops, calls, watchers, of };
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
		"  ? flare refactor                 question 12m       $0.80 1◐",
		"  ◌ what does gamma do?            2d ago",
		" ▾ beta (2, 1 closed)",
		"  ✕ crashy                         crashed just now         1 interrupt…",
		"  ⇢ notes                          live on other-n…",
		"  ◌ forked idea                    1d ago",
		" ▾ alpha (2, 1 closed)",
		"  ◐ ckpt restart                   done 2m ago        $0.40",
		"▌› ● physicsnemo sweep              bash 4m            $3.41 2w 1◐ 3✓",
		"  ◌ start the old run              3h ago                   1✓ 1 interr…",
		" ▾ outside (your tmux) (1)",
		"  ◐ notes outside ⇱ win 3          done 5m ago",
	]);
	// The selection is padded to the full width.
	const sel = view.render(72).find((l) => l.startsWith("\x1b[7m"))!;
	assert.equal(strip(sel).length, 1 + 72);
	assert.deepEqual(lines.slice(13, 15), ["", ""]);
	// The search bar in a box: badge and count on the top border, the color legend on the bottom one.
	assert.deepEqual(lines.slice(16), [
		`╭─ NORMAL ${"─".repeat(55)} 9/9 ─╮`,
		`│ ⌕${" ".repeat(68)}│`,
		`╰─ ○ active  ● working  ◐ done  ? needs input  ✕ error  » auto ${"─".repeat(8)}╯`,
		" j/k move  ⏎/C-l open  a new  d kill  i / search  ? help  q detach",
	]);
	assert.equal(lines[15], " physicsnemo sweep · ● working · tool bash · for 4m · $3.41 · subagents…");
	assert.match(screen(view, 140)[15]!, /^ physicsnemo sweep · ● working · tool bash · for 4m · \$3\.41 · subagents 2w 1◐ 3✓ · \/.*\/work\/alpha$/);
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
	assert.deepEqual(lines.slice(0, 2), [" ▾ gamma (1)", "▌› ? flare refactor                 question 12m       $0.80 1◐"]);
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
	assert.deepEqual(names().slice(0, 2).map((l) => l.trimEnd()), [" ▾ alpha (1 closed)", "▌› ◌ alpha closed 6h                6h ago"]);
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
	// q and C-c detach (close the popup); the list keeps running.
	press(view, "q", "\x03");
	assert.equal(of("detach").length, 2);
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
