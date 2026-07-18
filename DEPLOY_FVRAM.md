# Deploy coexistente: FVRAM en /fvram

Este proyecto es frontend estatico (HTML/CSS/JS con localStorage).
No necesita API Node para funcionar hoy.

Objetivo de acceso:
- http://10.69.40.7/fvram/

## 1) Levantar frontend en contenedor (puerto unico 8082)

Desde /home/sistemas/FVRAM:

```bash
chmod +x deploy/deploy-fvram.sh
./deploy/deploy-fvram.sh
```

Esto crea:
- contenedor web: fvram-web
- contenedor db (opcional para futura API): fvram-db

## 2) Configurar reverse proxy del host para ruta separada

### Opcion A: Apache (recomendado en esta PC)

Se detecto Apache activo en este equipo. Inserta el snippet de:
- deploy/fvram-apache-vhost-snippet.conf.example

en tu VirtualHost que atiende 10.69.40.7.

Habilita modulos (una sola vez) y recarga:

```bash
sudo a2enmod proxy proxy_http headers rewrite
sudo systemctl reload apache2
```

Forma automatica (recomendada):

```bash
sudo bash deploy/apply-apache-fvram.sh
```

### Opcion B: Nginx

Copiar el ejemplo incluido en deploy/fvram-nginx-site.conf.example a tu sitio Nginx real
(la ruta depende de tu distro, por ejemplo /etc/nginx/sites-available/default).

Bloque clave:

```nginx
location = /fvram {
    return 301 /fvram/;
}

location /fvram/ {
    proxy_pass http://127.0.0.1:8082/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Validar y recargar Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 3) Checklist de arranque automatico

```bash
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' fvram-web
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' fvram-db
```

Ambos deben devolver: unless-stopped

## 4) Si algun dia agregas API Node (opcional)

Usa servicio systemd dedicado, por ejemplo fvram-api:

```ini
[Unit]
Description=FVRAM API
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/sistemas/fvram-api
ExecStart=/usr/bin/node /home/sistemas/fvram-api/server.js
Restart=always
RestartSec=5
User=sistemas
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Activacion:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fvram-api
systemctl is-enabled fvram-api
```

## Notas

- Si ya existe otro sistema en /, no lo toques; solo agrega location /fvram/.
- El slash final en proxy_pass es obligatorio para que los assets carguen bien.
- URL final esperada: http://10.69.40.7/fvram/

## 5) Prueba final

```bash
curl -I http://127.0.0.1:8082
curl -I http://10.69.40.7/fvram/
```

Ambos deben responder HTTP 200 (o 301 seguido de 200 en el segundo).
