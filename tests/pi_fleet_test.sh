#!/bin/bash
# Runs the pi-fleet tests (tests/pi-fleet/*.test.ts) with node's test runner.
#
#   tests/pi_fleet_test.sh                  all tests
#   tests/pi_fleet_test.sh status registry  only tests/pi-fleet/{status,registry}.test.ts
#
# Needs node >= 22.18 (runs .ts by type stripping). The RPC tests need `pi` on PATH
# (PI_FLEET_TEST_PI overrides) and are skipped without it. Tests never touch the user's
# pi state, status dir or tmux server: they use temp dirs, and TMUX is unset here.

set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/pi-fleet-test.XXXXXX")
trap 'rm -rf "$work"' EXIT

# Belt and braces: anything that forgets its own override lands in $work.
export PI_FLEET_STATE_DIR="$work/state"
unset TMUX TMUX_PANE PI_FLEET_SESSION

files=()
if [ "$#" -eq 0 ]; then
    files=("$repo"/tests/pi-fleet/*.test.ts)
else
    for name in "$@"; do files+=("$repo/tests/pi-fleet/$name.test.ts"); done
fi

node --test --test-reporter=spec "${files[@]}"
