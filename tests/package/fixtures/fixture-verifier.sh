#!/bin/sh
# Known-fixture task verifier (S4-R4). Validated ONLY for the two-turn
# acceptance fixture, whose selected attempt must write selected-output.txt
# with the exact content "selected-result". This IS a task-success check for
# that specific fixture; it is not a generic reward and must not be reused
# for arbitrary captures. Usage: test.sh <workspace-path>.
set -eu
workspace="${1:?usage: test.sh <workspace-path>}"
test "$(cat "$workspace/selected-output.txt")" = "selected-result"
echo "fixture-verifier: PASS"
