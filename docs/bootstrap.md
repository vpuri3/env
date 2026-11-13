# bootstrap.sh

Sets up a machine from `~/env`. It's safe to re-run: a second run changes
nothing, and re-running is also how you update a machine:

```bash
git -C ~/env pull --ff-only && ~/env/bootstrap.sh
```

For clusters, run `env-deploy <cluster>` on the laptop instead. It runs
bootstrap on the cluster with the cluster's values pre-filled (see
`skills/env-deploy/`).

## Options

| Flag | Does |
| --- | --- |
| *(none)* | interactive: asks each question, with the current value as default |
| `--defaults` | accept every default without asking; required when stdin is not a terminal |
| `--skip-installs` | only shell startup, dotfiles, editors, git, ssh, agents; no tool installs, no Julia |
| `--only STEP,...` | run just these steps (below); skips the questions and every other step |
| `-h`, `--help` | usage |

| Environment variable | Does |
| --- | --- |
| `ENV_PY_WD`, `ENV_STORAGE_DIR`, `ENV_MACHINE`, `ENV_MACHINE_NAMES` | defaults for the matching questions (set by `env-deploy`) |
| `ENV_CACHE_ROOT=/path` | put caches here instead of `$STORAGE_DIR/cache` (e.g. scratch); remembered in `local.sh` |
| `PI_CODING_AGENT_DIR` | where pi's config lives (default `~/.pi/agent`) |

## Guarantees

- **User-level only.** Writes under `$HOME` and the chosen work directories.
  Never `sudo`, never a system package manager, never touches Homebrew. Tools
  go under `~/.local`. CI enforces this.
- **Supported:** macOS bash, macOS zsh, Linux bash. Linux + zsh is refused.
  It refuses to run inside a Slurm/PBS/LSF job (use a login node).
- **Shared files are touched minimally.** In `~/.bashrc`, `~/.zshrc`,
  `~/.bash_profile`, `~/.gitconfig` and `~/.ssh/config` it only writes between
  `# >>> env (managed by ~/env/bootstrap.sh) >>>` markers.
- **Backups.** Every file it replaces or rewrites is first saved under
  `~/.env-backup/<timestamp>/`, at the same path relative to `$HOME`. The
  final line of output names the directory.

## What it does, in order

1. **Checks:** bash, supported OS/shell, not in a batch job, `git` and `curl`
   present (on macOS also the Xcode command line tools).
2. **Repo:** clones `~/env` if missing. `origin` fetches over HTTPS and
   pushes over SSH. Removes links left by older versions of this repo.
3. **Questions → `~/.config/env/local.sh`** (untracked, this machine only):

   | Question | Saved as | Notes |
   | --- | --- | --- |
   | machine / cluster name for the prompt | `MACHINE`, `MACHINE_NAMES` | `user@MACHINE` in the prompt |
   | Python work directory | `PY_WD` | persistent storage; refuses temporary disks; `cdp` goes here |
   | personal storage | `STORAGE_DIR` | asked only when `PY_WD` is outside `$HOME` (clusters); `cds` goes here |
   | — | `CACHE_ROOT` | `$STORAGE_DIR/cache` (mode 700) when set; caches for uv, HF, torch, pip, Triton, wandb, CUDA go there |
   | — | `UV_LINK_MODE=copy` | when uv's cache and `PY_WD` are on different filesystems |
   | set up Julia? | `JULIA_DEPOT_PATH` | default no; skipped with `--skip-installs` |
4. **Dotfiles (symlinks into the repo):** `~/bin`, `~/.vimrc`, `~/.tmux.conf`,
   `~/.emacs`, `~/.config/nvim`.
5. **Editors:** for Cursor and VS Code, if each has been opened on this
   machine, asks to link `vscode_settings.json` / `vscode_keybindings.json`.
   With `STORAGE_DIR`, offers to move `~/.cursor-server` /
   `~/.vscode-server` there behind a symlink.
6. **git:** includes `~/env/gitconfig` from `~/.gitconfig` and asks for this
   machine's `user.name` / `user.email`.
7. **ssh:** `~/.ssh/config` includes `~/.ssh/config.local` and
   `~/env/sshconfig` at the top (so editors list the hosts) and
   `~/env/sshconfig_defaults` (`Host *`) at the bottom (so host values win).
8. **Agents:**
   - Codex: copies `codex/config.toml` once.
   - pi: links `keybindings.json` and `extensions/`, and copies `settings.json`
     once (pi writes to it).
   - Skills: links each `skills/<name>` into `~/.agents/skills/`.
9. **Shell startup:**
   - zsh (macOS): a block in `~/.zshrc` sources `~/env/shellrc`.
   - bash:
     - `~/.bashrc` gets a block at the top, so non-interactive shells (`ssh
       host cmd`, cron, Slurm) still get the environment, and one at the bottom
       for interactive shells. It also adds `/etc/bashrc` on RHEL-family
       systems, for `module`.
     - `~/.bash_profile` loads `~/.profile` and `~/.bashrc` once.
10. **macOS:** key repeat instead of the accent popup.
11. **Installs** (skipped with `--skip-installs`; each asks first):

    | Tool | Default | Where |
    | --- | --- | --- |
    | Neovim (pinned `NVIM_VERSION`) | yes | `~/.local/neovim` |
    | Neovim plugins and treesitter parsers | yes | built headless; downloads the pinned tree-sitter CLI (`TREE_SITTER_VERSION`) to `~/.local/bin` if needed, and needs a C compiler; log in `~/.local/share/nvim/env-bootstrap.log` |
    | uv | yes | `~/.local/bin` |
    | Codex CLI | no | npm under `~/.local` (installs Node.js LTS there if npm is missing) |
    | Claude Code | no | official installer |
    | pi | yes | official installer (`pi.dev/install.sh`), run without a terminal so it doesn't prompt: managed install in `~/.pi/agent`, launcher `~/.local/bin/pi`, upgrade with `pi update`. Installs Node.js LTS in `~/.local/node` first if node is missing or older than 22.19, so the installer never reaches for Homebrew or root |
    | Julia (juliaup, julia-vim, startup.jl) | if chosen in step 3 | `JULIA_DEPOT_PATH` |
    | pi packages in `pi/packages.txt` | when pi is installed | `pi install` |

    Existing tools are left alone. Neovim is replaced only after asking,
    when the user-local copy is a different version.

## Running single steps (`--only`)

`--only` runs the named steps and nothing else: no repo update, no machine
questions, no `local.sh`. Steps run in bootstrap's own order, whatever order
they are given in. The safety checks (shell, batch job, git and curl) still
run. Add `--defaults` when there's no terminal, e.g. from an agent.

```bash
~/env/bootstrap.sh --only pi,skills              # relink pi config and agent skills
~/env/bootstrap.sh --defaults --only install-pi  # install pi + pinned packages
```

| Step | Does |
| --- | --- |
| `dotfiles` | symlinks `~/bin`, `~/.vimrc`, `~/.tmux.conf`, `~/.emacs`, `~/.config/nvim` |
| `editors` | links the VS Code / Cursor settings and keybindings |
| `git` | `~/.gitconfig` include; asks for name/email |
| `ssh` | `~/.ssh/config` managed blocks |
| `codex` | copies `codex/config.toml` once |
| `pi` | links pi keybindings and extensions; copies `settings.json` once |
| `skills` | links `skills/*` into `~/.agents/skills/` |
| `shell` | rc-file blocks that load `shellrc` |
| `macos` | key repeat (macOS only) |
| `install-nvim` | Neovim, plugins, treesitter parsers |
| `install-uv`, `install-codex`, `install-claude` | those tools |
| `install-pi` | pi (if missing) and the packages in `pi/packages.txt` |

Steps that need the machine questions (`PY_WD`, `STORAGE_DIR`, Julia,
moving editor servers) are not available alone; run the full bootstrap.

## Common tasks

| Task | How |
| --- | --- |
| change `PY_WD` / `STORAGE_DIR` here | re-run bootstrap and answer the question differently |
| upgrade Neovim everywhere | bump `NVIM_VERSION` in `bootstrap.sh`, commit, re-run on each machine (`env-deploy` for clusters) |
| update Neovim plugins | `:PackerSync` (bootstrap never updates plugins) |
| undo a change | copy the file back from `~/.env-backup/<timestamp>/` |
| non-interactive run (CI, scripts) | `bootstrap.sh --defaults --skip-installs` |
| apply one change, e.g. new pi extension or skill | `bootstrap.sh --only pi,skills` |

## Testing changes to bootstrap

`tests/bootstrap_test.sh` bootstraps throwaway homes inside the repo
(`.bootstrap-test.*`, gitignored). It checks the results, re-runs to prove
nothing changes, and covers migrations and refusals. CI runs it on macOS bash,
macOS zsh and Ubuntu bash, plus `shellcheck` and `zsh -n`.

```bash
SHELL=/bin/zsh  tests/bootstrap_test.sh
SHELL=/bin/bash tests/bootstrap_test.sh
```

Add a `check` for every new step. See `AGENTS.md` for the rules a change
must keep.
