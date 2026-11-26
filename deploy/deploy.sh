#!/usr/bin/env bash
# Deploy one release tag of my-news-tg-bot on home-ubuntu.
#
# Install location: /usr/local/bin/newsbot-deploy (root-owned copy of this file).
# Run as the user `newsbot`:
#   sudo -u newsbot newsbot-deploy v1.2.3
# The autodeploy timer (newsbot-autodeploy) calls this script for each new tag.
#
# Exit codes:
#   0  deployed, service is running (or exited normally)
#   2  bad tag format       3  tag not found
#   4  service failed after restart
#   other  install, build or migration error

set -euo pipefail

APP_DIR="/opt/my-news-tg-bot"
SERVICE="my-news-tg-bot"
TAG="${1:-}"

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: expected a tag like v1.2.3, got: '${TAG}'" >&2
  exit 2
fi

log() { echo "[deploy $(date -Is)] $*"; }

cd "$APP_DIR"

log "fetch tags"
git fetch --quiet --tags --force origin

if ! git rev-parse --verify --quiet "refs/tags/${TAG}" >/dev/null; then
  echo "error: tag ${TAG} does not exist in origin" >&2
  exit 3
fi

log "check out ${TAG}"
git checkout --quiet --detach "refs/tags/${TAG}"

if [[ ! -f package.json ]]; then
  log "no package.json at ${TAG}: nothing to build"
  exit 0
fi

log "install dependencies"
pnpm install --frozen-lockfile

log "build"
pnpm build

if node -e "process.exit(require('./package.json').scripts?.['db:migrate'] ? 0 : 1)"; then
  log "run database migrations"
  set -a; source /etc/my-news-tg-bot.env; set +a
  pnpm db:migrate
fi

log "restart ${SERVICE}"
sudo /usr/bin/systemctl enable --now "${SERVICE}"
sudo /usr/bin/systemctl restart "${SERVICE}"

sleep 5
STATE="$(systemctl show -p ActiveState --value "${SERVICE}")"
RESULT="$(systemctl show -p Result --value "${SERVICE}")"
if [[ "$STATE" == "active" ]]; then
  log "${SERVICE} is active. Deployed ${TAG}."
elif [[ "$RESULT" == "success" ]]; then
  log "${SERVICE} exited normally (no long-running process at ${TAG}). Deployed ${TAG}."
else
  echo "error: ${SERVICE} failed (state=${STATE}, result=${RESULT}). Run: journalctl -u ${SERVICE} -n 100" >&2
  exit 4
fi
