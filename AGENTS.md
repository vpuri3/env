# env: instructions for coding agents

Personal shell, editor and agent configuration for macOS (bash/zsh) and Linux
clusters (bash), installed by an idempotent `bootstrap.sh`. `README.md` is the
user-facing overview; read it before changing how something is installed.

## This repo is public

Never commit anything machine- or employer-specific: hostnames, cluster names
or paths, usernames on other systems, tokens, keys, internal URLs. Those live
in untracked files on each machine:

| File | Holds |
| --- | --- |
| `~/.config/env/local.sh` | this machine: `MACHINE`, `PY_WD`, `STORAGE_DIR`, `CACHE_ROOT`, ... (written by bootstrap) |
| `~/.config/env/clusters/<name>.sh` | per-cluster values read by `bin/env-deploy` (laptop only) |
| `~/.ssh/config.local` | private ssh hosts, e.g. cluster login nodes |

Check `git diff --cached` for such strings before every commit. Examples in
docs and skills use placeholders (`mycluster`, `/project/me`).

## Layout

| Path | What |
| --- | --- |
| `bootstrap.sh` | sets up a machine; re-runnable |
| `shellrc`, `vars.sh`, `aliases.sh` | shell startup (bash + zsh); `aliases.sh` is interactive-only |
| `bin/` | small scripts on `PATH`; `env-deploy` sets up clusters from the laptop |
| `nvim/` | Neovim config; `nvconf` (terminal) vs `nvconf_vscode` (vscode-neovim) |
| `vimrc`, `tmux.conf`, `emacs.conf` | symlinked dotfiles |
| `vscode_settings.json`, `vscode_keybindings.json` | linked into Cursor and VS Code |
| `pi/` | pi agent: extensions, keybindings, settings, pinned packages |
| `skills/` | agent skills, linked into `~/.agents/skills/` |
| `docs/` | cheat sheets: `tmux.md`, `nvim.md`, `vscode.md` |
| `tests/bootstrap_test.sh` | bootstraps throwaway homes and checks the result |

## Rules for `bootstrap.sh`

- **Run single steps with `--only`** instead of the whole script, e.g.
  `~/env/bootstrap.sh --defaults --only pi,skills` after changing `pi/` or
  `skills/`. `--help` lists the steps. A new step that needs no machine
  questions belongs in `STEP_NAMES` and `run_step`.
- **User-level only.** No `sudo`, no system package managers, no Homebrew
  installs; CI greps for these. Tools go under `~/.local`.
- **Idempotent.** A second run must change nothing (the tests check this).
- **Touch other files minimally.** Edit rc files, `~/.gitconfig` and
  `~/.ssh/config` only inside the `# >>> env ... >>>` managed blocks.
- **Symlink only files no tool writes to;** copy the rest once (e.g.
  `pi/settings.json`, `codex/config.toml`). Replaced files go to
  `~/.env-backup/<timestamp>/` via `backup_move`.
- **Supported:** macOS bash, macOS zsh, Linux bash. Linux + zsh is refused.
- **Values from `env-deploy` arrive as `ENV_*` variables** (`ENV_PY_WD`,
  `ENV_STORAGE_DIR`, ...) and become prompt defaults; keep that contract.
- **Pinned versions** (`NVIM_VERSION`, `TREE_SITTER_VERSION`,
  `pi/packages.txt`) change only on purpose. Review a third-party pi package's
  source before adding it.

## Shell style

- bash, 4-space indent, `local` for function variables, quote everything.
- Must pass `shellcheck -x` (`.shellcheckrc` disables SC2016 and SC2088 on
  purpose). `shellrc`, `vars.sh` and `aliases.sh` must also parse in `zsh -n`.
- `vars.sh` runs in non-interactive shells (scp, Slurm jobs, editor
  terminals): no output, no prompts, nothing slow.

## Verify before claiming done

```bash
SHELL=/bin/zsh  tests/bootstrap_test.sh
SHELL=/bin/bash tests/bootstrap_test.sh
shellcheck -x bootstrap.sh shellrc vars.sh aliases.sh tests/bootstrap_test.sh   # if installed
for f in shellrc vars.sh aliases.sh; do zsh -n "$f"; done
```

Add a `check` to `tests/bootstrap_test.sh` for every new bootstrap step. For
`tmux.conf`, load it in a throwaway server: `tmux -L envtest -f tmux.conf
new-session -d` and inspect `show -gv <option>`. For `nvim/`, run
`nvim --headless -c 'qa!'` and check that there are no errors.

## Editors

- `nvim/init.lua` loads `nvconf` in a terminal and `nvconf_vscode` when
  `vim.g.vscode` is set. Every `nvim/after/plugin/*.lua` must return early
  under vscode-neovim, and must warn rather than error when its plugin is missing.
- Plugins are managed by packer. Bootstrap installs missing plugins and
  parsers headless and never updates them (`:PackerSync` does).
- When you change a keybinding in `tmux.conf`, `nvim/`, or the VS Code files,
  update the matching table in `docs/`.

## pi (`pi/`)

- Check every extension API against the installed pi source and docs
  (`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/`)
  rather than guessing. Test extensions in node against pi's real components.
- `compact-tools.ts` must keep the expanded (`ctrl+o`) rendering identical to
  pi's built-in one.
- Plain-letter keys must never be bound in `pi/keybindings.json`: pi's
  transcript handler runs before the editor and would steal typed letters.

## Clusters

Use the `env-deploy` skill (`skills/env-deploy/`) to deploy or update ~/env on
a cluster, and `env-add-cluster` to set up a new one. Never run `bootstrap.sh`
on a compute node or inside a Slurm job (it refuses).

## Git

- Commit messages: `area: what changed` in lowercase, e.g. `bootstrap: ...`,
  `env-deploy --probe: ...`, `pi: ...`, `nvim: ...`. Add a bulleted body for
  multi-part changes.
- Only commit or push when asked. Leave unrelated uncommitted changes out of a
  commit, or commit them separately, and say so.
- `origin` fetches over HTTPS and pushes over SSH.
