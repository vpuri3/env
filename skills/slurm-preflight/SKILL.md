---
name: slurm-preflight
description: Short per-session check before Slurm jobs - read ~/.config/env/cluster.md (and the repo prefs file), then ask the user 1-3 quick questions (job shape, packing, scope) before the FIRST job of a session and again only when a job falls outside what was confirmed. Use before any allocation, job submission, install or training launch; hand the confirmed answers to slurm-operator subagents.
---

# Slurm preflight

Goal: at most one or two short `ask_user_question` calls per interactive session, not one per job.

## Steps

1. **Read `~/.config/env/cluster.md`**, and from a repo also `<repo>/../<repo-name>.cluster.md`. If the cluster file is missing, stop and run [`cluster-onboarding`](../cluster-onboarding/SKILL.md) with the user; if the repo file is missing, create it per that skill. A `TODO (ask user)` item that affects this job goes into step 3.
2. **Check this session's confirmed answers** (earlier in this conversation, or the session note below). If the job fits, don't ask: launch and say in one line which confirmed settings you use.
3. **Otherwise ask one call with 1-3 questions** (options, recommendation), from the "ask each time" items and this job's specifics:
   - Job shape: GPUs per run, nodes (within the no-ask limit), walltime tier.
   - Packing: several runs per GPU? Only offer when memory allows; timings become unreliable.
   - Session scope: "OK to run follow-up jobs of this kind without asking again this session?"
   Never ask what the files already fix (account, partitions, racing, polling).
4. **Record answers** in `<SJOB_STAGE_DIR>/session-notes/<YYYY-MM-DD>-<repo>.md` (outside git): date, answers, scope covered.
5. **Hand settings to subagents** explicitly in the `slurm-operator` task: job shape, walltime, nodes, packing, race list with caps (operators race all listed queues by default, same kind each, and cancel losers; backfill only as `sjob batch --requeue`, on request), "never block on the queue". Operators don't ask the user and don't invent preferences: if a file is missing or a needed item is TODO, they stop and report the questions to you.

## Re-ask only when

- more nodes than the no-ask limit, a different GPUs-per-run layout, packing, or a longer walltime tier than confirmed;
- a new long chain or a larger sweep than discussed;
- a new account, partition or container;
- the earlier answers were explicitly one-off.

Standing changes go to the cluster or repo prefs file through the confirm-first rule in `cluster-onboarding`.
