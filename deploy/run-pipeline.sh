#!/usr/bin/env bash
# Collect, then process. Started by newsbot-pipeline.service under flock.
# Run both steps even when the first one fails. Exit 1 if any step failed.
set -uo pipefail

log() { echo "[pipeline $(date -Is)] $*"; }

failed=0
for step in collect process; do
  log "start ${step}"
  if /usr/bin/node "dist/${step}.js"; then
    log "${step} ok"
  else
    log "${step} FAILED (exit $?)"
    failed=1
  fi
done

if [[ "$failed" -eq 0 ]]; then
  log "done"
else
  log "done with errors"
fi
exit "$failed"
