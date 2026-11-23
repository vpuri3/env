# Cluster onboarding questions

Answers go in `~/.config/env/cluster.md` (sections A-K, cluster-wide) and, for repo-specific ones, the repo prefs file (last section).

## Rules

- Read the file before any allocation, job, install or training run. If missing, launch nothing: gather facts (A), ask B-K with `ask_user_question` (up to 4 related questions per call, 2-4 options, a recommendation), write it from TEMPLATE.md. Quote the user where wording matters.
- Edits only after the user confirms the exact lines (see SKILL.md). Note date and source of each change.
- A preference that became impossible: report evidence, propose the edit, ask.
- Skipped questions stay `TODO (ask user)`; ask before doing anything that depends on them.

## A. Facts to gather yourself (verify and record; user approves)

`sinfo -s`; `scontrol show partition <p>` (MaxTime, DefaultTime, PriorityTier, PreemptMode, OverSubscribe, QoS); `sacctmgr -P show qos` (GrpTRES, MaxTRESPerUser, MaxJobsPerUser, MaxWall); `sacctmgr show assoc user=$USER`; `scontrol show node <n>` (GPUs, CPUs, memory, local disk); driver/CUDA (`nvidia-smi` on a compute node); internet from compute nodes; container runtime (pyxis/enroot, apptainer); quotas and free space (`df -h`, `lfs quota`); site job-submit rules.
On a compute node also: node-local scratch (`df -h /raid /tmp /scratch /local`; which are RAM-backed tmpfs); CPUs per GPU and how many CPUs an allocation and a step get (`nproc` in a `sjob run` step vs a bare `srun --jobid` step).

## B. Identity and accounting

1. Account(s) (`-A`); default, and when to use another?
2. Required job-name pattern (e.g. `<account>-<subproject>.<details>`) and subproject name?
3. QOS, reservation or priority boost agents may or must use? Any to avoid?
4. GPU/node-hour budget per day/week/project; how to track and report?

## C. Compute approval

5. Without asking, agents may run: nothing / smoke only / training within limits / everything up to partition limits?
6. Do large sweeps or benchmark studies need separate approval?
7. May jobs stay queued while the user is away?

## D. Partitions and queues

8. Partition(s) for interactive, for batch?
9. Partitions to never use (preemptible, reserved, admin, debug)?
10. While an interactive request is pending, race a batch job (cancel the loser)?
11. How long pending before changing strategy (shorter walltime, other partition, ask)?

## E. Walltime

12. Fixed tiers (smoke/installs, sweeps, long training), ~1.5x estimate, or partition max?
13. Min and max walltime without asking.

## F. Long runs

14. Chain-link length: short, adaptive or max?
15. Checkpoint cadence target?
16. `sjob chain` vs interactive relays?

## G. Allocation shape

17. Whole nodes (exclusive) or per-GPU (`--gres=gpu:N`)? This sets the smallest allocation.
18. If per-GPU: default GPUs, CPUs and memory per GPU.
19. GPUs per run: fixed default or ask each time?
20. Several runs per GPU: always OK, ask first, never?
21. Max concurrent nodes/jobs without asking.
22. Multi-node single runs: allowed, ask first, never?

## H. Waiting and running

23. Poll and report cadence (e.g. poll 30-60 s, report 2-5 min, escalate on failure)?
24. On job failure: retry once, retry with workaround, or stop and ask?
25. May agents cancel their own pending/stale jobs without asking? (Never others'.)

## I. Storage

26. Slurm staging/log dir; storage limits; cleanup policy (keep checkpoints? delete smoke outputs?).
27. Containers: which images, when instead of a venv?

## J. Environment

28. Driver/CUDA and torch wheel combination; installs on compute nodes only?
29. Site modules or env vars to set?

## K. Network and data movement

30. Compute nodes reach the internet (HF, PyPI, GitHub)? If not, where do downloads run?
31. Download size/bandwidth limits; preferred tools (`hf download`, `rsync`, `aria2c`)?

## Repo prefs file (`<repo>/../<repo-name>.cluster.md`, repo-specific only)

Ask only when working from that repo and the file is missing or has TODOs:

R1. Launcher/wrapper to use for jobs (script, make target, `sjob` directly)?
R2. Repo checkout path, shared data root, cache root, run-output location on this cluster.
R3. Sweep packing: runs per GPU, GPUs per run default for this repo's workloads.
R4. Per-repo walltime habits (typical smoke, sweep, training durations).
R5. Repo-specific approvals (e.g. benchmark studies) and restart conventions.
