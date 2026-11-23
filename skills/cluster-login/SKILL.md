---
name: cluster-login
description: Log onto an HPC/Slurm cluster and get to a usable shell or compute node - ssh aliases from ~/.ssh/config.local, persistent tmux sessions on the login node, attaching to a running job's node, and checking where you are (login vs compute node). Use when asked to connect to, log into or work on a cluster, or when a command must run on a job's node.
---

# Logging onto a cluster

Cluster hosts are private: they live in `~/.ssh/config.local` (and on the laptop in
`~/.config/env/clusters/<name>.sh`), never in this repo. To add one, use the
`env-add-cluster` skill; to install ~/env there, `env-deploy`.

## From the laptop

```bash
grep -i '^Host ' ~/.ssh/config ~/.ssh/config.local      # known aliases
ssh <alias>                                              # login node
ssh <alias> -t 'tmux new -A -s main'                     # reattach a persistent session
```

Login nodes behind round-robin DNS give different machines per connection; a tmux
session lives on one of them. `MACHINE_NAMES` in `~/.config/env/local.sh` maps
login hostnames to short names shown in the prompt, so you know which one you are on.

## Where am I?

```bash
hostname; echo "job=${SLURM_JOB_ID:-none}"; nvidia-smi -L 2>/dev/null | head -2
```

- No `SLURM_JOB_ID` and no GPUs: login node. Edit, git, submit, monitor only.
- Inside a job: `SLURM_JOB_ID` is set; do not `scancel` it from here.

## Getting onto a compute node

Use the `slurm-jobs` skill (`sjob`):

```bash
sjob alloc -n dev -t 2:00:00     # after loading the SJOB_* block from ~/.config/env/cluster.md
sjob shell <jobid>               # interactive shell on that node, all CPUs
sjob run <jobid> -- <cmd>        # one command, no shell
ovl <jobid>                      # same as shell, minimal (bin/ovl)
```

Plain `ssh <node>` to a node only works on sites that allow it for nodes you hold
a job on; prefer `srun --overlap` (what `sjob`/`ovl` use) so the step is inside
the job's cgroup and gets its CPUs and GPUs.

## Agents

- Run long or blocking cluster work (allocations, installs, training) through a
  `slurm-operator` subagent; keep the main thread on the login node.
- Never put hostnames, account names or paths from a cluster into ~/env; put them
  in the project repo (if private) or `~/.config/env/`.
