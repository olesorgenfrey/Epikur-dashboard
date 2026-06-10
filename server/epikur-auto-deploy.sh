#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO=/home/ole/epikur
DEPLOY_REPO=/home/ole/epikur-deploy
STATE_DIR=/home/ole/.local/state/epikur-auto-deploy
STATE_FILE="$STATE_DIR/deployed-main"
LOCK_FILE="$STATE_DIR/deploy.lock"

mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

git -C "$SOURCE_REPO" fetch --quiet origin main
remote_commit=$(git -C "$SOURCE_REPO" rev-parse origin/main)
deployed_commit=$(cat "$STATE_FILE" 2>/dev/null || true)

if [[ "$remote_commit" == "$deployed_commit" ]]; then
  exit 0
fi

if [[ ! -e "$DEPLOY_REPO/.git" ]]; then
  git -C "$SOURCE_REPO" worktree add --detach "$DEPLOY_REPO" "$remote_commit"
else
  git -C "$DEPLOY_REPO" reset --hard
  git -C "$DEPLOY_REPO" clean -fd
  git -C "$DEPLOY_REPO" checkout --detach "$remote_commit"
fi

install -m 600 "$SOURCE_REPO/.env" "$DEPLOY_REPO/.env"

active_preview_services=()
for service in epikur-preview.service epikur-patient-preview.service; do
  if systemctl is-active --quiet "$service"; then
    active_preview_services+=("$service")
    sudo systemctl stop "$service"
  fi
done

restart_preview() {
  for service in "${active_preview_services[@]}"; do
    sudo systemctl start "$service"
  done
}
trap restart_preview EXIT

cd "$DEPLOY_REPO"
docker compose -p epikur up -d --build app

for _ in $(seq 1 60); do
  if curl -sS -o /dev/null http://127.0.0.1:3000/; then
    printf '%s\n' "$remote_commit" > "$STATE_FILE"
    echo "Deployed main commit $remote_commit"
    exit 0
  fi
  sleep 2
done

echo "Deployment healthcheck failed for $remote_commit" >&2
exit 1
