#!/bin/sh
# Stub pi for the CLI tests (PI_FLEET_PI_CMD). Each run appends "pid pane args..." to
# $PI_FLEET_STUB_DIR/<session>.runs, prints a banner, and exits with the code a test writes to
# $PI_FLEET_STUB_DIR/<session>.exit (the file is consumed).
dir=${PI_FLEET_STUB_DIR:?}
id=${PI_FLEET_SESSION:-none}
echo "$$ ${TMUX_PANE:-} $*" >> "$dir/$id.runs"
echo "stub pi $id"
while [ ! -e "$dir/$id.exit" ]; do sleep 0.05; done
code=$(cat "$dir/$id.exit")
rm -f "$dir/$id.exit"
exit "$code"
