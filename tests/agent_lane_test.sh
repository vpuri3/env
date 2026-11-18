#!/bin/bash
# Tests bin/agent-lane in a throwaway repository: lanes under .worktrees/ kept out of
# git status, nested lanes (a lead's workers merge into the lead), merge refusing
# conflicts, rm keeping unmerged branches.
#
#   tests/agent_lane_test.sh

set -uo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd -P)
lane="$repo_dir/bin/agent-lane"
work=$(mktemp -d "${TMPDIR:-/tmp}/agent-lane-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.org GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.org
export GIT_CONFIG_GLOBAL=/dev/null

failed=0
check() {
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then echo "ok   $name"; else echo "FAIL $name"; failed=$((failed + 1)); fi
}
commit_file() { (cd "$1" && echo "$3" > "$2" && git add "$2" && git commit -qm "$2"); }

r="$work/repo"
git init -q -b main "$r"
git -C "$r" commit -q --allow-empty -m init
cd "$r" || exit 1

lead=$("$lane" new lead)
check "new prints <repo>/.worktrees/<lane>" [ "$lead" = "$r/.worktrees/lead" ]
check "lane is on branch lane/lead" [ "$(git -C "$lead" symbolic-ref --short HEAD)" = lane/lead ]
check "main checkout stays clean" [ -z "$(git status --porcelain)" ]
check "exclude has /.worktrees/ once" [ "$(grep -cxF /.worktrees/ .git/info/exclude)" = 1 ]
check "second lane with the same name refused" sh -c '! "$1" new lead' _ "$lane"
check "bad lane name refused" sh -c '! "$1" new "a/b"' _ "$lane"
commit_file "$lead" l lead

cd "$lead" || exit 1
w1=$("$lane" new w1)
check "a sub-lane branches from the lead's HEAD" [ "$(git -C "$w1" rev-parse HEAD)" = "$(git -C "$lead" rev-parse HEAD)" ]
check "sub-lanes live in the main checkout's .worktrees" [ "$w1" = "$r/.worktrees/w1" ]
check "exclude still has /.worktrees/ once" [ "$(grep -cxF /.worktrees/ "$r/.git/info/exclude")" = 1 ]
commit_file "$w1" w1 one
check "list shows the sub-lane ahead of the lead" sh -c '"$1" list | grep -q "^w1 *+1 -0 vs lane/lead"' _ "$lane"
check "merge from the lead fast-forwards it" "$lane" merge w1
check "the lead has the worker's commit" [ -f "$lead/w1" ]
check "rm removes a merged lane and its branch" "$lane" rm w1
check "merged branch deleted" sh -c '! git rev-parse --verify --quiet refs/heads/lane/w1'

cd "$r" || exit 1
commit_file "$r" m main-moved
check "merge rebases the lead onto a moved main" "$lane" merge lead
check "main has every commit" sh -c '[ -f l ] && [ -f w1 ] && [ -f m ]'
"$lane" rm lead

c=$("$lane" new conflict)
commit_file "$c" m from-lane
commit_file "$r" m from-main
check "merge refuses a conflicting lane" sh -c '! "$1" merge conflict' _ "$lane"
git -C "$c" rebase --abort 2>/dev/null
check "main untouched after the refused merge" [ "$(cat m)" = from-main ]
"$lane" rm conflict 2>/dev/null
check "rm keeps an unmerged branch" git rev-parse --verify --quiet refs/heads/lane/conflict
check "rm removed its worktree" [ ! -e "$r/.worktrees/conflict" ]
check "rm -f deletes the unmerged branch" "$lane" rm -f conflict
check "empty .worktrees removed" [ ! -e "$r/.worktrees" ]

if [ "$failed" -gt 0 ]; then echo "$failed check(s) failed"; exit 1; fi
echo "all checks passed"
