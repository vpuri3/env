// Stub pi for the deck tests (PI_FLEET_PI_CMD="node .../deck-stub-pi.mjs"). Per session ($PI_FLEET_SESSION),
// in $PI_FLEET_STUB_DIR:
//   <id>.runs   "pid pane deck args..." per start
//   <id>.keys   every byte typed into it (raw mode; asks for extended keys like pi does)
//   <id>.winch  one line "COLSxROWS" per SIGWINCH
// It exits with the code a test writes to <id>.exit (the file is consumed).
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PI_FLEET_STUB_DIR;
const id = process.env.PI_FLEET_SESSION || "none";
const file = (ext) => join(dir, `${id}.${ext}`);
appendFileSync(file("runs"), `${process.pid} ${process.env.TMUX_PANE ?? ""} ${process.env.PI_FLEET_DECK ?? ""} ${process.argv.slice(2).join(" ")}\n`);
// getWindowSize() asks the tty now (stdout.columns may not be refreshed yet when this handler runs).
process.on("SIGWINCH", () => {
	const [cols, rows] = process.stdout.getWindowSize();
	appendFileSync(file("winch"), `${cols}x${rows}${process.env.DECK_STUB_TS ? ` ${Date.now()}` : ""}\n`);
});
// modifyOtherKeys 1: tmux (extended-keys on) then forwards Shift+Enter as an extended key.
process.stdout.write(`stub pi ${id}\r\n\x1b[>4;1m`);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (d) => appendFileSync(file("keys"), d));
const timer = setInterval(() => {
	if (!existsSync(file("exit"))) return;
	const code = Number(readFileSync(file("exit"), "utf8").trim()) || 0;
	rmSync(file("exit"), { force: true });
	clearInterval(timer);
	process.exit(code);
}, 50);
