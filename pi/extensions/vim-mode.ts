/**
 * vim-mode: modal focus between the transcript (NORMAL) and the prompt (INSERT).
 *
 * NORMAL mode (keys act on the message history, nothing is typed):
 *   j / k            scroll 1 line down / up
 *   ctrl+e / ctrl+y  scroll 1 line down / up
 *   ctrl+d / ctrl+u  half page down / up
 *   ctrl+f / ctrl+b  full page down / up
 *   gg / G           top / bottom (bottom re-enables follow)
 *   { / }            previous / next user prompt
 *   / and ?          search forward / backward; type query, Enter confirms
 *   n / N            next / previous match (direction relative to / or ?)
 *   Esc              clear active search; otherwise interrupt agent
 *   i a I A          enter INSERT mode
 *   Enter, ctrl+c, other ctrl/alt keys pass through to pi as usual
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

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Mode = "normal" | "insert";

// Shared across editor instances so search-confirm can hand focus back.
let currentEditor: VimModeEditor | undefined;

class VimModeEditor extends CustomEditor {
	mode: Mode = "insert";
	searchDir: 1 | -1 = 1;
	private pendingG = false;
	private screen: any;

	constructor(tui: any, theme: any, keybindings: any) {
		super(tui, theme, keybindings);
		this.screen = tui;
		currentEditor = this;
	}

	private canScroll(): boolean {
		return typeof this.screen?.scrollBy === "function";
	}

	private viewportHeight(): number {
		return this.screen.getPrimaryScrollView?.().viewportHeight ?? 20;
	}

	private setMode(mode: Mode): void {
		this.mode = mode;
		this.pendingG = false;
		this.invalidate();
		this.screen.requestRender?.();
	}

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

		// ---- NORMAL mode ----
		const s = this.screen;

		if (matchesKey(data, "escape")) {
			this.pendingG = false;
			if (s.activeSearch) {
				s.closeSearch();
				return;
			}
			super.handleInput(data); // app.interrupt
			return;
		}

		// gg
		if (data === "g") {
			if (this.pendingG) {
				this.pendingG = false;
				if (this.canScroll()) s.scrollToTop();
			} else {
				this.pendingG = true;
			}
			return;
		}
		this.pendingG = false;

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
		}

		if (this.canScroll()) {
			const h = this.viewportHeight();
			const half = Math.max(1, Math.floor(h / 2));
			const page = Math.max(1, h - 2);

			if (data === "j" || matchesKey(data, "ctrl+e")) return s.scrollBy(1);
			if (data === "k" || matchesKey(data, "ctrl+y")) return s.scrollBy(-1);
			if (matchesKey(data, "ctrl+d")) return s.scrollBy(half);
			if (matchesKey(data, "ctrl+u")) return s.scrollBy(-half);
			if (matchesKey(data, "ctrl+f")) return s.scrollBy(page);
			if (matchesKey(data, "ctrl+b")) return s.scrollBy(-page);
			if (data === "G") return s.scrollToBottom();
			if (data === "{") return s.scrollToPrompt(-1);
			if (data === "}") return s.scrollToPrompt(1);

			if (data === "/" || data === "?") {
				this.searchDir = data === "/" ? 1 : -1;
				if (s.activeSearch) s.closeSearch();
				s.toggleSearch(); // opens overlay and focuses it
				return;
			}
			if (data === "n" || data === "N") {
				if (s.activeSearch) s.navigateSearch(data === "n" ? this.searchDir : -this.searchDir);
				return;
			}
		}

		// Swallow other printable characters; pass control keys (enter, ctrl+c, ...) to pi.
		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

// Transcript search highlights. 256-color cube indexes (16-231) are not remapped by
// terminal color schemes, so these look the same on any theme or background.
// Matches: black on bright yellow (like vim Search); current match: bold black on magenta.
const SEARCH_MATCH = { fg: 16, bg: 226 };
const SEARCH_CURRENT = { fg: 16, bg: 201 };

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

			// Enter inside the search box: confirm, keep highlights, return focus to NORMAL mode.
			// Registered after pi's transcript listener; works because searchNext is not bound to Enter.
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
					if (ed) ed.mode = "normal";
					tui.requestRender();
					return { consume: true };
				});
			}
			return editor;
		});
	});
}
