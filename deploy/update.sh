#!/usr/bin/env bash
set -euo pipefail

cd /opt/hq-jr/deploy

image="ghcr.io/adi-il/hq-jr:latest"

running=$(docker inspect --format '{{.Image}}' hq-jr 2>/dev/null || true)
docker compose pull --quiet app
latest=$(docker image inspect --format '{{.Id}}' "$image")

if [ "$running" = "$latest" ]; then
  echo "hq-jr is current (${latest:7:12})"
  exit 0
fi

echo "updating hq-jr from ${running:7:12} to ${latest:7:12}"
docker compose up -d --no-deps app

for _ in $(seq 1 12); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "hq-jr healthy on ${latest:7:12}"
    exit 0
  fi
  sleep 5
done

echo "hq-jr failed its health check after updating to ${latest:7:12}" >&2
exit 1
