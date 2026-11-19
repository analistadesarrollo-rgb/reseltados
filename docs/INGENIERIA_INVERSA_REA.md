# Ingeniería Inversa con REA y Análisis del Sistema Original

## 1. Investigación con REA (Reverse Engineering Agent)

La investigación mediante **REA** (`https://github.com/morluto/rea.git`) se ejecutó en un directorio completamente independiente (`scratch/rea` y `scratch/rea-pkg`), sin añadir REA como dependencia del proyecto final `resultados_astro`.

### Hallazgos registrados por REA (`rea-agents@6.7.0`)

1. **`analyze-javascript-application`** sobre `C:\xampp\htdocs\resultados2` (`ev_0a9d164ff63db5be8215a21c7b757358b71f14fafcd180338123e1ff1f521cb5`):
   - Grafo analizado: **198 nodos, 201 aristas**.
   - Se identificó que `script.js` y `panel_validacion.html` presentaban problemas de codificación (`invalid-utf8` por caracteres acentuados guardados en Windows-1252/Latin-1).
   - Se mapearon dependencias front-end heredadas (`jquery`, `popper.js`, `bootstrap`, `sweetalert2`, `animate.css` en `login_down/`).
2. **`audit-release-exposure`** (`ev_78141e618a4d3197778a0b1555aa492a4edd748c3cadbd0676b7749818495666`):
   - Detectó exposición de source maps (`sourcesContent`) en `login_down/editar/css/*.css.map`.
   - Confirmó credenciales de bases de datos codificadas en texto plano dentro de múltiples archivos PHP (`index.php`, `obtener_datos.php`, `obtener_resultados.php`, `actualiza_baloto.php`, `login_down/conexion.php`, `login_down/editar/conexion.php`).

## 2. Comparación de variantes PHP del sistema original

| Archivo original | Rol | Diferencias clave | Conservado en `resultados_astro` |
|------------------|-----|-------------------|----------------------------------|
| `index.php` | **Versión de producción principal** | Tablero 16:9 completo, reloj sincronizado con `get_server_time.php`, polling de `obtener_datos.php` cada 5 min, carrusel cada 15 min, mini-slider de normas cada 4 s. **Defecto:** nunca llamaba a `actualiza_baloto.php`. | Sí (`/`) + sincronización automática desde backend |
| `index2.php` | Variante de pruebas/sincronización | Igual que `index.php`, pero añadía llamada AJAX periódica a `actualiza_baloto.php` cada 60 min desde el navegador. | Sí (lógica migrada a scheduler del servidor en Node.js) |
| `androidtv.php` | Variante para pantallas Android TV | Igual que `index.php`, agregando solicitud automática de `requestFullscreen()` al cargar o al primer evento táctil/teclado. | Sí (`/androidtv/`) |
| `panel_validacion.html` | Panel de monitoreo y validación | Permite consultar estado, verificar resultados y disparar sincronización manual de Baloto/acumulados. | Sí (`/panel-validacion/`) |
| `login_down/*` | Panel administrativo manual | Autenticación contra `bdpersona.usuario` (MD5) y edición manual de `chatbot.acumulados`. **Defecto:** no sincronizaba `POWERBI.INFORESULTADOS`. | Sí (`/admin/` + sincronización automática a PowerBI) |

## 3. Mapa completo de bases de datos y tablas

### A. Base de datos principal (`chatbot`, MariaDB 5.5.33 en `172.20.1.92:3306`)
- **`resultados`**: Almacena resultados históricos de loterías y sorteos diarios.
  - Columnas clave: `fecha` (`DATE`), `codigo` (`VARCHAR`), `numero` (`VARCHAR`), `serie` (`VARCHAR`), `nombre` (`VARCHAR`).
  - Se consulta el último registro por `codigo` (`ORDER BY fecha DESC LIMIT 1`) para las 20 Loterías Oficiales y 22 Sorteos Diarios, y por rango de fechas (`LUN` a `SAB` de la semana en curso o anterior según día) para las 30 celdas del Resumen Semanal.
- **`acumulados`**: Tabla de fila única (`id = 1`) que almacena:
  - `doble3`, `doble4`, `millonario` (acumulados comerciales).
  - `baloto_acumulado`, `baloto_1..baloto_5`, `baloto_super`, `baloto_fecha`.
  - `revancha_acumulado`, `revancha_1..revancha_5`, `revancha_super`, `revancha_fecha`.
  - `miloto_acumulado`, `miloto_1..miloto_5`, `miloto_fecha`.
  - `colorloto_acumulado`, `colorloto_1..colorloto_6`, `colorloto_fecha`.

### B. Base de datos de usuarios (`bdpersona`, MariaDB en `172.20.1.92:3306`)
- **`usuario`**: Autenticación del panel administrativo (`usuario`, `contrasena` en MD5).

### C. Base de datos externa PowerBI (`POWERBI`, MySQL 8.2.0 en `aplicacionesgane.cloud:5010`)
- **`INFORESULTADOS`**:
  - Llave primaria compuesta: `PRIMARY KEY (FECHA, CODIGO)`.
  - Columnas: `FECHA` (`DATE`), `CODIGO` (`INT` / `VARCHAR`), `NOMBRE`, `NUMERO`, `SERIE`, `ACUMULADO`, etc.
  - Códigos sincronizados:
    - `1000`: Baloto
    - `2000`: Revancha
    - `3000`: Doble Chance 3 Cifras
    - `4000`: Doble Chance 4 Cifras
    - `5000`: Chance Millonario
    - `6000`: MiLoto
    - `7000`: ColorLOTO
    - Loterías/sorteos diarios desde API interna `http://172.20.1.221:7080/api/v1/resultados`.

## 4. Códigos de loterías y sorteos preservados

- **Loterías Oficiales (20)**:
  - Col 1: `CUN/MARCA` (`1004`), `TOLIMA` (`1005`), `CRUZ ROJA` (`1006`), `HUILA` (`1007`)
  - Col 2: `VALLE` (`1008`), `MANIZALES` (`1009`), `META` (`1010`), `BOGOTA` (`1011`)
  - Col 3: `QUINDIO` (`1012`), `MEDELLIN` (`1013`), `RISARALDA` (`1014`), `SANTANDER` (`1015`)
  - Col 4: `BOYACA` (`1016`), `CAUCA` (`1017`), `EXTRA` (`1018`), `SUPERCHON` (`1031`)
  - Col 5: `PAISITA SA` (`1025`), `DORN SAB` (`1041`), `ASTRO SOL` (`1045`), `ASTRO LUNA` (`1046`)
- **Sorteos Diarios (22 códigos activos en grilla 8×4)**:
  - `CHONTICO` (Tarde `1021`, Noche `1022`, Festivo `1023`)
  - `DORADO` (Mañana `1038`, Tarde `1039`, Noche `1040`, Festivo `1042`)
  - `PAISITA` (Tarde `1024`, Noche `1026`, Festivo `1027`)
  - `CAFETERITO` (Tarde `1028`, Noche `1029`, Festivo `1030`)
  - `SAMAN` (Tarde `1032`, Festivo `1033`)
  - `CARIBEÑA` (Noche `1034`, Festivo `1035`)
  - `SINUANO` (Tarde `1036`, Noche `1037`, Festivo `1044`)
  - `FANTASTICA` (Noche `1043`, Festivo `1047`)
- **Resumen Semanal (5 filas × 6 días = 30 celdas)**:
  - `DORADO M` (`1038`), `CHON M` (`1021`), `PAISITA M` (`1024`), `CAFETE D` (`1028`), `SAMAN D` (`1032`) de Lunes a Sábado.

## 5. Intervalos de actualización y servicios externos

- **Reloj en pantalla**: Sincronizado con `/api/time` (`America/Bogota`) cada 10 minutos; tick local cada 1 segundo.
- **Actualización de tablero**: Polling a `/api/datos?hash=...` cada **5 minutos** (con animación `pulse` al detectar cambios reales).
- **Mini-slider de normas**: Rotación automática cada **4 segundos** con transición suave.
- **Carrusel comercial pantalla completa**: Se activa cada **15 minutos**, recorre dinámicamente las imágenes de `/img/carrusel/` (12 imágenes actuales) y regresa automáticamente al tablero.
- **Fuentes externas de scraping**:
  1. `https://baloto.com/resultados` (Baloto y Revancha)
  2. `https://baloto.com/miloto/resultados` (MiLoto)
  3. `https://baloto.com/colorloto/resultados` (ColorLOTO)
  4. `https://www.gane.com.co/doble-chance/` (Doble Chance 3C y 4C)
  5. `https://www.chancemillonario.com.co/` (Chance Millonario)
  6. `http://172.20.1.221:7080/api/v1/resultados` (Resultados diarios internos)
