#!/usr/bin/env bash
# Deploy one release tag of my-news-tg-bot on home-ubuntu.
#
# Install location: /usr/local/bin/newsbot-deploy (root-owned copy of this file).
# Runs as the user `newsbot`. Two ways to start it:
#   1. GitHub Actions: SSH forced command. The client sends "deploy <tag>"
#      and SSH puts it in SSH_ORIGINAL_COMMAND.
#   2. By hand: sudo -u newsbot newsbot-deploy <tag>
#
# The script accepts only tags in the form vMAJOR.MINOR.PATCH.

set -euo pipefail

APP_DIR="/opt/my-news-tg-bot"
SERVICE="my-news-tg-bot"

# Read the tag from the argument or from the SSH forced command.
REQUEST="${1:-${SSH_ORIGINAL_COMMAND:-}}"
TAG="${REQUEST#deploy }"

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: expected a tag like v1.2.3, got: '${REQUEST}'" >&2
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

# Before the scaffold (#7) exists, there is no application to build.
if [[ ! -f package.json ]]; then
  log "no package.json at ${TAG}: nothing to build. Done."
  exit 0
fi

log "install dependencies"
pnpm install --frozen-lockfile

log "build"
pnpm build

if node -e "process.exit(require('./package.json').scripts?.['db:migrate'] ? 0 : 1)"; then
  log "run database migrations"
  # Migrations read DATABASE_URL from the service environment file.
  set -a; source /etc/my-news-tg-bot.env; set +a
  pnpm db:migrate
fi

log "restart ${SERVICE}"
sudo /usr/bin/systemctl enable --now "${SERVICE}"
sudo /usr/bin/systemctl restart "${SERVICE}"

sleep 5
if systemctl is-active --quiet "${SERVICE}"; then
  log "${SERVICE} is active. Deployed ${TAG}."
else
  echo "error: ${SERVICE} did not start. Run: journalctl -u ${SERVICE} -n 100" >&2
  exit 4
fi
