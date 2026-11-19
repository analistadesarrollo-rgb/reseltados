import { getMainPool, getPowerBiPool, sanitizeDbError, withRetry } from '../config/db.js';
import { env, getBogotaDateParts } from '../config/env.js';
import { setExtraGamesCache } from './resultadosService.js';
import { extraerFuentesExternas, obtenerResultadoDesdeApiInterna } from './scraperService.js';

let syncInProgress = false;
let lastSyncReport = {
  lastRunAt: null,
  status: 'idle',
  fechaObjetivo: null,
  localDbUpdated: false,
  powerBiSyncedCount: 0,
  powerBiRecords: [],
  logs: []
};

export function getSyncStatus() {
  return {
    syncInProgress,
    ...lastSyncReport
  };
}

function validarFechaIso(fecha) {
  if (!fecha || typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha.trim())) {
    return false;
  }
  const [y, m, d] = fecha.trim().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function extraerFechaDesdeUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  try {
    const parsed = new URL(urlStr);
    const fecha = parsed.searchParams.get('fecha');
    return validarFechaIso(fecha) ? fecha.trim() : '';
  } catch {
    return '';
  }
}

function formatearResultadoYSerie(numeros) {
  if (!Array.isArray(numeros) || numeros.length < 5) {
    return ['', ''];
  }
  const resultado = numeros.slice(0, 5).map((n) => String(n).padStart(2, '0')).join('-');
  const serie = numeros[5] !== undefined ? String(numeros[5]).padStart(2, '0') : '';
  return [resultado, serie];
}

/**
 * Trunca los campos según las restricciones reales de la tabla INFORESULTADOS en MySQL 8:
 * CODIGO varchar(10), LOTERIA varchar(50), NOMBRECORTO varchar(10),
 * RESULTADO varchar(20), SERIE varchar(10), VERSION varchar(20)
 */
function normalizeInfoResultadoRow({
  fecha,
  codigo,
  loteria,
  nombrecorto,
  resultado,
  serie = '',
  horacierre = null,
  version = env.sync.versionTag
}) {
  return {
    fecha: String(fecha).slice(0, 10),
    codigo: String(codigo ?? '').trim().slice(0, 10),
    loteria: String(loteria ?? '').trim().slice(0, 50),
    nombrecorto: String(nombrecorto ?? '').trim().slice(0, 10),
    resultado: String(resultado ?? '').trim().slice(0, 20),
    serie: String(serie ?? '').trim().slice(0, 10),
    horacierre: horacierre ? String(horacierre).trim() : null,
    version: String(version || 'WS-SCRAPER-2.0').trim().slice(0, 20)
  };
}

/**
 * Inserta o actualiza atómicamente un registro en INFORESULTADOS respetando PRIMARY KEY (FECHA, CODIGO).
 * Elimina la condición de carrera (TOCTOU) que existía en actualiza_baloto.php (SELECT + INSERT/UPDATE separado).
 */
export async function upsertInfoResultado(connectionOrPool, record) {
  const row = normalizeInfoResultadoRow(record);
  const sql = `
    INSERT INTO INFORESULTADOS
      (FECHA, CODIGO, LOTERIA, NOMBRECORTO, RESULTADO, SERIE, HORACIERRE, VERSION, FECHACREATE, FECHAUPDATE)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      LOTERIA = VALUES(LOTERIA),
      NOMBRECORTO = VALUES(NOMBRECORTO),
      RESULTADO = VALUES(RESULTADO),
      SERIE = VALUES(SERIE),
      HORACIERRE = COALESCE(VALUES(HORACIERRE), HORACIERRE),
      VERSION = VALUES(VERSION),
      FECHAUPDATE = NOW()
  `;

  await connectionOrPool.execute(sql, [
    row.fecha,
    row.codigo,
    row.loteria,
    row.nombrecorto,
    row.resultado,
    row.serie,
    row.horacierre,
    row.version
  ]);

  return row;
}

/**
 * Sincroniza un lote de registros en POWERBI.INFORESULTADOS dentro de una transacción con reintentos controlados
 */
export async function sincronizarRegistrosPowerBi(fechaObjetivo, registros, logs = []) {
  const validRecords = registros.filter(
    (r) => r.resultado !== undefined && r.resultado !== null && String(r.resultado).trim() !== ''
  );

  for (const r of registros) {
    if (r.resultado === undefined || r.resultado === null || String(r.resultado).trim() === '') {
      logs.push(`ADVERTENCIA: Se omite código ${r.codigo} en PowerBI por resultado vacío.`);
    }
  }

  if (validRecords.length === 0) {
    return [];
  }

  return await withRetry(
    async () => {
      const pool = getPowerBiPool();
      const conn = await pool.getConnection();
      const synced = [];
      try {
        await conn.beginTransaction();
        for (const reg of validRecords) {
          const saved = await upsertInfoResultado(conn, {
            ...reg,
            fecha: fechaObjetivo
          });
          synced.push(saved);
        }
        await conn.commit();
        for (const s of synced) {
          logs.push(`ÉXITO: INFORESULTADOS sincronizado código ${s.codigo} fecha ${s.fecha} (${s.resultado}${s.serie ? ' / serie ' + s.serie : ''}).`);
        }
        return synced;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    {
      maxRetries: env.dbPowerBi.maxRetries,
      delayMs: env.dbPowerBi.retryDelayMs,
      label: 'Sincronización INFORESULTADOS PowerBI'
    }
  );
}

/**
 * Ejecuta el flujo completo de extracción, actualización de BD principal (chatbot.acumulados)
 * y sincronización con la BD externa (POWERBI.INFORESULTADOS).
 * Conserva siempre los últimos datos válidos si falla alguna fuente externa.
 */
export async function ejecutarSincronizacionCompleta({ fechaParam = '', urlResultadosParam = '' } = {}) {
  if (syncInProgress) {
    return {
      success: true,
      alreadyRunning: true,
      message: 'Ya hay una sincronización en progreso',
      ...lastSyncReport
    };
  }

  syncInProgress = true;
  const logs = [];
  const bogotaNow = getBogotaDateParts();

  try {
    const fechaDesdeUrl = extraerFechaDesdeUrl(urlResultadosParam);
    let fechaObjetivo =
      fechaDesdeUrl !== ''
        ? fechaDesdeUrl
        : validarFechaIso(fechaParam)
          ? fechaParam.trim()
          : bogotaNow.isoDate;

    logs.push(`[${bogotaNow.isoDateTime}] Iniciando sincronización para fecha objetivo: ${fechaObjetivo} (TZ: America/Bogota)`);

    // 1. Leer últimos datos válidos en chatbot.acumulados para no sobreescribir con vacío si falla una fuente
    const mainPool = getMainPool();
    let currentAcum = null;
    try {
      const [rows] = await mainPool.query('SELECT * FROM acumulados ORDER BY id DESC LIMIT 1');
      if (rows && rows.length > 0) {
        currentAcum = rows[0];
      }
    } catch (err) {
      logs.push(`ADVERTENCIA: No se pudo leer estado previo de acumulados (${sanitizeDbError(err)}).`);
    }

    // 2. Extraer datos de fuentes externas web
    const { results: scraped, logs: scraperLogs } = await extraerFuentesExternas();
    logs.push(...scraperLogs);

    // 3. Consultar API interna para códigos 235 (Baloto), 2351 (Revancha), 245 (MiLoto), 273 (ColorLoto)
    const [balotoApi, revanchaApi, milotoApi, colorlotoApi] = await Promise.all([
      obtenerResultadoDesdeApiInterna(fechaObjetivo, 235),
      obtenerResultadoDesdeApiInterna(fechaObjetivo, 2351),
      obtenerResultadoDesdeApiInterna(fechaObjetivo, 245),
      obtenerResultadoDesdeApiInterna(fechaObjetivo, 273)
    ]);

    // 4. Combinar resultados priorizando datos nuevos confirmados y conservando últimos datos válidos si falta alguno
    const prevBalotoBalls = currentAcum
      ? [
          currentAcum.resul_baloto1,
          currentAcum.resul_baloto2,
          currentAcum.resul_baloto3,
          currentAcum.resul_baloto4,
          currentAcum.resul_baloto5,
          currentAcum.resul_baloto6
        ].filter(Boolean)
      : [];

    const prevRevanchaBalls = currentAcum
      ? [
          currentAcum.resul_revancha1,
          currentAcum.resul_revancha2,
          currentAcum.resul_revancha3,
          currentAcum.resul_revancha4,
          currentAcum.resul_revancha5,
          currentAcum.resul_revancha6
        ].filter(Boolean)
      : [];

    const finalBalotoBalls =
      scraped.numerosBaloto.length === 6
        ? scraped.numerosBaloto
        : prevBalotoBalls.length === 6
          ? prevBalotoBalls
          : [];

    const finalRevanchaBalls =
      scraped.numerosRevancha.length === 6
        ? scraped.numerosRevancha
        : prevRevanchaBalls.length === 6
          ? prevRevanchaBalls
          : [];

    const finalAcumBaloto = scraped.acumuladoBaloto || (currentAcum?.acum_baloto ?? '');
    const finalAcumRevancha = scraped.acumuladoRevancha || (currentAcum?.acum_revancha ?? '');
    const finalAcumChance = scraped.acumuladoChance || (currentAcum?.acum_chmillonario ?? '');
    const finalAcum3Cifras = scraped.acumulado3Cifras || (currentAcum?.acum_3cifras ?? '');
    const finalAcum4Cifras = scraped.acumulado4Cifras || (currentAcum?.acum_4cifras ?? '');

    // 5. Actualizar chatbot.acumulados en BD principal
    let localDbUpdated = false;
    if (finalBalotoBalls.length === 6 && finalRevanchaBalls.length === 6) {
      try {
        await withRetry(
          async () => {
            const sqlUpdateAcum = `
              UPDATE acumulados SET
                resul_baloto1 = ?, resul_baloto2 = ?, resul_baloto3 = ?, resul_baloto4 = ?, resul_baloto5 = ?, resul_baloto6 = ?,
                resul_revancha1 = ?, resul_revancha2 = ?, resul_revancha3 = ?, resul_revancha4 = ?, resul_revancha5 = ?, resul_revancha6 = ?,
                acum_baloto = ?, acum_revancha = ?, acum_chmillonario = ?, acum_3cifras = ?, acum_4cifras = ?,
                fecha = ?
              ORDER BY id DESC
              LIMIT 1
            `;
            await mainPool.execute(sqlUpdateAcum, [
              finalBalotoBalls[0],
              finalBalotoBalls[1],
              finalBalotoBalls[2],
              finalBalotoBalls[3],
              finalBalotoBalls[4],
              finalBalotoBalls[5],
              finalRevanchaBalls[0],
              finalRevanchaBalls[1],
              finalRevanchaBalls[2],
              finalRevanchaBalls[3],
              finalRevanchaBalls[4],
              finalRevanchaBalls[5],
              finalAcumBaloto,
              finalAcumRevancha,
              finalAcumChance,
              finalAcum3Cifras,
              finalAcum4Cifras,
              fechaObjetivo
            ]);
          },
          { maxRetries: 2, delayMs: 500, label: 'Actualización de tabla acumulados' }
        );
        localDbUpdated = true;
        logs.push('ÉXITO: Tabla acumulados actualizada en base de datos principal.');
      } catch (err) {
        logs.push(`ERROR BD Principal (acumulados): ${sanitizeDbError(err)}`);
      }
    } else {
      logs.push('ADVERTENCIA: No se contaban con las 6 balotas de Baloto/Revancha para actualizar tabla acumulados.');
    }

    // 6. Preparar los 7 registros para POWERBI.INFORESULTADOS
    let [resultadoBaloto, serieBaloto] = formatearResultadoYSerie(finalBalotoBalls);
    let [resultadoRevancha, serieRevancha] = formatearResultadoYSerie(finalRevanchaBalls);

    if (balotoApi && balotoApi.resultado) {
      resultadoBaloto = balotoApi.resultado;
      serieBaloto = balotoApi.serie;
      if (validarFechaIso(balotoApi.fecha)) {
        fechaObjetivo = balotoApi.fecha;
      }
      logs.push(`BALOTO tomado desde API interna para fecha ${fechaObjetivo}: ${resultadoBaloto} serie ${serieBaloto}`);
    } else {
      logs.push(`BALOTO preparado desde scraping/BD para fecha ${fechaObjetivo}: ${resultadoBaloto} serie ${serieBaloto}`);
    }

    if (revanchaApi && revanchaApi.resultado) {
      resultadoRevancha = revanchaApi.resultado;
      serieRevancha = revanchaApi.serie;
      if (validarFechaIso(revanchaApi.fecha)) {
        fechaObjetivo = revanchaApi.fecha;
      }
      logs.push(`REVANCHA tomada desde API interna para fecha ${fechaObjetivo}: ${resultadoRevancha} serie ${serieRevancha}`);
    } else {
      logs.push(`REVANCHA preparada desde scraping/BD para fecha ${fechaObjetivo}: ${resultadoRevancha} serie ${serieRevancha}`);
    }

    const resultadoMiloto =
      scraped.resultadoMiloto !== ''
        ? scraped.resultadoMiloto
        : milotoApi?.resultado || '';

    const resultadoColorloto =
      scraped.resultadoColorloto !== ''
        ? scraped.resultadoColorloto
        : colorlotoApi?.resultado || '';

    setExtraGamesCache({
      miloto: resultadoMiloto,
      colorloto: resultadoColorloto
    });

    const registrosPowerBi = [
      {
        codigo: '235',
        loteria: balotoApi?.loteria || 'BALOTO',
        nombrecorto: balotoApi?.nombrecorto || 'BALOT',
        resultado: resultadoBaloto,
        serie: serieBaloto,
        horacierre: balotoApi?.horacierre || null
      },
      {
        codigo: '2351',
        loteria: revanchaApi?.loteria || 'BALOTO REVANCHA',
        nombrecorto: revanchaApi?.nombrecorto || 'BLTRE',
        resultado: resultadoRevancha,
        serie: serieRevancha,
        horacierre: revanchaApi?.horacierre || null
      },
      {
        codigo: '245',
        loteria: milotoApi?.loteria || 'MILOTO',
        nombrecorto: milotoApi?.nombrecorto || 'MILOT',
        resultado: resultadoMiloto,
        serie: milotoApi?.serie || '',
        horacierre: milotoApi?.horacierre || null
      },
      {
        codigo: '273',
        loteria: colorlotoApi?.loteria || 'COLORLOTO',
        nombrecorto: colorlotoApi?.nombrecorto || 'COLOR',
        resultado: resultadoColorloto,
        serie: colorlotoApi?.serie || '',
        horacierre: colorlotoApi?.horacierre || null
      },
      {
        codigo: '3000',
        loteria: 'ACUMULADO DCH 3CIF',
        nombrecorto: 'DCH3C',
        resultado: finalAcum3Cifras,
        serie: '',
        horacierre: null
      },
      {
        codigo: '4000',
        loteria: 'ACUMULADO DCH 4CIF',
        nombrecorto: 'DCH4C',
        resultado: finalAcum4Cifras,
        serie: '',
        horacierre: null
      },
      {
        codigo: '5000',
        loteria: 'ACUMULADO CHM 4CIF',
        nombrecorto: 'CHM4C',
        resultado: finalAcumChance,
        serie: '',
        horacierre: null
      }
    ];

    // 7. Sincronizar en POWERBI.INFORESULTADOS
    let syncedRecords = [];
    let powerBiError = null;
    try {
      syncedRecords = await sincronizarRegistrosPowerBi(fechaObjetivo, registrosPowerBi, logs);
    } catch (err) {
      powerBiError = sanitizeDbError(err);
      logs.push(`ERROR PowerBI: ${powerBiError}`);
    }

    const success = localDbUpdated && !powerBiError;
    const message = powerBiError
      ? `Resultados locales actualizados, pero falló la sincronización con PowerBI: ${powerBiError}`
      : 'Todos los resultados y acumulados actualizados correctamente. INFORESULTADOS PowerBI sincronizado.';

    lastSyncReport = {
      lastRunAt: getBogotaDateParts().isoDateTime,
      status: success ? 'ok' : 'partial_error',
      fechaObjetivo,
      localDbUpdated,
      powerBiSyncedCount: syncedRecords.length,
      powerBiRecords: syncedRecords,
      logs
    };

    return {
      success,
      message,
      ...lastSyncReport
    };
  } finally {
    syncInProgress = false;
  }
}

/**
 * Sincroniza hacia POWERBI.INFORESULTADOS los valores actuales de chatbot.acumulados
 * (Se invoca también cuando un administrador edita manualmente acumulados/baloto/revancha)
 */
export async function sincronizarAcumuladosActualesAPowerBi() {
  const mainPool = getMainPool();
  const [rows] = await mainPool.query('SELECT * FROM acumulados ORDER BY id DESC LIMIT 1');
  if (!rows || rows.length === 0) return [];

  const row = rows[0];
  const fechaObjetivo = getBogotaDateParts().isoDate;
  const balotoBalls = [
    row.resul_baloto1,
    row.resul_baloto2,
    row.resul_baloto3,
    row.resul_baloto4,
    row.resul_baloto5,
    row.resul_baloto6
  ];
  const revanchaBalls = [
    row.resul_revancha1,
    row.resul_revancha2,
    row.resul_revancha3,
    row.resul_revancha4,
    row.resul_revancha5,
    row.resul_revancha6
  ];

  const [resBaloto, serieBaloto] = formatearResultadoYSerie(balotoBalls);
  const [resRevancha, serieRevancha] = formatearResultadoYSerie(revanchaBalls);

  const registros = [
    {
      codigo: '235',
      loteria: 'BALOTO',
      nombrecorto: 'BALOT',
      resultado: resBaloto,
      serie: serieBaloto,
      horacierre: null
    },
    {
      codigo: '2351',
      loteria: 'BALOTO REVANCHA',
      nombrecorto: 'BLTRE',
      resultado: resRevancha,
      serie: serieRevancha,
      horacierre: null
    },
    {
      codigo: '3000',
      loteria: 'ACUMULADO DCH 3CIF',
      nombrecorto: 'DCH3C',
      resultado: row.acum_3cifras,
      serie: '',
      horacierre: null
    },
    {
      codigo: '4000',
      loteria: 'ACUMULADO DCH 4CIF',
      nombrecorto: 'DCH4C',
      resultado: row.acum_4cifras,
      serie: '',
      horacierre: null
    },
    {
      codigo: '5000',
      loteria: 'ACUMULADO CHM 4CIF',
      nombrecorto: 'CHM4C',
      resultado: row.acum_chmillonario,
      serie: '',
      horacierre: null
    }
  ];

  return await sincronizarRegistrosPowerBi(fechaObjetivo, registros);
}
