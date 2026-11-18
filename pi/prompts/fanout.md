---
description: Do a coding task fast - plan it, fan the parts out to parallel Sonnet workers in worktrees, merge, test once
argument-hint: "<task>"
---
Do the task below with the fan-out recipe, optimizing for my wall-clock time. You are the
lead: you plan, brief, merge and verify; workers write the code.

1. **Scope (2-3 min, in parallel).** Read only what you need to split the work. Send
   lookups and slow commands (e.g. timing the test suite) to `scout` agents with
   `wait:false`, several at once, while you read. Don't implement anything yourself.
2. **Split into 2-5 parts that touch disjoint files.** Parts that must edit the same
   file are one part. For each part write a brief: goal, the decisions already made,
   files it owns (and must not touch), the narrow check to run (single test file or
   name filter), done criteria. Put shared facts (conventions, commands, measurements)
   in every brief; workers don't see this conversation.
3. **Fan out.** For each part: `agent-lane new <part>` (from the checkout you are
   working in) and spawn a `coder-fast` with `wait:false` whose brief starts with
   "Work only in <lane dir>". Spawn all of them in one turn. Use `coder` (Opus) only for
   a part that needs real design judgment.
   **Debugging** (failures or flakes with no known cause): first, in one turn, 2-4
   `scout`s that reproduce (subsets of the failing tests, some under load) and 2-4
   `scout`s that each check one hypothesis by reading code (timing, shared state,
   product race, cleanup), read-only, `file:line` evidence, ~4 minutes. Brief a
   `coder-fast` as soon as a cause has evidence (don't wait for the repro scouts), one
   per group of fixes; each proves its fix under load in its lane with parallel copies
   of its test files (e.g. `-p 3`), not runs in a row.
4. **Merge as they finish**, not after the last one. For each finished worker: `agent-lane merge <part>` from
   your checkout, then `agent-lane rm <part>`. On a rebase conflict, resume that worker
   (`agent_steer`) to resolve it in its lane. A worker that failed or went off-brief:
   steer it once with the concrete problem; don't redo its work yourself.
5. **Verify once.** After the last merge, run the full checks once, plus one parallel
   round of the touched test files if flakes were the issue (or have a `scout` run them
   and report only failures). Don't loop proof runs. Fix failures by resuming the worker that owns the
   file. Review only if the change is risky (one fresh `reviewer`, findings go back to
   the owning worker).
6. **Report:** parts and who did them, commits, check results, anything flagged.

Interactive session: end your turn while workers run; their completion wakes you.
Headless (`pi -p`, `--mode json`, or the prompt says so): ending your turn exits the
process and aborts every worker, so never end it while one runs. Loop instead:
`agent_status` (no path) to find finished workers, merge them, then `agent_wait` on one
still running with `timeoutMs: 60000`.

Task: $@
