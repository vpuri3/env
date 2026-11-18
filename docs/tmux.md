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

pi sessions live in the **pi deck**, a private tmux server (`tmux -L pifleet`,
config `~/env/pi/deck.tmux.conf`) with four panes: down the left the session
list, the selected session's nvim and a shell in its directory (40/40/20), and
its pi on the right half. See
the README's pi-fleet section. `pf` opens it (outside tmux in the terminal,
inside tmux in a popup). These keys run `~/env/bin/pi-fleet` and
`pi-deck-attach`; without them they do nothing.

| Keys (your tmux) | Does |
| --- | --- |
| `prefix g`, `prefix G` | the deck in a popup (95% × 90%); `prefix g`, `prefix d` or `Ctrl+c` in the list closes it (in pi: `/sessions`) |
| `prefix e` | for a pi started by hand here: jump between it and its nvim split (made by `/view`). Pairing is by pane id, so panes you add or swap don't matter |

| Keys (in the deck, prefix `Ctrl+s` too) | Does |
| --- | --- |
| `Ctrl+h` `Ctrl+j` `Ctrl+k` `Ctrl+l` | move to the pane on that side: list ↔ nvim ↔ shell with `Ctrl+j`/`Ctrl+k`, nvim or shell → pi with `Ctrl+l`, pi → list with `Ctrl+h`. With no pane on that side the program gets the key (in pi `Ctrl+j`/`Ctrl+k`; in the shell `Ctrl+h`/`Ctrl+j`; in the list `Ctrl+l` is the list's: focus the pi) |
| `prefix e` | focus pi ↔ nvim |
| `prefix z` | zoom / unzoom the pane |
| `prefix h` `j` `k` `l` (or `prefix Ctrl+h` …) | send a literal `Ctrl+h` … to the program |
| `prefix d`, `prefix g` (or `Ctrl+c` in the list) | detach (closes the popup; the deck keeps running) |
| `Ctrl+d` in the list | kill every deck session and the deck (asks first) |
| `prefix [` | copy mode |

- **Bell.** A pi that stops (waiting ◐, question ?, error ✕) rings the bell.
  tmux flags that window in the window list unless it is the current one
  (`monitor-bell on`, `bell-action other`, `visual-bell off`).
- **Status bar.** `status-left` shows `#{@pi_deck_bar}`, which the deck's list
  sets when sessions need you, e.g. `π 1? 2◐` (? orange, ◐ green, ✕ red).
  Nothing polls: the list writes it when a session changes state.

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
