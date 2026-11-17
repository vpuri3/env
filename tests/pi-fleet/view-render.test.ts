// Phase 6 moved /view out of compact-tools.ts; its tool rendering must stay byte-identical.
// Renders a matrix of tool rows (collapsed and expanded; running, ok and error; bash, read,
// edit, write, grep, a custom tool, a self-shell tool and one without renderers) with the
// compact-tools.ts in the tree and with the version before the move (git show BASE), and
// compares the lines. Also checks that the old /view command is gone from compact-tools.
// Skipped when pi's packages or the base commit are not available.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piPackages, usePackages } from "./support/view-support.ts";

/** The last commit of compact-tools.ts before phase 6. */
const BASE = "2dd6d1a";
const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../..");

function baseSource(): string | undefined {
	try {
		return execFileSync("git", ["show", `${BASE}:pi/extensions/compact-tools.ts`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

const packages = piPackages();
const source = baseSource();
const skip = !packages ? "pi's packages not found" : !source ? `commit ${BASE} not available` : false;

let tuiMod: typeof import("@earendil-works/pi-tui");
let oldExt: any;
let newExt: any;
let tmp = "";

before(async () => {
	if (skip) return;
	await usePackages(packages!);
	tuiMod = await import("@earendil-works/pi-tui");
	tmp = mkdtempSync(join(tmpdir(), "pfv-render-"));
	writeFileSync(join(tmp, "compact-tools.base.ts"), source!);
	oldExt = (await import(pathToFileURL(join(tmp, "compact-tools.base.ts")).href)).default;
	newExt = (await import("../../pi/extensions/compact-tools.ts")).default;
});

function load(ext: (pi: any) => void) {
	let factory: ((tool: string, next: () => any) => any) | undefined;
	const commands: string[] = [];
	ext({
		on() {},
		registerCommand: (name: string) => commands.push(name),
		registerToolRenderer: (f: any) => (factory = f),
		getSettings: () => ({}),
	});
	return { factory: factory!, commands };
}

const theme = {
	fg: (c: string, t: string) => `<${c}>${t}</${c}>`,
	bg: (c: string, t: string) => `[${c}]${t}[/${c}]`,
	bold: (t: string) => `*${t}*`,
};

function baseRenderers(tool: string): any {
	if (tool === "nothing") return undefined;
	const { Text } = tuiMod;
	const r: any = {
		renderCall: (args: any, th: any) => new Text(th.fg("toolTitle", `${tool} ${JSON.stringify(args)}`), 0, 0),
		renderResult: (res: any, opts: any, th: any) =>
			new Text(th.fg("toolOutput", `${res.content.map((c: any) => c.text).join("|")} exp=${opts?.expanded}`), 0, 0),
	};
	if (tool === "selfshell") r.renderShell = "self";
	if (tool === "throws") r.renderCall = () => {
		throw new Error("boom");
	};
	return r;
}

interface Case {
	tool: string;
	args: any;
	result?: any;
	ctx: any;
}

function cases(): Case[] {
	const ok = (text: string, details?: any) => ({ content: [{ type: "text", text }], details });
	const out: Case[] = [];
	const rows: [string, any, any][] = [
		["bash", { command: "ls -la\n| wc" }, ok("a\nb\nc\n")],
		["bash", { command: "false" }, ok("oops\nCommand exited with code 1")],
		["read", { path: "/w/src/x.py", offset: 10, limit: 5 }, ok("1\n2\n3")],
		["read", { path: "/elsewhere/y.py" }, ok("ENOENT: no such file")],
		["edit", { path: "src/x.py" }, ok("ok", { patch: "--- a\n+++ b\n@@\n-x\n+y\n+z" })],
		["write", { path: "~/notes.md", content: "a\nb\n" }, ok("written")],
		["grep", { pattern: "foo", path: "src", glob: "*.py" }, ok("src/a.py:1:foo\nsrc/b.py:2:foo")],
		["custom_tool", { a: 1, b: "two\nlines", c: [1, 2] }, ok("custom out")],
		["selfshell", { q: "x" }, ok("self")],
		["nothing", { q: "y" }, ok("no renderers")],
		["throws", { q: "z" }, ok("thrown")],
	];
	for (const [tool, args, result] of rows) {
		for (const expanded of [false, true]) {
			for (const state of ["running", "ok", "error"]) {
				const ctx = {
					cwd: "/w",
					expanded,
					isPartial: state === "running",
					isError: state === "error",
					outputPad: tool === "read" ? 2 : undefined,
					durationMs: tool === "bash" ? 72_500 : 1500,
				};
				out.push({ tool, args, result: state === "running" ? undefined : result, ctx });
			}
		}
	}
	return out;
}

function renderAll(factory: (tool: string, next: () => any) => any): string[][] {
	const out: string[][] = [];
	for (const c of cases()) {
		const r = factory(c.tool, () => baseRenderers(c.tool));
		const state: any = {};
		const ctx = { ...c.ctx, state, args: c.args, lastComponent: undefined };
		const row = r.renderCall(c.args, theme, ctx);
		if (c.result) r.renderResult(c.result, { expanded: c.ctx.expanded, isPartial: c.ctx.isPartial }, theme, ctx);
		for (const width of [120, 40, 12]) out.push([`${c.tool} ${JSON.stringify(c.ctx)} w=${width}`, ...row.render(width)]);
		out.push([`${c.tool} shell`, String(r.renderShell)]);
	}
	return out;
}

test("compact-tools rendering is byte-identical to the version before /view moved", { skip }, () => {
	const before = renderAll(load(oldExt).factory);
	const after = renderAll(load(newExt).factory);
	assert.equal(after.length, before.length);
	for (let i = 0; i < before.length; i++) assert.deepEqual(after[i], before[i], before[i][0]);
	// Sanity: the matrix rendered real rows.
	assert.ok(before.some((rows) => rows.some((l) => l.includes("exit 1"))));
	assert.ok(before.some((rows) => rows.some((l) => l.includes("[toolSuccessBg]"))));
	rmSync(tmp, { recursive: true, force: true });
});

test("compact-tools no longer registers /view; the fleet does", { skip }, async () => {
	assert.ok(load(oldExt).commands.includes("view"));
	assert.deepEqual(load(newExt).commands, ["hide-tool-output"]);
	const { register } = await import("../../pi/extensions/fleet/view.ts");
	const names: string[] = [];
	register({ on() {}, registerCommand: (n: string) => names.push(n) } as any);
	assert.deepEqual(names, ["view"]);
});
