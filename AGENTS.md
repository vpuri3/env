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
| `~/.config/env/slurm.sh` | optional `SJOB_*` defaults for `bin/sjob` (account, partitions); project repos may set these instead |

Check `git diff --cached` for such strings before every commit. Examples in
docs and skills use placeholders (`mycluster`, `/project/me`).

## Layout

| Path | What |
| --- | --- |
| `bootstrap.sh` | sets up a machine; re-runnable |
| `shellrc`, `vars.sh`, `aliases.sh` | shell startup (bash + zsh); `aliases.sh` is interactive-only |
| `bin/` | small scripts on `PATH`; `env-deploy` sets up clusters from the laptop; `sjob` drives Slurm (site values only via `SJOB_*` env / `~/.config/env/slurm.sh`) |
| `nvim/` | Neovim config; `nvconf` (terminal) vs `nvconf_vscode` (vscode-neovim) |
| `vimrc`, `tmux.conf`, `emacs.conf` | symlinked dotfiles |
| `vscode_settings.json`, `vscode_keybindings.json` | linked into Cursor and VS Code |
| `pi/` | pi agent: extensions, prompt templates (`pi/prompts/`), keybindings, settings, pinned packages, subagent types (`pi/agents/`), global orchestration rules (`pi/AGENTS.md`, linked to `~/.pi/agent/AGENTS.md`; `bin/agent-lane` makes the worktrees) |
| `skills/` | agent skills, linked into `~/.agents/skills/` |
| `docs/` | cheat sheets: `tmux.md`, `nvim.md`, `vscode.md` |
| `tests/bootstrap_test.sh` | bootstraps throwaway homes and checks the result |
| `tests/pi_fleet_test.sh` | runs the pi-fleet tests (`tests/pi-fleet/*.test.ts`, node's test runner) |
| `tests/agent_lane_test.sh` | tests `bin/agent-lane` in a throwaway repository |

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
SHELL=/bin/zsh  tests/bootstrap_test.sh -q    # macOS only; on Linux it says unsupported
SHELL=/bin/bash tests/bootstrap_test.sh -q    # ~15 s
shellcheck -x bootstrap.sh shellrc vars.sh aliases.sh tests/*.sh   # if installed
for f in shellrc vars.sh aliases.sh; do zsh -n "$f"; done
```

For `pi/extensions/fleet/` and `bin/pi-*`, run the pi-fleet tests: the narrow
files while iterating, the full suite once at the end (~40 s; the files run in
parallel). `-q` prints only failures (file:line, name, message) and a summary
line; the full output is in the log whose path it prints, so don't grep it.

```bash
tests/pi_fleet_test.sh -q deck deck-view          # tests/pi-fleet/{deck,deck-view}.test.ts
tests/pi_fleet_test.sh -q -t 'C-d in the list' deck-view-tmux   # tests by name (regex)
tests/pi_fleet_test.sh -q -n 3 deck               # 3 runs in a row: flake or failure?
tests/pi_fleet_test.sh -q                         # everything, once, before claiming done
```

Tests use their own temp dirs and tmux sockets, so parallel runs (other
worktrees) are safe. A test that fails only sometimes is a bug to fix with a
proper wait (`waitFor` on the condition), not a longer `sleep` or a retry loop.

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
