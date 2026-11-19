# Arquitectura Técnica — `resultados_astro`

## 1. Visión general

El sistema desacopla completamente la capa de presentación (estática y ultraligera para Smart TVs) de la capa de datos y sincronización (API REST + scheduler en Node.js).

```text
[Smart TV / Navegador]
         │ HTTP
         ▼
[Nginx Proxy Manager (red-gane-int)]
         │
         ▼
[resultados-astro-web (Nginx + Astro static)]
   ├── /                     → Archivos estáticos HTML/CSS/JS/IMG (0 overhead PHP)
   └── /api/* y /health      → Reverse proxy dinámico (resolver 127.0.0.11)
                                       │
                                       ▼
                        [resultados-astro-api (Node.js 22 + Fastify 5 :3000)]
                           ├── Pool Main DB (172.20.1.92:3306 / chatbot)
                           ├── Pool Auth DB (172.20.1.92:3306 / bdpersona)
                           ├── Pool PowerBI DB (aplicacionesgane.cloud:5010 / POWERBI)
                           └── Scheduler interno (cada 60 min, America/Bogota)
```

## 2. Frontend (Astro 5 + CSS Grid/Flexbox)

- **Compilación estática (`output: 'static'`)**: Genera HTML, CSS y JS mínimos sin hidratación de React ni dependencias externas pesadas (se eliminó jQuery, Bootstrap y SweetAlert2 de la pantalla principal).
- **Optimización estricta para TV 16:9 sin scroll**:
  - Contenedor raíz `.main-content` con `width: 100vw; height: 100vh; overflow: hidden;` y `display: grid` con 8 filas proporcionales en `vh` (`6.8vh 0.5vh 19vh 0.5vh 4.2vh 38.5vh 0.5vh 30vh`).
  - Tipografías fluidas con `clamp(min, vw, max)` y `min-height: 0` en todas las tablas hijas para garantizar que los bordes inferiores nunca se desborden.
  - Verificado con `0px` de desbordamiento horizontal y vertical en `1280×720`, `1366×768`, `1920×1080` y `3840×2160`.
- **Fidelidad visual**: Se reutilizaron todos los recursos gráficos originales en `frontend/public/img/` (fondo `result-fondo.png`, logos Gane, SuperGIROS, Baloto, Revancha, Doble Chance 3/4, Chance Millonario, balotas amarillas/rojas, normas y carrusel comercial).

## 3. Backend (Node.js 22 + Fastify 5)

- **Justificación de Fastify**: Menor overhead de memoria y mayor throughput que Express, validación integrada, logging estructurado con Pino y soporte nativo de `async/await`.
- **Optimización SQL (de 89 consultas a 3)**:
  - En el PHP legado (`obtener_datos.php`), cada refresco ejecutaba **89 consultas secuenciales** (20 oficiales + 22 diarios + 30 semanal + 17 auxiliares/acumulados).
  - En `resultadosService.js`, se consolidó en **3 consultas parametrizadas por lote** (`IN (...)` con subconsulta agregada + rango semanal + `acumulados`), reduciendo la latencia y carga en MariaDB.
  - Además, `GET /api/datos?hash=<sha1>` devuelve `{ unchanged: true }` en ~50 ms cuando no hubo cambios en BD, evitando tráfico y repintados innecesarios en los televisores.
- **Seguridad y estabilidad**:
  - Todas las credenciales se inyectan exclusivamente vía variables de entorno (`.env`).
  - Consultas 100% parametrizadas (`?` placeholders) contra inyección SQL.
  - Respuestas de error sanitizadas (nunca exponen contraseñas, hosts ni stack traces internos al cliente).
  - Cierre ordenado (`SIGTERM`/`SIGINT`) cerrando pools de BD y timers.
