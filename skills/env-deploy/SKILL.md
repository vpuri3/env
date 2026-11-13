---
name: env-deploy
description: "Deploy or update the ~/env dotfiles repo on a remote cluster with ~/env/bin/env-deploy (runs on the laptop, installs the ssh key, clones/updates ~/env on the cluster and runs bootstrap.sh). Use when asked to set up, update, sync, redeploy or probe ~/env on a cluster, or to debug a failed env-deploy run. For a cluster that has no config yet, use env-add-cluster first."
---

# Deploy ~/env to a cluster

`env-deploy` runs on the laptop, never on the cluster. It reads per-cluster
values from `~/.config/env/clusters/<cluster>.sh` (private, not in the repo).

## Before you start

1. List the known clusters: `ls ~/.config/env/clusters/`. If the one asked for
   is missing, switch to the `env-add-cluster` skill.
2. Read that file to see its `SSH_HOST`, `PY_WD` and `STORAGE_DIR`. Don't paste
   its values into anything committed to ~/env (the repo is public).
3. Make sure the cluster gets what you expect. env-deploy deploys
   **`origin/<current branch>`**, not the local working tree:
   ```bash
   git -C ~/env status --short --branch
   git -C ~/env log --oneline -1 origin/$(git -C ~/env branch --show-current)
   ```
   Unpushed commits will **not** reach the cluster. Push them first, but only
   if the user agreed to push.

## Run it

```bash
~/env/bin/env-deploy <cluster> --probe   # read-only: host, paths, disk, quotas, key status
~/env/bin/env-deploy <cluster>           # install key if needed, clone/update, bootstrap
```

- **Probe first** for a cluster you haven't deployed recently. It changes
  nothing except installing the ssh key when key login fails.
- **The real deploy is interactive.** It runs `ssh -t` and `bootstrap.sh`
  asks questions, with defaults pre-filled from the cluster file. It may also
  ask for a password once (one shared ssh connection). Run it where the user
  can answer: tell them the command, or run it in a tmux window
  (`tmux new-window -n deploy '~/env/bin/env-deploy <cluster>; read'`). Don't
  run it through a non-interactive tool call that cannot take input.
- **To update every cluster**, loop over the files one at a time, each
  interactive. Ask before doing all of them.

## Read the output

| Line | Meaning |
| --- | --- |
| `== key login to X already works` | fine |
| `== installing ~/.ssh/id_ed25519.pub on X` | first deploy; a password prompt follows. Override the key with `ENV_DEPLOY_KEY=` |
| `key login still fails; X may not accept keys` | the cluster may require passwords or 2FA; deploy still works over the shared connection |
| `local ~/env differs from origin/<branch>` | unpushed or unpulled commits; the cluster gets origin |
| `== bootstrapping ~/env (branch B) on X` | handed over to bootstrap.sh on the cluster |

## After deploying

- Verify on the cluster:
  ```bash
  ssh <SSH_HOST> 'cat ~/.config/env/local.sh; git -C ~/env log --oneline -1'
  ```
- New shells pick up the changes. Existing tmux panes on the cluster keep
  their old environment until reopened.

## Common failures

| Symptom | Cause / fix |
| --- | --- |
| `no ~/.config/env/clusters/<c>.sh` | not set up yet: use `env-add-cluster` |
| `SSH_HOST is not set` / `PY_WD is not set` | fill in the cluster file |
| bootstrap: `running inside a batch job (compute node)` | `SSH_HOST` points at a compute node or the shell is in an allocation; use a login node alias |
| bootstrap: `stdin is not a terminal` | it was run without a tty; run env-deploy from a real terminal |
| `PY_WD is on temporary storage` | pick project space, not scratch, `/tmp` or a node-local disk (`--probe` shows each path's disk) |
| `git clone` fails on the cluster | `--probe` prints `github: unreachable`; the cluster has no outbound HTTPS, so a proxy is needed. Ask the user |
| stuck at the ssh connection | VPN or a 2FA prompt; a stale master can be closed with `ssh -o ControlPath=~/.ssh/cm/%C -O exit <SSH_HOST>` |
| home quota full | rerun the deploy and accept moving `~/.cursor-server` / `~/.vscode-server` into `STORAGE_DIR` |

## Don't

- Edit `~/.config/env/local.sh` on the cluster by hand to fix values. Fix the
  laptop's cluster file and redeploy, so they stay in sync.
- Run `bootstrap.sh --defaults` on a cluster without being asked. It accepts
  every default, including tool installs.
