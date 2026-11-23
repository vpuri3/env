# Orchestrating subagents (all projects)

Loaded by pi in every project (`~/.pi/agent/AGENTS.md`, linked from `~/env/pi/AGENTS.md`).
Project `AGENTS.md` files add to these rules and win where they conflict. Goal: the user
waits as little as possible for subagents without losing quality.

Subagents are decode-bound: most of their wall time is the model generating tokens, about
half of it hidden reasoning. To finish sooner: generate fewer tokens, take fewer serial
agent hops, run independent work in parallel, and keep the main thread free.

## Roles

| Type | Model / thinking | Use for |
| --- | --- | --- |
| main (you) | Opus | Talk to the user, split work into lanes, write the decisions into tasks, merge lanes. Not long implementation. |
| `architect` | Opus, medium | Design questions and multi-lane plans: lanes, owned files, interfaces, acceptance checks. |
| `coder` / `coder-low` | Opus, medium / low | A part that needs real judgment (design details left open). Not the default for debugging: see "Debugging" below. `coder-low` for the A/B. |
| `coder-fast` | Sonnet, low | Worker for one well-briefed part of a fanned-out task (owned files, decisions made, narrow check). The default writer. |
| `reviewer` | Opus, medium | Fresh-context review of a finished lane. Never edits. |
| `scout` | Sonnet, low | Lookups, running slow test suites and reporting only the failures, log and session triage. Never edits. |
| `tasker` | Opus, low | Small bounded jobs that edit files (one-site fixes, mechanical edits). |
| `slurm-operator` | Opus, low | Cluster jobs, queues, installs, babysitting runs. Reports failures it can't explain instead of debugging them. |

Choosing among these types is fine. Don't change a type's model or thinking level, per
spawn or in config, without asking the user.

## Lanes: one writer per worktree

- Before spawning more than one writer in a git repo, give each its own worktree:
  `agent-lane new <lane>` prints the directory (`<repo>/.worktrees/<lane>`, branch
  `lane/<lane>`; `.worktrees/` is kept out of git via `.git/info/exclude`). Put that path in the task: "work only in DIR; commit there; don't merge".
  A single writer can use the main checkout if nobody else is editing it.
- Split lanes by files, and list each lane's owned files in its task. Two lanes that must
  edit the same file are one lane, or run one after the other.
- Untracked files (venvs, `node_modules`, local config) are not copied into a lane. Say in
  the task how to get them (shared venv path, `npm ci`, ...).
- `git stash`, `git checkout` and branch switches in another lane's worktree or the main
  checkout are forbidden.
- Merge one lane at a time when it is done: `agent-lane merge <lane>` (rebases, then
  fast-forwards). On conflicts, resume the lane's coder to resolve them in its worktree.
  Then `agent-lane rm <lane>`. `agent-lane list` shows open lanes.

## Fan out instead of one long coder

A task with separable parts (tooling + tests + docs, several features, per-module
changes) is not one coder's job: one coder works through them in series, and the
user waits 20+ minutes. Follow the `/fanout` recipe (`~/env/pi/prompts/fanout.md`):

1. Scope in 2-3 minutes with parallel `scout`s; don't implement.
2. Split into 2-5 parts with disjoint files and write a self-contained brief for each.
3. One `agent-lane` worktree and one `coder-fast` per part, all spawned in one turn
   (`coder` only for a part that needs real judgment).
4. Merge each part as it finishes, run the full checks once, send failures back to
   the worker that owns the file.

**Debugging** (a failure or flake with no known cause) is the part that otherwise runs
for 20+ minutes on one Opus coder. Fan out the search instead:

1. In one turn, spawn 2-4 `scout`s that reproduce (each a subset of the failing tests,
   some under load) and 2-4 `scout`s that each check one hypothesis by reading code
   (timing/fixed sleeps, shared state, product race, cleanup/ordering), all read-only,
   each told to report `file:line` evidence within ~4 minutes.
2. Brief fixers as soon as a hypothesis has `file:line` evidence; don't wait for the
   slower repro scouts (they confirm or add causes, which become more briefs). One
   `coder-fast` per group of fixes with disjoint files.
3. Each fixer proves its own fix under load in its lane: its test files as parallel
   copies (e.g. `tests/pi_fleet_test.sh -q -p 3 <files>`), not runs in a row.
4. After the merges, one short proof: the full suite once plus one parallel round of the
   touched files. Don't loop proof runs; a remaining failure gets one more targeted
   round or goes in the report.

Measured on the pi-fleet flaky deck tests (same brief, same base commit): one Opus coder
had nothing merged after 21 min ($3.3); Opus supervisor + 7 Sonnet scouts + 4 Sonnet
fixers had all fixes merged at 12 min ($1.8), 23 min with proof runs ($2.1). Most of the rest was
waiting on tests (one fixer: 1 min of model time, 7 min of test runs; proofs run in a row),
which steps 2-4 cut.

**Merging as workers finish.** In an interactive session, each completion wakes you:
merge that lane right away. Headless (`pi -p`), ending your turn kills the workers, so
loop: `agent_status` (no path) to see which finished, merge those, then `agent_wait`
on one still running with `timeoutMs: 60000`, and repeat.

A small change (one file, a few minutes) goes to one `coder-fast` or `tasker`; don't
fan out what doesn't split.

## The coder → review → fix loop

1. **Tasks carry decisions.** The coder's task states the behavior, the owned files, the
   acceptance checks and every design decision already made. An open design question goes
   to an `architect` or the user first, not to a coder.
2. **Review only when it pays.** Routine, well-tested lanes skip review. Risky lanes (shared
   infrastructure, security, data loss, concurrency, anything the user flagged) get one
   fresh `reviewer` at the end. A large change can get two or three reviewers in parallel,
   each on one angle (correctness, tests, integration).
3. **Fixes go back to the same coder.** Send the reviewer's findings to the original coder
   with `agent_steer`; its session resumes with the code still in context. Don't spawn a
   new fix-coder unless the original is gone. The coder may push back on a finding with a
   reason.
4. **Overlap.** While lane N is in review, the next lane that doesn't depend on that review
   can already be coding in its own worktree.

## Tests

- While iterating: only the tests for the files you touched (single test files, not whole
  directories or suites), in quiet mode if the project has one.
- The full suite runs once per lane, at the end, and once more after merging only if the
  merge resolved conflicts. A follow-up agent doesn't rerun a suite that already passed on
  the same commit.
- A full suite that takes minutes or prints a lot can go to a `scout`: "run X in DIR,
  report only failures with their assertion messages".
- A flaky test is a bug to report, not something to loop on.

## Keep the main thread free

- Spawn with `wait:false`, all independent agents in one turn. Don't call `agent_wait`, or
  spawn with `wait:true`, unless the user is waiting on that exact answer and there is
  nothing else to do. Completion events wake you.
- No `timeoutMs` by default; completion and failure arrive as events. If you set one and a
  timeout event shows no change, re-arm silently and post nothing.
- New scope from the user goes to a new lane (new subagent), not into a running coder.
  Steer a running coder only to correct its current task.
- Prefer fresh children (`/task` paths) with a self-contained task, or a handoff file under
  `/tmp`, over forking your conversation (`/root/task`): forks start with your whole
  context.
- Don't ask the user a blocking question while subagents or jobs run. Ask in plain text,
  state the default you'll take, and keep going.

## Slurm work

- No allocation, job, install or training before `~/.config/env/cluster.md` exists; if it
  doesn't, run the `cluster-onboarding` skill interactively with the user first.
- Before the first job of a session run `slurm-preflight`. From a repo, also use its
  `<repo>/../<repo-name>.cluster.md` (repo-specific prefs; create via onboarding if missing).
- `slurm-operator` never invents preferences or writes these files: if one is missing or a
  needed item is `TODO (ask user)`, it stops and reports the questions to its parent.
- Edit either file only after the user confirms the exact lines.

## Coder thinking A/B (low vs medium)

To decide with data whether coders can run at low thinking: for well-specified lanes
(decisions written down, clear checks) alternate between `coder-low` and `coder`, and give
comparable tasks to each. Use `coder` for debugging unclear failures and for tasks with
design judgment left in them. When a `coder-low` result needed review fixes that `coder`
would plausibly have avoided, tell the user in one line. The comparison is done later from
the session logs (wall time, output tokens, review findings, follow-up fixes).
