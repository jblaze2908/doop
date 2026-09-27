#!/usr/bin/env bash
set -euo pipefail

# Pull-based deploy: the host fetches the branch itself, so nothing outside it holds server access.
# Run by deploy/draft.timer every 2 min; a no-op unless the branch moved or the app is down.
DEPLOY_DIR="${DEPLOY_DIR:-/opt/draft}"
ENV_FILE="${DRAFT_ENV_FILE:-/etc/draft/draft.env}"
BRANCH="${DEPLOY_BRANCH:-main}"
STATE_DIR="${DRAFT_STATE_DIR:-/var/lib/draft}"
BACKUP_DIR="${DRAFT_BACKUP_DIR:-/var/backups/draft}"
HEALTH_URL="${DRAFT_HEALTH_URL:-http://127.0.0.1:4400/healthz}"

# A build can outlast the timer interval; overlapping runs would race on checkout.
install -d -m 700 "$STATE_DIR" "$BACKUP_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || exit 0

compose() { docker compose -p draft -f deploy/compose.yml --env-file "$ENV_FILE" "$@"; }

notify() {
  # Optional ops alerts; NTFY_* live in the root-only env file and are never echoed.
  url="$(sed -n 's/^NTFY_URL=//p' "$ENV_FILE" | tail -1)"
  [[ -n "$url" ]] || return 0
  token="$(sed -n 's/^NTFY_TOKEN=//p' "$ENV_FILE" | tail -1)"
  curl --silent --max-time 10 ${token:+-H "Authorization: Bearer $token"} -d "draft: $1" "$url" >/dev/null || true
}

cd "$DEPLOY_DIR"
checkout_commit="$(git rev-parse HEAD)"
deployed_commit="$(git rev-parse -q --verify refs/heads/deployed || true)"
rollback_commit="${deployed_commit:-$checkout_commit}"
git fetch --prune origin "$BRANCH"
target_commit="$(git rev-parse "origin/$BRANCH")"
short="${target_commit:0:8}"

if [[ "$deployed_commit" == "$target_commit" ]] && compose ps --services --status running | grep -qx app; then
  exit 0
fi
# Don't rebuild a commit that already failed; a new push clears it.
if [[ "$(cat "$STATE_DIR/failed-commit" 2>/dev/null || true)" == "$target_commit" ]]; then
  exit 0
fi

restore_previous_release() {
  echo "Restoring $rollback_commit" >&2
  git checkout --detach "$rollback_commit"
  compose up --detach --build --remove-orphans
}

reject() {
  echo "$target_commit" >"$STATE_DIR/failed-commit"
  notify "❌ $short rejected: $1"
}

git checkout --detach "$target_commit"

# Build before touching the running stack, so a broken build never takes the app down.
if ! compose build; then
  echo "Build failed for $short" >&2
  git checkout --detach "$rollback_commit"
  reject "build failed"
  exit 1
fi

# Migrations run at app boot and a code rollback does not undo them, so snapshot first.
if compose ps --services --status running | grep -qx db; then
  compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip >"$BACKUP_DIR/pre-$short.sql.gz"
  chmod 600 "$BACKUP_DIR/pre-$short.sql.gz"
  ls -1t "$BACKUP_DIR"/pre-*.sql.gz | tail -n +15 | xargs -r rm -f
fi

if ! compose up --detach --build --remove-orphans; then
  echo "Compose rollout failed" >&2
  restore_previous_release
  reject "compose up failed"
  exit 1
fi

ready=false
for _ in {1..24}; do
  if curl --fail --silent --show-error -m 5 "$HEALTH_URL" >/dev/null; then
    ready=true
    break
  fi
  sleep 5
done

if [[ "$ready" != true ]]; then
  echo "Health check failed" >&2
  restore_previous_release
  reject "health check failed"
  exit 1
fi

git branch --force deployed "$target_commit"
rm -f "$STATE_DIR/failed-commit"
notify "✅ deployed $short"
