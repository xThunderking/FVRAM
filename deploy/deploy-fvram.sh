#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="fvram"
BASE_DIR="/home/sistemas/FVRAM"
WEB_CONTAINER="${PROJECT_NAME}-web"
WEB_PORT="8082"

# Optional DB container (not required by current frontend)
DB_CONTAINER="${PROJECT_NAME}-db"
DB_PORT="3308"
DB_ROOT_PASSWORD="fvram_root_2026"
DB_NAME="fvram"
DB_USER="fvram_user"
DB_PASS="fvram_pass_2026"

echo "[1/3] Recreate web container on port ${WEB_PORT}..."
docker rm -f "${WEB_CONTAINER}" >/dev/null 2>&1 || true

docker run -d \
  --name "${WEB_CONTAINER}" \
  --restart unless-stopped \
  -p "${WEB_PORT}:80" \
  -v "${BASE_DIR}:/usr/share/nginx/html:ro" \
  -v "${BASE_DIR}/deploy/fvram-web-default.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine

echo "[2/3] (Optional) Recreate db container on port ${DB_PORT}..."
docker rm -f "${DB_CONTAINER}" >/dev/null 2>&1 || true

docker run -d \
  --name "${DB_CONTAINER}" \
  --restart unless-stopped \
  -p "${DB_PORT}:3306" \
  -e MYSQL_ROOT_PASSWORD="${DB_ROOT_PASSWORD}" \
  -e MYSQL_DATABASE="${DB_NAME}" \
  -e MYSQL_USER="${DB_USER}" \
  -e MYSQL_PASSWORD="${DB_PASS}" \
  -v "${BASE_DIR}/fvram.sql:/docker-entrypoint-initdb.d/fvram.sql:ro" \
  mysql:8

echo "[3/3] Done. Validate restart policies:"
echo "docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${WEB_CONTAINER}"
echo "docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${DB_CONTAINER}"
