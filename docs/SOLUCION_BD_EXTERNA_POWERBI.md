# Diagnóstico y Solución de la Base de Datos Externa (`POWERBI.INFORESULTADOS`)

## 1. Problema reportado

En el sistema PHP original (`C:\xampp\htdocs\resultados2`), determinados resultados y acumulados no quedaban registrados correctamente en la tabla `INFORESULTADOS` de la base de datos externa (`aplicacionesgane.cloud:5010 / POWERBI`, MySQL 8.2.0).

## 2. Causas raíz identificadas con evidencia real

Tras inspeccionar `actualiza_baloto.php`, `baloto_log.txt`, `index.php`, `login_down/editar/update*.php`, y el esquema real de `POWERBI.INFORESULTADOS`, se confirmaron **5 causas raíz concretas**:

### Causa 1: Fallo TLS/SSL en `file_get_contents()` seguido de `die()` fatal
- **Evidencia**: Al reproducir la solicitud PHP a `https://baloto.com/resultados`, PHP devolvió `error:0A000086:SSL routines::certificate verify failed`. En `actualiza_baloto.php` el error era silenciado con `@` y, al recibir respuesta vacía, ejecutaba `die()` en la línea 187 — **abortando toda la ejecución antes de sincronizar con MySQL/PowerBI** (confirmado en `baloto_log.txt` líneas 1135–1151 y 1269–1272).
- **Solución implementada**: `scraperService.js` utiliza peticiones HTTPS con reintentos, timeout controlado, fallback TLS configurable (`SCRAPER_ALLOW_INSECURE_TLS`) y aislamiento por fuente mediante `Promise.allSettled`. Si una fuente externa falla, el resto continúa y se sincroniza sin abortar el proceso.

### Causa 2: Desfase de zona horaria (`Europe/Berlin` UTC+1 vs `America/Bogota` UTC-5)
- **Evidencia**: `actualiza_baloto.php` nunca declaraba `date_default_timezone_set('America/Bogota')`. En `baloto_log.txt`, ejecuciones realizadas a las 08:03 AM hora Colombia quedaban registradas a las `14:03:09`. A partir de las 18:00 hora Colombia, `date('Y-m-d')` avanzaba al día siguiente, provocando errores 404 contra la API interna (`http://172.20.1.221:7080/api/v1/resultados`) o escrituras con `FECHA` incorrecta en `INFORESULTADOS`.
- **Solución implementada**: Todos los contenedores y procesos fijan `TZ=America/Bogota` y utilizan `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' })` para calcular fechas de sorteo y sincronización.

### Causa 3: `index.php` en producción nunca disparaba sincronización y el panel manual omitía PowerBI
- **Evidencia**: Solo `index2.php` y `panel_validacion.html` invocaban `actualiza_baloto.php`; el `index.php` de producción jamás lo hacía. Adicionalmente, las ediciones manuales en `login_down/editar/update*.php` solo actualizaban `chatbot.acumulados` y nunca escribían en `POWERBI.INFORESULTADOS`.
- **Solución implementada**:
  - El backend Node.js incorpora un **scheduler interno automático** (`AUTO_SYNC_INTERVAL_MS`, por defecto cada 60 minutos) independiente de qué página abran los televisores.
  - Las actualizaciones manuales desde `/admin/` (`PUT /api/admin/acumulados`) sincronizan automáticamente los cambios hacia `POWERBI.INFORESULTADOS`.

### Causa 4: Sobrescritura con cadenas vacías ante fallos transitorios de scraping
- **Evidencia**: Cuando `gane.com.co/doble-chance/` o `chancemillonario.com.co/` fallaba temporalmente, `actualiza_baloto.php` guardaba cadenas vacías `''` en `chatbot.acumulados` y omitía los códigos `3000`, `4000` y `5000` al sincronizar `INFORESULTADOS`.
- **Solución implementada**: Antes de actualizar `chatbot.acumulados` y sincronizar `INFORESULTADOS`, `syncPowerBiService.js` fusiona los nuevos valores scrapeados con los últimos valores válidos almacenados en `chatbot.acumulados`, impidiendo sobrescrituras con vacío o `null`.

### Causa 5: Condición de carrera (TOCTOU) y operaciones no atómicas sobre `PRIMARY KEY (FECHA, CODIGO)`
- **Evidencia**: El script legado ejecutaba `SELECT` y luego `INSERT` o `UPDATE` en sentencias separadas sin transacción ni bloqueo de concurrencia. Ejecuciones simultáneas desde varios televisores o paneles podían generar colisiones `ER_DUP_ENTRY` o datos truncados en MySQL 8 strict mode.
- **Solución implementada**:
  - `syncPowerBiService.js` utiliza **mutex en memoria** (`syncInProgress`) para evitar solapamientos.
  - Todas las escrituras en `POWERBI.INFORESULTADOS` se ejecutan dentro de una **transacción** usando **`INSERT INTO INFORESULTADOS (...) VALUES (...) ON DUPLICATE KEY UPDATE ...`** (upsert atómico sobre `PRIMARY KEY (FECHA, CODIGO)`).
  - Se normalizan y recortan longitudes de cadenas conforme al esquema estricto de MySQL 8.2.0.

## 3. Verificación no destructiva realizada

Se ejecutó la prueba integrada en `backend/src/test-verification.js` contra la base de datos real `POWERBI.INFORESULTADOS` dentro de una transacción con `ROLLBACK`:
- Inserción inicial de registro de prueba (`FECHA = '2099-12-31', CODIGO = 99999`): **OK**.
- Segundo upsert con mismo `(FECHA, CODIGO)` verificando actualización sin duplicado (`COUNT(*) = 1`): **OK**.
- `ROLLBACK` completo verificando que no queda ningún dato de prueba en producción: **OK**.
