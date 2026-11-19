# Administración Restringida del Carrusel y Actualización Automática Unificada

Documentación técnica de las mejoras implementadas sobre `resultados_astro`.

---

## 1. Usuario inicial y sistema de permisos (`GESTOR_CARRUSEL`)

- **Usuario inicial**: `admin` (configurable mediante `CAROUSEL_ADMIN_INITIAL_USER` en `.env`).
- **Contraseña inicial**: Definida exclusivamente fuera del repositorio Git mediante `CAROUSEL_ADMIN_INITIAL_PASSWORD` en `.env` (y en la credencial `ENV_RESULTADOS_ASTRO` de Jenkins).
- **Almacenamiento seguro**: La contraseña se almacena mediante hash criptográfico `scrypt` (`N=16384, r=8, p=1`, salt aleatorio de 16 bytes) en `carousel-users.json` dentro del volumen persistente `resultados_astro_data` (`/app/data` en Docker, `./backend/data` en desarrollo local).
- **Inicialización idempotente (`initCarouselAuthStore`)**: Si `admin` ya existe en `carousel-users.json`, los reinicios o redespliegues de Docker **nunca** lo duplican ni restablecen su contraseña ni la bandera `mustChangePassword`.
- **Cambio tras primer ingreso**: Por defecto (`CAROUSEL_ADMIN_REQUIRE_PASSWORD_CHANGE=true`), al iniciar sesión por primera vez el panel muestra un aviso para actualizar la contraseña desde `POST /api/carousel-admin/change-password`.
- **Rol y permisos exclusivos**:
  - Rol asignado: `GESTOR_CARRUSEL`
  - Permisos: `carousel:read`, `carousel:upload`, `carousel:delete`
  - **Aislamiento RBAC real en backend**: `admin.js` (panel de acumulados/Baloto/Revancha) y `sync.js` (disparo de sincronización) rechazan explícitamente con **HTTP 403 Forbidden** cualquier solicitud autenticada con sesión `GESTOR_CARRUSEL` (incluso si envía `X-Requested-With: XMLHttpRequest`).

## 2. Módulo independiente de administración de imágenes

- **Ruta web independiente**: `/carrusel-admin/` (acceso directo `/imagenes` redirigido por Nginx).
- **Autenticación y seguridad HTTP**:
  - Cookies de sesión (`resultados_carousel_sid`) con `HttpOnly`, `SameSite=Lax` y `Secure` automático cuando llega por HTTPS (`COOKIE_SECURE=auto`).
  - Protección CSRF (`X-CSRF-Token` validado con `crypto.timingSafeEqual` + validación de cabecera `Origin`) en todas las operaciones de escritura (`POST`/`DELETE`).
  - Bloqueo contra fuerza bruta por IP y usuario (`429 Too Many Requests` + `Retry-After` tras 5 intentos fallidos en 15 minutos).
  - Cierre de sesión seguro (`POST /api/carousel-admin/logout`) que invalida la sesión en disco y limpia cookies.
- **Validación estricta de archivos**:
  - Extensiones permitidas: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif` (límite configurable con `CAROUSEL_MAX_FILE_SIZE_BYTES`, por defecto 10 MB).
  - Rechazo de SVG, HTML, scripts, ejecutables y dobles extensiones peligrosas (`.php.jpg`, `.svg.png`, etc.).
  - Inspección real de **magic bytes** binarios para confirmar correspondencia entre extensión y contenido.
  - Nombres sanitizados y únicos para evitar colisiones y *path traversal*; las eliminaciones validan `basename`, ausencia de `/`, `\`, `..`, enlaces simbólicos y pertenencia estricta al directorio del carrusel.
- **Experiencia de usuario**: Arrastrar y soltar con vista previa antes de subir, galería con miniaturas ampliables, identificación del nombre de archivo, indicador en imágenes recomendadas (`No Eliminar`), confirmación modal antes de borrar y mensajes de éxito/error.

## 3. Directorio y almacenamiento persistente

- **Desarrollo local**: `C:\xampp\htdocs\resultados_astro\frontend\public\img\carousel`
- **Producción Docker**: Volumen nombrado **`resultados_astro_carousel`** compartido entre ambos contenedores:
  - `resultados-astro-api`: montado en `/app/carousel` en modo lectura/escritura (`rw`).
  - `resultados-astro-web`: montado en `/usr/share/nginx/html/img/carousel` en modo solo lectura (`ro`).
- **Estado de aplicación (`resultados_astro_data`)**: Montado en `/app/data` dentro de `resultados-astro-api` para conservar `carousel-users.json`, `carousel-sessions.json`, `carousel-seeded.flag`, `sync-state.json` y `sync-lock.json`.
- **Siembra única (`seedCarouselIfNeeded`)**: Las 12 imágenes originales se empaquetan en `/app/carousel-seed` dentro de la imagen backend y se copian al volumen `resultados_astro_carousel` únicamente en la primera inicialización (`carousel-seeded.flag`). Si el gestor agrega o elimina imágenes, posteriores reinicios o reconstrucciones de Docker conservan exactamente su selección.
- **Endurecimiento Nginx**: En `/img/carousel/`, se desactiva ejecución/servicio de scripts y HTML/SVG (`403`), se añaden `X-Content-Type-Options: nosniff` y `Content-Security-Policy` restrictiva, y `Cache-Control: no-cache, must-revalidate` para reflejar cambios inmediatamente en televisores sin recompilar Astro.

## 4. Funcionamiento de las actualizaciones automáticas

- La lógica manual (**«Actualizar ahora»**), la programación en segundo plano y la comprobación al abrir la URL pública (`https://resultados.serviredgane.cloud`) invocan exactamente el mismo servicio central: `ejecutarSincronizacionCompleta()` en `backend/src/services/syncPowerBiService.js`.
- **Scheduler en backend (`server.js`)**: Evalúa al arranque (3 s después de iniciar) y cada `SYNC_SCHEDULER_TICK_MS` (60 s) mediante `evaluarYEjecutarSincronizacionSiCorresponde()` si corresponde sincronizar, operando 100 % independiente de si hay televisores conectados.
- **Verificación al abrir la URL pública**: `BoardScripts.astro` solicita `/api/datos?checkSync=1` al cargar el tablero (también disponible vía `/api/sync/check-due`). El backend verifica cuándo ocurrió la última sincronización exitosa y si no ha vencido el intervalo, responde datos inmediatamente sin ejecutar nada; si ya venció, dispara la sincronización en segundo plano sin bloquear el pintado del televisor.
- **Bloqueo contra duplicados (anti-concurrencia)**: Tres capas combinadas (`activeInProcessLocks` en memoria, lockfile atómico `wx` con TTL `SYNC_LOCK_TTL_MS` en `/app/data/sync-lock.json` y `GET_LOCK('resultados_astro_sync_lock', 0)` en MariaDB `172.20.1.92`). Si 5 televisores cargan al mismo tiempo, solo 1 proceso ejecuta y los demás reciben `alreadyRunning: true`.

## 5. Intervalos de actualización identificados y conservados (`America/Bogota`)

Se respetan intactos los intervalos originales identificados mediante ingeniería inversa:
- **Sincronización completa de fuentes y PowerBI (`AUTO_SYNC_INTERVAL_MS`)**: cada **1 hora (`3600000 ms`)**, evaluado en zona horaria `America/Bogota`.
- **Evaluación periódica del scheduler (`SYNC_SCHEDULER_TICK_MS`)**: cada **60 segundos (`60000 ms`)** para verificar vencimiento o reintentos pendientes.
- **Espera entre reintentos automáticos PowerBI (`POWERBI_RETRY_COOLDOWN_MS`)**: **5 minutos (`300000 ms`)** cuando quedó una sincronización externa pendiente.
- **Refresco del tablero en televisores**: polling `/api/datos` cada **30 s** (con caché SHA-1), hora de servidor cada **5 min**, normas cada **40 s** y carrusel comercial **180 s tablero / 20 s imagen**.

## 6. Sincronización obligatoria con la BD externa PowerBI (`INFORESULTADOS`)

- Secuencia completa en `ejecutarSincronizacionCompleta()`:
  1. Leer último estado válido de `chatbot.acumulados`.
  2. Scraping paralelo tolerante a fallos (`baloto.com`, `miloto`, `colorloto`, `chancemillonario`, `doble-chance`) + consulta a API interna `http://172.20.1.221:7080/api/v1/resultados`.
  3. Fusionar conservando últimos valores válidos ante fallos transitorios web.
  4. Actualizar `chatbot.acumulados` (BD principal) con reintentos.
  5. Ejecutar upsert atómico (`INSERT ... ON DUPLICATE KEY UPDATE` sobre `PRIMARY KEY (FECHA, CODIGO)`) en `POWERBI.INFORESULTADOS` dentro de una transacción con reintentos.
  6. **Verificación real post-commit**: `SELECT CODIGO, RESULTADO, SERIE FROM INFORESULTADOS WHERE FECHA = ? AND CODIGO IN (...)` comprobando que cada código quedó efectivamente guardado.
- **Diferenciación exacta de estados**: `completed`, `partial`, `main_db_error`, `powerbi_db_error` y `running` (nunca reporta `completed` si PowerBI falló).
- **Pendientes y reintentos sin duplicados**: Si falla PowerBI, `pendingPowerBi` queda guardado en `sync-state.json` para reintentarse automáticamente en el siguiente ciclo o manualmente desde `/panel-validacion/` mediante `POST /api/sync/retry-powerbi`.

## 7. Cambios realizados en el backend (`backend/`)

- Nuevas dependencias: `@fastify/cookie` y `@fastify/multipart` en `package.json`.
- `src/config/env.js`: Configuración de almacenamiento, credenciales iniciales de carrusel, cookies, locks y reintentos.
- `src/services/carouselAuthService.js` *(nuevo)*: Bootstrap idempotente de `admin`, hash `scrypt`, sesiones persistentes, cookies seguras, CSRF, cambio de contraseña, rate limit anti fuerza bruta y RBAC `GESTOR_CARRUSEL`.
- `src/services/carouselService.js`: Siembra idempotente, validación binaria (magic bytes), subida atómica, listado detallado y borrado seguro anti-traversal.
- `src/routes/carouselAdmin.js` *(nuevo)*: Endpoints REST `/api/carousel-admin/*`.
- `src/routes/admin.js` y `src/routes/sync.js`: Bloqueo explícito `403` para `GESTOR_CARRUSEL`, además de `/api/sync/check-due` y `/api/sync/retry-powerbi`.
- `src/services/syncPowerBiService.js`: Bloqueo persistente + distribuido MariaDB `GET_LOCK`, estado persistente `sync-state.json`, historial, duración, verificación post-commit PowerBI, evaluación central por intervalos y reintento sin duplicados.
- `src/routes/resultados.js` y `src/routes/health.js`: Soporte de `?checkSync=1` no bloqueante en `/api/datos` y alias `/api/health/db`.
- `src/server.js`: Registro de cookies/multipart, inicializaciones idempotentes al arrancar y scheduler central.

## 8. Cambios realizados en el frontend (`frontend/`)

- `src/pages/carrusel-admin.astro` *(nuevo)*: Consola independiente con login exclusivo, aviso de cambio de contraseña inicial, subida drag-and-drop con vista previa, galería con lightbox, confirmación antes de eliminar y cierre de sesión.
- `src/components/BoardScripts.astro`: Envía `checkSync=1` en el primer `/api/datos` al abrir `/` o `/androidtv/`, limpia correctamente el arreglo del carrusel si queda vacío y aplica cache-busting `?v=` por metadatos para reflejar nuevas imágenes sin reconstruir Astro. La apariencia visual del tablero TV no sufrió ninguna modificación.
- `src/pages/panel-validacion.astro`: Conserva intacto el botón «Actualizar ahora» y todas sus tarjetas, agregando visibilidad de estado detallado, última/próxima sincronización (`America/Bogota`), estado de cada BD, duración, botón de reintento PowerBI si hay pendientes e historial de ejecuciones.

## 9. Modificaciones en Docker, Nginx y Jenkins

- `docker-compose.yml`: Añadidos volúmenes nombrados `resultados_astro_carousel` (rw en API, ro en Web) y `resultados_astro_data` (rw en API), manteniendo intactos `red-gane-int`, `expose` sin `ports`, `restart: unless-stopped` y `TZ: America/Bogota`.
- `backend/Dockerfile`: Contexto raíz para copiar imágenes originales hacia `/app/carousel-seed` y crear `/app/carousel` y `/app/data`.
- `nginx.conf`: Preservación de `X-Forwarded-Proto`, `client_max_body_size 15m`, bloqueo `403` de extensiones peligrosas en `/img/carousel/`, cabeceras `nosniff`/`CSP` y alias `/imagenes` → `/carrusel-admin/`.
- `Jenkinsfile`: Conserva `docker compose -p resultados-astro down --remove-orphans` (sin `-v`, protegiendo los volúmenes) y valida la disponibilidad de `/app/carousel`, `/app/data` y `/usr/share/nginx/html/img/carousel` tras desplegar.
- `.gitignore`, `.dockerignore`, `backend/.dockerignore` y `.env.example`: Actualizados para excluir datos en ejecución (`data/`) y documentar nuevas variables sin exponer secretos.

## 10. Pruebas realizadas y limitaciones

- **Backend & BD reales (`npm --prefix backend test`)**: **15/15 pruebas aprobadas** cubriendo healthchecks, conectividad real MariaDB + PowerBI, `/api/datos?checkSync=1`, inicialización idempotente de `admin`, persistencia de semilla/borrado ante reinicios simulados, cookies `HttpOnly`/`SameSite`/`Secure`, aislamiento RBAC (`403` en admin y sync), rechazo de SVG/HTML camuflado/path traversal, subida y eliminación real de PNG con reflejo en `/api/carousel-images`, cambio de contraseña, fuerza bruta (`429`), concurrencia de 5 llamadas paralelas (lock distribuido `GET_LOCK` + file lock), simulación de fallo y recuperación PowerBI, scraping externo en vivo y transacción no destructiva `INSERT + UPDATE + SELECT verification + ROLLBACK` en `POWERBI.INFORESULTADOS`.
- **Build estático Astro (`npm --prefix frontend run build`)**: Exitoso (`5` páginas estáticas generadas).
- **Verificación visual en navegador**: Probado en vivo `/carrusel-admin/`, `/` (`1920×1080` sin scroll y cero regresiones visuales) y `/panel-validacion/`.
- **Limitación del entorno local**: Docker no está instalado en esta estación Windows (`docker` no reconocido en CLI), por lo que las pruebas de reinicio/reconstrucción de contenedores Docker y ejecución del `Jenkinsfile` deben ejecutarse en el servidor de producción una vez desplegado.

## 11. Requisitos pendientes antes de ejecutar Jenkins en producción

1. Actualizar la credencial **Secret file** `ENV_RESULTADOS_ASTRO` en Jenkins incorporando las nuevas variables de [.env.example](file:///C:/xampp/htdocs/resultados_astro/.env.example), incluyendo `CAROUSEL_ADMIN_INITIAL_PASSWORD` con el valor deseado.
2. Ejecutar el job de Jenkins para construir y levantar las nuevas imágenes Docker (`resultados-astro-web:v2.0` y `resultados-astro-api:v2.0`).
3. Validar en producción:
   - `https://resultados.serviredgane.cloud/` carga el tablero y dispara evaluación automática en background.
   - `https://resultados.serviredgane.cloud/carrusel-admin/` permite ingresar con `admin`, cambiar contraseña si se desea y administrar imágenes reflejadas de inmediato en `/api/carousel-images`.
   - `docker compose -p resultados-astro restart` mantiene intactas las imágenes subidas/eliminadas y la contraseña actualizada.
