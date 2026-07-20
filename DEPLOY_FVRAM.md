# Producción FVRAM en PHP/MySQL local

Producción usa PHP 8.3 y una instancia MySQL local dedicada, sin contenedores.
Apache conserva la URL compartida y reenvía `/fvram/` al servicio PHP local.

Objetivo de acceso:
- http://10.69.40.7/fvram/

## 1) Levantar servicios locales

Desde /home/sistemas/FVRAM:

```bash
chmod +x deploy/deploy-host-fvram.sh
./deploy/deploy-host-fvram.sh
```

Esto habilita servicios de usuario persistentes:
- `fvram-mysql.service`: MySQL en `127.0.0.1:3308`.
- `fvram-php.service`: frontend y API PHP en `127.0.0.1:8082`.
- `fvram-mail-worker.timer`: procesa la cola de correo cada minuto.

Los datos están en `runtime/mysql/`. No elimines ese directorio.

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

## 3) Checklist de arranque automático

```bash
systemctl --user is-active fvram-mysql fvram-php fvram-mail-worker.timer
loginctl show-user sistemas -p Linger
```

Los tres servicios deben indicar `active` y Linger debe ser `yes`.

## Notas

- Si ya existe otro sistema en /, no lo toques; solo agrega location /fvram/.
- El slash final en proxy_pass es obligatorio para que los assets carguen bien.
- URL final esperada: http://10.69.40.7/fvram/

## 5) Prueba final

```bash
curl -I http://127.0.0.1:8082
curl http://127.0.0.1:8082/api/health
curl -I http://10.69.40.7/fvram/
```

Ambos deben responder HTTP 200 (o 301 seguido de 200 en el segundo).
