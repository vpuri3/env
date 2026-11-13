# VS Code / Cursor (with vscode-neovim)

Config: `~/env/vscode_settings.json` and `~/env/vscode_keybindings.json`.
Bootstrap links them into `<editor>/User/settings.json` and
`keybindings.json` for every editor (Cursor, VS Code) that has been opened on
the machine. Changes made in the settings UI therefore land in the repo.

Vim editing comes from the **vscode-neovim** extension
(`asvetliakov.vscode-neovim`). It runs a real Neovim with the same
`~/.config/nvim` as the terminal (see [nvim.md](nvim.md)). Because
`vim.g.vscode` is set, `init.lua` loads `lua/nvconf_vscode/` instead: same
options and leader (**`Space`**), no telescope, tree, LSP or treesitter.
VS Code provides those.

## Same keys as terminal Neovim

| Keys | Mode | Does |
| --- | --- | --- |
| `Ctrl+h/j/k/l` | n | focus the editor group left / below / above / right (like nvim splits) |
| `Ctrl+p` / `Ctrl+n` | n | previous / next editor tab (like nvim tabs) |
| `<leader>y` | n, v | yank to the system clipboard |
| `<leader>P` | n, v | paste from the system clipboard |
| `<leader>p` | visual | paste over the selection, keeping the register |
| `<leader>d` | n, v | delete without overwriting the register |
| `J` / `K` | visual | move selected lines down / up |
| `<` / `>` | visual | indent and keep the selection |
| `Y` | n | yank to end of line |
| `Esc Esc` | n | clear search highlight |

## VS Code equivalents of the terminal setup

| Keys | Does | Terminal nvim equivalent |
| --- | --- | --- |
| `<leader>e` | toggle the sidebar | `<leader>e` file tree |
| `<leader>f` | Quick Open (files) | `<leader>ff` |
| `<leader>c` | toggle line comment | `<leader>cc` |
| `<leader>r` | focus the terminal panel | `:TT` |
| `gd` / `Ctrl+]` | go to definition | `gd` |
| `gD` | peek definition | (`gD` = declaration in nvim) |
| `gf` | go to declaration | |
| `gH` | find references | `gr` |
| `K` / `gh` | hover | `K` |
| `gO` | go to symbol in file | |
| `z=` | quick fix | |
| `Ctrl+w s` / `Ctrl+w v` | split the editor | same |

`gd`, `K`, `gH` and friends are vscode-neovim defaults that call VS Code's
language features, so they work for any language VS Code supports.
Brackets and quotes are auto-closed by VS Code, not by the nvim auto-pairs.

## Moving between editor, terminal and sidebar (`Ctrl+g` chords)

| Keys | From | Does |
| --- | --- | --- |
| `Ctrl+g j` or `Ctrl+g k` | editor | focus the terminal |
| `Ctrl+g j` or `Ctrl+g k` | terminal | back to the editor |
| `Ctrl+g h` | editor or terminal | focus the file explorer |
| `Ctrl+g l` | explorer | back to the editor |
| `Ctrl+g Shift+j` / `Shift+k` | editor or terminal | resize the terminal panel |

## Other bindings and settings

| Item | Note |
| --- | --- |
| `Cmd+r` / `Ctrl+r` | revert the file to its saved version. **`Ctrl+r` therefore does not redo** in the editor; use `:redo` |
| `Shift+Enter` in the terminal | sends `ESC` + `Enter`, which Claude Code reads as a new line. **pi reads it as `Alt+Enter`** (queue a follow-up message), not a new line; in pi, use `Ctrl+j` for a new line |
| `extensions.experimental.affinity` | runs vscode-neovim in its own extension host so other extensions can't slow typing |
| `files.exclude` / `search.exclude` / `files.watcherExclude` | hide and skip `.git`, `.venv`, `wandb`, `data`, caches |
| `terminal.integrated.profiles.linux.tmux` | a "tmux" terminal profile on Linux remotes that attaches to session `main` (not the default) |
| `remote.SSH.useExecServer`, `remote.SSH.externalSSH_ASKPASS` | more reliable Remote-SSH connections to clusters |
| `cursor.composer.*` = `steer` | Cursor: messages sent while the agent works steer it instead of queueing |

## Remote-SSH on clusters

- Hosts come from `~/.ssh/config`. Bootstrap includes `~/.ssh/config.local`
  and `~/env/sshconfig` at the top of it, so Cursor and VS Code list them.
- Editor servers (`~/.cursor-server`, `~/.vscode-server`) grow to several GB.
  With `STORAGE_DIR` set, bootstrap moves them there behind a symlink
  (mode 700), keeping small home quotas free. Disconnect the editor before
  re-running bootstrap if it offers to move them.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Vim keys stop working / "Neovim not found" | the extension needs `nvim` 0.10+ on the editor's `PATH`; on macOS a GUI app may not see `~/.local/bin`, so set `vscode-neovim.neovimExecutablePaths.darwin` to the full path |
| keybinding does nothing | Command Palette → "Developer: Toggle Keyboard Shortcuts Troubleshooting", then press it |
| settings edits vanished | the User settings file must still be a symlink into `~/env`; re-run bootstrap |
| startup message "loading nvim/lua/nvconf_vscode/init.lua" | expected: printed by `nvconf_vscode/init.lua` |
