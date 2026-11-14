---
name: cluster-python-env
description: Build Python/uv virtual environments for GPU work on HPC clusters - always on a compute node, caches redirected off $HOME, CUDA wheel index chosen against the node's driver, modular re-runnable install steps, and a verify step (CUDA, Triton, torch.compile). Use when creating or repairing a project venv on a cluster, or when torch/Triton fails on cluster GPUs.
---

# Python environments on clusters

## Rules

1. **Install on a compute node**, not the login node: builds and wheel unpacking are
   CPU/IO heavy, login nodes are shared and often lack GPUs to verify. Get a node with
   the `slurm-jobs` skill and run the install as a step (`sjob run <id> -- ...`).
   Delegate to a `slurm-operator` subagent so the build log stays out of the main context.
2. **Caches off `$HOME`.** Home quotas are small. `bootstrap.sh` sets `CACHE_ROOT`
   (in `~/.config/env/local.sh`) and `vars.sh` points `XDG_CACHE_HOME`,
   `UV_PYTHON_INSTALL_DIR`, `TRITON_CACHE_DIR`, `CUDA_CACHE_PATH`, `HF_HOME`... at it.
   Check with `env | grep -E 'CACHE|UV_|HF_'`. On a shared filesystem set
   `UV_LINK_MODE=copy` to avoid hardlink warnings/failures across mounts.
3. **Match the CUDA wheel to the driver.** `nvidia-smi` on a compute node shows the
   driver's CUDA version. Wheels built for a newer CUDA 12.x usually run through minor
   version compatibility, but Triton/torch.compile can fail on old drivers. If they do:
   an older wheel index (`cu126`, `cu124`), or run inside a site container that ships
   CUDA compat libs (pyxis: `srun --container-image=... --container-mounts=...`).
4. **Modular, idempotent scripts.** Split installs into named steps (venv, torch, sync,
   extras, native builds, verify) that can run alone, take no prompts, and read
   versions from env vars with per-cluster defaults in the project (not in ~/env).
5. **Verify on a GPU** before declaring success: `torch.cuda.is_available()`, a matmul,
   a tiny Triton kernel, a `torch.compile`d function, and the project's own imports.

## Typical uv flow

```bash
uv venv --python 3.11                                     # .venv
uv pip install --python .venv/bin/python "torch==2.8.*" torchvision \
  --index-url https://download.pytorch.org/whl/cu128       # CUDA torch first
uv sync --inexact --extra dev                              # rest from uv.lock, keep torch
MAX_JOBS=32 uv pip install --python .venv/bin/python --no-build-isolation flash-attn   # native builds last
```

`uv sync` without `--inexact` removes packages not in the lock (e.g. CUDA extras
installed by hand). Native extensions (`flash-attn`, `mamba-ssm`) must build against
the installed torch: `--no-build-isolation --no-deps`.

## When something breaks

- `CUDA driver version is insufficient` / PTX toolchain errors: rule 3.
- `No space left` / quota: a cache still points at `$HOME`; check `uv cache dir`,
  `python -c 'import triton, os; print(os.environ.get("TRITON_CACHE_DIR"))'`.
- Import works on login node but not in a job: the job shell did not activate the
  venv; use `bash -lc 'source .venv/bin/activate && ...'` or the venv's python path.
