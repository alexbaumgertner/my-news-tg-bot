#!/usr/bin/env bash
# Poll GitHub for a new release tag and deploy it.
#
# Install location: /usr/local/bin/newsbot-autodeploy (root-owned copy of this file).
# Started every 2 minutes by newsbot-autodeploy.timer, as the user `newsbot`.
#
# The script reads tags with `git ls-remote`. It needs no GitHub token
# (the repository is public) and does not use the GitHub API rate limit.
# Each tag is tried once. To retry a failed tag, run:
#   sudo -u newsbot newsbot-deploy <tag>

set -euo pipefail

APP_DIR="/opt/my-news-tg-bot"
STATE_DIR="/var/lib/newsbot"
STATE_FILE="${STATE_DIR}/last-tag"
LOCK_FILE="${STATE_DIR}/deploy.lock"

exec 9>"$LOCK_FILE"
flock -n 9 || { echo "another deploy is running"; exit 0; }

LATEST="$(git -C "$APP_DIR" ls-remote --tags --refs origin 'v*' \
  | awk -F/ '{print $3}' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -V | tail -n 1 || true)"

if [[ -z "$LATEST" ]]; then
  exit 0
fi

LAST="$(cat "$STATE_FILE" 2>/dev/null || true)"
if [[ "$LATEST" == "$LAST" ]]; then
  exit 0
fi

echo "new tag ${LATEST} (last: ${LAST:-none})"
# Record the tag before the deploy, so a failed tag is not retried every 2 minutes.
echo "$LATEST" > "$STATE_FILE"
/usr/local/bin/newsbot-deploy "$LATEST"
