---
name: cluster-onboarding
description: One-time (per cluster) interview that writes and maintains ~/.config/env/cluster.md, the user's cluster-wide Slurm preferences outside git - accounts, approvals, partitions, walltime tiers, nodes/GPUs, queue behaviour, failure and cleanup policy. Also creates a repo's own prefs file (<repo>/../<repo-name>.cluster.md) with repo-specific answers. Use when ~/.config/env/cluster.md is missing, has `TODO (ask user)` items a job depends on, or the user wants to review cluster preferences. Per-session checks are slurm-preflight.
---

# Cluster onboarding

Two untracked files, per cluster (each cluster has its own `$HOME`):

| File | Holds |
| --- | --- |
| `~/.config/env/cluster.md` | cluster-wide: `SJOB_*` export block, approval, partitions, walltime tiers, facts, nodes/GPUs, queue behaviour, failure/cleanup, per-session questions, open questions, change log |
| `<repo>/../<repo-name>.cluster.md` | repo-specific only: launcher, data/cache roots, sweep packing, per-repo walltime habits |

Questions: [`QUESTIONS.md`](QUESTIONS.md). Layout: [`TEMPLATE.md`](TEMPLATE.md).

## When to run

| Situation | Action |
| --- | --- |
| `~/.config/env/cluster.md` missing | Full onboarding, interactively with the user, **before** any allocation, job, install or training run |
| It has `TODO (ask user)` items | Ask them in batches when the user has time (offer once per session); ask right away only if the next job depends on one |
| User changes a standing preference | Propose the exact edit, confirm (see Editing) |
| A cluster fact looks wrong | Re-gather (QUESTIONS.md §A), propose corrected `Cluster facts` lines |
| Working from a repo whose prefs file is missing | Create it: repo-specific questions only (QUESTIONS.md "Repo prefs file") |

## Full onboarding

1. Gather facts yourself (QUESTIONS.md §A); don't ask what you can look up. Draft `Cluster facts`.
2. Show the facts; the user confirms or corrects before any preference questions. Only approved facts go in the file.
3. Ask sections B-K with `ask_user_question`: up to 4 related questions per call, 2-4 options, recommended first, ~6-8 calls. Skipped questions become `TODO (ask user)`.
4. Write `~/.config/env/cluster.md` from TEMPLATE.md. Preferences that say "ask each time" become the per-session questions for `slurm-preflight`.
5. When in a repo, also do the repo prefs file (repo-specific questions only).
6. Summarize, get confirmation, and only then launch anything.

## Editing (standing rule)

Agents edit either file only after the user confirms the exact lines to add, change or remove. Never edit from inference, a convenient default or a one-off instruction ("use 1 h this time"). Add a dated change-log entry quoting the user. If a preference became impossible (partition removed, limit changed), report the evidence and propose the edit; don't silently work around it.

`slurm-operator` subagents never create or edit these files and never invent preferences: if a file is missing or a needed item is TODO, they stop and report the questions to their parent.
