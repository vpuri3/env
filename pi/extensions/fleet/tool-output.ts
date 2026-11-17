/**
 * fleet/tool-output: a tool call's full output for `/view tool:N` (design §11; phase 6).
 * Moved here from compact-tools.ts (which keeps its rendering and exports describe/textOf/
 * shortPath for the labels).
 *
 *   edit -> unified diff, write -> written file, read -> file contents (both named after the
 *   file, so nvim picks the filetype), bash -> command + complete output (the untruncated log
 *   when pi spilled it to disk), others -> arguments + output.
 *
 * view.ts shows the document as a read-only scratch buffer in the paired nvim; without one it
 * writes it to <tmpdir>/pi-view/<pid>/<call id>/<name> (writeToolFile) and opens that in
 * `nvim -R`, as compact-tools did. Those files are removed when the main session shuts down.
 * No module-level mutable state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, shortPath, textOf } from "../compact-tools.ts";
import { fleetOf } from "./shared.ts";

type Result = { content: Array<{ type: string; text?: string }>; details?: any; isError?: boolean };

export interface ToolCall {
	id: string;
	name: string;
	args: any;
	result?: Result;
}

/** Tool calls on a session branch (oldest first), each with its result if it has one. */
export function collectCalls(entries: readonly any[]): ToolCall[] {
	const calls: ToolCall[] = [];
	const results = new Map<string, any>();
	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const m = entry.message;
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b?.type === "toolCall") calls.push({ id: b.id, name: b.name, args: b.arguments });
			}
		} else if (m?.role === "toolResult") {
			results.set(m.toolCallId, m);
		}
	}
	for (const c of calls) c.result = results.get(c.id);
	return calls;
}

/** Newest first: recentCalls(entries)[N-1] is `tool:N`. */
export function recentCalls(entries: readonly any[]): ToolCall[] {
	return collectCalls(entries).reverse();
}

/** `✓ bash  ls -la  · exit 0 · 3 lines` (without the number). */
export function callSummary(c: ToolCall, cwd: string, width = 70): string {
	const ctx = { cwd, isError: c.result?.isError, isPartial: !c.result };
	const [target, stats] = describe(c.name, c.args, c.result, ctx);
	const mark = !c.result ? "…" : c.result.isError ? "✗" : "✓";
	const t = target.length > width ? target.slice(0, width - 1) + "…" : target;
	return `${mark} ${c.name}  ${t}${stats.length ? "  · " + stats.join(" · ") : ""}`;
}

/** The select-list label compact-tools' /view used: ` 3. ✓ bash  ls  · exit 0`. */
export function callLabel(c: ToolCall, n: number, cwd: string): string {
	return `${String(n).padStart(2)}. ${callSummary(c, cwd)}`;
}

/** File name (drives nvim's filetype detection) and contents for a call. */
export function toolDocument(c: ToolCall, cwd: string): { name: string; text: string } {
	const a = c.args ?? {};
	const out = textOf(c.result);
	const base = typeof a.path === "string" && a.path ? basename(a.path) : "";
	const argLines = Object.entries(a)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`)
		.join("\n");
	switch (c.name) {
		case "edit": {
			const patch: string | undefined = c.result?.details?.patch;
			if (patch) return { name: `${base || "edit"}.diff`, text: `# ${shortPath(a.path, cwd)}\n${patch}` };
			return { name: `${base || "edit"}.edit.txt`, text: `${argLines}\n\n--- result ---\n${out}` };
		}
		case "write":
			if (typeof a.content === "string") return { name: base || "write.txt", text: a.content };
			break;
		case "read":
			if (!c.result?.isError && out) return { name: base || "read.txt", text: out };
			break;
		case "bash":
		case "powershell": {
			let body = out;
			const full = c.result?.details?.fullOutputPath;
			if (typeof full === "string" && existsSync(full)) body = readFileSync(full, "utf8");
			return { name: `${c.name}.log`, text: `$ ${a.command ?? ""}\n\n${body}` };
		}
	}
	return { name: `${c.name}.txt`, text: `${argLines}\n\n--- result ---\n${out}` };
}

export function viewRoot(pid = process.pid): string {
	return join(tmpdir(), "pi-view", String(pid));
}

/** Write the document to a temp file for the no-fleet fallback; returns its path. */
export function writeToolFile(c: ToolCall, doc: { name: string; text: string }): string {
	const dir = join(viewRoot(), c.id.replace(/[^\w.-]/g, "_"));
	mkdirSync(dir, { recursive: true });
	const file = join(dir, doc.name);
	writeFileSync(file, doc.text.endsWith("\n") ? doc.text : doc.text + "\n");
	return file;
}

/** `tool:N` → N (1-based), else undefined. */
export function parseToolRef(arg: string): number | undefined {
	const m = /^tool:(\d+)$/.exec(arg.trim());
	return m ? Number.parseInt(m[1], 10) : undefined;
}

export function register(pi: ExtensionAPI): void {
	const shared = fleetOf(pi);
	// Temp files are per pi process; the main session removes them when it exits (a subagent
	// in the same process must not delete the main's files).
	pi.on("session_shutdown", async () => {
		if (!shared.main) return;
		try {
			rmSync(viewRoot(), { recursive: true, force: true });
		} catch {
			// best effort
		}
	});
}
