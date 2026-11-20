---
name: slurm-jobs
description: Get interactive Slurm allocations, submit batch jobs and restart chains, run commands inside allocations, monitor queues and job health with the `sjob` CLI from ~/env/bin. Use for any work on a Slurm cluster - installs, data prep, training, sweeps, checking the queue - and to decide what to delegate to a slurm-operator subagent.
---

# Slurm jobs with `sjob`

`sjob` (on PATH; source ~/env/bin/sjob) wraps `salloc`/`sbatch`/`srun`/
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

- **default:** the export block in `~/.config/env/cluster.md` (untracked, one per cluster; written
  by `cluster-onboarding`; run `slurm-preflight` before the first job of a session). Load it with
  `eval "$(sed -n '/^```bash/,/^```/{/^```/d;p}' ~/.config/env/cluster.md)"`;
- a repo wrapper, only where a repo has one (exports them and `exec sjob "$@"`);
- `~/.config/env/slurm.sh`: legacy (sjob still reads it).

Check with `sjob config`. Discover site limits with `sjob limits`.

## Allocations

Every job races the queues in the cluster file's race list by default (see "Racing queues" below;
never only one queue). Report the race up front: per racer, queue, job id and state.

```bash
sjob alloc -n myproj.install -t 1:00:00 > out 2>&1 &   # prints JOBID=<id> once granted; poll squeue
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

Agents: never block on the queue. Run `sjob alloc ... > out 2>&1 &`, then poll `squeue -u $USER`
every 30-60 s (report every 2-5 min); `out` gets `JOBID=<id>` when granted.

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
  poll every 30-60 s and report every 2-5 min, appending to a status file; look at it
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

Submit the same request to every queue in the cluster file's race list (priority order; skip any
whose walltime/node caps the job exceeds, and never backfill, reservation-only, reserved, admin or
"never" queues). All racers are the same kind: `alloc` everywhere for interactive-style work
(`sjob run` steps), `batch` everywhere for batch scripts; never mix. The per-queue choice
(QOS/partition) is **not** in `SJOB_ALLOC_ARGS`; each racer adds its own. Keep the one that starts
and cancel the rest at once; if several start together, keep the one highest in the race order.

```bash
eval "$(sed -n '/^```bash/,/^```/{/^```/d;p}' ~/.config/env/cluster.md)"
sjob alloc -n myproj.train -t 2:00:00 -- --qos=short > race-short.out 2>&1 &
sjob alloc -n myproj.train -t 2:00:00 -- --qos=normal > race-normal.out 2>&1 &
sjob alloc -n myproj.train -t 2:00:00 -- --qos=long > race-long.out 2>&1 &
squeue -u $USER -n myproj.train          # poll every 30-60 s, report every 2-5 min
sjob cancel <loser-id>                   # each loser, own jobs only
# batch racers (no `--` passthrough): per-command SJOB_ALLOC_ARGS
SJOB_ALLOC_ARGS="$SJOB_ALLOC_ARGS --qos=short" sjob batch -n myproj.train -t 2:00:00 train.sh > race-short.out 2>&1 &
```

`sjob cancel` refuses `$SLURM_JOB_ID` without `--force`.

## Backfill (only on request, never raced)

Backfill runs only as `sjob batch` (never alloc: a requeued salloc has no script to rerun), with
`--requeue` and the backfill QOS; the script runs the repo's auto-restart launch with the repo
prefs file's Backfill flags. It may pend indefinitely: the cluster file states a max wait; past it,
cancel and report.

```bash
eval "$(sed -n '/^```bash/,/^```/{/^```/d;p}' ~/.config/env/cluster.md)"
SJOB_ALLOC_ARGS="$SJOB_ALLOC_ARGS --qos=<backfill> --requeue" sjob batch -n myproj.train -t 4:00:00 train.sh
```

## Safety

- Never cancel the allocation your shell runs in (`$SLURM_JOB_ID`), nor others' jobs.
- To stop misbehaving work inside an allocation, kill that step's processes, not the job.
- Do not run installs, builds or training on login nodes.
