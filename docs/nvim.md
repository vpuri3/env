# Neovim

Config: `~/env/nvim/`, symlinked to `~/.config/nvim`. `init.lua` loads
`lua/nvconf/` in a terminal, and `lua/nvconf_vscode/` inside VS Code / Cursor
(see [vscode.md](vscode.md)). `~/env/vimrc` is the separate, plain-vim config
with the same basics.

Leader is **`Space`**. `nv` is an alias for `nvim`.

## Install and update

- Bootstrap installs a pinned Neovim (`NVIM_VERSION` in `bootstrap.sh`) under
  `~/.local`, then installs missing plugins and treesitter parsers headless.
  Log: `~/.local/share/nvim/env-bootstrap.log`.
- It never updates plugins. To update: `:PackerSync`.
- To upgrade Neovim on every machine, bump `NVIM_VERSION` and re-run
  bootstrap. Treesitter highlighting needs 0.12+.

## Files and search

| Keys | Does |
| --- | --- |
| `<leader>e` | toggle the file tree (nvim-tree); `:e` inside the tree refreshes it |
| `<leader>ff` | find files: git files incl. untracked, or all files outside a repo |
| `<leader>fg` | git files only |
| `<leader>fs` | grep: prompts `Grep >`, searches with ripgrep (follows symlinks, includes hidden files) |
| `<leader>fb` | open buffers |
| `<leader>fh` | command palette (`:` commands) |

Telescope skips `.git`, `node_modules`, `.venv`, `__pycache__`, caches,
`wandb`, `build`/`dist` and similar directories.

## Windows, buffers, tabs

| Keys | Does |
| --- | --- |
| `Ctrl+h/j/k/l` | move to the split left / down / up / right |
| `Shift+h` / `Shift+l` | previous / next buffer |
| `Ctrl+p` / `Ctrl+n` | previous / next tab |
| `:T` | `:tabe` (new tab) |
| `:TT` | new tab with a terminal, in insert mode |
| `Esc` (in a terminal) | back to normal mode |

New splits open below / to the right.

## Editing

| Keys | Mode | Does |
| --- | --- | --- |
| `<leader>y` / `<leader>Y` | n, v | yank to the system clipboard (line / to end of line) |
| `<leader>d` | n, v | delete without overwriting the register |
| `<leader>p` | visual | paste over the selection, keeping the register |
| `J` / `K` | visual | move selected lines down / up |
| `<` / `>` | visual | indent and keep the selection |
| `Y` | n | yank to end of line |
| `<leader>cc` | n | toggle comment on the line |
| `<leader>c{motion}` | n, v | toggle comment |
| `<leader>u` | n | undo tree |
| `<leader>gs` | n | git status (fugitive) |
| `Esc Esc` | n | clear search highlight |
| `Ctrl+d` / `Ctrl+u` | n | half page down / up, cursor centered |

`clipboard=unnamedplus`, so plain `y`/`p` also use the system clipboard where
one exists. Undo history persists across sessions (`~/.vim/undodir`).

**Auto-pairs in insert mode:** `(`, `[`, `{` close themselves. Followed by
`Enter`, they open an indented block. Typing a quote twice (`""`, `''`, ` `` `)
puts the cursor between the pair. Three quotes or backticks open a block,
e.g. a docstring or a code fence.

## Code intelligence

LSP servers are installed by Mason on first use: `lua_ls`, `clangd`,
`julials`. Completion (nvim-cmp) draws on LSP, the buffer, paths and snippets.

| Keys | Does |
| --- | --- |
| `gd` / `gD` | go to definition / declaration |
| `gi` | go to implementation |
| `gr` | references |
| `K` | hover docs |
| `gk` | signature help |
| `gl` | show the line's diagnostics |
| `[d` / `]d` | previous / next diagnostic |
| `<leader>q` | diagnostics into the location list |

| Completion keys (insert) | Does |
| --- | --- |
| `Tab` / `Shift+Tab` | next / previous item, or jump through snippet fields |
| `Ctrl+j` / `Ctrl+k` | next / previous item |
| `Enter` | accept (the first item if none is selected) |
| `Ctrl+Space` | open completion |
| `Ctrl+e` | close |
| `Ctrl+f` / `Ctrl+b` | scroll docs |

Treesitter highlights and indents bash, lua, vim, markdown, python, julia,
javascript, c/c++, fortran, latex/bibtex, make and git files. It skips files
over 100 KB.

## Paired nvim (pi-fleet)

The nvim on the right of a pi-fleet window is **paired** with its pi. It
counts as paired when `pi-fleet` started it, i.e. when `$PI_FLEET_SESSION` and
`$PI_FLEET_CTL_SOCK` are set and it is not running inside another nvim's
terminal. Any other nvim, including one the agent starts through bash, behaves
normally. In a paired nvim:

- **File buffers are read-only**, so a stray edit never reaches pi. A winbar
  shows how to write: `pi ▸ read-only · :w! save + note · :w!! save + interrupt · :PiHelp`.
- **Plain `:w` fails on purpose** (E45). After every write the buffer is
  read-only again. Writes with no changes are not sent to pi.

| Command | Does |
| --- | --- |
| `:w!` | save + **note**: pi gets your diff with your next message. If the agent is working and touches this file in the current run, it gets the diff before its next step (steer) |
| `:w!!` | save + **interrupt**: pi gets the diff now (steer). It lands after the running tool call and never aborts a running command |
| `:PiHelp` | explains the writes, reloads and conflicts (`q` closes) |
| `:PiDiff` | compare your buffer with the version on disk (`q` closes) |
| `:PiFocus` | back to the pi (same as tmux `prefix e`; in the pi deck the pi is swapped back into the slot) |

**When pi edits a file that is open here:**

- An unmodified buffer reloads silently and keeps your view.
- A modified buffer is **not** reloaded. The winbar turns into a warning:
  `:PiDiff` compares, `:e!` takes pi's version, `:w!` keeps yours (pi is told
  what you changed). nvim never stops on a "file changed" prompt.
- Changes made through the agent's bash commands are picked up when the agent
  finishes its turn.

Saves of one file within 2 s go to pi as one diff. pi blocks the agent's
`edit` and `write` on a file you saved until the agent has read it again.
`/view` and the pi leader keys open files here and then focus this pane.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "X is not installed; run :PackerInstall" at startup | `:PackerInstall`, or re-run bootstrap |
| no syntax colors | Neovim < 0.12 or missing parser: re-run bootstrap, or `:TSInstall <lang>` |
| LSP not attaching | `:LspInfo`, `:Mason` to (re)install the server |
| startup errors after editing the config | `nvim --headless -c 'qa!'` prints them |
