# Sistema de Resultados de Loterías y Sorteos — `resultados_astro`

Reconstrucción técnica completa del sistema de visualización y sincronización de resultados de loterías, sorteos diarios, acumulados, Baloto, Revancha, MiLoto y ColorLOTO, diseñada específicamente para **televisores 16:9 sin scroll** y despliegue de producción mediante **Docker, Nginx y Jenkins**.

## Arquitectura

- **Frontend (`frontend/`)**: Astro 5 compilado de forma estática (`output: 'static'`) y servido mediante **Nginx** con compresión Gzip y caché optimizada para imágenes. Sin React ni frameworks pesados.
- **Backend (`backend/`)**: API REST en **Node.js 22 + Fastify 5** con pool de conexiones `mysql2/promise`, soporte **Oracle 11g Thick Mode** (`oracledb` + respaldo API interna) para el ETL programado de loterías (`24 1,11,12,13,16,19,21,23 * * *`), scraping multi-fuente tolerante a fallos, sincronización atómica hacia `POWERBI.INFORESULTADOS` y scheduler automático en zona horaria `America/Bogota`.
- **Infraestructura (raíz)**: `docker-compose.yml`, `nginx.conf`, `Jenkinsfile`, `.env.example`, `.gitignore`, `.dockerignore`.

## Estructura del proyecto

```text
resultados_astro/
├── backend/                  # API REST Node.js + Fastify + MySQL2
│   ├── src/
│   │   ├── config/           # env.js, db.js (pools main, auth, powerbi)
│   │   ├── routes/           # health.js, resultados.js, sync.js, carouselAdmin.js
│   │   ├── services/         # resultadosService, scraperService, syncPowerBiService, carouselService, carouselAuthService
│   │   ├── server.js         # Punto de entrada Fastify (0.0.0.0:3000)
│   │   └── test-verification.js
│   ├── Dockerfile
│   └── package.json
├── frontend/                 # Aplicación estática Astro 5 optimizada para TV 16:9
│   ├── public/img/           # Recursos gráficos originales preservados
│   ├── src/
│   │   ├── components/       # HeaderBar, LoteriasOficiales, SorteosDiarios, ResumenSemanal, BottomSection, FullscreenCarousel, BoardScripts
│   │   ├── layouts/          # Layout.astro
│   │   ├── pages/            # index.astro, androidtv.astro, panel-validacion.astro, carrusel-admin.astro
│   │   └── styles/           # global.css (TV 16:9 zero-scroll)
│   ├── astro.config.mjs
│   ├── Dockerfile
│   └── package.json
├── docs/                     # Documentación técnica completa
│   ├── INGENIERIA_INVERSA_REA.md
│   ├── ARQUITECTURA.md
│   ├── SOLUCION_BD_EXTERNA_POWERBI.md
│   └── DESPLIEGUE_PRODUCCION.md
├── docker-compose.yml
├── nginx.conf
├── Jenkinsfile
├── .env.example
└── README.md
```

## Rutas disponibles

| Ruta | Descripción |
|------|-------------|
| `/` | Pantalla principal de resultados para televisores (16:9 sin scroll, con carrusel automático) |
| `/androidtv/` | Variante para Android TV con solicitud automática de pantalla completa |
| `/panel-validacion/` | Panel de validación, diagnóstico de BD, métricas y disparo manual de sincronización |
| `/carrusel-admin/` | Consola independiente para usuario restringido (`GESTOR_CARRUSEL`) de imágenes del carrusel |

## Endpoints del Backend

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/health` y `/api/health` | Healthcheck HTTP (`{"status":"ok"}`) para Docker y Nginx Proxy Manager |
| `GET` | `/api/health/db` | Diagnóstico de conectividad de BD Principal y PowerBI |
| `GET` | `/api/datos?hash=...` | Datos completos del tablero en solo lectura para televisores |
| `GET` | `/api/resultados` | Últimos resultados por código de lotería |
| `GET` | `/api/time` | Fecha, hora y día de la semana sincronizados en `America/Bogota` |
| `GET` | `/api/carousel-images` | Listado dinámico de imágenes del carrusel comercial |
| `GET` | `/api/sync/status` | Estado de la última sincronización, PowerBI, errores e historial |
| `GET` / `POST` | `/api/sync/check-due` | Evalúa en servidor si corresponde sincronizar según intervalo |
| `POST` | `/api/sync` y `/api/sync/retry-powerbi` | Ejecuta sincronización manual (PowerBI + ETL loterías) o reintento PowerBI pendiente |
| `GET` | `/api/etl/status` | Estado, programación y bitácora del ETL programado de loterías |
| `POST` | `/api/etl/run` | Ejecución manual del ETL de loterías (`Oracle 11g -> chatbot.resultados`) |
| `GET` / `POST` | `/api/etl/check-due` | Evalúa si corresponde ejecutar la franja actual del ETL en `America/Bogota` |
| `*` | `/api/carousel-admin/*` | Login, sesión HttpOnly, CSRF, subida, listado y borrado exclusivo del carrusel (`GESTOR_CARRUSEL`) |

## Ejecución local rápida

1. Configure `.env` a partir de `.env.example`.
2. Instale dependencias:
   ```bash
   npm --prefix backend install
   npm --prefix frontend install
   ```
3. Ejecute el backend (puerto `3000`):
   ```bash
   npm --prefix backend start
   ```
4. En otra terminal, ejecute el frontend en modo desarrollo (puerto `4321`, con proxy `/api` → `localhost:3000`):
   ```bash
   npm --prefix frontend run dev
   ```
5. Para generar la compilación estática de producción del frontend:
   ```bash
   npm --prefix frontend run build
   ```
6. Para ejecutar la suite de verificación real del backend (no destructiva):
   ```bash
   npm --prefix backend test
   ```

## Documentación técnica

- [Ingeniería Inversa con REA y Análisis del Legado](docs/INGENIERIA_INVERSA_REA.md)
- [Arquitectura del Nuevo Sistema](docs/ARQUITECTURA.md)
- [Diagnóstico y Solución de la BD Externa (`POWERBI.INFORESULTADOS`)](docs/SOLUCION_BD_EXTERNA_POWERBI.md)
- [Guía de Despliegue en Producción (Docker, Nginx y Jenkins)](docs/DESPLIEGUE_PRODUCCION.md)
- [Gestión Restringida del Carrusel y Actualización Automática](docs/GESTION_CARRUSEL_Y_SYNC_AUTO.md)
- [ETL Programado e Independiente de Loterías (Oracle 11g -> chatbot.resultados)](docs/ETL_RESULTADOS_ORACLE.md)
