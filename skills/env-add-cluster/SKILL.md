---
name: env-add-cluster
description: "Onboard a new remote cluster for the ~/env dotfiles: add its ssh aliases to ~/.ssh/config.local, write ~/.config/env/clusters/<name>.sh (SSH_HOST, MACHINE, PY_WD, STORAGE_DIR), choose paths with env-deploy --probe, then deploy. Use when asked to add, register or set up a cluster/machine that env-deploy doesn't know yet, or to change a cluster's paths."
---

# Add a cluster for env-deploy

Everything here is **private** and stays on the laptop. Never put hostnames,
cluster names or paths into the ~/env repo (it is public).

## 1. Gather facts (ask the user for what you can't find)

- Login node hostnames (and any data-copier or VS Code nodes).
- Username on the cluster, if it differs from the local one.
- Where project space and personal storage live (often a Lustre/GPFS path).
  Home quotas on clusters are small, so caches must not stay in `$HOME`.

## 2. ssh aliases in `~/.ssh/config.local`

Follow the existing naming in that file: `<site>N` for login node N, `<site>-dcN`
for data copier N, `<site>-vsN` for VS Code node N. Add a comment line naming the
cluster:

```
# mycluster (site, arch, GPU)
Host myc1
    HostName login-01.mycluster.example.org

Host myc2
    HostName login-02.mycluster.example.org
```

- One alias per `Host` line, with a `HostName`. env-deploy derives prompt
  names from this file: hosts whose alias starts with `MACHINE` show that
  alias in the prompt (`myc1`); other nodes show `myc:<node>`.
- Shared defaults (`AddKeysToAgent`, `ForwardX11`, `ForwardAgent no`) come
  from `Host *` in `~/env/sshconfig_defaults`. Only add per-host options that
  differ, e.g. `User` or `ForwardAgent yes`.
- Test it: `ssh -o BatchMode=yes myc2 true`. A failure is fine before the key
  is installed; a DNS or timeout error is not.
- Prefer login node 02+ for `SSH_HOST`: node 01 is usually the busiest.

## 3. Cluster file `~/.config/env/clusters/<name>.sh`

Copy the shape of an existing file there. A comment says which cluster it is.

```bash
# mycluster. Read by ~/env/bin/env-deploy; bootstrap.sh on the cluster
# saves these in ~/.config/env/local.sh there.
SSH_HOST=myc2
MACHINE=myc
PY_WD=/project/me/python          # persistent project space; `cdp` goes here
STORAGE_DIR=/project/me           # personal storage; caches -> $STORAGE_DIR/cache
# CACHE_ROOT=/scratch/me/cache    # optional override, e.g. scratch
# MACHINE_NAMES="host1=myc1 ..."  # optional; normally read from config.local
```

`<name>` (the file name) is what the user types: `env-deploy <name>`.

## 4. Probe, then fix paths

```bash
~/env/bin/env-deploy <name> --probe
```

Read the output with the user:

- **paths:** each existing path shows its real path (resolved symlinks) and
  disk. For a missing path, the probe walks up to the deepest existing parent
  and lists its contents, to pick the right directory.
- **PY_WD** must be persistent (project space), never scratch, `/tmp` or a
  node-local disk; bootstrap refuses temporary storage.
- **STORAGE_DIR** should have room for caches (HF, torch, uv, wandb) and the
  editor servers (several GB).
- **quotas:** shown when the site provides a quota script.
- **`github: unreachable`** means `git clone` will fail; stop and ask.

Edit the cluster file and probe again until the paths are right.

## 5. Deploy

Follow the `env-deploy` skill: `~/env/bin/env-deploy <name>`. It's
interactive, so the user must be able to answer prompts.

## Changing an existing cluster

Edit its cluster file, `--probe`, then redeploy. Bootstrap rewrites
`local.sh` on the cluster from the new values. Moving `PY_WD` doesn't move
existing code; tell the user.
