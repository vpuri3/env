---
name: slurm-jobs
description: Get interactive Slurm allocations, submit batch jobs and restart chains, run commands inside allocations, monitor queues and job health with the `sjob` CLI from ~/env/bin. Use for any work on a Slurm cluster - installs, data prep, training, sweeps, checking the queue - and to decide what to delegate to a slurm-operator subagent.
---

# Slurm jobs with `sjob`

`sjob` (in `~/env/bin`, on `PATH` after bootstrap) wraps `salloc`/`sbatch`/`srun`/
`squeue`/`sacct` in independent subcommands. `sjob help` lists them.

Site values are **not** in this repo. They come from `SJOB_*` variables:

| Variable | Meaning |
| --- | --- |
| `SJOB_ACCOUNT` | `--account` (many sites reject jobs without one) |
| `SJOB_PARTITION` | default for `alloc` (an interactive partition) |
| `SJOB_BATCH_PARTITION` | default for `batch` / `chain` |
| `SJOB_TIME` | default walltime |
| `SJOB_NAME_PREFIX` | prefix for job names, e.g. a site naming convention |
| `SJOB_ALLOC_ARGS` | extra args for every allocation, e.g. `--exclusive` or `--gres=gpu:8` |
| `SJOB_STAGE_DIR` | staged batch scripts and logs (use a shared filesystem) |

Set them in one of:

- the export block in `~/.config/env/cluster.md` (untracked, one per cluster; written by
  the `cluster-onboarding` skill, which must exist before any job - run `slurm-preflight`
  before the first job of a session);
- a project wrapper that exports them and `exec sjob "$@"` (e.g. a repo's
  `scripts/slurm.sh` + `scripts/clusters/<cluster>.sh`) - preferred for project work;
- `~/.config/env/slurm.sh` (untracked, per machine; still read by `sjob`) for personal defaults.

Check with `sjob config`. Discover site limits with `sjob limits`.

## Prefer interactive allocations

Interactive partitions usually start in seconds to minutes; batch can wait hours.
Use interactive unless the work outlives the interactive time limit or you hit the
per-user interactive job limit.

```bash
sjob alloc -n myproj.install -t 1:00:00     # blocks until granted, prints JOBID=<id>
sjob run <id> -- nvidia-smi -L               # step on the node with all its CPUs
sjob run <id> --log /path/install.log -- bash scripts/install.sh
sjob run <id> --bg --log /path/train.log -- bash train.sh   # detached; prints PID and LOG
sjob shell <id>                              # human: interactive shell on the node
sjob left <id>; sjob gpus <id>
sjob cancel <id>                             # release it when done
```

`sjob run` passes `--overlap --cpu-bind=none` and all of the node's CPUs, so
dataloaders do not get squeezed onto one core. Several `run` steps can share one
allocation (e.g. install in one, download in another). `--bg` steps survive the
calling shell; their srun exits when the command ends or the allocation expires.

Agents: `sjob alloc` blocks while queued. Run it with a timeout
(`timeout 900 sjob alloc ...`) or in the background and `sjob wait <id>`.

## Batch jobs and restart chains

```bash
sjob batch -t 4:00:00 -n myproj.train train.sh --resume     # staged copy, prints JOBID=<id>
sjob batch -t 0:30:00 --wrap 'python prep.py'
sjob chain 4 -t 4:00:00 -n myproj.train train.sh             # 4 links, each afterany the previous
sjob tail <id> 40; sjob info <id>; sjob hist 2
```

- The script is copied at submit time, so later edits do not change queued jobs.
- Logs go to `$SJOB_STAGE_DIR/logs/%x-%j.out` unless `-o` is given.
- A chain link must be **resumable**: on start, resume from the latest checkpoint if
  one exists, else start fresh; exit 0 when training is already complete so the
  remaining links finish instantly. `afterany` runs the next link even after a
  timeout, which is what you want for walltime-limited training.
- Cancel the rest of a chain with `sjob cancel <id>` for each pending link
  (`sjob q` shows them as `(Dependency)`).

## Monitoring

- `sjob q` for the queue, `sjob info <id>` for one job (state, reason, nodes, stdout).
- Long jobs: confirm launch (log has first steps, `sjob gpus <id>` shows load), then
  poll every 2-5 minutes from a loop that appends to a status file; look at it
  rather than streaming logs. Scan logs with
  `rg -n 'Traceback|CUDA error|NaN|Inf|Killed|OOM' LOG | tail -20`.

## Delegate to a `slurm-operator` subagent

Hand these to a `slurm-operator` (pi subagent type from `~/env/pi/agents`), not the
main thread, so queue polling and build logs stay out of the main context:

- environment installs and builds (always on compute nodes),
- dataset downloads + extraction,
- launching training / sweeps and babysitting them past warmup,
- restart chains and anything that waits on the queue.

Give it: the project path, the cluster skill to read, the exact goal, whether to
keep or release the allocation, and where to write logs/status. Expect back job ids,
paths and a one-line status.

## Racing queues (default for every job)

Submit the same request to every queue listed as raced in `~/.config/env/cluster.md` (priority
order; skip any whose walltime/node limits the job exceeds, and never backfill, preemptible,
reserved, admin or "never" queues). Keep the first that starts, cancel the rest at once:

```bash
sjob alloc -n myproj.train -t 2:00:00 -- -p batch &          # non-blocking, output to files
sjob alloc -n myproj.train -t 2:00:00 -- --qos=short &
squeue -u $USER -n myproj.train                               # poll every 30-60 s
sjob cancel <loser-id>                                        # each loser, own jobs only
```

Same with `sjob batch`. `sjob cancel` refuses `$SLURM_JOB_ID` without `--force`, so a racer
inside an allocation can't cancel itself.

## Safety

- Never `scancel` the allocation your own shell runs in (`sjob cancel` refuses
  `$SLURM_JOB_ID` without `--force`), nor jobs you did not start.
- To stop misbehaving work inside an allocation, kill that step's processes, not the job.
- Do not run installs, builds or training on login nodes.
