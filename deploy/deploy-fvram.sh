#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="fvram"
BASE_DIR="/home/sistemas/FVRAM"
WEB_CONTAINER="${PROJECT_NAME}-web"
WEB_PORT="8082"
API_CONTAINER="${PROJECT_NAME}-api"
NETWORK="${PROJECT_NAME}-network"

DB_CONTAINER="${PROJECT_NAME}-db"
DB_VOLUME="${PROJECT_NAME}-db-data"
DB_ROOT_PASSWORD="fvram_root_2026"
DB_NAME="fvram"
DB_USER="fvram_user"
DB_PASS="fvram_pass_2026"

ADMIN_PASSWORD="${FVRAM_ADMIN_PASSWORD:-Farma2026}"

echo "[1/5] Create application network and persistent database volume..."
docker network create "${NETWORK}" >/dev/null 2>&1 || true
docker volume create "${DB_VOLUME}" >/dev/null

echo "[2/5] Start persistent database..."
docker rm -f "${DB_CONTAINER}" >/dev/null 2>&1 || true
docker run -d \
  --name "${DB_CONTAINER}" \
  --restart unless-stopped \
  --network "${NETWORK}" \
  -e MYSQL_ROOT_PASSWORD="${DB_ROOT_PASSWORD}" \
  -e MYSQL_DATABASE="${DB_NAME}" \
  -e MYSQL_USER="${DB_USER}" \
  -e MYSQL_PASSWORD="${DB_PASS}" \
  -v "${DB_VOLUME}:/var/lib/mysql" \
  -v "${BASE_DIR}/fvram.sql:/docker-entrypoint-initdb.d/fvram.sql:ro" \
  mysql:8

echo "[3/5] Build and start API..."
docker build -t fvram-api:local "${BASE_DIR}/api"
docker rm -f "${API_CONTAINER}" >/dev/null 2>&1 || true
docker run -d \
  --name "${API_CONTAINER}" \
  --restart unless-stopped \
  --network "${NETWORK}" \
  -e DB_HOST="${DB_CONTAINER}" \
  -e DB_NAME="${DB_NAME}" \
  -e DB_USER="${DB_USER}" \
  -e DB_PASSWORD="${DB_PASS}" \
  -e ADMIN_PASSWORD="${ADMIN_PASSWORD}" \
  fvram-api:local

echo "[4/5] Recreate web container on port ${WEB_PORT}..."
docker rm -f "${WEB_CONTAINER}" >/dev/null 2>&1 || true

docker run -d \
  --name "${WEB_CONTAINER}" \
  --restart unless-stopped \
  --network "${NETWORK}" \
  -p "${WEB_PORT}:80" \
  -v "${BASE_DIR}:/usr/share/nginx/html:ro" \
  -v "${BASE_DIR}/deploy/fvram-web-default.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine

echo "[5/5] Done. Validate restart policies:"
echo "docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${WEB_CONTAINER}"
echo "docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${API_CONTAINER}"
echo "docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${DB_CONTAINER}"
