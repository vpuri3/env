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
| [skills/](skills/) | agent skills (`env-deploy`, `env-add-cluster`, `slurm-jobs`, `cluster-login`, `cluster-python-env`, `dataset-download`, `run-autonomously`), linked into `~/.agents/skills/` |
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
such as `/run-autonomously`) are symlinked into `~/.pi/agent` (or `$PI_CODING_AGENT_DIR`), and
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

pi-fleet runs several pi sessions at once in the **pi deck**, a private tmux
server (`tmux -L pifleet`) with four panes: down the left the session list,
the selected session's **nvim** and a **shell** in its directory (40/40/20),
and its **pi** on the right half. Moving in the list swaps that session's pi,
nvim and shell in; every session keeps running in the background, and each
has its own nvim and shell (started the first time the session is shown; the
shell goes when the session ends, whatever runs in it). The list keeps its
order as sessions change state (new sessions go last in their repo); `r`
sorts it again. It is made of `pi/extensions/fleet/` (the pi extension),
`bin/pi-fleet` (the CLI), `pi/deck.tmux.conf`, `nvim/lua/nvconf/pi_fleet.lua`
and the tmux keys in [docs/tmux.md](docs/tmux.md). The design is in
[docs/pi-deck-design.md](docs/pi-deck-design.md) (§15–§17) and
[docs/pi-fleet-design.md](docs/pi-fleet-design.md).

From a shell, `pf` opens the deck: outside tmux in this terminal, inside tmux
in a 95% popup (also `prefix g`). `pf DIR [-- PI_ARGS]` (or `pf -- PI_ARGS`
for here) first starts a new session in DIR. `prefix d` (or `C-c` in the list)
detaches; the deck keeps running. `pi-fleet open --session FILE|ID` resumes
a session in the deck; one live on another login node is refused.
`pi-fleet kill-deck` ends every deck session and the deck.

Status glyphs: ● running · ? question · ◐ waiting (unseen) · ○ idle · ✕ error or
crashed · ⟳ starting. Colors, the same in the list and the tmux status bar:
active (idle) blue, working purple (`»` when autonomous, after
`/run-autonomously`), done (unseen) green, question orange, error red,
closed grey. A stopped pi rings the bell, and your tmux status bar counts the
sessions that need you (`π 1? 2◐`).

| In pi | Does |
| --- | --- |
| `/new` | a new session in the pi deck, shown and focused (the current one keeps running); from a pi started by hand, the deck pops up |
| `/resume` | pi's picker; the chosen session opens in the pi deck (selected if already there), or is jumped to if it runs in your tmux |
| `/kill` | end this session: a dialog lists the subagents it stops and its Slurm jobs (left running by default) |
| `/sessions` | in the deck: back to the list; elsewhere the deck popup |
| `/reload` | pi's reload; also refreshes a running pi deck: re-reads `pi/deck.tmux.conf` and restarts the deck's list with the current code (sessions stay). By hand: `pi-fleet deck-reload` |
| `/autonomous [off]` | is this session autonomous (set by `/run-autonomously`)? `off` ends it |
| `/view FILE[:LINE]` | open a file in the session's nvim at LINE, then focus it (in the deck: the nvim below the list); completes files this session touched first, then the repo |
| `/view tool:N` | the Nth most recent tool call's full output, read-only in nvim (`tool:` completes) |
| `/view` | picker: touched files, then the last 10 tool calls |
| `/btw QUESTION` | a side conversation (pi-btw) that runs even while the agent works |

**Session titles.** After the first run of an unnamed session, the fleet
extension asks a cheap model (the cheapest haiku/flash/mini/nano/lite model of
the session's provider, else the session's model) for a 6–12 word title and
sets it as the session name, which the deck and `/resume` show.
It is rewritten once more after 6 user messages. A name you give with `/name`
or `--name` is never replaced. `PI_FLEET_TITLE_MODEL=provider/id` picks the
model, `PI_FLEET_TITLE=off` turns titles off (`on` also titles RPC-mode pis),
`PI_FLEET_TITLE_DEBUG=FILE` logs failures. `pi-fleet title-backfill [--limit N]
[--dry-run]` titles the N (default 20) newest closed sessions without a name.

Outside tmux, pi keeps its own `/new` and `/resume`, and `/view` falls back to
`nvim -R`. **Don't `/reload` while subagents are running.** It reloads every
extension, including the subagent manager that runs them, so wait until they
finish.

| In the deck | Does |
| --- | --- |
| `C-h` `C-j` `C-k` `C-l` | move to the pane in that direction: list ↕ nvim ↕ shell down the left, `C-l` to pi, `C-h` from pi to the list. At an edge the key goes to the program (in pi `C-j`/`C-k` stay newline/kill line; in the shell `C-h`/`C-j`; `prefix C-k`/`prefix C-l` send those literally) |
| `prefix e` | pi ↔ nvim |
| `prefix z` | zoom the focused pane |
| `prefix h` (or `prefix C-h`), … | send a literal `C-h`, … |
| `prefix d`, `prefix g` | detach (closes the popup) |

| Session list | Does |
| --- | --- |
| `j` / `k` (or arrows, `C-n`/`C-p`) | move; the session's pi, nvim and shell follow |
| `r` | refresh: sort the list again (otherwise rows keep their place; the selection stays on its row) |
| `Enter`, `C-l` | focus the session's pi (closed session: `Enter` resumes it, `C-l` reads its transcript in `less`) |
| `Space` | show a session's subagents; fold a repo. A subagent of a deck session shows its agent view (as `/agents tree` → Enter) in the session's pi, `Enter`/`C-l` go there (`Esc` → the tree → the conversation); other subagents preview their transcript (`C-l` reads it in `less`) |
| `d` | kill the session: confirm with `y`, or `s` to also scancel its Slurm jobs (`n`/`Esc` cancel) |
| `a` | new session in the repo of the row or repo header |
| `i`, `/` | search by name, repo, cwd or last message (`Esc` back) |
| `!` `@` `#` `&` / `0` | only running / waiting / idle / error; `0` shows all |
| `?` | help |
| `C-c` | detach (as `prefix d`; the deck keeps running) |
| `C-d` | kill every deck session and the deck (asks first: `y`/`Enter` kill, `n`/`Esc` cancel; nvims with unsaved changes keep it up and are named) |

**vim-mode** (`pi/extensions/vim-mode.ts`, `Esc` enters NORMAL mode). Leader
keys (`,`) work in NORMAL mode only. The mode line shows `,…` while one is
pending. Any other key, or 1 s with no key, cancels it.

| NORMAL mode | Does |
| --- | --- |
| `Space` | start a selection; `v` toggles it between characters and whole lines (`V` starts a line selection); `y` copies |
| `, f f` | file picker (session files, then the repo), opening in the session's nvim |
| `, f g` | git files only |
| `, f b` | files touched in this session |
| `, f s` | grep (`Grep >` prompt, ripgrep), opening the hit at its line |
| `, f h` | slash commands; the chosen one goes into the prompt |
| `, g s` | `:Git` (fugitive) in the session's nvim, then focus it |
| `, t` | tool output picker |

| INSERT mode | Does |
| --- | --- |
| `Tab` while the agent works | queue the prompt as a follow-up (when idle: autocomplete) |
| `Up` on the first line | take queued messages back into the prompt |

The agent's `ask_user_question` takes an optional `timeoutSeconds`: if nobody
answers in time, the options marked "(Recommended)" are chosen and the agent is
told so. Any keypress cancels the countdown. In the session's nvim, files are
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
