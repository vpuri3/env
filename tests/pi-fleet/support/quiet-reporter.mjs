// A node --test reporter for agents (tests/pi_fleet_test.sh -q): one block per failing test (file:line,
// name, the assertion message without stack frames), then a one-line summary. Everything else (passes,
// test output, stacks) goes to the spec reporter's log file only.
import { relative } from "node:path";

const MAX_LINES = 30;

function message(error) {
	// The runner wraps the thrown error (failureType testCodeFailure, hookFailure, cancelledByParent, ...).
	const cause = error?.cause ?? error;
	let text = cause instanceof Error ? cause.message : String(cause ?? error?.message ?? "failed");
	if (error?.failureType && error.failureType !== "testCodeFailure") text = `${error.failureType}: ${text}`;
	const lines = text.replace(/\n+$/, "").split("\n");
	return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines (full log)`] : lines;
}

export default async function* quietReporter(source) {
	const start = Date.now();
	let pass = 0;
	let fail = 0;
	let skipped = 0;
	let todo = 0;
	for await (const event of source) {
		const data = event.data;
		if (event.type !== "test:pass" && event.type !== "test:fail") continue;
		if (data.details?.type === "suite") continue;
		if (data.skip !== undefined && data.skip !== false) {
			skipped++;
			continue;
		}
		if (data.todo !== undefined && data.todo !== false) {
			todo++;
			continue;
		}
		if (event.type === "test:pass") {
			pass++;
			continue;
		}
		const error = data.details?.error;
		// A parent failing only because a subtest did is not news.
		if (error?.failureType === "subtestsFailed") continue;
		fail++;
		const rel = data.file ? relative(process.cwd(), data.file) : "";
		const where = data.file ? `${rel.startsWith("..") ? data.file : rel}${data.line ? `:${data.line}` : ""}` : "";
		const ms = data.details?.duration_ms;
		yield `✖ ${where} ${data.name}${ms >= 500 ? ` (${(ms / 1000).toFixed(1)} s)` : ""}\n`;
		yield `${message(error).map((l) => `    ${l}`).join("\n")}\n`;
	}
	const total = pass + fail + skipped + todo;
	const secs = ((Date.now() - start) / 1000).toFixed(1);
	const extra = [skipped && `${skipped} skipped`, todo && `${todo} todo`].filter(Boolean).join(", ");
	yield `${fail ? "FAIL" : "ok"}: ${pass}/${total} passed${fail ? `, ${fail} failed` : ""}${extra ? `, ${extra}` : ""} in ${secs} s\n`;
}
