# Guía de Despliegue en Producción (Docker, Nginx y Jenkins)

La infraestructura de despliegue de `resultados_astro` sigue el estándar productivo de `project_metas`, manteniendo total independencia de contenedores, imágenes y variables.

## 1. Arquitectura de contenedores (`docker-compose.yml`)

| Servicio | Contenedor | Imagen | Red | Puertos publicados al host | Exposición interna |
|----------|------------|--------|-----|----------------------------|--------------------|
| `resultados-astro-api` | `resultados-astro-api` | `resultados-astro-api:${IMAGE_TAG:-latest}` | `red-gane-int` (externa) | **Ninguno** | `3000` (`expose`) |
| `resultados-astro-web` | `resultados-astro-web` | `resultados-astro-web:${IMAGE_TAG:-latest}` | `red-gane-int` (externa) | **Ninguno** | `80` (`expose`) |

Características obligatorias implementadas:
- `restart: unless-stopped` en ambos servicios.
- `TZ: America/Bogota` en ambos servicios.
- Red externa `red-gane-int` (nunca se publican `ports:` al host; el tráfico entra exclusivamente por Nginx Proxy Manager).
- Healthcheck nativo en `resultados-astro-api` consultando `http://127.0.0.1:3000/health` (`{"status":"ok"}`).
- `nginx.conf` utiliza resolución DNS dinámica (`resolver 127.0.0.11 valid=10s ipv6=off;` con variable `$api_upstream http://resultados-astro-api:3000`) para evitar fallos 502 si el contenedor API se reinicia.

## 2. Variables de entorno (`.env`)

Cree el archivo `.env` en el servidor (nunca lo suba a Git) a partir de `.env.example`:

- `IMAGE_TAG` (ej. `v2.0`)
- `TZ=America/Bogota`
- `PORT=3000`
- `MAIN_DB_HOST`, `MAIN_DB_PORT`, `MAIN_DB_USER`, `MAIN_DB_PASSWORD`, `MAIN_DB_NAME`
- `AUTH_DB_HOST`, `AUTH_DB_PORT`, `AUTH_DB_USER`, `AUTH_DB_PASSWORD`, `AUTH_DB_NAME`
- `POWERBI_DB_HOST`, `POWERBI_DB_PORT`, `POWERBI_DB_USER`, `POWERBI_DB_PASSWORD`, `POWERBI_DB_NAME`
- `INTERNAL_RESULTS_API_URL=http://172.20.1.221:7080/api/v1/resultados`
- `SYNC_API_TOKEN` (token secreto para autorizar `POST /api/sync`)
- `AUTO_SYNC_ENABLED=true`
- `AUTO_SYNC_INTERVAL_MS=3600000`
- `SCRAPER_ALLOW_INSECURE_TLS=true`

## 3. Pipeline de Jenkins (`Jenkinsfile`)

El `Jenkinsfile` automatiza las siguientes etapas:
1. **Checkout** del repositorio.
2. **Verificación de entorno** (`.env`, existencia de red Docker `red-gane-int`).
3. **Build de imágenes** Docker (`resultados-astro-api` y `resultados-astro-web`) con etiqueta `v2.0` / `BUILD_NUMBER`.
4. **Despliegue con Docker Compose** (`docker compose up -d --remove-orphans`).
5. **Verificación post-despliegue** (`docker exec resultados-astro-api wget -qO- http://127.0.0.1:3000/health` y validación HTTP interna de `resultados-astro-web`).

## 4. Configuración en Nginx Proxy Manager (NPM)

En el panel de Nginx Proxy Manager conectado a la red `red-gane-int`:
1. Cree o edite el **Proxy Host** del dominio asignado (ej. `resultados.midominio.com`).
2. **Scheme**: `http`
3. **Forward Hostname / IP**: `resultados-astro-web`
4. **Forward Port**: `80`
5. Active **Block Common Exploits** y configure el certificado SSL/TLS (Let's Encrypt o corporativo) si aplica.

## 5. Checklist de validación post-despliegue

- [ ] `docker ps` muestra `resultados-astro-api` (`healthy`) y `resultados-astro-web` (`Up`).
- [ ] `curl -s http://resultados-astro-web/health` (desde red interna) devuelve `{"status":"ok"}`.
- [ ] `curl -s http://resultados-astro-web/api/health/db` devuelve `ok: true` para `main`, `auth` y `powerbi`.
- [ ] La pantalla principal `/` carga sin scroll horizontal ni vertical en TV 16:9.
- [ ] `/panel-validacion/` y `/admin/` responden correctamente.
- [ ] Al cabo de 1 ciclo del scheduler (o al invocar `POST /api/sync` con `X-Sync-Token`), se registran filas actualizadas en `POWERBI.INFORESULTADOS` sin errores en `docker logs resultados-astro-api`.
