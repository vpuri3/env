# tmux

Config: `~/env/tmux.conf`, symlinked to `~/.tmux.conf`. Reload it in a
running server with `prefix r`; some options (extended keys) only apply after
`tmux kill-server`.

**Prefix is `Ctrl+s`** (not `Ctrl+b`). Press `Ctrl+s Ctrl+s` to send a literal
`Ctrl+s` to the program inside.

## Sessions

| Command | Does |
| --- | --- |
| `tmux` / `tmux new -s NAME` | new session |
| `tma` | attach to the last session (`~/env/bin/tma`) |
| `tma NAME` | attach to session NAME |
| `tmls` | list sessions (alias for `tmux ls`) |
| `prefix d` | detach |
| `prefix $` | rename session |

`prefix s` is remapped to splitting (see below), so use `tmls` / `tma` to
switch sessions, or `prefix w` for the window/session tree.

## Windows and panes

| Keys | Does |
| --- | --- |
| `prefix c` | new window |
| `prefix n` / `prefix p` | next / previous window |
| `prefix 0`..`9` | go to window N |
| `prefix ,` | rename window (windows otherwise rename automatically) |
| `prefix v` | split side by side (new pane on the right) |
| `prefix s` | split stacked (new pane below) |
| `prefix h` `j` `k` `l` | move to the pane left / down / up / right |
| `prefix H` `J` `K` `L` | resize the pane by 10 cells |
| `prefix z` | zoom / unzoom the pane |
| `prefix x` | close the pane |

The mouse is on: click to focus, drag borders to resize, scroll to enter copy mode.

## pi-fleet (pi sessions)

Each pi session gets its own window, with pi on the left and its paired nvim
on the right (see the README's pi-fleet section). These keys run
`~/env/bin/pi-fleet`. Without it they do nothing.

| Keys | Does |
| --- | --- |
| `prefix e` | jump between pi and its paired nvim. Pairing is by pane id, so panes you add or swap don't matter. From a pi whose nvim is gone, it pairs a new one |
| `prefix g` | the `fleet` dashboard window; from the dashboard, back to the last window (in pi: `Space e`, `/sessions`) |
| `prefix G` | the dashboard as a popup (95% × 90%); `q` closes it (in pi: `Space E`) |
| `Ctrl+h` | in a pi pane joined into the dashboard window (dashboard `ctrl+l`): back to the list on its left. Everywhere else `Ctrl+h` goes to the program as usual |
| `prefix 0`..`9` | the numbers in the status bar are real window indices, so they jump straight there |

- **Bell.** A pi that stops (waiting ◐, question ?, error ✕) rings the bell.
  tmux flags that window in the window list unless it is the current one
  (`monitor-bell on`, `bell-action other`, `visual-bell off`).
- **Status bar.** `status-left` lists sessions that need you, newest first,
  e.g. `π [3]? flare [5]◐ ckpt` (? magenta, ◐ yellow, ✕ red). It refreshes
  every 5 s. Window names are
  `<glyph> <session name>`.
- **Hooks.** Switching to a window or session (`session-window-changed`,
  `client-session-changed`) runs `pi-fleet seen`, which marks its waiting
  sessions as seen: ◐ becomes ○ and they leave the status bar.

## Copy mode (vi keys)

| Keys | Does |
| --- | --- |
| `prefix [` or mouse scroll | enter copy mode |
| `h j k l`, `Ctrl+u/d`, `g` / `G` | move |
| `/` `?`, then `n` / `N` | search forward / backward |
| `Space` / `V` | start selection / select whole lines |
| `v` | toggle rectangle (block) selection |
| `y` | copy to the **system clipboard** and exit |
| `q` | exit |

Mouse-drag selections stay highlighted after you release the button; press
`y` to copy.

The clipboard uses OSC 52, so `y` reaches the laptop's clipboard even from a
cluster over ssh. The terminal must allow OSC 52 (iTerm2: "Applications in
terminal may access clipboard"; VS Code / Cursor terminals do).

## Things the config takes care of

- **ssh agent after reconnecting.** New panes use `~/.ssh/ssh_auth_sock`,
  which is re-pointed at the live agent socket on every attach. `git push`
  keeps working in long-lived sessions. Panes opened before this config was
  loaded need `export SSH_AUTH_SOCK=$HOME/.ssh/ssh_auth_sock` once.
- **No Esc delay** (`escape-time 0`), so vim/nvim mode switches are instant.
- **Extended keys** (`extended-keys`, CSI-u): `Shift+Enter`, `Ctrl+Enter` and
  `Alt+Enter` reach programs that ask for them. pi uses `Shift+Enter` for a new
  line (follow-ups are Tab or ctrl+q in this setup; see the README). It needs tmux 3.2+ (CSI-u format 3.5+),
  is skipped silently on older tmux, and needs a server restart to take effect.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Shift+Enter` submits in pi | `tmux kill-server` (saves nothing!) and start again; check `tmux show -gv extended-keys` says `on` |
| garbage like `c0c/0c0c/0c0c` at pi startup | tmux 3.6 bug; upgrade tmux |
| `git push` / `ssh` in an old pane: "could not open a connection to your authentication agent" | `export SSH_AUTH_SOCK=$HOME/.ssh/ssh_auth_sock`, or open a new pane |
| `y` doesn't reach the clipboard | the terminal blocks OSC 52; enable clipboard access in its settings |
