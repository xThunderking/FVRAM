#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Este script requiere root. Ejecuta: sudo bash deploy/apply-apache-fvram.sh"
  exit 1
fi

VHOST_FILE="/etc/apache2/sites-available/000-default.conf"
BACKUP_FILE="/etc/apache2/sites-available/000-default.conf.bak.$(date +%Y%m%d%H%M%S)"

if [[ ! -f "${VHOST_FILE}" ]]; then
  echo "No existe ${VHOST_FILE}"
  exit 1
fi

cp "${VHOST_FILE}" "${BACKUP_FILE}"
echo "Backup creado en ${BACKUP_FILE}"

if grep -q "ProxyPass /fvram/ http://127.0.0.1:8082/" "${VHOST_FILE}"; then
  echo "La ruta /fvram/ ya estaba configurada en Apache."
else
  TMP_FILE="$(mktemp)"
  awk '
    /<\/VirtualHost>/ && !done {
      print "\n    # FVRAM route"
      print "    RedirectMatch 301 ^/fvram$ /fvram/"
      print "    ProxyPreserveHost On"
      print "    ProxyPass /fvram/ http://127.0.0.1:8082/"
      print "    ProxyPassReverse /fvram/ http://127.0.0.1:8082/"
      print "    RequestHeader set X-Forwarded-Proto expr=%{REQUEST_SCHEME}"
      print "    RequestHeader set X-Forwarded-For %{REMOTE_ADDR}s\n"
      done=1
    }
    { print }
  ' "${VHOST_FILE}" > "${TMP_FILE}"
  cat "${TMP_FILE}" > "${VHOST_FILE}"
  rm -f "${TMP_FILE}"
  echo "Reglas /fvram/ agregadas en ${VHOST_FILE}"
fi

a2enmod proxy proxy_http headers rewrite >/dev/null
apache2ctl configtest
systemctl reload apache2

echo "Configuracion aplicada correctamente."
echo "Prueba: curl -I http://10.69.40.7/fvram/"
