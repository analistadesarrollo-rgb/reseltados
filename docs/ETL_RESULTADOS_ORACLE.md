# ETL Programado e Independiente de Loterías (`Oracle 11g -> chatbot.resultados`)

## 1. Análisis del ETL legado en `172.20.1.92`

En el proyecto anterior, la actualización de **Loterías Oficiales**, **Sorteos Diarios** y **Resumen Semanal** dependía de un `crontab` externo del usuario `servidorweb` en `172.20.1.92` (zona `COT-0500` / `America/Bogota`):

```cron
24 1,11,12,13,16,19,21,23 * * * /home/servidorweb/tareas_programadas/chatbotconsultas/chatbot_consultas_genera.sh
```

Dicho proceso ejecutaba `CHATBOT_CONSULTAS_MYSQL.sql` contra **Oracle Database 11g (11.2.0.4.0)** (`resultadosloteries` JOIN `loteries`) para los sorteos de ayer (`TRUNC(SYSDATE - 1)`) y hoy (`TRUNC(SYSDATE)`), formateando los resultados según el código de lotería e insertando en la tabla `chatbot.resultados` de MariaDB.

> Otros scripts en ese servidor (`resultados_gane.sh` y `resultadosdia_gane.sh`) únicamente envían reportes por correo electrónico (`mailx`) y no escriben en `chatbot.resultados`.

---

## 2. Arquitectura independiente en `resultados_astro`

Para que `resultados_astro` sea **100% autónomo** y no dependa del cron legado de `172.20.1.92`, el ETL quedó integrado en el backend Node.js (`backend/src/services/etlResultadosService.js`):

### Programación exacta en `America/Bogota`
- Expresión equivalente: **`24 1,11,12,13,16,19,21,23 * * *`** (8 franjas diarias a las `01:24, 11:24, 12:24, 13:24, 16:24, 19:24, 21:24, 23:24`).
- Configurable por variables de entorno:
  - `ETL_LOTERIAS_ENABLED=true`
  - `ETL_LOTERIAS_HOURS=1,11,12,13,16,19,21,23`
  - `ETL_LOTERIAS_MINUTE=24`
  - `ETL_LOTERIAS_ON_STARTUP=true`
- **Ejecución 100% desde el servidor con idempotencia por franja (`lastCompletedSlotKey`)**:
  1. Scheduler interno del backend (evalúa cada `60 s` en `server.js`).
  2. Evaluación al arrancar el contenedor (`startup`).
  3. Disparo manual opcional desde `/panel-validacion/` (**Actualizar ahora** o **Ejecutar ETL Loterías**).
  - Los televisores (`/` y `/androidtv/`) permanecen estrictamente en modo **solo lectura** (`/api/datos` sin `checkSync=1`).
- **Bloqueo distribuido de 3 capas** (en memoria + archivo exclusivo `wx` `etl-loterias-lock.json` + `GET_LOCK('resultados_astro_etl_loterias_lock', 0)` en MariaDB) para evitar ejecuciones simultáneas duplicadas.

### Reglas exactas de formateo y esquema destino
Replicadas de `CHATBOT_CONSULTAS_MYSQL.sql`:
1. Códigos `1, 10, 13, 17, 22, 26, 27, 63`: `RESULTADO || '-' || SUBSTR(SERIERESULTADO, -1)` (ej. `0639-3`).
2. Códigos `47, 48` (Astro Sol / Astro Luna): `RESULTADO || SERIERESULTADO` (ej. `0748ACU`, `7067LIB`).
3. Demás códigos de loterías/sorteos diarios: `RESULTADO` tal cual (4 dígitos).
4. `version = '0'` (configurable vía `ETL_LOTERIAS_VERSION`).
5. Escritura transaccional atómica respetando `UNIQUE KEY chatbot_resultados (fecha, codigo)`:
   ```sql
   INSERT INTO resultados (fecha, codigo, loteria, resultado, version)
   VALUES (?, ?, ?, ?, ?)
   ON DUPLICATE KEY UPDATE
     loteria = VALUES(loteria),
     resultado = VALUES(resultado),
     version = VALUES(version)
   ```

### Estrategia Dual de Extracción (`ETL_LOTERIAS_SOURCE=auto`)
- **Fuente primaria (`oracle`)**: Consulta directa a Oracle 11g (`10.167.27.90:1521/BDMM028`) mediante `oracledb` en **modo Thick** (obligatorio para Oracle Database 11.2).
- **Respaldo automático (`internal_api`)**: Si Oracle Instant Client no está disponible en un entorno de desarrollo o falla la conexión a Oracle, el ETL cambia automáticamente al endpoint corporativo `API_RESULTADOS_BASE_URL` para ayer y hoy, filtrando los códigos especiales de Baloto/acumulados (`235, 2351, 245, 273, 3000, 4000, 5000`) y manejando HTTP 404 cuando aún no hay sorteos publicados (por ejemplo en la franja de las `01:24`).

---

## 3. Soporte Docker y Jenkins para Oracle Instant Client 11.2

- `backend/Dockerfile` utiliza `node:22-bookworm-slim` + `libaio1` + `tzdata` y configura `/opt/oracle/instantclient_11_2` (`ldconfig` y symlinks `libclntsh.so` / `libocci.so`).
- `Jenkinsfile` copia automáticamente `/var/lib/jenkins/instantclient_11_2` hacia `./backend/instantclient_11_2/` antes de compilar la imagen Docker del backend (si no existe en algún agente, emite advertencia y la compilación continúa sin fallar usando el respaldo API).
- Nunca se versionan binarios de Instant Client ni contraseñas en Git (protegido en `.gitignore`).

---

## 4. Endpoints del ETL

| Método | Ruta | Protección | Descripción |
|--------|------|------------|-------------|
| `GET` | `/api/etl/status` | Pública (solo lectura) | Estado actual, franja completada, próxima ejecución y bitácora |
| `POST` | `/api/etl/run` | `SYNC_API_TOKEN` o `X-Requested-With` (bloquea `GESTOR_CARRUSEL` con 403) | Ejecución manual inmediata del ETL |
| `GET` / `POST` | `/api/etl/check-due` | Pública no destructiva | Evalúa si la franja actual está pendiente y ejecuta en segundo plano |
| `POST` | `/api/sync` | `SYNC_API_TOKEN` o `X-Requested-With` (bloquea `GESTOR_CARRUSEL` con 403) | Botón **Actualizar ahora**: ejecuta sincronización Baloto/PowerBI + ETL de loterías |
