/**
 * vim-mode: modal focus between the transcript (NORMAL) and the prompt (INSERT).
 *
 * NORMAL mode works like tmux copy-mode-vi: a block cursor on the transcript.
 *   h j k l          cursor left / down / up / right (scrolls at the edges)
 *   w b e  W B E     word motions
 *   0 ^ $            line start / first non-blank / line end
 *   H M L            top / middle / bottom of the screen
 *   gg / G           top / bottom of the transcript (G re-enables follow)
 *   ctrl+e / ctrl+y  scroll 1 line;  ctrl+d / ctrl+u half page;  ctrl+f / ctrl+b page
 *   { / }            previous / next user prompt
 *   / and ?          search forward / backward; Enter confirms, cursor jumps to the match
 *   n / N            next / previous match
 *   counts           5j, 3w, ...
 * Selection and copy (same keys as ~/env/tmux.conf):
 *   Space            start a selection at the cursor
 *   V                select whole lines
 *   v                toggle rectangle (block) selection
 *   o                jump to the other end of the selection
 *   y / Enter        copy to the system clipboard (and the tmux buffer inside tmux),
 *                    then leave NORMAL mode and jump to the bottom, like copy-pipe-and-cancel
 *   Esc              clear the selection; else close the search; else interrupt the agent
 *   q                leave NORMAL mode and jump to the bottom
 *   p                paste the last copy into the prompt (INSERT mode)
 *   i a I A          enter INSERT mode
 *   Enter (no selection), ctrl+c and other ctrl/alt keys pass through to pi as usual
 *
 * INSERT mode: everything goes to the prompt. Esc -> NORMAL.
 *   ctrl+p / ctrl+n move through the autocomplete menu while it is open.
 *
 * Also recolors transcript search matches (see SEARCH_MATCH / SEARCH_CURRENT).
 *
 * Requires fullscreen (alt-screen) mode; transcript scrolling does not exist otherwise.
 * No plain-letter keys may be bound in keybindings.json: the transcript key handler
 * runs before the editor and would steal them in INSERT mode.
 */

import { spawn } from "node:child_process";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	matchesKey,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

type Mode = "normal" | "insert";
type Pt = { row: number; col: number };
type Cell = { start: number; end: number; ch: string };

// Transcript search highlights. 256-color cube indexes (16-231) are not remapped by
// terminal color schemes, so these look the same on any theme or background.
// Matches: black on bright yellow (like vim Search); current match: bold black on magenta.
const SEARCH_MATCH = { fg: 16, bg: 226 };
const SEARCH_CURRENT = { fg: 16, bg: 201 };
// Copy-mode selection: black on light blue. Cursor: reverse video (looks like the terminal cursor).
const SELECTION = "\x1b[0;38;5;16;48;5;117m";
const CURSOR = "\x1b[0;7m";
const RESET = "\x1b[0m";
// pi-tui wraps the prompt's fake cursor in these (tui.js renderFakeCursor).
const FAKE_CURSOR_START = "\x1b_pi:fc\x07";
const FAKE_CURSOR_END = "\x1b_pi:/fc\x07";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Shared across editor instances so search-confirm and the render hook can find it.
let currentEditor: VimModeEditor | undefined;

function findBox(box: any, scrollView: any): any {
	if (!box) return undefined;
	if (box.scrollView === scrollView) return box;
	for (const child of box.children ?? []) {
		const hit = findBox(child, scrollView);
		if (hit) return hit;
	}
	return undefined;
}

function toCells(line: string): Cell[] {
	const cells: Cell[] = [];
	let col = 0;
	for (const { segment } of graphemes.segment(stripTerminalSequences(line))) {
		const w = visibleWidth(segment);
		if (w === 0) continue;
		cells.push({ start: col, end: col + w, ch: segment });
		col += w;
	}
	return cells;
}

// Width of a line's text without trailing spaces.
function textWidth(cells: Cell[]): number {
	for (let i = cells.length - 1; i >= 0; i--) if (cells[i]!.ch.trim()) return cells[i]!.end;
	return 0;
}

function charClass(ch: string, big: boolean): number {
	if (!ch.trim()) return 0;
	if (big) return 1;
	return /[\p{L}\p{N}_]/u.test(ch) ? 1 : 2;
}

function isImageLine(line: string): boolean {
	return line.includes("\x1b_G") || line.includes("\x1b]1337;File");
}

class VimModeEditor extends CustomEditor {
	mode: Mode = "insert";
	searchDir: 1 | -1 = 1;
	cursor: Pt | undefined;
	anchor: Pt | undefined; // selection start; undefined = no selection
	lineSelect = false;
	block = false;
	pendingSearchJump = false;
	private pendingG = false;
	private count = "";
	private wantCol = 0;
	private lastCopy = "";
	private screen: any;
	private cellCache = new Map<number, Cell[]>();

	constructor(tui: any, theme: any, keybindings: any) {
		super(tui, theme, keybindings);
		this.screen = tui;
		currentEditor = this;
	}

	// ---- transcript geometry ----

	private canScroll(): boolean {
		return typeof this.screen?.scrollBy === "function";
	}

	private view(): any {
		return this.screen.getPrimaryScrollView?.();
	}

	private contentLines(): string[] | undefined {
		const layout = this.screen.currentLayout;
		if (!layout) return undefined;
		return findBox(layout.root, this.view())?.scrollContentLines;
	}

	private cells(row: number): Cell[] {
		let c = this.cellCache.get(row);
		if (!c) {
			c = toCells(this.contentLines()?.[row] ?? "");
			this.cellCache.set(row, c);
		}
		return c;
	}

	private viewportHeight(): number {
		return this.view()?.viewportHeight ?? 20;
	}

	// Snap a column to the start of the character under it, within the line's text.
	private snapCol(row: number, col: number): number {
		const cells = this.cells(row);
		if (cells.length === 0) return 0;
		for (const c of cells) if (col < c.end) return c.start;
		return cells[cells.length - 1]!.start;
	}

	private cellIndex(p: Pt): number {
		const cells = this.cells(p.row);
		const i = cells.findIndex((c) => p.col < c.end);
		return i < 0 ? Math.max(0, cells.length - 1) : i;
	}

	// Put the cursor back on screen (after wheel scrolling or new output), creating it if needed.
	private ensureCursor(total: number): Pt {
		const top = this.view().scrollTop;
		const bottom = Math.min(total - 1, top + this.viewportHeight() - 1);
		if (!this.cursor) {
			let row = bottom;
			while (row > top && textWidth(this.cells(row)) === 0) row--;
			this.cursor = { row, col: 0 };
			this.wantCol = 0;
		} else if (this.cursor.row < top || this.cursor.row > bottom) {
			const row = Math.max(top, Math.min(bottom, this.cursor.row));
			this.cursor = { row, col: this.snapCol(row, this.wantCol) };
		}
		return this.cursor;
	}

	private reveal(row: number): void {
		const top = this.view().scrollTop;
		const h = this.viewportHeight();
		if (row < top) this.screen.scrollBy(row - top);
		else if (row > top + h - 1) this.screen.scrollBy(row - (top + h - 1));
	}

	private moveTo(row: number, col: number, keepWant = false): void {
		const total = this.contentLines()?.length ?? 0;
		if (total === 0) return;
		row = Math.max(0, Math.min(total - 1, row));
		this.cursor = { row, col: this.snapCol(row, col) };
		if (!keepWant) this.wantCol = this.cursor.col;
		this.reveal(row);
		this.screen.requestRender?.();
	}

	// Scroll the view and carry the cursor by the same amount (tmux halfpage/page behavior).
	private scrollWithCursor(delta: number): void {
		const before = this.view().scrollTop;
		this.screen.scrollBy(delta);
		const moved = this.view().scrollTop - before;
		const c = this.cursor!;
		const total = this.contentLines()?.length ?? 0;
		const row = Math.max(0, Math.min(total - 1, c.row + (moved === 0 ? delta : moved)));
		this.moveTo(row, this.wantCol, true);
	}

	// ---- word motions ----

	private next(p: { row: number; i: number }, total: number) {
		if (p.i + 1 < this.cells(p.row).length) return { row: p.row, i: p.i + 1 };
		return p.row + 1 < total ? { row: p.row + 1, i: 0 } : undefined;
	}

	private prev(p: { row: number; i: number }) {
		if (p.i > 0) return { row: p.row, i: p.i - 1 };
		if (p.row === 0) return undefined;
		return { row: p.row - 1, i: Math.max(0, this.cells(p.row - 1).length - 1) };
	}

	private cls(p: { row: number; i: number }, big: boolean): number {
		const c = this.cells(p.row)[p.i];
		return c ? charClass(c.ch, big) : 0;
	}

	private wordMotion(kind: "w" | "b" | "e", big: boolean, total: number): void {
		let p = { row: this.cursor!.row, i: this.cellIndex(this.cursor!) };
		let n: { row: number; i: number } | undefined;
		if (kind === "w") {
			const c0 = this.cls(p, big);
			if (c0 !== 0) {
				for (;;) {
					n = this.next(p, total);
					if (!n) break;
					const crossed = n.row !== p.row;
					p = n;
					if (crossed || this.cls(p, big) !== c0) break;
				}
			}
			while (this.cls(p, big) === 0 && (n = this.next(p, total))) p = n;
		} else {
			const step = (q: { row: number; i: number }) => (kind === "e" ? this.next(q, total) : this.prev(q));
			if ((n = step(p))) p = n;
			while (this.cls(p, big) === 0 && (n = step(p))) p = n;
			const c = this.cls(p, big);
			while ((n = step(p)) && n.row === p.row && this.cls(n, big) === c) p = n;
		}
		this.moveTo(p.row, this.cells(p.row)[p.i]?.start ?? 0);
	}

	// ---- selection ----

	private selection(): { start: Pt; end: Pt } | undefined {
		if (!this.anchor || !this.cursor) return undefined;
		const a = this.anchor;
		const c = this.cursor;
		const aFirst = a.row < c.row || (a.row === c.row && a.col <= c.col);
		return aFirst ? { start: a, end: c } : { start: c, end: a };
	}

	// Cell columns [from, to) selected on a row, or undefined.
	selectedColumns(row: number): [number, number] | undefined {
		const sel = this.selection();
		if (!sel || row < sel.start.row || row > sel.end.row) return undefined;
		const cells = this.cells(row);
		const lineEnd = textWidth(cells);
		if (this.lineSelect) return [0, lineEnd];
		const endOf = (p: Pt) => {
			const cell = this.cells(p.row).find((x) => p.col < x.end);
			return cell ? cell.end : p.col + 1;
		};
		if (this.block) {
			const from = Math.min(sel.start.col, sel.end.col);
			const to = Math.max(endOf(sel.start), endOf(sel.end));
			return [from, to];
		}
		const from = row === sel.start.row ? sel.start.col : 0;
		const to = row === sel.end.row ? endOf(sel.end) : lineEnd;
		return [from, Math.max(from, to)];
	}

	private selectionText(): string {
		const sel = this.selection();
		const lines = this.contentLines();
		if (!sel || !lines) return "";
		const out: string[] = [];
		for (let row = sel.start.row; row <= sel.end.row; row++) {
			const cols = this.selectedColumns(row);
			if (!cols) continue;
			const text = sliceByColumn(lines[row] ?? "", cols[0], Math.max(0, cols[1] - cols[0]), true);
			out.push(stripTerminalSequences(text).trimEnd());
		}
		return out.join("\n");
	}

	private clearSelection(): void {
		this.anchor = undefined;
		this.lineSelect = false;
		this.block = false;
	}

	private copySelection(): void {
		const text = this.selectionText();
		if (!text) return;
		this.lastCopy = text;
		void this.screen.copyTextToClipboard?.(text); // pi's clipboard path; flashes "Copied!"
		if (process.env.TMUX) {
			// Same buffer tmux's own `y` fills, so prefix+] pastes it.
			try {
				const p = spawn("tmux", ["load-buffer", "-"], { stdio: ["pipe", "ignore", "ignore"] });
				p.on("error", () => {});
				p.stdin.end(text);
			} catch {
				// tmux buffer is best-effort
			}
		}
		this.leaveNormal();
	}

	// tmux "cancel": back to the prompt and the live end of the transcript.
	private leaveNormal(): void {
		this.clearSelection();
		this.setMode("insert");
		if (this.canScroll()) this.screen.scrollToBottom();
	}

	setMode(mode: Mode): void {
		this.mode = mode;
		this.pendingG = false;
		this.count = "";
		if (mode === "insert") this.clearSelection();
		if (mode === "normal" && this.canScroll()) {
			this.cellCache.clear();
			const total = this.contentLines()?.length ?? 0;
			if (total > 0) this.ensureCursor(total);
		}
		this.invalidate();
		this.screen.requestRender?.();
	}

	// ---- input ----

	handleInput(data: string): void {
		if (this.mode === "insert") {
			if (matchesKey(data, "escape")) {
				this.setMode("normal");
				return;
			}
			// ctrl+p/n move the autocomplete menu (otherwise app.model.cycle* would see ctrl+p first).
			if (this.isShowingAutocomplete()) {
				if (matchesKey(data, "ctrl+p")) return super.handleInput("\x1b[A");
				if (matchesKey(data, "ctrl+n")) return super.handleInput("\x1b[B");
			}
			super.handleInput(data);
			return;
		}
		this.cellCache.clear(); // content may have changed since the last key
		this.normalKey(data);
	}

	private normalKey(data: string): void {
		const s = this.screen;

		if (matchesKey(data, "escape")) {
			this.pendingG = false;
			this.count = "";
			if (this.anchor) {
				this.clearSelection();
				s.requestRender?.();
				return;
			}
			if (s.activeSearch) {
				s.closeSearch();
				return;
			}
			super.handleInput(data); // app.interrupt
			return;
		}

		switch (data) {
			case "i":
				this.setMode("insert");
				return;
			case "a":
				this.setMode("insert");
				super.handleInput("\x1b[C");
				return;
			case "I":
				this.setMode("insert");
				super.handleInput("\x1b[H");
				return;
			case "A":
				this.setMode("insert");
				super.handleInput("\x1b[F");
				return;
			case "q":
				this.leaveNormal();
				return;
			case "p":
				if (this.lastCopy) {
					this.setMode("insert");
					super.handleInput(`\x1b[200~${this.lastCopy}\x1b[201~`);
				}
				return;
		}

		const total = this.canScroll() ? (this.contentLines()?.length ?? 0) : 0;
		if (total === 0) {
			if (data.length === 1 && data.charCodeAt(0) >= 32) return;
			super.handleInput(data);
			return;
		}

		// Counts: 1-9 start one, 0 continues it (a bare 0 is "line start").
		if (/^[1-9]$/.test(data) || (data === "0" && this.count)) {
			this.count += data;
			return;
		}
		const n = Math.max(1, Math.min(100000, parseInt(this.count || "1", 10)));
		this.count = "";

		if (data === "g") {
			if (this.pendingG) {
				this.pendingG = false;
				this.ensureCursor(total);
				this.moveTo(0, 0);
				s.scrollToTop();
			} else {
				this.pendingG = true;
			}
			return;
		}
		this.pendingG = false;

		const c = this.ensureCursor(total);
		const h = this.viewportHeight();
		const top = this.view().scrollTop;
		const half = Math.max(1, Math.floor(h / 2));
		const page = Math.max(1, h - 2);
		const cells = this.cells(c.row);
		const idx = this.cellIndex(c);

		switch (data) {
			case "j":
				return this.moveTo(c.row + n, this.wantCol, true);
			case "k":
				return this.moveTo(c.row - n, this.wantCol, true);
			case "h":
				return this.moveTo(c.row, cells[Math.max(0, idx - n)]?.start ?? 0);
			case "l":
				return this.moveTo(c.row, cells[Math.min(cells.length - 1, idx + n)]?.start ?? 0);
			case "0":
				return this.moveTo(c.row, 0);
			case "^": {
				const first = cells.find((x) => x.ch.trim());
				return this.moveTo(c.row, first?.start ?? 0);
			}
			case "$":
				this.moveTo(c.row, Math.max(0, textWidth(cells) - 1));
				this.wantCol = Number.MAX_SAFE_INTEGER;
				return;
			case "w":
			case "b":
			case "e":
			case "W":
			case "B":
			case "E": {
				const kind = data.toLowerCase() as "w" | "b" | "e";
				for (let k = 0; k < n; k++) this.wordMotion(kind, data !== kind, total);
				return;
			}
			case "H":
				return this.moveTo(top, this.wantCol, true);
			case "M":
				return this.moveTo(top + Math.floor((Math.min(h, total - top) - 1) / 2), this.wantCol, true);
			case "L":
				return this.moveTo(Math.min(total - 1, top + h - 1), this.wantCol, true);
			case "G": {
				let row = total - 1;
				while (row > 0 && textWidth(this.cells(row)) === 0) row--;
				this.moveTo(row, 0);
				s.scrollToBottom();
				return;
			}
			case "{":
			case "}":
				for (let k = 0; k < n; k++) s.scrollToPrompt(data === "{" ? -1 : 1);
				return this.moveTo(this.view().scrollTop, 0);
			case " ":
				this.anchor = { ...c };
				this.lineSelect = false;
				s.requestRender?.();
				return;
			case "V":
				this.anchor = { ...c };
				this.lineSelect = true;
				s.requestRender?.();
				return;
			case "v":
				this.block = !this.block;
				if (this.block) this.lineSelect = false;
				s.requestRender?.();
				return;
			case "o":
				if (this.anchor) {
					const a = this.anchor;
					this.anchor = { ...c };
					this.moveTo(a.row, a.col);
				}
				return;
			case "y":
				this.copySelection();
				return;
			case "/":
			case "?":
				this.searchDir = data === "/" ? 1 : -1;
				if (s.activeSearch) s.closeSearch();
				s.toggleSearch(); // opens overlay and focuses it
				return;
			case "n":
			case "N":
				if (s.activeSearch) {
					s.navigateSearch(data === "n" ? this.searchDir : -this.searchDir);
					this.pendingSearchJump = true;
				}
				return;
		}

		if (matchesKey(data, "enter") && this.anchor) return this.copySelection();
		if (matchesKey(data, "ctrl+e")) return this.scrollKeepCursor(n);
		if (matchesKey(data, "ctrl+y")) return this.scrollKeepCursor(-n);
		if (matchesKey(data, "ctrl+d")) return this.scrollWithCursor(half);
		if (matchesKey(data, "ctrl+u")) return this.scrollWithCursor(-half);
		if (matchesKey(data, "ctrl+f")) return this.scrollWithCursor(page);
		if (matchesKey(data, "ctrl+b")) return this.scrollWithCursor(-page);

		// Swallow other printable characters; pass control keys (enter, ctrl+c, ...) to pi.
		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	// ctrl+e / ctrl+y: move the view, leave the cursor where it is unless it falls off screen.
	private scrollKeepCursor(delta: number): void {
		this.screen.scrollBy(delta);
		this.ensureCursor(this.contentLines()?.length ?? 0);
		this.screen.requestRender?.();
	}

	render(width: number): string[] {
		installCopyLayer(this.screen);
		let lines = super.render(width);
		if (lines.length === 0) return lines;
		// One cursor at a time: hide the prompt's block cursor while the transcript has it.
		if (this.mode === "normal") lines = lines.map((l) => l.split(FAKE_CURSOR_START).join("").split(FAKE_CURSOR_END).join(""));
		let label = " INSERT ";
		if (this.mode === "normal") {
			label = !this.anchor ? " NORMAL " : this.lineSelect ? " V-LINE " : this.block ? " V-BLOCK " : " VISUAL ";
			if (!this.anchor && this.block) label = " NORMAL (block) ";
		}
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

// ---- drawing the cursor and selection on the transcript ----

function paintCells(line: string, from: number, to: number, style: string): string {
	const width = visibleWidth(line);
	if (to > width) line += " ".repeat(to - width);
	const before = sliceByColumn(line, 0, from, true);
	const mid = stripTerminalSequences(sliceByColumn(line, from, to - from, true)) || " ";
	const after = sliceByColumn(line, to, Math.max(0, visibleWidth(line) - to), true);
	return `${before}${style}${mid}${RESET}${after}`;
}

function drawCopyLayer(tui: any, screen: string[], layout: any): string[] {
	const ed = currentEditor;
	if (!ed || ed.mode !== "normal" || !layout) return screen;
	const view = layout.primaryScrollView ?? tui.implicitScrollView;
	const box = findBox(layout.root, view);
	if (!box?.scrollContentLines) return screen;

	if (ed.pendingSearchJump) {
		ed.pendingSearchJump = false;
		const search = tui.activeSearch;
		const seg = search?.matches?.[search.selectedIndex]?.segments?.[0];
		if (seg) ed.cursor = { row: seg.row, col: seg.startCol ?? 0 };
	}
	if (!ed.cursor) return screen;

	const top = view.scrollTop;
	const firstRow = Math.max(0, box.rect.y, box.clip.y);
	const lastRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
	const maxCol = Math.min(box.rect.width, box.clip.x + box.clip.width - box.rect.x);
	const out = [...screen];
	for (let y = firstRow; y <= lastRow; y++) {
		const row = top + y - box.rect.y;
		let line = out[y] ?? "";
		if (isImageLine(line)) continue;
		const cols = ed.selectedColumns(row);
		if (cols && cols[1] > cols[0]) {
			line = paintCells(line, box.rect.x + cols[0], box.rect.x + Math.min(maxCol, cols[1]), SELECTION);
		}
		if (row === ed.cursor.row && ed.cursor.col < maxCol) {
			const cells = toCells(box.scrollContentLines[row] ?? "");
			const cell = cells.find((x) => ed.cursor!.col < x.end);
			const w = cell ? cell.end - cell.start : 1;
			line = paintCells(line, box.rect.x + ed.cursor.col, box.rect.x + ed.cursor.col + w, CURSOR);
		}
		out[y] = line;
	}
	return out;
}

// Runs right after pi's own (mouse) selection highlight, before flashes are composited.
function installCopyLayer(tui: any): void {
	if (!tui || tui.__vimCopyLayer || typeof tui.applySelection !== "function") return;
	const original = tui.applySelection;
	tui.applySelection = function (this: any, screen: string[], layout?: any) {
		const result = original.call(this, screen, layout);
		try {
			return drawCopyLayer(this, result, layout ?? this.currentLayout);
		} catch {
			return result;
		}
	};
	tui.__vimCopyLayer = true;
}

function setSearchHighlight(tui: any): void {
	if (!("searchMatchStyle" in tui)) return; // only exists in fullscreen mode
	const paint = (c: { fg: number; bg: number }, bold: boolean) => (text: string) =>
		`\x1b[${bold ? "1;" : ""}38;5;${c.fg};48;5;${c.bg}m${text}\x1b[${bold ? "22;" : ""}39;49m`;
	tui.searchMatchStyle = paint(SEARCH_MATCH, false);
	tui.searchCurrentMatchStyle = paint(SEARCH_CURRENT, true);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setEditorComponent((tui: any, theme, keybindings) => {
			const editor = new VimModeEditor(tui, theme, keybindings);
			setSearchHighlight(tui);
			installCopyLayer(tui);

			// Enter inside the search box: confirm, keep highlights, return focus to NORMAL mode
			// with the cursor on the match. Registered after pi's transcript listener; works
			// because searchNext is not bound to Enter.
			if (!tui.__vimModeSearchHook && typeof tui.addInputListener === "function") {
				tui.__vimModeSearchHook = true;
				tui.addInputListener((data: string) => {
					const search = tui.activeSearch;
					if (!search?.overlay?.isFocused?.()) return undefined;
					if (!matchesKey(data, "enter")) return undefined;
					if (isKeyRelease(data)) return { consume: true };
					const ed = currentEditor;
					if (ed?.searchDir === -1) tui.navigateSearch(-1); // ? : first match above
					search.overlay.unfocus({ target: ed ?? null });
					if (ed) {
						if (ed.mode !== "normal") ed.setMode("normal");
						ed.pendingSearchJump = true;
					}
					tui.requestRender();
					return { consume: true };
				});
			}
			return editor;
		});
	});
}
