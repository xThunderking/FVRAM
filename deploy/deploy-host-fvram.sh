#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="/home/sistemas/FVRAM"
USER_SERVICE_DIR="/home/sistemas/.config/systemd/user"

mkdir -p "${USER_SERVICE_DIR}" "${BASE_DIR}/runtime/logs" "${BASE_DIR}/runtime/run"
install -m 0644 "${BASE_DIR}/deploy/fvram-mysql.service" "${USER_SERVICE_DIR}/fvram-mysql.service"
install -m 0644 "${BASE_DIR}/deploy/fvram-php.service" "${USER_SERVICE_DIR}/fvram-php.service"
install -m 0644 "${BASE_DIR}/deploy/fvram-mail-worker.service" "${USER_SERVICE_DIR}/fvram-mail-worker.service"
install -m 0644 "${BASE_DIR}/deploy/fvram-mail-worker.timer" "${USER_SERVICE_DIR}/fvram-mail-worker.timer"

systemctl --user daemon-reload
systemctl --user enable --now fvram-mysql.service

for _ in $(seq 1 30); do
  if mysqladmin --protocol=tcp -h127.0.0.1 -P3308 -uroot ping >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

mysqladmin --protocol=tcp -h127.0.0.1 -P3308 -uroot ping >/dev/null
systemctl --user enable --now fvram-php.service
systemctl --user enable --now fvram-mail-worker.timer

echo "FVRAM host services started."
