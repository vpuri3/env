# env

Personal shell and editor configuration for macOS (bash or zsh) and Linux
clusters (bash), with an idempotent bootstrap script.

## Docs

| Doc | Covers |
| --- | --- |
| [docs/bootstrap.md](docs/bootstrap.md) | what bootstrap does, options, re-running, testing |
| [docs/tmux.md](docs/tmux.md) | tmux keys (prefix `Ctrl+s`), copy mode, ssh agent |
| [docs/nvim.md](docs/nvim.md) | Neovim keys, plugins, LSP |
| [docs/vscode.md](docs/vscode.md) | Cursor / VS Code with vscode-neovim |
| [AGENTS.md](AGENTS.md) | rules for coding agents working in this repo (`CLAUDE.md` links to it) |
| [skills/](skills/) | agent skills `env-deploy` and `env-add-cluster`, linked into `~/.agents/skills/` |

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
opened on the machine. For pi, `pi/keybindings.json` and `pi/extensions/` are
symlinked into `~/.pi/agent` (or `$PI_CODING_AGENT_DIR`), and
`pi/settings.json` is copied there only if none exists, since pi writes to it.
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
