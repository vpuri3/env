# Cluster job preferences: <CLUSTER NAME> (<login hosts>)

Saved as `~/.config/env/cluster.md`. **Not in git**, one per cluster. Cluster-wide only; repo-specific preferences live in `<repo>/../<repo-name>.cluster.md` (bottom). Agents read it before any allocation, job, install or training (via `slurm-preflight`). Interview and editing rules: `cluster-onboarding` skill.

**Editing:** only after the user confirms the exact lines. One-off instructions don't change standing preferences. Record date and source below. `TODO (ask user)` items are open: ask before doing anything that depends on them.

## Slurm settings (source before any `sjob` call; `sjob config` shows them)

```bash
export SJOB_ACCOUNT=<account> SJOB_PARTITION=<interactive partition> SJOB_BATCH_PARTITION=<batch partition> \
  SJOB_TIME=<default walltime> SJOB_NAME_PREFIX=<job-name prefix> SJOB_ALLOC_ARGS=<e.g. --exclusive> \
  SJOB_STAGE_DIR=<staging/log dir>
```

## Compute approval

- May run without asking: <quoted>
- Needs explicit OK: <...>
- QOS / reservations: <...>
- Budget / usage tracking: <...>
- While the user is away: <...>

## Partitions

- Use: <...>. Never use: <...>.
- Race: <queues in priority order>; never: <...>

## Walltime

| Job type | Walltime |
| --- | --- |
| smoke / installs | <...> |
| sweeps | <...> |
| long training | <chain links ...> |

Limits without asking: <...>

## Long runs

- Checkpoint cadence: <...>
- Chains: <batch chains / interactive relays>

## Cluster facts (verified <date>)

Gathered by the agent, approved by the user.

- Node: <GPUs x model>, <N> CPUs (<per GPU>), <RAM>; driver <ver> / CUDA <ver>.
- CPUs per allocation/step: <how to get them, e.g. `sjob run` steps get all, bare `srun --jobid` gets 1>
- Node-local scratch: <path, size, NVMe/tmpfs>; <what not to use, e.g. RAM-backed tmpfs>
- Shared storage: <path, quota check>
- Network: <compute nodes reach HF/PyPI or not>

## Nodes and GPUs

- Allocation unit / floor: <whole node or per-GPU gres>
- Max nodes without asking: <...>
- GPUs per run: <default, or ask each time>
- Several runs per GPU: <always / ask first / never>
- Multi-node single run: <...>

## Queue behaviour

- Never block a tool call on the queue; poll every <30-60 s>. Re-plan after <N> min pending.
- Reporting: <...>. Failures: <...>. Cancelling own jobs: <...>.

## Failure and cleanup policy

- Failures: <retry/stop and ask>. Cleanup: <...>. Environment: <venv/containers/modules>. Downloads: <where, limits>.

## Per-session questions (slurm-preflight asks before the first job of a session)

- <the "ask each time" items>

## Open questions

- <ID> <question>: TODO (ask user)

## Change log

- <date>: created via cluster-onboarding (<summary>).

---

# Repo prefs file template: `<repo>/../<repo-name>.cluster.md`

Per repo, per cluster, outside git. Repo-specific only (QUESTIONS.md R1-R5); same editing rule. Repo AGENTS.md points at this and at `~/.config/env/cluster.md`.

```markdown
# <repo-name> preferences: <CLUSTER NAME>
- Launcher: <...>
- Paths: checkout <...>; data root <...>; cache root <...>; outputs <...>
- Sweep packing: <runs per GPU, GPUs per run>
- Walltime habits: <smoke / sweep / training>
- Approvals: <repo-specific>
## Open questions
- <question>: TODO (ask user)
## Change log
- <date>: created (<summary>).
```
