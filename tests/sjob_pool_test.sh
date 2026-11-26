#!/bin/bash
# Tests bin/sjob-pool against stub Slurm commands (no real Slurm call is possible: squeue,
# scancel, sjob, salloc, sbatch, srun, sacct and scontrol are shadowed by stubs; fake
# allocations run worker loops locally in the background). Seconds-scale intervals.
#
#   tests/sjob_pool_test.sh        (run it on a compute node, not a login node)

set -uo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd -P)
POOL="$repo_dir/bin/sjob-pool"
W=$(mktemp -d "${TMPDIR:-/tmp}/sjob-pool-test.XXXXXX")
S="$W/stub"; OUT="$W/out"; REPO="$W/repo"
mkdir -p "$S" "$OUT" "$REPO" "$W/home" "$W/src"

failed=0
check() {
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then echo "ok   $name"; else echo "FAIL $name"; failed=$((failed + 1)); fi
}
wait_for() {
    # wait_for SECONDS CMD...: poll every 0.2 s
    local t=$(($1 * 5)); shift
    while [ "$t" -gt 0 ]; do "$@" >/dev/null 2>&1 && return 0; sleep 0.2; t=$((t - 1)); done
    return 1
}

# ------------------------------------------------------------------ stubs
for c in salloc sbatch srun sacct scontrol; do
    printf '#!/bin/bash\necho "%s $*" >>"%s/forbidden.log"; echo "stub: %s refused" >&2; exit 99\n' "$c" "$S" "$c" >"$S/$c"
done
cat >"$S/squeue" <<'EOF'
#!/bin/bash
S=$(dirname "$0"); j="" fmt="%i %j"
while [ $# -gt 0 ]; do case $1 in -j) j=$2; shift 2 ;; -o) fmt=$2; shift 2 ;; -u|-n) shift 2 ;; *) shift ;; esac; done
touch "$S/jobs"
if [ -n "$j" ] && ! grep -q "^$j|" "$S/jobs"; then echo "slurm_load_jobs error: Invalid job id specified" >&2; exit 1; fi
hidden=$(cat "$S"/hide.* 2>/dev/null | paste -sd' ')
awk -F'|' -v j="$j" -v fmt="$fmt" -v hid=" $hidden " '(j == "" && index(hid, " " $1 " ") == 0) || $1 == j { o = fmt; gsub(/%i/, $1, o); gsub(/%j/, $2, o);
  gsub(/%P/, $3, o); gsub(/%T/, $4, o); gsub(/%L/, $5, o); gsub(/%N/, $6, o); gsub(/%r/, $7, o); print o }' "$S/jobs"
EOF
cat >"$S/scancel" <<'EOF'
#!/bin/bash
S=$(dirname "$0")
for id; do
  echo "$id" >>"$S/scancel.log"
  ( flock 9; grep -v "^$id|" "$S/jobs" >"$S/jobs.tmp"; mv "$S/jobs.tmp" "$S/jobs" ) 9>"$S/lock"
  [ -f "$S/worker.$id.pgid" ] && kill -KILL -- "-$(cat "$S/worker.$id.pgid")" 2>/dev/null
done
exit 0
EOF
cat >"$S/sjob" <<'EOF'
#!/bin/bash
S=$(dirname "$0"); cmd=$1; shift
case $cmd in
  pool) exec bash "$REAL_POOL" "$@" ;;
  alloc)
    f="${SJOB_CONFIG:-$HOME/.config/env/slurm.sh}"; [ -f "$f" ] && . "$f"   # like the real sjob
    part="" t="" n=""
    while [ $# -gt 0 ]; do case $1 in -p) part=$2; shift 2 ;; -t) t=$2; shift 2 ;; -n) n=$2; shift 2 ;; --) shift; break ;; *) shift ;; esac; done
    echo "alloc part=$part t=$t n=$n args=$SJOB_ALLOC_ARGS" >>"$S/alloc.log"
    if [ -f "$S/refuse.$part" ]; then echo "salloc: error: QOSMaxJobsPerUserLimit"; echo "sjob: allocation failed"; exit 1; fi
    st=RUNNING; [ -f "$S/pending.$part" ] && st=PENDING
    ( flock 9; id=$(( $(cat "$S/counter" 2>/dev/null || echo 1000) + 1 )); echo $id >"$S/counter"
      echo "$id|${SJOB_NAME_PREFIX}$n|$part|$st|1:00:00|node$id|None" >>"$S/jobs"; echo "JOBID=$id" ) 9>"$S/lock" ;;
  run)
    id=$1; shift; log=/dev/null
    while [ $# -gt 0 ]; do case $1 in --bg) shift ;; --log) log=$2; shift 2 ;; --) shift; break ;; *) break ;; esac; done
    echo "run $id $*" >>"$S/run.log"
    [ -f "$S/run_fail" ] && { echo "srun: error: stub run_fail"; exit 1; }
    setsid bash -c 'echo $$ >"$0"; exec "$@"' "$S/worker.$id.pgid" env SLURM_JOB_ID="$id" "$@" >"$log" 2>&1 </dev/null &
    echo "PID=$! LOG=$log" ;;
  *) echo "sjob $cmd $*" >>"$S/forbidden.log"; exit 99 ;;
esac
EOF
chmod +x "$S"/*
touch "$S/jobs"

export PATH="$S:$PATH" HOME="$W/home" XDG_STATE_HOME="$W/state" USER=tester OUT REAL_POOL="$POOL"
export SJOB_NAME_PREFIX=tst. POOL_TICK_SEC=1 WATCH_EVERY_SEC=1 POOL_IDLE_SLEEP_SEC=0.3 POOL_RACE_RETRY_SEC=1
export POOL_STATUS_EVERY=1 STALL_SEC=3 NO_NODES_SEC=3 IDLE_RELEASE_SEC=100000 POOL_RELEASE_WAIT_SEC=3
export POOL_WORKER_GRACE_SEC=2 POOL_WORKER_HB_SEC=0.5 POOL_IDLE_FRESH_SEC=2
# sjob reads SJOB_CONFIG after the env: the pool must use the same job-name prefix (cfg., not tst.)
mkdir -p "$HOME/.config/env"; echo 'SJOB_NAME_PREFIX=cfg.' >"$HOME/.config/env/slurm.sh"
unset PI_FLEET_SESSION PI_SESSION_ID BASH_ENV CUDA_VISIBLE_DEVICES SLURM_JOB_ID ALERT_REGEX ALERT_IGNORE_REGEX PROGRESS_REGEX

# Safety: every Slurm entry point must resolve to a stub, or nothing runs.
for c in squeue scancel sjob salloc sbatch srun sacct scontrol; do
    if [ "$(command -v "$c")" != "$S/$c" ]; then echo "ABORT: $c resolves to $(command -v "$c"), not the stub"; exit 1; fi
done
echo "ok   stubs shadow squeue scancel sjob salloc sbatch srun sacct scontrol"

cleanup() {
    local d f
    for d in "$W"/pools/*; do
        [ -d "$d" ] || continue
        touch "$d/DRIVER_STOP"
        for f in "$d/driver.pid" "$d/watchdog.pid"; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; done
    done
    for f in "$S"/worker.*.pgid; do [ -f "$f" ] && kill -KILL -- "-$(cat "$f")" 2>/dev/null; done
    if [ "$failed" -gt 0 ]; then
        for d in "$W"/pools/*; do echo "== $d/alerts.jsonl"; cat "$d/alerts.jsonl" 2>/dev/null; echo "== $d/logs/driver.log"; tail -n 15 "$d/logs/driver.log"; done
    fi
    sleep 0.5
    rm -rf "$W"
}
trap cleanup EXIT

nalerts() { # nalerts DIR KIND [ITEM]
    python3 -c 'import json,sys
n=0
for l in open(sys.argv[1]+"/alerts.jsonl") if __import__("os").path.exists(sys.argv[1]+"/alerts.jsonl") else []:
    a=json.loads(l)
    if a["kind"]==sys.argv[2] and (len(sys.argv)<4 or a["item"]==sys.argv[3]): n+=1
print(n)' "$@"
}
export -f nalerts
alerts_is() { [ "$(nalerts "$1" "$2" ${4:+"$4"})" = "$3" ]; }   # alerts_is DIR KIND N [ITEM]
owners_of() { # owners_of DIR KIND [ITEM] -> owners of the first matching alert, space-separated
    python3 -c 'import json,sys
for l in open(sys.argv[1]+"/alerts.jsonl"):
    a=json.loads(l)
    if a["kind"]==sys.argv[2] and (len(sys.argv)<4 or a["item"]==sys.argv[3]):
        print(" ".join(a["owners"])); break' "$@"
}
job_of() { awk -F'|' -v n="cfg.$1" -v p="$2" '$2 == n && $3 == p {print $1}' "$S/jobs" | tail -1; }
set_field() { # set_field ID FIELDNO VALUE
    ( flock 9; awk -F'|' -v OFS='|' -v id="$1" -v f="$2" -v v="$3" '$1 == id {$f = v} {print}' "$S/jobs" >"$S/jobs.tmp"
      mv "$S/jobs.tmp" "$S/jobs" ) 9>"$S/lock"
}
kill_alloc() { # allocation disappears (not via scancel)
    ( flock 9; grep -v "^$1|" "$S/jobs" >"$S/jobs.tmp"; mv "$S/jobs.tmp" "$S/jobs" ) 9>"$S/lock"
    kill -KILL -- "-$(cat "$S/worker.$1.pgid")" 2>/dev/null
}
starts() { grep -o ' start .*' "$1/logs/events.log" | awk '{print $2}' | paste -sd' '; }
item() { printf '#!/bin/bash\n%s\n' "$2" >"$W/src/$1"; bash "$POOL" add "$3" "$1" "$W/src/$1"; }

check "sjob dispatches 'pool'" sh -c '"$1" pool help | grep -q "sjob pool <command>"' _ "$repo_dir/bin/sjob"

# ------------------------------------------------------------------ pool A: slots=1, bind none
A="$W/pools/a"
cat >"$W/plugin.sh" <<'EOF'
ALERT_IGNORE_REGEX='ignored-thing'
PROGRESS_REGEX='^step'
pool_on_done() {
  echo "$1" >>"$OUT/hooks"
  [ "$1" = 10_ok ] && printf '#!/bin/bash\necho follow\n' | sjob pool add "$POOL_DIR" 15_follow -
  if [ "$1" = 70_needtime ]; then sleep 2; printf '#!/bin/bash\nsleep 1.5\n' | sjob pool add "$POOL_DIR" 75_hookfollow -; fi
  return 0
}
EOF
bash "$POOL" init "$A" --scope repo --name tpa --repo "$REPO" --max-nodes 1 --race "interactive:2:00:00 batch:4:00:00" \
    --plugin "$W/plugin.sh" --min-left 45 >/dev/null
check "init creates the layout" bash -c 'for d in queue running done failed retries workers logs races tmp staging; do [ -d "$1/$d" ] || exit 1; done' _ "$A"
check "init writes pool.env keys" grep -q "^POOL_NAME='tpa'" "$A/pool.env"
check "repo scope: no owner" bash -c 'grep -qx "POOL_SCOPE='"'"'repo'"'"'" "$1" && grep -qx "POOL_OWNER='"'"''"'"'" "$1"' _ "$A/pool.env"
export PI_FLEET_SESSION=sessA
item 10_ok 'echo "slot=$POOL_SLOT/$POOL_SLOTS item=$POOL_ITEM cvd=${CUDA_VISIBLE_DEVICES-unset} pwd=$PWD dir=$POOL_DIR sid=$PI_FLEET_SESSION" >"$OUT/10_ok.env"' "$A" >/dev/null
item 20_resume 'n=$(( $(cat "$OUT/20.n" 2>/dev/null || echo 0) + 1 )); echo $n >"$OUT/20.n"; echo "step $n"; [ $n -ge 2 ] && exit 0; exit 75' "$A" >/dev/null
item 30_flaky 'n=$(( $(cat "$OUT/30.n" 2>/dev/null || echo 0) + 1 )); echo $n >"$OUT/30.n"; [ $n -ge 2 ] && exit 0; exit 3' "$A" >/dev/null
PI_FLEET_SESSION=sessB item 40_fail 'echo boom; exit 7' "$A" >/dev/null
item 50_log 'echo "Traceback A"; echo "x CUDA error ignored-thing"; sleep 1.5; echo "step ok"; sleep 1.5; echo fin' "$A" >/dev/null
item 60_stall 'echo start; sleep 6; echo end' "$A" >/dev/null
printf '#!/bin/bash\n# pool: min_left=90\necho ran\n' >"$W/src/70_needtime"; bash "$POOL" add "$A" 70_needtime "$W/src/70_needtime" >/dev/null
check "add records the owner after the shebang" bash -c '[ "$(sed -n 2p "$1")" = "# pool-owner: sessA" ]' _ "$A/queue/10_ok.job"
check "owner from PI_FLEET_SESSION per add" grep -qx "# pool-owner: sessB" "$A/queue/40_fail.job"
printf '#!/bin/bash\n# pool-owner: other\necho x\n' >"$W/src/hdr"
bash "$POOL" add "$A" 00_hdr "$W/src/hdr" >/dev/null
check "an existing pool-owner header is kept" bash -c '[ "$(grep -c "^# pool-owner:" "$1")" = 1 ] && grep -qx "# pool-owner: other" "$1"' _ "$A/queue/00_hdr.job"
rm -f "$A/queue/00_hdr.job"
PI_SESSION_ID=sessC PI_FLEET_SESSION= bash "$POOL" add "$A" 00_hdr - <<<'echo x' >/dev/null
check "PI_SESSION_ID fallback, header first line without a shebang" bash -c '[ "$(head -1 "$1")" = "# pool-owner: sessC" ]' _ "$A/queue/00_hdr.job"
rm -f "$A/queue/00_hdr.job"
unset PI_FLEET_SESSION
check "add refuses a duplicate queued name" sh -c '! bash "$1" add "$2" 10_ok "$3"' _ "$POOL" "$A" "$W/src/10_ok"

check "start refuses inside a Slurm allocation" sh -c '! SLURM_JOB_ID=123 bash "$1" start "$2" 2>&1 | grep -q "driver pid"' _ "$POOL" "$A"
out=$(PI_FLEET_SESSION=starter bash "$POOL" start "$A" 2>&1); echo "$out" | sed 's/^/     /'
check "start: driver + watchdog alive" bash -c 'kill -0 $(cat "$1/driver.pid") && kill -0 $(cat "$1/watchdog.pid")' _ "$A"
check "start refuses a second copy" sh -c '! bash "$1" start "$2"' _ "$POOL" "$A"
reg="$XDG_STATE_HOME/sjob-pool/tpa.pool"
check "registry file written" grep -qx "dir=$A" "$reg"
check "registry has repo" grep -qx "repo=$REPO" "$reg"
check "init refuses a second dir with a registered pool name" sh -c '! bash "$1" init "$2" --name tpa --repo "$3"' _ "$POOL" "$W/pools/dup" "$REPO"
check "registry has scope and owner" bash -c 'grep -qx scope=repo "$1" && grep -qx owner= "$1"' _ "$reg"
check "driver uses the stub sjob" wait_for 5 grep -q "sjob=$S/sjob" "$A/logs/driver.log"

wait_for 60 bash -c '[ $(ls "$1/done" | wc -l) -ge 6 ] && [ $(ls "$1/failed" | wc -l) -ge 1 ] && [ -z "$(ls "$1/running")" ]' _ "$A"
check "claim order = name order (75 and retries go back to the front)" \
    [ "$(starts "$A")" = "10_ok 15_follow 20_resume 20_resume 30_flaky 30_flaky 40_fail 40_fail 50_log 60_stall" ]
check "exit 0 -> done/" test -f "$A/done/10_ok.job" -a -f "$A/done/20_resume.job" -a -f "$A/done/30_flaky.job"
check "exit 75 -> requeued, no retry mark" test ! -e "$A/retries/20_resume"
check "other exit -> retried once (retries/)" grep -q '^3 ' "$A/retries/30_flaky"
check "failed twice -> failed/" test -f "$A/failed/40_fail.job" -a ! -e "$A/done/40_fail.job"
check "item log appended across resumes" bash -c '[ "$(grep -c "^step" "$1/logs/20_resume.log")" = 2 ]' _ "$A"
check "item env: slot, item, no CUDA_VISIBLE_DEVICES, cwd=repo" \
    grep -qx "slot=0/1 item=10_ok cvd=unset pwd=$REPO dir=$A sid=sessA" "$OUT/10_ok.env"
check "pool_on_done hook ran for exit-0 items only" bash -c 'grep -qx 10_ok "$1" && grep -qx 30_flaky "$1" && ! grep -q 40_fail "$1"' _ "$OUT/hooks"
check "hook enqueued a follow-up item" test -f "$A/done/15_follow.job"
check "follow-up inherits the item's owner, not the starter's session" grep -qx "# pool-owner: sessA" "$A/done/15_follow.job"
check "pool jobs named with the SJOB_CONFIG prefix are found (no reclaim)" bash -c 'grep -q "|cfg.tpa.g001|" "$1/jobs" && ! grep -q reclaimed "$2/logs/driver.log"' _ "$S" "$A"
check "events say slotN (bind none)" bash -c 'grep -q " slot0 job[0-9]* start 10_ok" "$1" && ! grep -q " gpu0 " "$1"' _ "$A/logs/events.log"
check "min_left header: 70_needtime not claimed with 60 min left" test -f "$A/queue/70_needtime.job"
ida=$(sed -n 's/^JOBID=//p' "$A/races/g001.interactive.out"); idb=$(sed -n 's/^JOBID=//p' "$A/races/g001.batch.out")
check "raced interactive + batch for g001" bash -c 'grep -q "part=interactive t=2:00:00 n=tpa.g001" "$1" && grep -q "part=batch t=4:00:00 n=tpa.g001" "$1"' _ "$S/alloc.log"
check "kept the highest-listed racer, cancelled the other" bash -c '[ -n "$1" ] && grep -qx "$2" "$3" && ! grep -qx "$1" "$3"' _ "$ida" "${idb:-none}" "$S/scancel.log"
check "no pool_done while an item is still queued" alerts_is "$A" pool_done 0
set_field "$ida" 5 2:00:00
check "70_needtime runs once 120 min are left" wait_for 15 test -f "$A/done/70_needtime.job"
check "hook follow-up ran" wait_for 15 test -f "$A/done/75_hookfollow.job"
check "pool_done alert" wait_for 10 alerts_is "$A" pool_done 1
sleep 2
check "no pool_done while pool_on_done runs" alerts_is "$A" pool_done 1
check "routing: item alert -> the item's owner" [ "$(owners_of "$A" item_failed 40_fail)" = sessB ]
check "routing: retry alert -> the item's owner" [ "$(owners_of "$A" item_retry 30_flaky)" = sessA ]
check "routing (repo scope): pool_done -> owners of this episode's items" [ "$(owners_of "$A" pool_done)" = "sessA sessB" ]
item 80_again 'echo "sid=$PI_FLEET_SESSION" >"$OUT/80.sid"; sleep 2.5' "$A" >/dev/null
check "pool_done again for a new episode" wait_for 20 alerts_is "$A" pool_done 2
sleep 3   # a few more watchdog passes: nothing may repeat
check "item_retry once per item (30_flaky, 40_fail)" bash -c '[ $(nalerts "$1" item_retry) = 2 ] && [ $(nalerts "$1" item_retry 30_flaky) = 1 ]' _ "$A"
check "item_failed once (40_fail)" bash -c '[ $(nalerts "$1" item_failed) = 1 ] && [ $(nalerts "$1" item_failed 40_fail) = 1 ]' _ "$A"
check "log_alert once, for new bytes only" bash -c '[ $(nalerts "$1" log_alert) = 1 ] && [ $(nalerts "$1" log_alert 50_log) = 1 ]' _ "$A"
check "log_alert has the matching line, not the ignored one" bash -c 'grep log_alert "$1/alerts.jsonl" | grep -q "Traceback A" && ! grep log_alert "$1/alerts.jsonl" | grep -q ignored-thing' _ "$A"
check "stall once (60_stall only)" bash -c '[ $(nalerts "$1" stall) = 1 ] && [ $(nalerts "$1" stall 60_stall) = 1 ]' _ "$A"
check "pool_done stays at 2" alerts_is "$A" pool_done 2
check "ownerless item does not get the starter's session" grep -qx "sid=" "$OUT/80.sid"
bash "$POOL" add "$A" 40_fail "$W/src/40_fail" >/dev/null
check "re-add clears failed/ and retries/" test ! -e "$A/failed/40_fail.job" -a ! -e "$A/retries/40_fail"
check "re-added item fails again" wait_for 15 test -f "$A/failed/40_fail.job"
check "re-added failure alerts again" wait_for 5 bash -c '[ $(nalerts "$1" item_failed 40_fail) = 2 ] && [ $(nalerts "$1" item_retry 40_fail) = 2 ]' _ "$A"
check "no no_nodes / restart alerts in a healthy pool" bash -c '[ $(nalerts "$1" no_nodes) = 0 ] && [ $(nalerts "$1" driver_restarted) = 0 ] && [ $(nalerts "$1" watchdog_restarted) = 0 ]' _ "$A"
check "alerts.jsonl is valid JSON lines with spec keys" python3 -c 'import json,sys
for l in open(sys.argv[1]):
    a=json.loads(l); assert list(a)==["ts","pool","repo","dir","kind","item","msg","owners"] and a["pool"]=="tpa" and a["dir"]==sys.argv[2]' "$A/alerts.jsonl" "$A"
check "alerts prints unacked" sh -c 'bash "$1" alerts "$2" | grep -q "item_failed 40_fail"' _ "$POOL" "$A"
bash "$POOL" alerts "$A" --ack >/dev/null
check "alerts --ack: nothing unacked after" sh -c 'bash "$1" alerts "$2" | grep -qx "(no unacked alerts)"' _ "$POOL" "$A"
check "alerts --all still shows history" sh -c 'bash "$1" alerts "$2" --all | grep -q pool_done' _ "$POOL" "$A"
check "status.md has counts and progress" wait_for 5 bash -c 'bash "$1" status "$2" | grep -q "^## counts: queue=0 running=0 done=9 failed=1"' _ "$POOL" "$A"
item 90_drainfail 'sleep 1.5; exit 3' "$A" >/dev/null
wait_for 10 bash -c 'ls "$1"/running/90_drainfail@*' _ "$A"
bash "$POOL" stop "$A" --drain >/dev/null
check "drain: a failing item still counts as a failure (not requeued as 75)" wait_for 10 test -f "$A/retries/90_drainfail" -a -f "$A/queue/90_drainfail.job"
check "stop: driver + watchdog exit" bash -c '! kill -0 $(cat "$1/driver.pid" 2>/dev/null || echo 999999) 2>/dev/null && ! kill -0 $(cat "$1/watchdog.pid" 2>/dev/null || echo 999999) 2>/dev/null' _ "$A"
check "stop removes the registry file" test ! -e "$reg"
check "stop without --release cancels nothing" bash -c '! grep -qx "$1" "$2"' _ "$ida" "$S/scancel.log"
kill_alloc "$ida"

# ------------------------------------------------------------------ pool B: slots=2, bind gpu x2
B="$W/pools/b"
PI_SESSION_ID=sessP bash "$POOL" init "$B" --name tpb --repo "$REPO" --max-nodes 1 --slots 2 --slot-bind gpu --gpus-per-slot 2 \
    --race "interactive:2:00:00 batch:4:00:00" --alloc-args "--gpus-per-node=4 -c 8" >/dev/null
touch "$S/refuse.interactive" "$S/pending.batch"
item b1 'echo "$CUDA_VISIBLE_DEVICES" >"$OUT/b1.cvd"; sleep 1' "$B" >/dev/null
item b2 'echo "$CUDA_VISIBLE_DEVICES" >"$OUT/b2.cvd"; sleep 1' "$B" >/dev/null
bash "$POOL" start "$B" >/dev/null
check "no_nodes alert while only pending/refused racers" wait_for 15 alerts_is "$B" no_nodes 1
check "session scope (default): POOL_OWNER from PI_SESSION_ID" grep -qx "POOL_OWNER='sessP'" "$B/pool.env"
check "routing (session scope): pool alert -> POOL_OWNER" [ "$(owners_of "$B" no_nodes)" = sessP ]
check "registry: scope=session owner=sessP" bash -c 'grep -qx scope=session "$1" && grep -qx owner=sessP "$1"' _ "$XDG_STATE_HOME/sjob-pool/tpb.pool"
check "refused interactive racer gets a retry marker" test -f "$B/races/g001.interactive.retry"
check "refused interactive racer is retried" bash -c '[ $(grep -c "part=interactive t=2:00:00 n=tpb.g001" "$1") -ge 2 ]' _ "$S/alloc.log"
check "ALLOC_ARGS passed as SJOB_ALLOC_ARGS" grep -q "n=tpb.g001 args=--gpus-per-node=4 -c 8" "$S/alloc.log"
sleep 2
check "no_nodes once per episode" alerts_is "$B" no_nodes 1
idb1=$(job_of tpb.g001 batch)
set_field "$idb1" 4 RUNNING
check "pending racer starts -> items run" wait_for 20 test -f "$B/done/b1.job" -a -f "$B/done/b2.job"
check "slot bind gpu: CUDA_VISIBLE_DEVICES per slot" bash -c '[ "$(sort "$1"/b1.cvd "$1"/b2.cvd | paste -sd" ")" = "0,1 2,3" ]' _ "$OUT"
check "events say gpuN (bind gpu)" grep -q " gpu[01] job$idb1 start b1" "$B/logs/events.log"
kill -KILL -- "-$(cat "$S/worker.$idb1.pgid")"   # worker dies, allocation lives
check "dead worker on a live allocation is restarted" wait_for 15 bash -c '[ $(grep -c "^run $1 " "$2") -ge 2 ]' _ "$idb1" "$S/run.log"
item b3_long 'echo up; sleep 60' "$B" >/dev/null
check "b3_long claimed" wait_for 10 test -f "$B/running/b3_long@$idb1.0.job" -o -f "$B/running/b3_long@$idb1.1.job"
kill_alloc "$idb1"
check "orphan reclaimed to queue when its allocation disappears" wait_for 10 grep -q "reclaimed b3_long from dead job $idb1" "$B/logs/driver.log"
check "a new group is raced for the reclaimed item" wait_for 10 grep -q "n=tpb.g002" "$S/alloc.log"
idb2=$(job_of tpb.g002 batch); set_field "$idb2" 4 RUNNING
check "reclaimed item runs on the new allocation" wait_for 10 bash -c 'ls "$1"/running/b3_long@"$2".*.job' _ "$B" "$idb2"
check "reclaim is not a retry" test ! -e "$B/retries/b3_long"
echo "$idb2" >"$S/hide.b"   # squeue snapshot misses the job, but squeue -j still knows it
sleep 3
check "no reclaim while squeue -j says the job is alive" bash -c 'ls "$1"/running/b3_long@"$2".*.job && grep -q "job $2 missing from squeue snapshot but not gone" "$1/logs/driver.log"' _ "$B" "$idb2"
rm -f "$S/hide.b"
echo "9999|cfg.tpb.g002|interactive|RUNNING|1:00:00|node9999|None" >>"$S/jobs"
check "a late higher-listed racer never displaces a working allocation" wait_for 10 bash -c 'grep -qx 9999 "$1" && ! grep -qx "$2" "$1"' _ "$S/scancel.log" "$idb2"
dp=$(cat "$B/driver.pid"); kill -KILL "$dp"
check "watchdog restarts a dead driver" wait_for 10 bash -c 'p=$(cat "$1/driver.pid"); [ "$p" != "$2" ] && kill -0 "$p"' _ "$B" "$dp"
check "driver_restarted alert once" wait_for 5 alerts_is "$B" driver_restarted 1
check "heartbeat files are fresh" bash -c '[ $(( $(date +%s) - $(stat -c %Y "$1/driver.hb") )) -le 3 ] && [ $(( $(date +%s) - $(stat -c %Y "$1/watchdog.hb") )) -le 3 ]' _ "$B"
wp=$(cat "$B/watchdog.pid"); kill -KILL "$wp"
check "driver restarts a dead watchdog" wait_for 10 bash -c 'p=$(cat "$1/watchdog.pid"); [ "$p" != "$2" ] && kill -0 "$p"' _ "$B" "$wp"
check "watchdog_restarted alert once" wait_for 5 alerts_is "$B" watchdog_restarted 1
sleep 2
check "restart alerts not repeated" bash -c '[ $(nalerts "$1" driver_restarted) = 1 ] && [ $(nalerts "$1" watchdog_restarted) = 1 ]' _ "$B"
sleep 30 & dummy=$!
dp=$(cat "$B/driver.pid"); echo "$dummy" >"$B/driver.pid"   # pid file now names an unrelated process
check "a driver whose pid file names another process exits" wait_for 10 bash -c '! kill -0 "$1" 2>/dev/null' _ "$dp"
check "unrelated pid is not taken for a driver (restarted, not killed)" wait_for 10 bash -c 'p=$(cat "$1/driver.pid"); [ "$p" != "$2" ] && tr "\0" " " </proc/$p/cmdline | grep -q _driver && kill -0 "$2"' _ "$B" "$dummy"
kill "$dummy" 2>/dev/null
bash "$POOL" stop "$B" --release >/dev/null
check "stop --release cancels pool allocations" grep -qx "$idb2" "$S/scancel.log"
check "stop --release requeues running items" test -f "$B/queue/b3_long.job" -a -z "$(ls "$B/running")"
check "stop --release drains workers" test -f "$B/workers/$idb2.stop"
rm -f "$S/refuse.interactive" "$S/pending.batch"

# ------------------------------------------------------------------ default names and dirs
PI_FLEET_SESSION=abcdefghijk SJOB_STAGE_DIR="$W/stage" bash "$POOL" init --repo "$REPO" >/dev/null
check "default session pool: \$SJOB_STAGE_DIR/pools/s-<id8>-<repo>" grep -qx "POOL_OWNER='abcdefghijk'" "$W/stage/pools/s-abcdefgh-repo/pool.env"
(cd "$REPO" && PI_FLEET_SESSION=abcdefghijk SJOB_STAGE_DIR="$W/stage" bash "$POOL" init --scope repo >/dev/null)
check "default repo pool: name = repo basename, repo = cwd" bash -c 'grep -qx "POOL_REPO='"'"'$2'"'"'" "$1" && grep -qx "POOL_OWNER='"'"''"'"'" "$1"' _ "$W/stage/pools/repo/pool.env" "$REPO"
PI_FLEET_SESSION=abcdefghijk SJOB_STAGE_DIR="$W/stage" bash "$POOL" init --scope cluster --repo "$REPO" >/dev/null
check "default cluster pool: name cluster" grep -qx "POOL_SCOPE='cluster'" "$W/stage/pools/cluster/pool.env"

# ------------------------------------------------------------------ pool C: adopt an existing dir
C="$W/pools/c"
mkdir -p "$C"/{queue,running,done,failed,retries,workers,logs,races,tmp,staging}
cat >"$C/pool.env" <<EOF
P=$C
REPO=$REPO
GPUS=2
MIN_LEFT_TRAIN=45   # old key, kept
POOLNAME=tpc
EOF
echo 'old driver' >"$C/driver.sh"
printf '#!/bin/bash\necho "adopted $POOL_SLOT"\n' >"$C/queue/c1.job"
echo "[2026-01-01 00:00:00] old event" >"$C/logs/events.log"
echo "Traceback old" >"$C/logs/c1.log"
bash "$POOL" init "$C" --race "batch:4:00:00" >/dev/null
check "adopt: legacy POOLNAME/REPO/GPUS/MIN_LEFT_TRAIN mapped" bash -c 'f="$1/pool.env"; grep -qx "POOL_NAME='"'"'tpc'"'"'" "$f" && grep -qx "POOL_REPO='"'"'$2'"'"'" "$f" && grep -qx "SLOTS='"'"'2'"'"'" "$f" && grep -qx "SLOT_BIND='"'"'gpu'"'"'" "$f" && grep -qx "MIN_LEFT='"'"'45'"'"'" "$f"' _ "$C" "$REPO"
check "adopt: old pool.env lines kept" bash -c 'grep -q "^P=$1$" "$1/pool.env" && grep -q "^MIN_LEFT_TRAIN=45   # old key, kept" "$1/pool.env" && grep -q "^POOLNAME=tpc" "$1/pool.env"' _ "$C"
check "adopt: keys added" bash -c 'grep -qx "POOL_NAME='"'"'tpc'"'"'" "$1/pool.env" && grep -qx "SLOTS='"'"'2'"'"'" "$1/pool.env" && grep -qx "MAX_NODES='"'"'4'"'"'" "$1/pool.env"' _ "$C"
check "adopt: queue, logs, files untouched" test -f "$C/queue/c1.job" -a -f "$C/driver.sh" -a -d "$C/watch"
bash "$POOL" init "$C" --max-nodes 2 >/dev/null
check "re-init updates only the given key" bash -c 'grep -qx "MAX_NODES='"'"'2'"'"'" "$1/pool.env" && grep -qx "SLOTS='"'"'2'"'"'" "$1/pool.env" && [ $(grep -c "^MAX_NODES=" "$1/pool.env") = 1 ]' _ "$C"
touch "$S/run_fail"
IDLE_RELEASE_SEC=1 bash "$POOL" start "$C" >/dev/null
check "failed sjob run: no .started, retried" wait_for 10 bash -c '[ $(grep -c "^run " "$1/run.log") -ge "$2" ] && ! ls "$3"/workers/*.started' _ "$S" "$(( $(grep -c '^run ' "$S/run.log") + 2 ))" "$C"
rm -f "$S/run_fail"
check "adopted pool runs its queue" wait_for 20 test -f "$C/done/c1.job"
idc=$(job_of tpc.g001 batch)
check "idle node released after IDLE_RELEASE" wait_for 15 grep -qx "$idc" "$S/scancel.log"
check "adopt: existing log content not alerted" bash -c '[ $(nalerts "$1" log_alert) = 0 ]' _ "$C"
bash "$POOL" stop "$C" >/dev/null

check "no forbidden Slurm command was called" test ! -e "$S/forbidden.log"
if [ "$failed" -eq 0 ]; then echo "all sjob-pool tests passed"; else echo "$failed sjob-pool test(s) FAILED"; fi
[ "$failed" -eq 0 ]
