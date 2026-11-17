# pi-fleet: many pi sessions, a dashboard, and a paired nvim pane

Status: **design, not implemented**, revision 2 with the user's decisions (2026-11-17). Versions: pi 1.5.2, pi-subagent-manager 1.7.1, tmux 3.2a, nvim 0.12.6, node 22.23. agent-deck source studied at commit `80494e5` (2026-11-16).

## 1. Goals

- Several main pi sessions run at once, one tmux window each. Switching never pauses, aborts or kills a session.
- A dashboard (with a live preview) and a `/sessions` picker list every session on this login node, grouped by repo, with status and subagent counts.
- `/new` and `/resume` always open a new window. `/kill` ends a session deliberately.
- Each session window is pi (left) | nvim (right):
  - `/view` opens files or tool output in that nvim.
  - Agent edits reload in nvim.
  - Writes from nvim reach pi as a note (`:w!`) or a steer (`:w!!`).
- vim-mode gets NORMAL-mode leader keys that mirror nvim.
- Non-goals: replacing tmux, surviving a node reboot, and managing Slurm beyond listing and optionally cancelling jobs.

## 2. Checked facts

| Fact | Source |
|---|---|
| `/new` and `/resume` emit `session_before_switch` (`reason`, `targetSessionFile`) before `teardownCurrent()` aborts and disposes the session. `{cancel:true}` stops them. `/fork` and `/clone` use `session_before_fork` | pi `dist/bundle/chunks/chunk-VEJDBY3O.js` (`AgentSessionRuntime`), `docs/extensions.md` |
| `ui_prompt_start/end` wrap every select/confirm/input/editor/custom dialog. `agent_settled` is final-idle; `agent_end` is not. `sendMessage` `deliverAs: steer\|followUp\|nextTurn`. `tool_call` can `{block, reason}`. `getArgumentCompletions` may be async. `pi.events` is a shared bus between extensions | `docs/extensions.md` |
| `--session <path\|id>` resumes in the session's cwd. `--session-id <id>` creates a session with a chosen ID | `docs/cli.md` |
| Extensions are discovered one level deep (`extensions/*/index.ts`), so helper modules beside `index.ts` are not loaded as extensions | `docs/extensions.md` |
| Subagent state is in the **main** JSONL as `pi-subagent:registry:v1` plus `…registry-delta:v1` entries. `ThreadState = starting\|running\|paused\|completed\|failed\|stopped` | a real session file; `pi-subagent-manager/src/types.ts:44` |
| tmux 3.2a has pane options (`set -p @x`) and `display-popup` | throwaway server |
| `$XDG_RUNTIME_DIR` is unset and `/home` is NFS shared across login nodes | login-eos02 |
| In nvim, a `c`-mode `<expr>` mapping of `<CR>` can rewrite `:w!!` into a user command. `:w!` clears `readonly` | headless test with `nvim -u NONE` |
| vim-mode NORMAL uses `v`/`V` (char/line selection), `e` (word end), `y`; Space is free for the leader. INSERT mode uses Tab (follow-up queue) and Up (dequeue) | `pi/extensions/vim-mode.ts` header |
| nvim leader is Space: `e` (nvim-tree), `ff` (git_files, untracked), `fg`, `fb`, `fh`, `fs` (grep prompt), `gs` (fugitive), `u` (undotree), `y`/`Y`/`d`/`p` (registers) | `nvim/lua/nvconf/remap.lua`, `nvim/after/plugin/*.lua` |

Verify during implementation: whether node 22.23 runs `.ts` unflagged (otherwise use `--experimental-strip-types`), and whether registry deltas carry `state` (the fold must accept both).

## 3. What we borrow from agent-deck (MIT)

agent-deck is MIT-licensed (© 2025 Ashesh Goplani). We port ideas and small pieces of logic from Go to TypeScript; we do not vendor the binary. Every file that contains ported logic says so in its header: `Portions adapted from agent-deck (github.com/asheshgoplani/agent-deck, MIT, commit 80494e5)`. The MIT text goes in `pi/extensions/fleet/THIRD_PARTY_LICENSES`.

| Idea | agent-deck file | Our use |
|---|---|---|
| Status from pi events, not pane regex: `session_start`→waiting, `turn_start`→running, `turn_end`→waiting, `agent_settled` final, `session_shutdown`→dead. A per-run `run_id` minted at the first `agent_start` of a run, so a late settle cannot overwrite a newer run | `internal/session/assets/pi/agent-deck.ts` (header) | state reducer (§5) |
| Socket hygiene: bind at a private path and rename over the public one (last starter wins); only the owner unlinks; NDJSON with a byte cap; drop connections idle for 2 s | same file, wake socket | control socket (§10) |
| Status vocabulary: ● running, ◐ waiting (stopped, **unacknowledged**), ○ idle (acknowledged), ✕ error, ⟳ starting. A **background-work** substate: the main is idle but children still run, so it shows ● | `skills/agent-deck/references/tui-reference.md`, `internal/sessionstatus/sessionstatus.go`, `session/instance_status.go` | glyphs, ack model, `bg` substate |
| Notification bar: waiting sessions listed in the tmux status bar, newest first | `docs/guide/sessions.md` §Notification Bar | status-left, using real window indices so plain `prefix N` jumps (no new keys) |
| Preview: `capture-pane -p -e` of the pane, debounced 150 ms on cursor moves, cached per session; control characters stripped but SGR kept | `internal/ui/home_preview_fetch.go`, `ui/home_view_preview.go` (`stripControlCharsPreserveANSI`), `tmux/tmux_capture.go` | dashboard preview |
| Classify capture failures: "can't find pane/session" or "no server" means **gone**; anything else (including timeout) means **keep the last frame** | `internal/tmux/tmux_capture.go` (`captureGoneMarkers`) | preview and liveness |
| Batch captures through one tmux client (`capture-pane … ; display -p MARK …`) | `internal/tmux/capture_batch.go` | optional; only if the dashboard ever captures more than the selected row |
| Test guard: refuse any tmux spawn from tests that resolves to the user's default socket | `internal/tmux/default_socket_guard.go` | test harness (§14) |
| `/` fuzzy filter plus status filters; `humanizeSince` ("3h 20m ago"); MRU "previous session" toggle | `docs/guide/sessions.md`, `ui/humanize_since.go`, `ui/mru_nav.go` | dashboard keys, time column, `prefix g` back-toggle |
| Pane-regex fallback for pi: the live `── ⠴ Working ──` banner above the composer box | `internal/tmux/pi_patterns.go` | optional: label a row "busy (no heartbeat)" when the extension is hung |

What we do **not** take, and why: agent-deck's own tmux session layout (it conflicts with the pi|nvim pairing), its SQLite state, web UI, conductor, groups config, and Alt-key group navigation (the user has no Alt key). It also has no knowledge of pi-subagent-manager threads.

## 4. Architecture

```
tmux server (per login node)
 ├─ window "fleet"   : pi-fleet dashboard (node + pi-tui)          prefix g / prefix G (popup)
 ├─ window "● api"   : %12 pi + fleet ext  |  %13 nvim --listen     (+ any user panes)
 └─ ...
~/.local/state/pi-fleet/status/<sessionId>.json    live state, NFS, dir 0700  (source of truth)
/tmp/pi-fleet-<uid>/ (0700, node-local)            <id>.pi.sock (control), <id>.nvim.sock
```

| Component | Path |
|---|---|
| Fleet extension. `index.ts` only calls `register(pi)` from each module: `status.ts`, `registry.ts`, `sessions-view.ts`, `lifecycle.ts` (new/resume/kill/duplicates), `control.ts` (socket), `nvim.ts`, `view.ts` (files + `tool:N`), `files.ts` (candidates, grep), `tool-output.ts` (moved out of compact-tools), `edits.ts` (user-write delivery), `leader.ts` (handles `pi-fleet:action` from vim-mode) | `pi/extensions/fleet/` |
| CLI `pi-fleet`: `open`, `pair`, `peer`, `ls`, `bar`, `seen`, `dashboard`, `run-pi` | `pi/extensions/fleet/cli.ts`, shim `bin/pi-fleet` |
| nvim side, active only when `$PI_FLEET_SESSION` is set | `nvim/lua/nvconf/pi_fleet.lua` |
| Leader keys | `pi/extensions/vim-mode.ts` (emits on `pi.events`) |
| tmux glue | `tmux.conf` |

The dashboard is a standalone node TUI (decided). It imports pi-tui from the pinned install through `realpath(which pi)`, and shares `SessionsView` with `/sessions`.

## 5. Status file and state model

The fleet extension in each main pi writes its status file atomically (tmp + rename, mode 0600). It writes on change (debounced 250 ms) and as a 15 s heartbeat. Subagent pis skip it: their header has `parentSession` and they carry a `pi-subagent:thread:v1` entry.

```json
{ "v":1, "sessionId":"…", "sessionFile":"…", "name":"…", "cwd":"…", "repo":"/…/physicsnemo-runner",
  "host":"login-eos02", "pid":4242, "runId":"r7",
  "tmux":{"socket":"/tmp/tmux-1000/default","window":"@7","windowIndex":3,"piPane":"%12","nvimPane":"%13"},
  "nvimSock":"…", "ctlSock":"…",
  "state":"running", "sub":"tool:bash", "acked":false, "since":"…", "lastAssistant":"≤200 chars",
  "model":"…", "costUsd":3.41, "contextPct":41,
  "subagents":{"working":2,"waiting":1,"done":3,"error":0}, "slurmJobs":["8812345"], "autonomous":true, "heartbeat":"…" }
```

`autonomous` is present only from `/run-autonomously` (the prompt template, seen as typed in the `input` event; the old name `/leavemealone` still counts) until `/autonomous off`; a `pi-fleet:autonomous` session entry keeps it across a resume.

| state | glyph | when |
|---|---|---|
| `starting` | ⟳ | `session_start` |
| `running` | ● | `agent_start`/`turn_start`; `sub`=`tool:<name>`. Also when idle but subagents are working (`sub`=`bg 2`) |
| `question` | ? | `ui_prompt_start` during a run (except the fleet's own pickers) or `ask_user_question` running |
| `waiting` | ◐ | `agent_settled` for the current `runId`, `acked=false` |
| `idle` | ○ | waiting + acknowledged: next `input` event, or `pi-fleet seen` from the tmux `session-window-changed` hook |
| `error` | ✕ | settled after a failed run |
| `crashed` (derived) | ✕ | same host and pid dead, or heartbeat older than 60 s |
| `remote` (derived) | dimmed | other host, heartbeat fresh |

Subagent counts fold registry entries from `ctx.sessionManager.getEntries()`. The fold is incremental and runs on `turn_end`, `agent_settled`, and every 3 s while any thread runs. Mapping: starting/running→working, paused→waiting, completed/stopped→done, failed→error. For sessions that are not running, the reader folds the JSONL and shows dead-but-working threads as **interrupted**. A dialog the user opens while the agent is idle (no run active) is not a `question`: only prompts raised during a run count. A clean quit deletes the file. Entering `waiting`, `question` or `error` rings BEL.

## 6. Session index and grouping

`registry.ts` scans `~/.pi/agent/sessions/*/*.jsonl`, reading the first 16 KB of each to classify it:
- A **subagent** has a thread entry, or `session_info` named `<type> /<path>` together with `parentSession`.
- A **fork** has `parentSession` but no thread entry; it counts as a main.

Results are cached by `(path, size, mtime)` in `~/.cache/pi-fleet/index.json`. **Repo** = `git -C cwd rev-parse --show-toplevel`, else cwd, cached per cwd. Live status files are merged over the scan.

## 7. tmux windows, panes and lifecycle

- **Identity is always pane and window IDs**, never positions:
  - pi pane options: `@pi_fleet_role=pi`, `@pi_fleet_session`, `@pi_fleet_peer=%13`; the nvim pane mirrors them.
  - User-added panes carry none and are ignored.
  - pi finds its own pane through `$TMUX_PANE`.
- **`pi-fleet open [--session F|ID] [--cwd D]`** (the only launcher):
  1. Live on this host with its pane present → `switch-client` + `select-pane`.
  2. Live on another host → refuse and show `running on login-eos01`.
  3. Otherwise:
     - `new-window -P -F '#{pane_id}' -c CWD -e PI_FLEET_SESSION=ID -- pi-fleet run-pi …`
     - `split-window -h -l 50% -d -t %P -- nvim --listen SOCK`
     - set the pane options and focus pi.
  - New sessions get `--session-id <uuid>`, so the dashboard row exists immediately.
  - Every tmux call uses `execFile` with an argument array.
- **The nvim pane is always created at session start** (decided). A `pi` started by hand in tmux runs `pi-fleet pair $TMUX_PANE` on `session_start` if it has no peer. Outside tmux, nvim features fall back to a foreground `nvim -R`.
- **`run-pi`** wraps pi:
  - Exit 0 → close the peer nvim with `:qa` unless it has modified buffers.
  - Non-zero exit → the pane stays with `pi exited (N). r restart · q close`.
- **Duplicate guard.** On `session_start`, if a fresh status file with a different pid or host claims the same ID, offer `Jump there / Quit`.
- **Window name**: `<glyph> <name|repo-basename>` via `rename-window -t $TMUX_PANE`.
- **Login nodes** (decided): pin the ssh alias to one login node in `~/.ssh/config.local`. Rows from other hosts are shown dimmed and never started twice. `tma` warns when fresh status files exist for another host.

## 8. Session commands in pi

| Command | Behaviour |
|---|---|
| `/new` | Always `{cancel:true}` + `pi-fleet open --cwd <cwd>` in a new focused window, even from an empty session (decided) |
| `/resume` | pi's own picker. On `session_before_switch`: always `{cancel:true}` + `pi-fleet open --session <target>` (jump if live, else new window) |
| `/fork`, `/clone` | If subagents are working, confirm that forking replaces this session and stops N subagents |
| `/sessions` | §9 |
| `/autonomous` | Shows whether the session is autonomous (§5, set by `/run-autonomously`); `/autonomous off` ends it |
| `/kill` | Dialog below, then stop subagents, `ctx.shutdown()`; `run-pi` closes the window. An empty session with no subagents is killed without a dialog |
| `/view` | §11 |

```
Kill session "physicsnemo sweep"?   (agent is working: its run will be aborted)
  2 subagents working (/sweep-operator, /coder-x) will be stopped; transcripts are kept.
  Slurm jobs from this session still queued/running: 8812345 (RUNNING 1:02:11)
> Kill, leave Slurm jobs running          ← default (decided)
  Kill and scancel 8812345
  Cancel
```

The `/new`, `/resume`, `/fork` interceptions and the duplicate guard apply only to an interactive TUI pi (`ctx.mode === "tui"`). RPC, print and json pis keep pi's own behaviour even with `$TMUX` set, so programs never open windows in the user's tmux and a dialog nobody answers cannot hold a pi; `/kill` and the control socket work in every mode. Outside tmux a TUI pi keeps pi's behaviour with a one-line notice.

`/import` emits a `resume` whose target (the copy in the session dir) does not exist yet. It is not redirected: pi imports in place, as outside tmux, with the notice "import happens in this window; use /resume to open it elsewhere".

Slurm job IDs come from the `tool_result` of `bash` calls that match `Submitted batch job (\d+)`. They are stored via `appendEntry("pi-fleet:slurm-job")` and in `slurmJobs`, and checked with `squeue -h -j … -o '%i %T %M'`; array tasks and het components (`123_4`, `123_[5-10]`, `456+0`) are listed once, as the base job.

## 9. Dashboard and `/sessions` (one component)

`SessionsView` (pi-tui) polls the index and status files every 1 s; `fs.watch` is unreliable on NFS. It shows every main session on this node plus the 30 most recent non-running ones, **grouped by repo**:
- Groups are ordered by their most urgent row.
- Within a group: ? > ✕ > ◐ > ● > ○, then recency.

`/sessions` renders the list only, through `ctx.ui.custom`. The **dashboard** adds a preview pane on the right (decided). It runs in the `fleet` window (`prefix g`) or as `display-popup -E -w 95% -h 90%` (`prefix G`).

```
 pi-fleet  login-eos02   4 live · 1 waiting   ● working ● auto ◐ needs you ? question ✕ error ○ idle
 ▾ physicsnemo-runner (3)                       │ ── preview: physicsnemo sweep (%12) ─────────
   ● physicsnemo sweep  bash 4m   $3.41 2w 1◐ 3✓│ ● bash  squeue -u $USER
   ◐ ckpt restart       done 2m ago     $0.40   │   8812345 RUNNING 1:02:11 …
   ○ elas mixer seeds   3h ago      2 interrupted│ ── ⠴ Working ──────────────────────────────
 ▾ FLARE-dev.py (1)                             │ >
   ? flare refactor     question 12m   $0.80 1◐ │
 ▸ env (1)                                      │
   ⇢ notes              live on login-eos01     │
```

- **Preview**: `capture-pane -p -e -t <piPane> -S -<rows>` of the selected live row, debounced 150 ms on cursor moves and refreshed every 1 s. Control characters are stripped and SGR kept. If the pane is gone the preview says so; on a timeout it keeps the last frame. Rows that are not running show the session's last assistant message instead.
- **Keys**:
  - `j`/`k`/arrows move.
  - `Space` expands or collapses a group or a main's subagents (subagents are hidden by default).
  - `Enter` on a main → `pi-fleet open`. `Enter` on a subagent → its main.
  - `d` kill: an inline confirm on the line above the key hints (`Kill sweep? 2 subagents working · Slurm 8812345 running`, then `y kill · s kill+scancel · n/Esc cancel`; `s` only when Slurm jobs are queued). `y`/`s` send `{"type":"kill","confirmed":true,"scancel":false|true}` to that pi's control socket, which then ends without its own dialog; the view stays open and the row disappears. Not running: a flash; remote: refused.
  - `a` new session in the repo of the row or of the selected repo header. `/` filters on name, repo, cwd and last message, and while it is active `j`/`k`/`d`/`a` type letters; `Esc` leaves the filter.
  - `!` `@` `#` `&` filter running/waiting/idle/error, `0` clears (agent-deck's keys).
  - `q`/`Esc` close the popup or `/sessions`.
  - The view never binds Tab and never needs Alt or Ctrl+Shift.
- **Colors** (glyph and state text only): working blue (pi's `mdLink`), autonomous working green `auto`, needs you (done, unseen) yellow, question magenta bold (pi's `accent`; an autonomous question too), error/crashed red, idle/closed/remote dim. The selected row gets a full-width background (pi's `selectedBg`; grey 237 in the dashboard) as well as the `›` marker. The header shows the legend; `?` repeats it.
- **Status line** above the key hints: the selected session's full state, current tool, time in that state, cost, subagent counts, cwd and last message (a repo header: its path and counts).
- While `/sessions` is open the fleet emits `pi.events` `pi-fleet:overlay` `{name, open}`; vim-mode then draws neither its transcript cursor nor the prompt's.

## 10. Notifications and control socket

- **Bell**: `\a` written to pi's stdout on waiting/question/error. `tmux.conf`: `monitor-bell on`, `bell-action other`, `visual-bell off`.
- **Notification bar**: `status-left` gets `#(pi-fleet bar)` with `status-interval 5`. Output looks like `π [3]? flare [5]◐ ckpt`, glyphs colored as in the dashboard (`#[fg=magenta,bold]`, `#[fg=yellow]`, `#[fg=red]`). The numbers are real window indices, so the existing `prefix 3` jumps there.
- **Window glyphs** as in §7. OSC 7501/777 passthrough is not used.
- **Control socket** `<id>.pi.sock` (0600 in the 0700 dir) dispatches each NDJSON line on its `type` (`cmd` is accepted as an alias) to the registered handlers: `ping`, `kill` (with `"confirmed":true` no dialog; `"scancel":true` also cancels its Slurm jobs) and `user_edit`; anything else gets `{"ok":false,"error":"unknown type …"}` (64 KB cap, 2 s idle drop, private bind + rename).

## 11. Paired nvim, `/view`, and saves

**nvim side** (`pi_fleet.lua`, a no-op unless `PI_FLEET_SESSION` is set):

- Every file buffer gets `readonly` on `BufReadPost`, and again after each write, because `:w!` clears it. Telescope, nvim-tree and treesitter are unaffected.
- **Hint**: a `winbar` in paired windows: `pi ▸ read-only · :w! save + note · :w!! save + interrupt · :PiHelp`. When the buffer is modified it reads `pi ▸ modified · :w! tells pi with your next message · :w!! tells it now`. `:PiHelp` opens a scratch buffer explaining both writes, conflicts and `:PiDiff`.
- **`:w!`** = save + **note**. Native semantics are untouched. `BufWritePre` keeps the old disk text. `BufWritePost` computes `vim.text.diff(old, new)` and sends `{"type":"user_edit","mode":"note",path,diff,added,removed}` over `$PI_FLEET_CTL_SOCK` and reads the one-line reply (a warning on `ok:false`).
- **`:w!!`** = save + **interrupt**. It is not a native command, so it is implemented as:
  - a user command `:PiWriteSteer` that sets `b:pi_fleet_write_mode='steer'` and runs `write!`;
  - a buffer-independent, paired-only mapping `vim.keymap.set('c', '<CR>', expr)`. It returns `<C-u>PiWriteSteer<CR>` when `getcmdtype()==':'` and `getcmdline()` matches `^%s*w!!%s*$`, and plain `<CR>` otherwise.
  - Because the mapping is defined only in paired nvims, `:w!!` there never reaches Vim's parser, and other nvims behave natively. Checked headless.
  - Only the `:` command line is rewritten; `/` and `?` searches are untouched. Today nothing else in `nvim/` maps `<CR>` in `c` mode (cmp-cmdline does not); the module warns if one appears.
- **Agent edits** call `M.agent_changed(paths)`:
  - Unmodified buffer → silent `checktime` reload that keeps the view.
  - Modified buffer → no reload. Mark a conflict and show `pi changed foo.py — :PiDiff compares, :e! takes pi's version`.
  - `FileChangedShell` sets `v:fcs_choice`, so no W12 prompt ever blocks.
  - `M.checktime_all()` runs on `agent_settled` for edits made through bash.
- **Calls into nvim**: a msgpack-RPC `nvim_exec_lua` request on the nvim's `--listen` socket (nvim.ts's own client), running a fixed chunk that calls `require("nvconf.pi_fleet")[fn](arg)`; the function name and the paths are RPC arguments (`...`), data that is never spliced into Lua code or a shell string. This works in any mode.
- **Other commands**: `:PiDiff`, `:PiFocus` (focuses the pi pane).

**pi side, receiving saves** (`edits.ts`). Saves are coalesced per path over 2 s; empty diffs are dropped. The diff is capped at 120 lines; beyond that the message gives a hunk summary and "read the file".

| Save | Agent idle | Agent working, path touched in this run | Agent working, other path |
|---|---|---|---|
| `:w!` note | `sendMessage(…, {deliverAs:"nextTurn"})`, plus a widget `✎ foo.py (+3 −1) goes with your next message` | `deliverAs:"steer"` (lands before its next step) | `nextTurn` |
| `:w!!` interrupt | `deliverAs:"steer", triggerTurn:true` (the agent responds now) | `steer` | `steer` |

The message is a custom `pi-fleet:user-edit`: `The user edited src/foo.py in their editor (+3 −1):` followed by a diff block. "Interrupt" means steer: the note lands after the tool call that is running now and before the next LLM call. It never aborts a running tool such as a long bash command. **Write guard**: `tool_call` for `write` on a path with an undelivered edit is blocked with "The user edited this file at 14:03; read it before overwriting". `edit` is not blocked, because it fails on its own if `oldText` no longer matches.

**`/view`** (the old compact-tools command is merged into it, and there is no `/output`):

- `/view FILE[:LINE]`: async completion, top 20.
  - Tier 1: files touched in this session (read/edit/write args and user saves), most recent first.
  - Tier 2: `git ls-files`, falling back to `fd -t f` (capped at 50k), cached and refreshed on `agent_settled`.
  - `fuzzyFilter` ranks within each tier; tier 1 wins.
- `/view tool:N`: the Nth most recent tool call's full output (the existing compact-tools logic, moved into `fleet/tool-output.ts`). Typing `tool:` completes to labelled recent calls.
- Bare `/view` opens one select list: touched files, then the last 10 tool calls.
- Files open in the paired nvim (recreated with `pair` if gone), **then focus moves to nvim** (decided). Tool output opens as a read-only scratch buffer named after the call.
- compact-tools keeps its rendering byte-for-byte; only its `/view` registration and output-file helpers move.

## 12. vim-mode leader keys

**Leader = Space, NORMAL mode only.** INSERT mode never sees it, so typing is unaffected.

- **No conflict (decided 2026-11-17).** Selection moved off Space: `v` starts a character selection, `V` a line selection; block selection was removed (vim-mode commit `a395f6e`). Space is now only the leader.
- Space enters `pendingLeader` and the mode line shows `␣…`. If the following keys form a mapping it runs; any other key, `Esc`, or a 1000 ms timeout cancels the leader (the key is dropped, not replayed). Counts are not applied to leader maps.
- **Dispatch**: vim-mode emits `pi.events.emit("pi-fleet:action", {name})`, and the fleet extension runs it using the UI context saved at `session_start`. Without the fleet extension, vim-mode shows "pi-fleet not loaded".

| Keys | Action | nvim analogue | Status |
|---|---|---|---|
| `Space e` | `/sessions` | `<leader>e` nvim-tree | decided |
| `Space f f` | file picker (the `/view` backend: touched files first, then the repo), opening in the paired nvim | `<leader>ff` | decided |
| `Space f g` | git files only | `<leader>fg` | decided |
| `Space f b` | files touched in this session only | `<leader>fb` buffers | decided |
| `Space f s` | `Grep >` input, then `rg --vimgrep` results, opening the hit at its line in nvim | `<leader>fs` | decided |
| `Space f h` | select list of pi slash commands, inserted into the prompt | `<leader>fh` commands | decided |
| `Space g s` | `:Git` (fugitive) in the paired nvim, then focus it | `<leader>gs` | decided |
| `Space t` | `/view` tool picker | none | decided |

`Space y`, `Y`, `d` and `p` are not mirrored: vim-mode's `y` already copies to the system clipboard, and the transcript is not editable.

## 13. Keys, failure modes, security

**Keys** (no Alt, no Ctrl+Shift, no Tab, no Up):

| Where | Keys |
|---|---|
| tmux | `prefix g` dashboard window (from the dashboard: back to the last window), `prefix G` popup, `prefix e` jump between pi and nvim via `@pi_fleet_peer`, `prefix N` window from the notification bar (existing) |
| pi | `/sessions` `/new` `/resume` `/kill` `/view` `/autonomous`, and the leader maps in §12. No `keybindings.json` changes |
| nvim | `:w!` `:w!!` `:PiHelp` `:PiDiff` `:PiFocus` |

The fleet binds nothing at the pi editor level, so Tab (follow-up) and Up (dequeue) stay free. Inside its own pickers the arrows navigate as in every pi list, while the editor is not focused. Add the new keys to `docs/tmux.md` and `docs/nvim.md`.

**Failure modes:**

| Failure | Behaviour |
|---|---|
| pi crashes | `run-pi` keeps the pane open with a restart offer; the row shows ✕ crashed |
| nvim dies | the next `/view` or agent edit re-runs `pair` |
| user adds or moves panes | pairing is by ID, so nothing changes |
| node reboot or tmux server death | all rows go stale (✕); `Enter` restarts each in a new window |
| capture timeout | the preview keeps its last frame |
| two pis on one session | duplicate guard |
| partial NFS writes | atomic rename; readers skip files they cannot parse |
| stale socket | unlinked only by its owner, otherwise rebound |
| subagent-manager format change | the fold skips unknown entries and shows `?`; a contract test catches it |

**Security:**
- The runtime dir `/tmp/pi-fleet-$UID` is created 0700. Before each use, `lstat` checks: no symlink, owned by us, mode 0700. Otherwise fall back to `mkdtemp`.
- Sockets are 0600, with no TCP. `~/.local/state/pi-fleet` is 0700 and status files are 0600.
- The control socket dispatches registered types only (`ping`, `kill`, `user_edit`; `cmd` is an alias of `type`); unknown types are refused.
- tmux, nvim, squeue and rg are always called with argument arrays. Paths reach nvim only as msgpack-RPC arguments (`nvim_exec_lua` args), never as code.

## 14. Phases (each one coder task)

**Test rules for every phase:**
- No interactive keypresses: `node --test` on pure modules; a throwaway tmux server (`tmux -L fleettest -f /dev/null`, plus agent-deck's guard idea: the harness refuses the default socket) driven by `send-keys`/`capture-pane`; `nvim --headless --listen`; pi in RPC mode (`pi --mode rpc`, slash commands as `prompt`, dialogs answered through `extension_ui_request`).
- `PI_FLEET_PI_CMD` can swap in a stub pi.
- Tests go in `tests/pi-fleet/`, run by `tests/pi_fleet_test.sh`.
- **Phase 1 creates `index.ts` with a `register(pi)` call for every module, each a stub.** Later phases own disjoint module files and never edit `index.ts`, so phases with satisfied dependencies can run in parallel.

1. **Skeleton and status.** `index.ts` with stubs; `status.ts`; the subagent fold in `registry.ts`; `THIRD_PARTY_LICENSES`. Accept: the §5 schema and states, run-id guard, ack, `bg` substate, heartbeat, subagents skipped, BEL. Test: reducer over synthetic event sequences; fold over an anonymised fixture; an RPC pi run checks `running`→`waiting`.
2. **CLI and tmux lifecycle.** `cli.ts` (`open`, `pair`, `peer`, `bar`, `seen`, `ls`, `run-pi`), `bin/pi-fleet`, `tmux.conf` (keys, bell, bar, hook). Accept: §7 and §10 tmux parts. Test: the stub pi in fleettest: one window per session, `peer` survives added and swapped panes, a crash keeps the pane, `show -gv`/`list-keys`.
3. **Lifecycle commands.** `lifecycle.ts`, `control.ts`: `/new`, `/resume` → new window; `/fork` guard; `/kill` dialog; Slurm capture; duplicate guard; socket. Test: RPC pi in fleettest, `/new` leaves the original pi alive; kill dialog answered over RPC; fake `squeue` on PATH.
4. **Session index, `SessionsView`, `/sessions`, dashboard with preview.** `registry.ts` scan, `sessions-view.ts`, `cli.ts dashboard`. Accept: §6 and §9 (repo groups, filter, status filters, Space, preview with gone/timeout handling, popup). Test: headless render (feed `handleInput`, assert `render(width)`) on a fixture sessions dir; preview against a fleettest pane; a registry contract test.
5. **nvim bridge.** `pi_fleet.lua` and `nvim.ts`: readonly and re-readonly, winbar, `:PiHelp`, `:w!`/`:w!!` with the `<CR>` mapping, `agent_changed`, `checktime_all`, `:PiDiff`/`:PiFocus`. Test: headless nvim; `feedkeys(":w!!\r")` sends `mode:"steer"` to a test socket, and in an unpaired nvim `:w!!` is not rewritten; `nvim --headless -c 'qa!'` stays clean.
6. **`/view`.** `view.ts`, `files.ts`, `tool-output.ts`; remove `/view` from compact-tools. Accept: tiered completion under 50 ms on 50k paths, `tool:N`, bare picker, nvim gets focus, compact-tools rendering unchanged. Test: ranker unit tests; RPC `/view src/x.py:10` checks the nvim buffer and cursor; diff compact-tools render output before and after.
7. **Edit delivery.** `edits.ts`: the §11 table, coalescing, cap, widget, write guard. Test: policy unit test, then RPC pi plus headless nvim with writes during a stubbed run.
8. **Leader keys.** `vim-mode.ts`: pending-leader state machine, all maps in §12; the `pi-fleet:action` handler in `index.ts`-registered `leader.ts`, a stub from phase 1. Test: feed key strings to the wrapped editor; check timeout and cancel (`Space j` does nothing, `v j` selects); INSERT mode unaffected; events emitted.
9. **Docs and bootstrap.** `docs/tmux.md`, `docs/nvim.md`, the README section, the vim-mode header comment, and a `tests/bootstrap_test.sh` check for `bin/pi-fleet` and the linked `extensions/fleet/index.ts`.

## 15. Risks

- A pi update could reorder `session_before_switch` and bring back abort-on-switch; phase 3's test catches it.
- The registry format is private to pi-subagent-manager; rerun the contract test before upgrading to 1.9.
- The `<CR>` cmap could clash with a future cmdline plugin.
- The leader timeout slightly delays Space-selection, which is the deliberate trade-off.
- BEL from inside the pi TUI is assumed harmless.

## 16. Decisions (2026-11-17)

| Topic | Decision |
|---|---|
| Dashboard | Our own standalone node TUI (window `prefix g` and popup `prefix G`) with a live capture-pane preview, all sessions on the node grouped by repo, `/` filter. Borrow agent-deck's logic with attribution (§3); not adopted as a tool |
| `/new`, `/resume` | Always a new window, never in place |
| `/kill` | Confirm dialog listing subagents and Slurm jobs; the default leaves Slurm jobs running |
| Login nodes | Pin ssh to one login node; sessions on other nodes shown dimmed, never duplicated |
| nvim pane | Always created at session start |
| `/view` | One command: `/view FILE` (session-touched files first, then the repo) and `/view tool:N`. No `/output`. Focus moves to nvim |
| nvim saves | Read-only buffers. `:w!` = save + note (next message, or steer if the agent is working on that file; blind `write` blocked). `:w!!` = save + interrupt (steer now). Explained by winbar and `:PiHelp` |
| Leader keys | Space leader in vim-mode NORMAL: `Space e` `/sessions`, `Space f f` file picker into nvim, plus `f g` `f b` `f s` `f h` `g s` `t`; selection on `v`/`V` (§12) |
| Keys | No Alt, no Ctrl+Shift; the fleet uses neither Tab nor Up |
