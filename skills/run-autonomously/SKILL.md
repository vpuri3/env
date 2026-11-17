---
name: run-autonomously
description: Hand-off protocol for when the user is stepping away (going to bed, a meeting, "proceed autonomously", "I won't be available"). Ask every question you need in one batch now, then work autonomously within the agreed scope without waiting on permissions or input, keep a decision log, and leave a detailed report for their return. Use when the user says they are leaving or unavailable and wants the work to continue, or invokes /run-autonomously.
---

# Run autonomously: hand-off, autonomous work, report

The user is about to leave. Three phases: **hand-off** (they are still here,
briefly), **autonomous work** (they are gone), **report** (for when they are
back). Text the user typed after the command is extra scope, limits or notes;
it overrides anything below. The project's `AGENTS.md` (or equivalent) still
applies; where it is stricter, it wins.

## Phase 1 - Hand-off (do this immediately, keep it short)

1. **Restate the scope** from the conversation so far, in a few lines:
   goal, in scope, out of scope, done criteria, resource limits (GPUs, jobs,
   allocations, time), and what you may do without asking (edit, commit, push
   to which branch, launch/cancel jobs, delete files you created). Do not
   invent scope the user never stated; anything ambiguous becomes a question.
2. **Plan.** Break the work into ordered steps. For a large task, use
   subagents to explore/break it down in parallel first, but do not let this
   delay the questions by more than a few minutes - the user is leaving.
3. **Ask all questions in one `ask_user_question` call** (up to 4 questions;
   the rest become stated assumptions). Only ask what would change the plan
   or is risky to guess. Every question:
   - has the option you would pick first, labelled `... (Recommended)`;
   - uses `timeoutSeconds: 300`, so if the user already left, the
     Recommended options are taken and you proceed.
   Good questions: scope boundaries, push/merge permission, resource
   budget, what to do if X fails, which variant to prioritize.
4. **Post the contract** and start working without waiting for an
   acknowledgement:
   - final scope and plan;
   - answers (or auto-selected defaults) and your other assumptions;
   - things you will NOT do without the user (see hard stops);
   - where the decision log lives (below).

If the user already left before the questions were answered, that is fine:
the timeouts resolve them. Never end your turn waiting for an answer; end a
turn only while background work runs (its completion events wake you).

## Phase 2 - Autonomous work

Permission: the user has authorized you to make decisions within the
agreed scope. Do not stop to ask for confirmation of in-scope actions.

- **Decide, don't stall.** For each unforeseen choice:
  - *Low-stakes or clearly implied:* just decide (conservative, reversible),
    log it, keep going.
  - *The user would plausibly want a say:* `ask_user_question` with
    `timeoutSeconds: 300` and your pick as the first option, labelled
    `(Recommended)`. On timeout, proceed with it, say in chat that it was
    auto-selected, and log it.
  - *Destructive or irreversible* (deleting data or checkpoints, cancelling
    others' jobs, force-push, pushing): never auto-default. Take the safe
    path, park only that branch as *deferred*, keep the rest moving.
  - Never ask without a timeout: one blocking question freezes the whole
    agent tree (it once held everything, and an idle GPU node, for 7 h).
- **Hard stops** (skip, log as *deferred*, move on to other work):
  irreversible or destructive actions outside scope (force-push, rewriting
  shared history, deleting data you did not create, dropping checkpoints),
  pushing/merging/publishing anything externally visible unless
  authorized, touching other people's or other agents' jobs, GPUs and
  processes, exceeding the stated resource budget, handling secrets or
  credentials, anything that costs money or sends messages to others.
- **Don't stall on a blocker.** Try a workaround (2-3 honest attempts), then
  record it and continue with the next independent item. Stopping early with
  work left that you could have done is a failure.
- **Stay steerable.** No long blocking sleeps or polling loops: run long work
  in the background (`--bg`, nohup, status files) and check with short
  bounded calls (each sleep <= 60 s). A user message always takes
  precedence over whatever you are waiting on.
- **Don't kill your own work.** Restarting or reloading the agent (`/reload`,
  `/new`, `/resume`, exiting) kills every running subagent of the session.
  While work runs, never do it or ask the user to. If you notice a child
  stopped or aborted, resume it (`agent_steer` with "resume from where you
  left off") and log it.
- **Launch work immediately** once its inputs are ready; do not hold back a
  job because it might not finish in the current window - make it resumable
  (checkpoints, restart chains) instead.
- **Verify** before claiming success: run the relevant tests/smokes, read
  the logs. Record what was and was not verified.
- **Checkpoint progress.** If commits are in scope, commit in logical steps
  on the agreed branch (never push unless authorized). Keep the working
  tree in a state the user can understand.
- **Subagents** inherit these rules. Put in their task text: "The user is
  away. Decide within this scope, do not ask blocking questions, log
  decisions, report deferred items." Then:
  - spawn with `wait:false` and run independent work in parallel;
  - design is decided by an architect (or you); the coder gets those
    decisions written into its task, never an open design question; a
    reviewer checks the result;
  - `timeoutMs: 300000` only for coder/reviewer/architect tasks expected
    to take < 30 min; if a timeout wake shows no change, re-arm silently
    (`agent_steer` with `timeoutMs` only) and post nothing;
  - long-running operators (jobs, training, queues) get no timeout and
    send `agent_update` at milestones (started, first metrics, failure, done).
- **Decision log.** Keep one markdown file updated as you go, so nothing is
  lost to compaction or a crash:
  `~/.local/state/run-autonomously/<YYYY-MM-DD-HHMM>-<slug>.md` (outside the
  repo, never committed). One line per decision (see the table below),
  plus events: jobs launched (IDs), failures, workarounds, auto-selected
  answers, resumed children.

## Phase 3 - Report (final message, also appended to the log file)

When the work is done, or you are truly blocked on everything that remains,
or the resources ran out, finish with this report. The user reads it cold:
complete, but compact (tables and bullets, no logs).

1. **TL;DR** - status (done / partial / blocked), 3-5 bullets of outcome.
2. **What was done** - per plan step: result, files, commits (hash, branch,
   *not pushed* unless authorized), job IDs, output/log paths.
3. **Results** - compact numbers and tables, with how they were measured
   and any caveats (e.g. timings measured on a shared GPU).
4. **Decision log** - mark auto-selected (timed-out) answers:
   | # | Decision | Options considered | Chosen | Why | Auto-selected? | How to undo | Confidence |
5. **Deviations from the plan** and why.
6. **Deferred / needs you** - hard stops hit, blockers, open questions, each
   with your recommendation so the user can answer in one word.
7. **Verify yourself** - what you tested and how; what the user must check
   by hand (untested paths, visuals, results that look off).
8. **Still running** - jobs, allocations, background processes, monitors,
   with IDs, end times and how to check/stop them.
9. **Suggested next steps.**
10. Path to the decision log file.
