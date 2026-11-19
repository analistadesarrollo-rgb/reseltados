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

Cree el archivo `.env` en el servidor (nunca lo suba a Git) o actualice el Secret file **`ENV_RESULTADOS_ASTRO`** en Jenkins a partir de `.env.example`:

- `TZ=America/Bogota`, `PORT=3000`, `HOST=0.0.0.0`, `NODE_ENV=production`
- `DB_MAIN_*`, `DB_POWERBI_*`
- `API_RESULTADOS_BASE_URL=http://172.20.1.221:7080/api/v1/resultados`
- `SYNC_API_TOKEN` (token secreto para autorizar `POST /api/sync`)
- `AUTO_SYNC_ENABLED=true`, `AUTO_SYNC_INTERVAL_MS=3600000`, `AUTO_SYNC_ON_STARTUP=true`
- `SYNC_LOCK_TTL_MS=180000`, `POWERBI_RETRY_COOLDOWN_MS=300000`, `SYNC_SCHEDULER_TICK_MS=60000`
- `CAROUSEL_MAX_FILE_SIZE_BYTES=10485760`, `CAROUSEL_ADMIN_INITIAL_USER=admin`
- `CAROUSEL_ADMIN_INITIAL_PASSWORD` (contraseña inicial del gestor de imágenes; nunca en Git)
- `CAROUSEL_ADMIN_REQUIRE_PASSWORD_CHANGE=true`, `COOKIE_SECURE=auto`

## 3. Volúmenes persistentes y Pipeline de Jenkins (`Jenkinsfile`)

`docker-compose.yml` define dos volúmenes nombrados persistentes:
- `resultados_astro_carousel`: compartido entre `resultados-astro-api` (`/app/carousel`, rw) y `resultados-astro-web` (`/usr/share/nginx/html/img/carousel`, ro). Sembrado por única vez al primer arranque desde `/app/carousel-seed`.
- `resultados_astro_data`: almacenado en `resultados-astro-api` (`/app/data`, rw) para conservar usuario `admin`, sesiones, estado de sincronización y bloqueos.

El `Jenkinsfile` automatiza las siguientes etapas:
1. **Prepare Environment (`.env`)** desde credencial `ENV_RESULTADOS_ASTRO`.
2. **Verify External Docker Network** (`red-gane-int`).
3. **Build Docker Images** (`resultados-astro-api:v2.0` y `resultados-astro-web:v2.0`).
4. **Stop Previous Project Containers** (`down --remove-orphans` sin `-v` para conservar volúmenes).
5. **Deploy with Docker Compose** (`up -d`).
6. **Verify Containers, Volúmenes y `/health`**.

## 4. Configuración en Nginx Proxy Manager (NPM)

En el panel de Nginx Proxy Manager conectado a la red `red-gane-int`:
1. Cree o edite el **Proxy Host** del dominio asignado (`resultados.serviredgane.cloud`).
2. **Scheme**: `http`
3. **Forward Hostname / IP**: `resultados-astro-web`
4. **Forward Port**: `80`
5. Desactive **Cache Assets**, active **Block Common Exploits** y configure SSL/TLS (Wildcard o Cloudflare DNS Challenge si aplica).

## 5. Checklist de validación post-despliegue

- [ ] `docker ps` muestra `resultados-astro-api` (`healthy`) y `resultados-astro-web` (`Up`).
- [ ] `curl -s http://resultados-astro-web/health` (desde red interna) devuelve `{"status":"ok"}`.
- [ ] `curl -s http://resultados-astro-web/api/health/db` devuelve `ok: true` para `main`, `powerbi` y estado `sync`.
- [ ] La pantalla principal `/` carga sin scroll horizontal ni vertical en TV 16:9 y evalúa actualización automática al entrar.
- [ ] `/carrusel-admin/` permite ingresar con `admin`, ver/subir/eliminar imágenes y se reflejan de inmediato en `/` tras reiniciar contenedores.
- [ ] `/panel-validacion/` responde correctamente para monitoreo y sincronización manual.
- [ ] En `POWERBI.INFORESULTADOS` quedan sincronizados y verificados los registros automáticamente sin errores en `docker logs resultados-astro-api`.
