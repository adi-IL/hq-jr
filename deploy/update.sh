#!/usr/bin/env bash
set -euo pipefail

cd /opt/hq-jr/deploy

image=$(docker compose config --images app | head -n1)
if [ -z "$image" ]; then
  echo "could not read image for service app from compose config" >&2
  exit 1
fi

probe_health() {
  docker compose exec -T app node -e \
    "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(8000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    2>/dev/null
}

wait_healthy() {
  local label="$1"
  for _ in $(seq 1 12); do
    if probe_health; then
      echo "hq-jr healthy on ${label}"
      return 0
    fi
    sleep 5
  done
  return 1
}

ensure_running_healthy() {
  local label="$1"
  local state
  state=$(docker inspect --format '{{.State.Status}}' hq-jr 2>/dev/null || true)
  if [ "$state" != "running" ]; then
    echo "hq-jr container is ${state:-missing}; recreating from ${label}"
    docker compose up -d --no-deps app
  fi
  if wait_healthy "$label"; then
    return 0
  fi
  echo "hq-jr is on ${label} but failed its health check" >&2
  return 1
}

running=$(docker inspect --format '{{.Image}}' hq-jr 2>/dev/null || true)
previous_image_id="$running"

docker compose pull --quiet app
latest=$(docker image inspect --format '{{.Id}}' "$image")

if [ -n "$running" ] && [ "$running" = "$latest" ]; then
  ensure_running_healthy "${latest:7:12}"
  exit $?
fi

echo "updating hq-jr from ${running:7:12} to ${latest:7:12}"
docker compose up -d --no-deps app

if wait_healthy "${latest:7:12}"; then
  docker image prune -f >/dev/null
  exit 0
fi

echo "hq-jr failed its health check after updating to ${latest:7:12}" >&2

if [ -n "$previous_image_id" ] && [ "$previous_image_id" != "$latest" ]; then
  echo "rolling back to previous image ${previous_image_id:7:12}" >&2
  docker tag "$previous_image_id" "$image"
  docker compose up -d --no-deps app
  if wait_healthy "${previous_image_id:7:12}"; then
    echo "hq-jr rolled back to ${previous_image_id:7:12}" >&2
    exit 1
  fi
  echo "hq-jr rollback to ${previous_image_id:7:12} also failed health check" >&2
fi

exit 1
