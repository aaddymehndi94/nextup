#!/usr/bin/env bash
# run-logged.sh "<title>" <command> [args…]
# Runs a command with its output shown as usual. If it fails, the last lines of that output also become an
# ::error:: annotation: annotations can be read without signing in to GitHub, raw logs can't.
title="$1"
shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  msg=$(tail -n 40 "$log" | sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' -e 's/%/%25/g' -e 's/\r//g' | cut -c1-300 | awk '{ printf "%s%%0A", $0 }')
  echo "::error title=${title} (exit ${status})::${msg}"
fi
rm -f "$log"
exit "$status"
