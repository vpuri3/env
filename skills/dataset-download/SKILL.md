---
name: dataset-download
description: Download and unpack large ML datasets (Hugging Face Hub, Zenodo, GCS/HTTP archives) on clusters - where to run, caches, resumable non-interactive downloads, disk checks, extraction, completion markers. Use when fetching datasets or model weights to a cluster or shared filesystem.
---

# Downloading datasets on clusters

1. **Check space first**: `df -h <data-root>` (and quota tools such as `lfs quota -h -u $USER <fs>`
   on Lustre). Extracted data is often 1.5-2x the archive, and the archive coexists
   with it until extraction ends.
2. **Run where it is allowed and fast**: extraction is IO/CPU heavy, so run on a
   compute node if compute nodes have internet (test: `curl -sI https://huggingface.co`
   inside a job); otherwise download on a login/data-mover node and extract in a job.
   Delegate long downloads to a `slurm-operator` subagent.
3. **Non-interactive, resumable**: scripts used by agents must take explicit dataset
   keys and a `--yes`-style flag, never prompt. Prefer tools that resume:
   `hf download <repo> <file> --repo-type dataset --local-dir DIR`
   (`huggingface_hub`), `wget -c`, `curl -C -`. Write a marker (e.g. `.<key>.done`)
   after a successful extract so reruns skip finished items.
4. **Caches**: `HF_HOME`/`HF_HUB_CACHE` under `CACHE_ROOT` (not `$HOME`); with
   `--local-dir` the files land in the target, not the cache. Logged-in token:
   `HF_TOKEN_PATH` or `hf auth login` (only for gated/private repos).
5. **Parallelism**: many small files -> `snapshot_download(max_workers=16)`; one big
   archive -> a single stream is usually limited by the server; `pigz -d`/`tar -I pigz`
   speeds up `.tar.gz` extraction if available.
6. **Verify**: list top-level dirs with sizes (`du -sh DIR/*`), compare file counts or
   sizes with what the source documents, then delete archives.

Project specifics (dataset keys, data roots, sizes) belong in the project's own skill,
not here.
