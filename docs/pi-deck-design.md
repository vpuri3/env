# pi-deck: one deck window, pi sessions in a private tmux server

Status: **design, not implemented** (2026-11-17). Replaces the window-per-session part of
[pi-fleet-design.md](pi-fleet-design.md); everything that design says about status files, the
registry, the control socket, the nvim bridge, `/view`, edit delivery and leader keys stays true
unless this document says otherwise. Versions: pi 1.5.2, tmux 3.2a, node 22.

## 1. Why

User feedback on pi-fleet: **cluttered** (`pf` outside tmux leaves window 0 a bare shell,
window 1 pi|nvim, window 2 the dashboard, window 3 the opened session) and **laggy**. The root
cause is coupling one tmux window per session to the user's own tmux, which forces:

| Cost today | Mechanism | Measured / estimated |
|---|---|---|
| status bar | `#(pi-fleet bar)` every 5 s per client | one node start per run: 0.15 s wall, ~0.27 s CPU (`pi-fleet ls` measured) → ~5 % of a core per client, forever |
| window hooks | `session-window-changed` / `client-session-changed` → `pi-fleet seen` | the same node start on **every** window switch |
| dashboard | 1 s index + status rescan, 1 s `capture-pane` of the selected pane | constant wakeups plus one tmux client per second |
| `ctrl+l` join | `join-pane` / `break-pane` resize the pi pane | a full pi redraw on every join and on every return home |
| popup | `display-popup … pi-fleet dashboard` | cold node + pi-tui start (~0.5 s) every time |

For comparison, one tmux client call is ~2 ms (20 `display -p` calls: 37 ms).

## 2. Decisions

1. **A private deck server**: `tmux -L pifleet -f ~/env/pi/deck.tmux.conf`. Every deck pi lives
   as a hidden pane in the session `pool`. The session `deck` has one window `deck`: **left** the
   session list TUI, **right** the selected session's *real* pi pane, swapped in with
   `swap-pane -d`.
2. **Split 50/50**: the list is `50%` of the window (deck option `@deck_list_pct`, default
   50). The list re-applies it with `resize-pane -x` on every SIGWINCH.
3. **Inner prefix is `C-s`, the same as the user's tmux.** Verified: while a `display-popup`
   is open, tmux 3.2a sends *every* key (prefix and root bindings included) to the popup's job,
   so the outer server never sees them. With `pf` outside tmux there is no nesting at all. The
   same chords therefore mean the same things everywhere, and the only clash would be attaching
   the deck in an ordinary outer pane, which `pf` never does (it always uses the popup in tmux).
4. **No node spawned by tmux on a timer or a hook.** The list TUI is a long-running process
   inside the deck; it watches the status dir with `fs.watch` and pushes the outer status-bar
   text into a tmux user option.
5. **Pool panes are kept at exactly the right-slot size**, so a swap never resizes, and pi and
   nvim never redraw (verified: zero SIGWINCH across three swaps; §5).
6. **Per-session nvim lives in the pool too**, created **lazily** (first `prefix e`, `Space v`,
   `/view` or `Space f …`) and toggled with the session's pi in the right slot.
7. **One entry story**: in the user's tmux `prefix g`, `prefix G`, `Space e`, `Space E` and
   `/sessions` all open the same popup; `prefix g` (or `q`) inside the deck closes it. A
   persistent outer "deck window" is rejected: it is exactly the nesting and clutter we remove,
   and the popup opens instantly because the list TUI is already running.

Rejected alternatives, one line each:
- *Keep windows in the user's tmux, just remove polling*: fixes lag, not clutter, and keeps join-pane redraws.
- *Deck as a session in the user's server*: pool windows would show up in `choose-tree`, `prefix w` and window indices; resize rules would be shared with the user's windows.
- *capture-pane preview for deck sessions*: a copy instead of the real pane, and it needs polling.
- *Grouped sessions per client*: a pane can be in one window only, so the right slot is shared anyway.

## 3. Verified on tmux 3.2a

All on throwaway servers (`tmux -L decktest-$$ -f /dev/null`, plus `…-outer` and a `…-harness`
server whose pane ran a real outer client so keys could be typed with `send-keys`). Never the
default server.

| Fact | Result |
|---|---|
| `set -t pool window-size manual` + `set -t pool default-size 100x50` | new pool windows are created at 100x50 |
| `resize-window -t pool:W -x X -y Y` | works on a manual window |
| `swap-pane -d -s <pool pane> -t deck:deck.1` | pane ids move with the panes; the active slot stays active; pane options travel with the pane |
| swap between equal-size panes | no SIGWINCH in either process (WINCH logger, 3 swaps) |
| `resize-pane -t deck:deck.0 -x 50%` | works |
| `display-popup -E -w 95% -h 90% 'env -u TMUX tmux -L X attach -t deck'` | nested client runs in the popup (150x41 inside a 160x48 client) |
| keys while a popup is open | `C-s "` split the **inner** pane; an outer `bind -n C-h` did **not** fire; the inner one did |
| `bind -n C-h if -F '…' 'select-pane …' 'send-keys C-h'` (inner) | conditional root binding works through the popup |
| extended keys through the popup | `ESC[13;2u` (Shift+Enter) reached the inner pane byte-exact with `extended-keys` and `terminal-features …:extkeys` in both servers |
| targets in key bindings | **not** format-expanded: `swap-pane -s '#{@x}'` fails ("Can't find pane"), also inside `if -F`. `run-shell 'tmux swap-pane -s "#{@x}" …'` works (sh + tmux, ~5 ms) |
| popup job environment | has outer `$TMUX`/`$TMUX_PANE`; `tmux display -p '#{client_name}'` there names the outer client; `tmux switch-client -t :W` from the popup works; `display-popup -C -c CLIENT` closes it |
| `remain-on-exit on`, `#{pane_dead}`, `#{pane_dead_status}`, `set-hook -g pane-died` | work |
| writing ANSI to another pane's `#{pane_tty}` | shows in that pane (`capture-pane -e` confirmed) |
| `fs.watch` on the NFS home dir | events within ~5 ms for local tmp+rename writes (remote hosts' writes are not seen) |

pi facts (pi-tui 1.5.2 `keybindings.js`, `keys.js`): pi binds `ctrl+l` (model selector),
`ctrl+e` (line end; vim-mode scroll), `ctrl+g`, `ctrl+]`, … ; it does **not** bind `ctrl+h`, but
treats raw `0x08` as backspace. Backspace from cmux is `0x7f`, so stealing `C-h` only loses
"ctrl+h as backspace".

## 4. Architecture

```
Mac cmux ──ssh──► login node (pinned)
 ├─ user tmux (default socket, prefix C-s, ~/env/tmux.conf)
 │   status-left '… #{@pi_deck_bar}'   ◄─────────── set-option by the list TUI on change
 │   prefix g/G, Space e/E, /sessions ─► display-popup -E -w95% -h90% pi-deck-attach
 │   windows: shells, pis started by hand ("outside" sessions)
 └─ deck tmux  tmux -L pifleet -f ~/env/pi/deck.tmux.conf   (status off, prefix C-s)
     session deck ─ window deck
       ┌──────────────── 50% ───────────────┬───────────── right slot ─────────────┐
       │ %L list TUI (node: pi-fleet deck)  │ whichever pool pane is shown:        │
       │   @pi_fleet_role=list              │   pi | nvim of the selected session, │
       │                                    │   or the preview holder              │
       └────────────────────────────────────┴──────────────────────────────────────┘
     session pool (window-size manual, default-size = right-slot size, never attached)
       one window per pane:  pi (run-pi)   nvim --listen (lazy)   preview holder (1)

 ~/.local/state/pi-fleet/status/*.json ──fs.watch──► list TUI   (pis write on change, as today)
 /tmp/pi-fleet-$UID/  <id>.pi.sock (control)  <id>.nvim.sock  deck.sock (list TUI)
```

**Ownership.** The list TUI is the only process that creates pool panes and decides *which
session* is in the right slot. Two things swap without it, and never change the session shown:
the `prefix e` toggle and `/view` (pi ↔ its own nvim). tmux is the source of truth for the slot:
before every action the TUI reads `deck:deck.1` (`#{pane_id} #{@pi_fleet_role}
#{@pi_fleet_session} #{pane_dead}`), so it never trusts a cached copy.

**Pane options** (existing names kept): `@pi_fleet_role` = `list|pi|nvim|preview`,
`@pi_fleet_session`, `@pi_fleet_peer` (pi ↔ nvim), `@pi_fleet_nvim_sock`. Server options:
`@deck_tui_pid`, `@deck_outer` (`socket|client` of the last popup), `@deck_jump`.

**deck.sock** (NDJSON, the control.ts socket hygiene: private bind + rename, 64 KB cap, 2 s idle):
`{"type":"open","cwd":D}` or `{"type":"open","session":F|ID,"piArgs":[…]}` → creates (or finds) the
session, selects it, shows it, optionally focuses it; `{"type":"select","session":ID,"focus":bool}`;
`ping`. Replies `{"ok":true,"session":ID}` or `{"ok":false,"error":…}`.

**Server bootstrap** (`pi-fleet deck-start`, also implied by `open`/`attach`): if `tmux -L
pifleet has-session -t deck` fails → `new-session -d -s deck -n deck -x W -y H 'pi-fleet
deck'`; the TUI on start creates `pool` (+ the preview holder), splits its window, writes
`@deck_tui_pid`, binds `deck.sock`. Callers wait ≤ 3 s for `deck.sock`. The server is started
with the caller's environment plus the stable `SSH_AUTH_SOCK` link, like tmux.conf does.

## 5. Right-slot size invariant

- Pool windows: `window-size manual`, `default-size` = slot size, so new panes start at the
  right size and pi's first frame is correct.
- On start and on every SIGWINCH of the list pane (the deck window changed size: other client,
  popup vs direct attach, terminal resize) the TUI, in **one** tmux call:
  `resize-pane -t deck:deck.0 -x <pct>%` ; read `deck:deck.1` size ; `set -t pool default-size WxH` ;
  `resize-window -t pool:@n -x W -y H` for every pool window. Hidden pis then redraw once,
  which only happens on real size changes (e.g. switching between popup and direct attach).
- The deck session keeps `window-size latest`; several clients share one deck (same selection,
  same slot), which is how tmux sessions behave anyway.
- The deck config unbinds splits/`break-pane`/`kill-pane` in the deck window, so the window
  always has exactly two panes; the TUI repairs it (re-split with a holder) if not.

## 6. The list TUI (`pi-fleet deck`)

```
┌ list (50%) ──────────────────────────────────────┬ right slot ───────────────────────────────┐
│ ▾ physicsnemo-runner (3, 5 closed)                │  (the real pi pane of "sweep")            │
│ › ● sweep            bash 4m    $3.41  2w 1◐      │  ● bash  squeue -u $USER                  │
│   ◐ ckpt restart     done 2m                      │  ── ⠴ Working ─────────────────────────── │
│   ○ seeds            3h ago     2 interrupted     │  > _                                      │
│   ◌ old sweep        1d ago                       │                                           │
│   ◌ data prep        2d ago                       │                                           │
│   ◌ lr search        3d ago                       │                                           │
│   ⋯ +2 closed                                     │                                           │
│ ▾ FLARE-dev.py (1)                                │                                           │
│   ? flare refactor   question 12m                 │                                           │
│ ▾ outside (your tmux)                             │                                           │
│   ◐ notes ⇱ win 3    waiting 5m                   │                                           │
│ ▸ dotfiles (2 closed)                             │                                           │
│                                                   │                                           │
│ sweep · bash 4m · $3.41 · 2 working 1 waiting     │                                           │
│ NORMAL  ⌕ phys run_                     4/12      │                                           │
│ j/k move  ⏎/C-l open  a new  d kill  i / search   │                                           │
└───────────────────────────────────────────────────┴───────────────────────────────────────────┘
```

Closed sessions sit in their repo's group (by cwd → repo), after its live rows: grey, `◌`, the
newest 3, older ones behind a `+N closed` row (Enter/Space shows them). Repos with only closed
sessions get a group of their own, after every group with live sessions, folded. A search shows
every match. Row names take their state's color (working blue, needs-you yellow, question
magenta, autonomous green, error red, idle bright white, closed grey); dark grey is for borders
and separators only.

Built from `sessions-view.ts` (rows, grouping, ordering, colors, `humanizeSince`, the inline
kill confirm, `fleetSource`, `TranscriptTails`), minus the preview pane, joins and timers.
Telescope layout: list on top, then the selected row's detail line, then the **search bar**
(mode + query + match count), then key hints.

**Right slot per row kind**

| Row | Right slot |
|---|---|
| live deck session | its pi pane (or its nvim if toggled), swapped in on highlight |
| subagent (Space expands; unfinished first, then completed/stopped/failed, newest first in each) | preview holder: transcript tail (existing renderer), refreshed on `fs.watch` of its JSONL while selected |
| outside session (plain `pi` in the user's tmux) | preview holder: summary card + one `capture-pane -p -e` taken on highlight and on that session's status change (≤ 1/s); no timer |
| closed / crashed-elsewhere / remote | preview holder: summary card (state, cwd, last assistant message, cost, subagents, Slurm jobs) |

The **preview holder** is a pool pane running `stty -echo -icanon; printf '\e[?25l'; exec sleep
2147483647` with `@pi_fleet_role=preview`. The TUI writes frames straight to its
`#{pane_tty}`: no second node process, no IPC.

**Highlight → swap.** Moving the selection runs `swap-pane -d -s <pane> -t deck:deck.1` (~2 ms);
key repeats faster than 30 ms are coalesced into one swap. Selection that lands on a session
whose nvim is currently shown shows the nvim (the toggle state is per session, remembered as
`@pi_fleet_shown=nvim` on the pi pane). Showing a session for ≥ 1 s while a client is attached
acks it (writes `<id>.seen`, as `pi-fleet seen` did).

**Updates, no polling.** `fs.watch(statusDir)`, debounced 100 ms, re-reads only the named files.
A 15 s timer re-derives liveness from cached data (`kill(pid,0)` for local pids, heartbeat age);
a 60 s timer re-stats the sessions dir for the closed list and remote heartbeats (NFS gives no
events for other hosts). `pane-died` in the deck config runs `run-shell -b 'kill -USR2
#{@deck_tui_pid}'` (an sh, only when a pane dies) and the TUI reconciles: a dead pane in the
slot is replaced by the next row (or the holder) and killed.

**Outer bar.** On any state change the TUI computes `π 1? 2◐ 1✕` (colored with `#[fg=…]`) and,
debounced 500 ms, runs one `tmux -S <outer socket> set -g @pi_deck_bar '…'` (outer socket from
`@deck_outer`, else the default socket if it exists). On exit it clears it. Entering
waiting/question/error writes BEL to the deck client (`bell-action any` in the deck config).

**Enter on an outside row.** In a popup: `set -g @deck_jump <pane>` and detach; `pi-deck-attach`
(still inside the popup) reads and clears `@deck_jump` and runs `tmux switch-client -c CLIENT
-t PANE \; select-pane -t PANE` on the outer server, then exits, closing the popup. Without a
popup (direct attach) the row flashes "runs in your tmux (window N)".

**Keys** (no Alt, no Ctrl+Shift, no Tab):

| Mode | Key | Does |
|---|---|---|
| NORMAL | `j`/`k`, ↓/↑, `C-n`/`C-p`, PgUp/PgDn | move; the right slot follows |
| | `Enter`, `C-l` | live deck row: focus the right pane. Closed row: resume into the pool, then focus. Outside row: jump there (above). Subagent: select its main |
| | `Space` | expand subagents / collapse a repo group / show a repo's older closed sessions (`+N closed`) |
| | `a` | new session in the highlighted row's repo (or header's) → shown and focused |
| | `d` | kill with the inline confirm: `y`/Enter kill · `s` kill + scancel · `n`/Esc cancel (Slurm default: left running) |
| | `i`, `/` | INSERT mode (search bar) |
| | `!` `@` `#` `&` / `0` | status filters / clear (unchanged) |
| | `?` | help; `q` detach (close the popup / back to the shell) |
| INSERT | letters | fuzzy terms (space-separated, all must match name/repo/cwd/last message); list filters live |
| | `C-n`/`C-p`, ↑/↓ | move while typing; `Enter` = NORMAL `Enter` |
| | `Esc` | back to NORMAL (query kept; a second `Esc` in NORMAL clears it) |

## 7. Keys outside the list

| Where | Key | Does |
|---|---|---|
| deck server, root | `C-h` | `select-pane -t deck:deck.0` (back to the list) from any pane, **unconditionally** |
| deck prefix (`C-s`) | `e` | toggle the slot between the session's pi and nvim (creates the nvim on first use); works from list, pi and nvim |
| | `g`, `d` | detach (closes the popup; `prefix g` opens and closes the deck) |
| | `C-h` | send a literal `C-h` (backspace-by-C-h in nvim insert mode, telescope's which_key) |
| | `[`, PgUp | copy mode (as in the user's tmux) |
| user tmux | `prefix g`, `prefix G` | open the deck popup |
| | `prefix e` | unchanged: pi ↔ nvim of an outside session |
| pi (vim-mode NORMAL) | `Space e`, `Space E` | in the deck: back to the list. Outside: open the deck popup |
| | `Space v` (new) | toggle the slot to this session's nvim (outside: focus the peer pane) |
| | `Space f …`, `Space g s`, `Space t` | unchanged; whatever opens in nvim also shows nvim in the slot |
| nvim | `:PiFocus` | in the deck: swap back to pi (`swap-pane -d -s $PI_FLEET_PI_PANE -t $TMUX_PANE`) |

`prefix e` in the deck config:
`bind e run-shell 'set -- $(tmux display -p -t deck:deck.1 "#{pane_id} #{@pi_fleet_peer}"); tmux swap-pane -d -s "$2" -t "$1" 2>/dev/null || pi-fleet pair --deck "$1" --show'`
(the node fallback runs once per session, when no nvim exists yet).

Why `C-h` unconditionally: only the list and the slot are ever visible, the list has no use for
`C-h`, and a rule that works the same in pi and nvim beats one that silently types a backspace.
Its cost (nvim insert `C-h` and telescope `C-h`) is covered by `prefix C-h`. `C-e` was rejected
for the toggle: pi uses it (line end, vim-mode scroll) and so does nvim (scroll, cmp abort).

## 8. Entry, lifecycle and commands

| Action | Behaviour |
|---|---|
| `pf` outside tmux | ensure the deck; `exec tmux -L pifleet attach -t deck` |
| `pf DIR [-- ARGS]` outside tmux | ensure the deck; `open {cwd}` over deck.sock (selected, focused); attach |
| `pf [DIR]` inside tmux | same, then `display-popup -E -w 95% -h 90% pi-deck-attach` instead of attach |
| `bin/pi-deck-attach` (POSIX sh, no node) | in a popup: `tmux -L pifleet set -g @deck_outer "$(tmux display -p '#{socket_path}|#{client_name}')"`; `env -u TMUX tmux -L pifleet -f CONF new-session -A -s deck -n deck 'pi-fleet deck'`; afterwards handle `@deck_jump` |
| `/new` in a deck pi | `{cancel:true}`; `open {cwd}`; the new session is shown and focused; the old one keeps running in the pool |
| `/resume` in a deck pi | `{cancel:true}`; `open {session}`: live in the deck → select; live outside → notify "runs in your tmux, window N"; remote → refused; else a new pool pane |
| `/new`, `/resume` in an outside pi | the same `open`, then the popup on that client (spawned detached). Every new session goes to the deck |
| `/kill`, `d` | unchanged dialog / inline confirm; `run-pi` exits 0, `:qa`s the nvim (kept, hidden, if it has modified buffers; the closed row shows `✎` and Enter shows that nvim) |
| `/sessions` | outside: the popup; in the deck: focus the list |
| pi crash | `run-pi` keeps the pane: `pi exited (N). r restart · q close` — visible in the slot, `C-l` then `r` |
| list TUI crash | `pane-died` hook: `if -F '#{==:#{@pi_fleet_role},list}' respawn-pane`; the new TUI rebuilds everything from tmux + status files |
| `pf --kill-deck` | lists live deck sessions, asks once, sends `kill {confirmed, scancel:false}` to each control socket, waits ≤ 10 s, then `kill-server` |
| deck lifetime | runs until `--kill-deck` or node reboot; detaching never stops it |
| several clients | one shared deck; the deck socket is node-local (`/tmp/tmux-$UID/pifleet`), so one deck per login node (login-node pinning as before; other hosts' rows dimmed) |

`run-pi` panes get `-e PI_FLEET_SESSION=ID -e PI_FLEET_DECK=1` (+ `passEnv`); the extension knows
it is in the deck from `PI_FLEET_DECK=1` and `$TMUX` naming the `pifleet` socket.

**Migration.** Running pi-fleet windows keep working as outside sessions: listed, jumpable,
their own pi|nvim layout untouched. Their old extension code still renames windows until the pi
restarts. After `prefix r` the user's server still holds the removed hooks and `C-h`, so
tmux.conf carries `set-hook -gu session-window-changed`, `set-hook -gu client-session-changed`
and `unbind -n C-h` for one release. Kill the old `fleet` dashboard window by hand.

## 9. Code: deleted, changed, kept

| Area | Fate |
|---|---|
| `cli.ts` `bar`, `seen` (CLI), `dashboard --window`, `dashboardWindow`, `inDashboardWindow`, `joinPane`, `sendHome`, `joinedPane`, `JOIN_SIZE`, window naming, `@pi_fleet_named/joined/home/dashboard` | **delete** |
| `cli.ts` `openSession` new-window path | **replace** with `open` → deck.sock |
| `cli.ts` `pairPane` | **change**: in the deck `new-window -d -t pool:` at slot size; outside, `split-window` as now but only lazily |
| `cli.ts` `run-pi`, `peer`, `pair`, `ls`, runtime/socket helpers, tmux guard | keep |
| new `deck.ts` (tmux layer: server, pool, slot, sizes, holder, deck.sock) and `deck-view.ts` (list TUI) | **new** |
| `sessions-view.ts` capture timers, joined state, `panePreview` polling, dashboard window/popup openers | **delete**; row/group/format helpers move to or are imported by `deck-view.ts` |
| `status.ts` `tmuxWindow` lookup (window index for the bar) | **delete**; `tmux` gets `{socket, piPane, deck}` |
| `lifecycle.ts` window-name marking | **delete**; `/new` `/resume` → `open`; kill, Slurm, autonomous, duplicate guard kept |
| `nvim.ts` | at-start pairing → lazy |
| `view.ts`, `leader.ts` | "focus nvim" → "show nvim in the slot" in the deck; `Space e/E/v` as §7 |
| `pi_fleet.lua` | `:PiFocus` deck-aware; winbar, `:w!`/`:w!!`, `agent_changed` unchanged |
| `control.ts`, `edits.ts`, `registry.ts`, `files.ts`, `tool-output.ts`, `protocol.ts`, `shared.ts` | keep |
| `tmux.conf` fleet block | remove `status-interval 5`, `#(pi-fleet bar)`, both hooks, the `g` window binding, `C-h`; `status-left '[#{session_name}] #{@pi_deck_bar}'`; `prefix g`/`G` → popup; keep bell and `prefix e` |
| `aliases.sh` `pf` | rewrite (§8) |

## 10. Costs after the change

| Event | Work |
|---|---|
| idle | nothing spawned; the TUI sleeps on `fs.watch` with a 15 s and a 60 s timer |
| status change | pi writes its file (as now); the TUI re-reads one file; ≤ 1 tmux call for the outer bar |
| j/k | one `swap-pane` (~2 ms); tmux repaints the right half from its own grid, the app does not redraw |
| `prefix e` | one sh + two tmux clients (~5 ms) |
| open the popup | one tmux attach to a warm TUI (no node start) |
| window switch in the user's tmux | nothing |
| resize | one batched tmux call + one redraw per hidden pane |

The TUI is one resident node process (≈ 60–90 MB RSS, estimate, unmeasured). Lazy nvim saves one
nvim (plus LSPs) per session that never opens a file.

## 11. Tests

- Every tmux test uses throwaway servers `tmux -L decktest-$$-<n> -f ~/env/pi/deck.tmux.conf`;
  `PI_FLEET_DECK_SOCKET` overrides the `pifleet` name and `PI_FLEET_TMUX_GUARD` refuses
  `default` **and** `pifleet`. Each test `kill-server`s and removes its socket file in a trap
  (`/tmp/tmux-$UID/` currently holds ~300 stale `fleettest-*`/`pfexp*` sockets from earlier runs).
- Key-level tests use the three-server harness from §3: harness pane → outer client → popup →
  deck; keys via `send-keys` to the harness, results via key-logger panes, `capture-pane` and
  `list-panes`. A WINCH-logger stub pi asserts "no SIGWINCH on swap".
- `PI_FLEET_PI_CMD` stub pi for pool panes; RPC pi for `/new`/`/resume`/`/kill`; headless
  `deck-view` render tests (feed keys, assert `render(width)`) on fixture status/session dirs;
  headless nvim for `:PiFocus`.

## 12. Phases (each one coder task)

1. **Deck server layer.** `pi/deck.tmux.conf`, `deck.ts`, `bin/pi-deck-attach`, CLI `deck-start`,
   `open` (deck.sock client), `attach`, `kill-deck`, `pair --deck`, `run-pi` env. A stub list
   process may stand in for the TUI here (`deck.sock` server and slot primitives live in
   `deck.ts`, so phase 2 only wires them). **Accept:** fresh start creates `deck` (2 panes,
   50/50) and `pool` (manual, default-size = slot); `open` ×3 → 3 pool pis at slot size; swapping
   them produces no SIGWINCH; resizing the deck client resizes every pool window in one tmux
   call; `prefix e` creates then toggles nvim; `C-h`, `prefix C-h`, `prefix g` behave per §7
   through a popup; Shift+Enter reaches a pool pane; pane-died respawns the list; `kill-deck`
   kills only its server. **Validate:** §11 harness; `list-keys`, `show -gv`.
2. **List TUI** (`deck-view.ts`, `pi-fleet deck`), after 1. **Accept:** §6 layout, modes and keys;
   highlight swaps the slot (coalesced); holder previews for subagent/outside/closed rows; fs.watch
   updates within 300 ms of a status write, no 1 s timers (assert with a fake clock / timer
   count); ack after 1 s shown; outer `@pi_deck_bar` set on change and cleared on exit; Enter on
   an outside row switches the outer client and closes the popup; dead slot pane replaced on
   SIGUSR2. **Validate:** headless render tests + harness.
3. **Extension integration**, after 1 (parallel with 2). `lifecycle.ts`, `status.ts`, `nvim.ts`,
   `view.ts`, `leader.ts`, `vim-mode.ts` (`Space v`), `pi_fleet.lua`. **Accept:** `/new`/`/resume`
   in a deck pi send `open` and leave the original alive (and its subagents); in an outside pi
   they open in the deck and pop up; `/view` shows nvim in the slot; agent edits reload a hidden
   nvim; `:w!`/`:w!!` reach pi from a pool nvim; `:PiFocus` swaps back; no pairing at session
   start. **Validate:** RPC pi + stub deck.sock; headless nvim.
4. **Remove and rewire**, after 2 and 3. Deletions in §9, `tmux.conf`, `aliases.sh pf`,
   `README.md`, `docs/tmux.md`, `docs/nvim.md`, the old design doc's header pointing here,
   `tests/bootstrap_test.sh` check that `deck.tmux.conf` loads (`tmux -L envtest -f … new -d`).
   **Accept:** `grep` finds no `bar`/`seen`/`join`/`dashboard --window` users; no `#(`
   in tmux.conf; shellcheck + `zsh -n` clean; full test suite green.

Optional refinements: mouse click selects a list row; a `prefix s` "last two sessions" toggle
(agent-deck's MRU); a deck-local key to swap slot ↔ list widths.

## 13. Risks

- **Deck config drift** from tmux.conf (terminal, extended keys, clipboard, copy mode): the ~15
  lines are duplicated deliberately (own minimal config); a phase-4 test loads both and compares
  `default-terminal`, `extended-keys`, `escape-time`.
- **Targets are not format-expanded** in 3.2a bindings, so every option-driven binding goes
  through `run-shell` (sh + tmux). Fine for keypresses; never use it on hooks that fire often.
- **Writing to a holder's tty** relies on same-uid pts permissions (`crw--w----`, owner us);
  if a site hardens that, fall back to a small `pi-fleet holder` reader on a FIFO.
- A user who attaches the deck inside a normal outer pane gets `C-s` eaten by the outer server;
  `pf`/`pi-deck-attach` refuse that (`$TMUX` set and not in a popup → use the popup).
- `kill-server` of the deck (or a node reboot) ends all deck pis at once; `pf --kill-deck`
  confirms, and rows come back as closed sessions that `Enter` resumes.

## 14. Open questions

1. **nvim eager or lazy?** The pi-fleet decision was "always at session start". (a) lazy, on
   first `prefix e`/`Space v`/`/view` (**recommended**: no hidden nvim+LSP per session; agent
   edits only matter once a file is open); (b) eager, as before; (c) eager only for sessions
   started with `pf DIR`.
2. **`/new` and `/resume` in an outside pi.** (a) open in the deck and pop it up
   (**recommended**: one place for new sessions); (b) keep opening a new window in the user's
   tmux (the old clutter, for those pis only); (c) pi's native in-place switch (kills
   subagents).
3. **`C-h` in the deck.** (a) unconditional, literal via `prefix C-h` (**recommended**, §7);
   (b) conditional: pass through in nvim panes, so only pi panes return with `C-h` and nvim
   uses `prefix h`/`:PiFocus`; (c) no root key, `prefix h` only.

## Decisions (user, 2026-11-17)
1. nvim starts lazily on first use (prefix e / Space v / /view).
2. /new and /resume in a hand-started pi create the session in the deck and pop the deck up.
3. C-h always returns to the list (pi and nvim); prefix C-h sends a literal C-h.
