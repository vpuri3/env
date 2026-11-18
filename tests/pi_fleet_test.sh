#!/bin/bash
# Runs the pi-fleet tests (tests/pi-fleet/*.test.ts) with node's test runner, one process per file,
# the files in parallel.
#
#   tests/pi_fleet_test.sh                  all tests (spec output)
#   tests/pi_fleet_test.sh status registry  only tests/pi-fleet/{status,registry}.test.ts
#   tests/pi_fleet_test.sh -q [names]       quiet (for agents): only the failures (file:line, name, message;
#                                           no stacks) and a one-line summary; the full spec output goes to
#                                           a log file whose path is printed last. PI_FLEET_TEST_QUIET=1 too.
#   tests/pi_fleet_test.sh -t REGEX [names] only tests whose name matches (node --test-name-pattern)
#   tests/pi_fleet_test.sh -n 5 -q deck     run 5 times in a row (telling a flake from a failure)
#   tests/pi_fleet_test.sh -j 4             at most 4 files at once (default: one per CPU)
#
# Needs node >= 22.18 (runs .ts by type stripping). The RPC tests need `pi` on PATH
# (PI_FLEET_TEST_PI overrides) and are skipped without it. Tests never touch the user's
# pi state, status dir or tmux server: they use temp dirs and tmux sockets named after the
# test process's pid (parallel runs, e.g. from several worktrees, do not collide), and TMUX is
# unset here.

set -euo pipefail

usage() { sed -n '2,/^$/s/^# \{0,1\}//p' "$0"; }

repo=$(cd "$(dirname "$0")/.." && pwd -P)
quiet=${PI_FLEET_TEST_QUIET:-}
repeat=1
jobs=
node_args=()
while [ "$#" -gt 0 ]; do
    case "$1" in
        -q | --quiet) quiet=1 ;;
        -t | --grep)
            node_args+=("--test-name-pattern=$2")
            shift
            ;;
        -n | --repeat)
            repeat=$2
            shift
            ;;
        -j | --jobs)
            jobs=$2
            shift
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        -*)
            echo "pi_fleet_test.sh: unknown option $1" >&2
            usage >&2
            exit 2
            ;;
        *) break ;;
    esac
    shift
done
case "$repeat" in '' | *[!0-9]* | 0) echo "pi_fleet_test.sh: -n needs a positive count" >&2 && exit 2 ;; esac
[ -n "$jobs" ] && node_args+=("--test-concurrency=$jobs")

work=$(mktemp -d "${TMPDIR:-/tmp}/pi-fleet-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

# Belt and braces: anything that forgets its own override lands in $work.
export PI_FLEET_STATE_DIR="$work/state"
unset TMUX TMUX_PANE PI_FLEET_SESSION PI_FLEET_TMUX_SOCKET PI_FLEET_CTL_SOCK PI_FLEET_PI_PANE PI_FLEET_DECK PI_FLEET_RUNTIME_DIR \
    PI_FLEET_TITLE PI_FLEET_TITLE_MODEL PI_FLEET_TITLE_DEBUG

files=()
if [ "$#" -eq 0 ]; then
    files=("$repo"/tests/pi-fleet/*.test.ts)
else
    for name in "$@"; do
        case "$name" in
            */*) file=$name ;;
            *) file="$repo/tests/pi-fleet/${name%.test.ts}.test.ts" ;;
        esac
        if [ ! -f "$file" ]; then
            echo "pi_fleet_test.sh: no test file $file" >&2
            exit 2
        fi
        files+=("$file")
    done
fi

# Quiet: the spec output (and node's own stderr) to a log kept after the run; failures and a summary here.
run_once() {
    local log="$1"
    if [ -z "$quiet" ]; then
        node --test --test-reporter=spec ${node_args[@]+"${node_args[@]}"} "${files[@]}"
        return
    fi
    local status=0
    node --test --test-reporter=spec --test-reporter-destination="$log" \
        --test-reporter="$repo/tests/pi-fleet/support/quiet-reporter.mjs" --test-reporter-destination=stdout \
        ${node_args[@]+"${node_args[@]}"} "${files[@]}" 2>>"$log" || status=$?
    echo "full log: $log"
    return "$status"
}

logs=${TMPDIR:-/tmp}/pi-fleet-test-logs
[ -z "$quiet" ] || mkdir -p "$logs"
failed=0
for ((i = 1; i <= repeat; i++)); do
    [ "$repeat" -eq 1 ] || echo "== run $i/$repeat"
    log="$logs/$(date +%Y%m%d-%H%M%S)-$$-$i.log"
    run_once "$log" || failed=$((failed + 1))
done
if [ "$repeat" -gt 1 ]; then
    echo "== $failed of $repeat runs failed"
fi
[ "$failed" -eq 0 ]
