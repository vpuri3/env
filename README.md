# env

Personal shell and editor configuration for macOS (bash or zsh) and Linux
clusters (bash), with an idempotent bootstrap script.

## Docs

| Doc | Covers |
| --- | --- |
| [docs/bootstrap.md](docs/bootstrap.md) | what bootstrap does, options, re-running, testing |
| [docs/tmux.md](docs/tmux.md) | tmux keys (prefix `Ctrl+s`), copy mode, ssh agent, pi-fleet keys |
| [docs/nvim.md](docs/nvim.md) | Neovim keys, plugins, LSP, the pi-fleet paired nvim |
| [docs/vscode.md](docs/vscode.md) | Cursor / VS Code with vscode-neovim |
| [AGENTS.md](AGENTS.md) | rules for coding agents working in this repo (`CLAUDE.md` links to it) |
| [skills/](skills/) | agent skills (`env-deploy`, `env-add-cluster`, `slurm-jobs`, `cluster-login`, `cluster-python-env`, `dataset-download`, `leavemealone`), linked into `~/.agents/skills/` |
| [bin/sjob](bin/sjob) | Slurm helper: `sjob alloc/run/shell/batch/chain/q/info/wait/cancel`; site values from `SJOB_*` vars |
| [pi/agents/](pi/agents/) | pi subagent types (e.g. `slurm-operator`), copied into `~/.pi/agent/subagent-manager/agents/` |

## Bootstrap

```bash
git clone https://github.com/vpuri3/env.git ~/env
~/env/bootstrap.sh
```

To update a machine later:

```bash
git -C ~/env pull --ff-only && ~/env/bootstrap.sh
```

Run it from a terminal on a login node (it refuses to run inside a batch job).
`--defaults` accepts every default without prompting; `--skip-installs`
configures startup files, dotfiles, git and ssh only.

Supported: macOS bash, macOS zsh, Linux bash. Linux + zsh is refused.

Bootstrap only writes under `$HOME` and the Python work directory. It never
uses `sudo` or a system package manager, and it leaves an existing Homebrew
(personal or IT-managed) alone, so it is safe on company-managed machines and
shared clusters. Optional tools (Neovim, uv, Codex CLI, Claude Code, Julia)
are installed user-local under `~/.local`.

Neovim and the tree-sitter CLI are pinned (`NVIM_VERSION`, `TREE_SITTER_VERSION`
at the top of `bootstrap.sh`); bump them and re-run to upgrade every machine.
Bootstrap also installs missing plugins and treesitter parsers headless, so the
first launch is clean. It never updates installed plugins: run `:PackerSync`
for that. Output goes to `~/.local/share/nvim/env-bootstrap.log`.

## What lives where

| Where | What |
| --- | --- |
| `~/env/shellrc` | entry point sourced from `~/.bashrc` / `~/.zshrc` |
| `~/env/vars.sh` | environment shared by bash and zsh |
| `~/env/aliases.sh` | interactive aliases (not loaded in non-interactive shells) |
| `~/.config/env/local.sh` | this machine only: `MACHINE`, `PY_WD`, `CACHE_ROOT`, ... (generated, untracked) |
| `~/.gitconfig` | this machine's identity and credential helpers; includes `~/env/gitconfig` |
| `~/.ssh/config` | this machine's hosts; includes `~/.ssh/config.local`, `~/env/sshconfig` and `~/env/sshconfig_defaults` |
| `~/.ssh/config.local` | optional, private hosts such as work clusters (never in this repo) |

Bootstrap edits rc files, `~/.gitconfig` and `~/.ssh/config` only inside a
`# >>> env ... >>>` block and leaves the rest alone. `vimrc`, `tmux.conf`,
`emacs.conf`, `nvim/` and `bin/` are symlinked, as are `vscode_settings.json`
and `vscode_keybindings.json` into Cursor and VS Code, for whichever has been
opened on the machine. For pi, `pi/keybindings.json`, `pi/extensions/` and `pi/prompts/` (`/` commands
such as `/leavemealone`) are symlinked into `~/.pi/agent` (or `$PI_CODING_AGENT_DIR`), and
`pi/settings.json` is copied there only if none exists, since pi writes to it.
On Linux, bootstrap also adds `"theme": "dark"` to it when no theme is set.
Subagent types in `pi/agents/*.md` are copied (the subagent manager refuses
symlinks) into `~/.pi/agent/subagent-manager/agents/`; a copy that differs from
the repo is backed up and replaced. Run `/agents reload` in pi to pick them up.
Bootstrap offers to install pi with its official installer (Node.js goes to
`~/.local/node` first if needed), then installs the pinned packages in
`pi/packages.txt` that pi does not list yet (both skipped with `--skip-installs`).
To re-apply just this part: `~/env/bootstrap.sh --only pi,skills,install-pi`.
Each `skills/<name>` is linked into `~/.agents/skills/`, where pi and
Codex find it. Anything it replaces is saved
under `~/.env-backup/<timestamp>/`.

This repo is public: machine-specific and work hosts go in `~/.ssh/config`
between the env blocks, or in `~/.ssh/config.local`, never in `sshconfig`.
Bootstrap includes `config.local` and `sshconfig` at the top of
`~/.ssh/config`, so Cursor and VS Code list their hosts, and the `Host *`
defaults at the bottom, so every host-specific value wins. For example:

```
Host github.com
    IdentityFile ~/.ssh/id_ed25519_github
    IdentitiesOnly yes
```

## pi-fleet

pi-fleet runs several pi sessions at once in tmux, one window each: pi on the
left, a **paired nvim** on the right. A dashboard lists every session on this
login node, grouped by repo. Switching windows never pauses or kills a session.
It is made of `pi/extensions/fleet/` (the pi extension), `bin/pi-fleet` (the
CLI), `nvim/lua/nvconf/pi_fleet.lua` and the tmux keys in
[docs/tmux.md](docs/tmux.md). The design is in
[docs/pi-fleet-design.md](docs/pi-fleet-design.md).

Start with `pi-fleet open` inside tmux (or `pi-fleet open --cwd DIR`,
`pi-fleet open --session FILE|ID`). A session that is already live is jumped
to and never started twice; one live on another login node is refused.

Status glyphs: ● running · ? question · ◐ waiting (unseen) · ○ idle · ✕ error or
crashed · ⟳ starting. A stopped pi rings the bell, and the tmux status bar
lists the sessions that need you by window number.

| In pi | Does |
| --- | --- |
| `/new` | a new session in a new window (the current one keeps running) |
| `/resume` | pi's picker; the chosen session opens in a new window, or is jumped to if live |
| `/kill` | end this session: a dialog lists the subagents it stops and its Slurm jobs (left running by default) |
| `/sessions` | the session list (the dashboard without the preview) |
| `/view FILE[:LINE]` | open a file in the paired nvim at LINE, then focus it; completes files this session touched first, then the repo |
| `/view tool:N` | the Nth most recent tool call's full output, read-only in nvim (`tool:` completes) |
| `/view` | picker: touched files, then the last 10 tool calls |
| `/btw QUESTION` | a side conversation (pi-btw) that runs even while the agent works |

Outside tmux, pi keeps its own `/new` and `/resume`, and `/view` falls back to
`nvim -R`. **Don't `/reload` while subagents are running.** It reloads every
extension, including the subagent manager that runs them, so wait until they
finish.

| Dashboard (`prefix g`, popup `prefix G`) | Does |
| --- | --- |
| `j` / `k` (or arrows) | move |
| `Space` | show a session's subagents; collapse a repo |
| `Enter` | jump to the session, or open it in a new window (on a subagent: its main) |
| `x` | kill the session (the dialog appears in its own window) |
| `n` | new session in the row's repo |
| `/` | filter by name, repo, cwd or last message (`Esc` stops typing) |
| `!` `@` `#` `&` / `0` | only running / waiting / idle / error; `0` shows all |
| `?` | help |
| `q` | close (`Esc` clears filters first) |

**vim-mode** (`pi/extensions/vim-mode.ts`, `Esc` enters NORMAL mode). Leader
keys work in NORMAL mode only and mirror nvim's `<leader>` keys. The mode
line shows `␣…` while one is pending. Any other key, or 1 s with no key,
cancels it.

| NORMAL mode | Does |
| --- | --- |
| `Space e` | `/sessions` |
| `Space f f` | file picker (session files, then the repo), opening in the paired nvim |
| `Space f g` | git files only |
| `Space f b` | files touched in this session |
| `Space f s` | grep (`Grep >` prompt, ripgrep), opening the hit at its line |
| `Space f h` | slash commands; the chosen one goes into the prompt |
| `Space g s` | `:Git` (fugitive) in the paired nvim, then focus it |
| `Space t` | tool output picker |
| `v` / `V` | start a character / line selection; `y` copies |

| INSERT mode | Does |
| --- | --- |
| `Tab` while the agent works | queue the prompt as a follow-up (when idle: autocomplete) |
| `Up` on the first line | take queued messages back into the prompt |

The agent's `ask_user_question` takes an optional `timeoutSeconds`: if nobody
answers in time, the options marked "(Recommended)" are chosen and the agent is
told so. Any keypress cancels the countdown. In the paired nvim, files are
read-only: `:w!` saves and tells pi with your next message, and `:w!!` saves
and tells it now. See [docs/nvim.md](docs/nvim.md#paired-nvim-pi-fleet).

## Python work directory and caches

`PY_WD` (asked once, saved in `local.sh`) holds code and must be on persistent
storage: project space on clusters, not scratch or a node-local disk.

When `PY_WD` is outside `$HOME` (typical on clusters with small home quotas),
bootstrap sets `CACHE_ROOT=$PY_WD/cache` (mode 700) and the shell points
`XDG_CACHE_HOME` (uv, Hugging Face, torch, pip on Linux, vLLM) plus Triton,
wandb, the CUDA JIT cache and uv-managed Pythons there. The Hugging Face token
stays in `~/.config/huggingface/token`. When `PY_WD` is inside `$HOME`, tools
keep their default cache locations.

If uv's cache and `PY_WD` end up on different filesystems, bootstrap sets
`UV_LINK_MODE=copy`. To force a different cache location (e.g. scratch), run
`ENV_CACHE_ROOT=/path ~/env/bootstrap.sh`.

## git remote

`origin` fetches over HTTPS (works on any machine) and pushes over SSH (works
once a key or a forwarded agent is available).

## Validation

CI runs `shellcheck`, `zsh -n`, a check that `bootstrap.sh` stays user-level,
and `tests/bootstrap_test.sh` on macOS bash, macOS zsh and Ubuntu bash. Run
the tests locally with:

```bash
SHELL=/bin/zsh tests/bootstrap_test.sh
SHELL=/bin/bash tests/bootstrap_test.sh
```
