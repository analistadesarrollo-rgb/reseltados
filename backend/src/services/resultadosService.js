import crypto from 'node:crypto';
import { getMainPool, sanitizeDbError, withRetry } from '../config/db.js';
import { getBogotaDateParts } from '../config/env.js';

export const CODIGOS_LOTERIAS_OFICIALES = [
  10,  // CUN/MARCA (CUNDINAMARCA)
  11,  // TOLIMA
  13,  // CRUZ ROJA
  14,  // HUILA
  17,  // VALLE
  18,  // MANIZALES
  22,  // BOGOTA
  23,  // QUINDIO
  211, // META
  26,  // MEDELLIN
  29,  // RISARALDA
  30,  // SANTANDER
  95,  // SUPERCHON
  33,  // BOYACA
  27,  // CAUCA
  34,  // EXTRA
  52,  // PAISITA SA
  46,  // DORN SAB
  47,  // ASTRO SOL
  48   // ASTRO LUNA
];

export const CODIGOS_SORTEOS_DIARIOS = [
  1,   // CHONTICO TARDE (CHONTICO MILLONARIO)
  62,  // CHONTICO NOCHE
  99,  // CHONTICO FESTIVO
  3,   // DORADO MAÑANA
  51,  // DORADO TARDE
  46,  // DORADO NOCHE (DORN SAB)
  65,  // DORADO FESTIVO
  2,   // PAISITA TARDE (PAISITA DIA)
  8,   // PAISITA NOCHE
  68,  // PAISITA FESTIVO
  7,   // CAFETERITO TARDE (CAFETERITO DIA)
  9,   // CAFETERITO NOCHE
  66,  // CAFETERITO FESTIVO
  5,   // SAMAN TARDE (SAMAN DIA)
  64,  // SAMAN FESTIVO
  167, // CARIBEÑA NOCHE
  168, // CARIBEÑA FESTIVO
  185, // SINUANO TARDE (SINUANO DIA)
  191, // SINUANO NOCHE
  192, // SINUANO FESTIVO
  179, // FANTASTICA NOCHE
  180  // FANTASTICA FESTIVO
];

export const CODIGOS_SEMANALES = {
  3: 'DORADO M',
  1: 'CHON M',
  2: 'PAISITA M',
  7: 'CAFETE D',
  5: 'SAMAN D'
};

const DIAS_SEMANA_ES = [
  'DOMINGO',
  'LUNES',
  'MARTES',
  'MIÉRCOLES',
  'JUEVES',
  'VIERNES',
  'SÁBADO'
];

const MESES_CORTOS_EN = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

const MESES_LARGO_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];

// Caché en memoria del último estado válido para resiliencia ante fallos transitorios
let lastValidPayload = null;
let lastExtraGames = {
  miloto: '',
  colorloto: ''
};

export function setExtraGamesCache({ miloto, colorloto }) {
  if (miloto) lastExtraGames.miloto = miloto;
  if (colorloto) lastExtraGames.colorloto = colorloto;
}

export function getExtraGamesCache() {
  return { ...lastExtraGames };
}

/**
 * Calcula la información de fecha actual y de "ULTIMO SORTEO" en zona horaria America/Bogota,
 * replicando exactamente la lógica de index.php
 */
export function getFechasTablero(now = new Date()) {
  const parts = getBogotaDateParts(now);
  const diaSemanaActual = DIAS_SEMANA_ES[parts.dayOfWeek];
  const mesCorto = MESES_CORTOS_EN[parts.month - 1];
  const fechaActualDisplay = `${parts.dayStr}/${mesCorto}/${parts.yearStr}`;

  // Lógica exacta de index.php para ULTIMO SORTEO (Baloto: Lunes, Miércoles, Sábado)
  let diaSorteoNombre = 'MIÉRCOLES';
  let diasAtras = 1;

  switch (parts.dayOfWeek) {
    case 0: // Sunday -> SÁBADO (1 día atrás)
      diaSorteoNombre = 'SÁBADO';
      diasAtras = 1;
      break;
    case 1: // Monday -> SÁBADO (2 días atrás)
      diaSorteoNombre = 'SÁBADO';
      diasAtras = 2;
      break;
    case 2: // Tuesday -> LUNES (1 día atrás)
      diaSorteoNombre = 'LUNES';
      diasAtras = 1;
      break;
    case 3: // Wednesday -> LUNES (2 días atrás)
      diaSorteoNombre = 'LUNES';
      diasAtras = 2;
      break;
    case 4: // Thursday -> MIÉRCOLES (1 día atrás)
      diaSorteoNombre = 'MIÉRCOLES';
      diasAtras = 1;
      break;
    case 5: // Friday -> MIÉRCOLES (2 días atrás)
      diaSorteoNombre = 'MIÉRCOLES';
      diasAtras = 2;
      break;
    case 6: // Saturday -> MIÉRCOLES (3 días atrás)
      diaSorteoNombre = 'MIÉRCOLES';
      diasAtras = 3;
      break;
  }

  const fechaBaseBogota = new Date(`${parts.isoDate}T12:00:00-05:00`);
  const fechaSorteoDate = new Date(fechaBaseBogota.getTime() - diasAtras * 86400000);
  const sorteoParts = getBogotaDateParts(fechaSorteoDate);

  return {
    diaSemana: diaSemanaActual,
    fechaActual: fechaActualDisplay,
    isoDate: parts.isoDate,
    isoDateTime: parts.isoDateTime,
    ultimoSorteo: {
      diaSemana: diaSorteoNombre,
      diaNumero: sorteoParts.dayStr,
      mesNombre: MESES_LARGO_ES[sorteoParts.month - 1],
      anio: parts.yearStr
    }
  };
}

/**
 * Obtiene todos los datos del tablero principal optimizando las consultas SQL
 * y conservando exactamente la estructura consumida por el frontend original.
 */
export async function obtenerDatosCompletos() {
  const pool = getMainPool();

  try {
    const allCodes = Array.from(
      new Set([...CODIGOS_LOTERIAS_OFICIALES, ...CODIGOS_SORTEOS_DIARIOS])
    );

    // 1. Consulta optimizada en lote para Loterías Oficiales y Sorteos Diarios (última fecha por código)
    const placeholders = allCodes.map(() => '?').join(',');
    const sqlLatestByCode = `
      SELECT r.codigo, r.loteria, r.resultado, r.fecha
      FROM resultados r
      INNER JOIN (
        SELECT codigo, MAX(fecha) AS max_fecha
        FROM resultados
        WHERE codigo IN (${placeholders})
        GROUP BY codigo
      ) m ON r.codigo = m.codigo AND r.fecha = m.max_fecha
    `;

    // 2. Consulta optimizada en lote para Resumen Semanal (códigos 3, 1, 2, 7, 5 y WEEKDAY 0..5)
    const weeklyCodes = Object.keys(CODIGOS_SEMANALES).map(Number);
    const weeklyPlaceholders = weeklyCodes.map(() => '?').join(',');
    const sqlWeekly = `
      SELECT r.codigo, WEEKDAY(r.fecha) AS weekday, r.resultado, r.loteria
      FROM resultados r
      INNER JOIN (
        SELECT codigo, WEEKDAY(fecha) AS weekday, MAX(fecha) AS max_fecha
        FROM resultados
        WHERE codigo IN (${weeklyPlaceholders}) AND WEEKDAY(fecha) BETWEEN 0 AND 5
        GROUP BY codigo, WEEKDAY(fecha)
      ) m ON r.codigo = m.codigo AND WEEKDAY(r.fecha) = m.weekday AND r.fecha = m.max_fecha
    `;

    // 3. Consulta de acumulados y baloto/revancha
    const sqlAcumulados = `
      SELECT *
      FROM acumulados
      ORDER BY id DESC
      LIMIT 1
    `;

    const [[latestRows], [weeklyRows], [acumRows]] = await withRetry(
      () =>
        Promise.all([
          pool.query(sqlLatestByCode, allCodes),
          pool.query(sqlWeekly, weeklyCodes),
          pool.query(sqlAcumulados)
        ]),
      { maxRetries: 2, delayMs: 500, label: 'Consulta de datos principales' }
    );

    const byCodeMap = new Map();
    for (const row of latestRows) {
      byCodeMap.set(Number(row.codigo), {
        loteria: String(row.loteria ?? '').trim(),
        resultado: String(row.resultado ?? '').trim()
      });
    }

    const loteriaOficial = {};
    for (const codigo of CODIGOS_LOTERIAS_OFICIALES) {
      if (byCodeMap.has(codigo)) {
        loteriaOficial[codigo] = byCodeMap.get(codigo);
      }
    }

    const sorteosDiarios = {};
    for (const codigo of CODIGOS_SORTEOS_DIARIOS) {
      if (byCodeMap.has(codigo)) {
        sorteosDiarios[codigo] = byCodeMap.get(codigo);
      }
    }

    const resumenSemanal = {};
    for (const codigo of weeklyCodes) {
      resumenSemanal[codigo] = {
        0: null,
        1: null,
        2: null,
        3: null,
        4: null,
        5: null
      };
    }

    for (const row of weeklyRows) {
      const codigo = Number(row.codigo);
      const weekday = Number(row.weekday);
      if (resumenSemanal[codigo] && weekday >= 0 && weekday <= 5) {
        resumenSemanal[codigo][weekday] = {
          resultado: String(row.resultado ?? '').trim(),
          loteria: String(row.loteria ?? '').trim()
        };
      }
    }

    const acumRow = acumRows[0] || {};
    const trimOrNull = (val) => (val !== undefined && val !== null && String(val).trim() !== '' ? String(val).trim() : null);

    const acumulados = {
      acum_3cifras: trimOrNull(acumRow.acum_3cifras),
      acum_4cifras: trimOrNull(acumRow.acum_4cifras),
      acum_chmillonario: trimOrNull(acumRow.acum_chmillonario),
      acum_baloto: trimOrNull(acumRow.acum_baloto),
      acum_revancha: trimOrNull(acumRow.acum_revancha)
    };

    const baloto = {
      resul_baloto1: trimOrNull(acumRow.resul_baloto1),
      resul_baloto2: trimOrNull(acumRow.resul_baloto2),
      resul_baloto3: trimOrNull(acumRow.resul_baloto3),
      resul_baloto4: trimOrNull(acumRow.resul_baloto4),
      resul_baloto5: trimOrNull(acumRow.resul_baloto5),
      resul_baloto6: trimOrNull(acumRow.resul_baloto6)
    };

    const revancha = {
      resul_revancha1: trimOrNull(acumRow.resul_revancha1),
      resul_revancha2: trimOrNull(acumRow.resul_revancha2),
      resul_revancha3: trimOrNull(acumRow.resul_revancha3),
      resul_revancha4: trimOrNull(acumRow.resul_revancha4),
      resul_revancha5: trimOrNull(acumRow.resul_revancha5),
      resul_revancha6: trimOrNull(acumRow.resul_revancha6)
    };

    const dataPayload = {
      loteriaOficial,
      sorteosDiarios,
      acumulados,
      baloto,
      revancha,
      resumenSemanal,
      extra: {
        miloto: lastExtraGames.miloto || null,
        colorloto: lastExtraGames.colorloto || null
      }
    };

    const hash = crypto
      .createHash('sha1')
      .update(JSON.stringify(dataPayload))
      .digest('hex');

    const fechas = getFechasTablero();

    const response = {
      success: true,
      hash,
      data: dataPayload,
      fechas,
      timestamp: Math.floor(Date.now() / 1000),
      fecha_consulta: fechas.isoDateTime
    };

    lastValidPayload = response;
    return response;
  } catch (err) {
    const safeErr = sanitizeDbError(err);
    // Si falla la BD pero tenemos últimos datos válidos en memoria, los conservamos sin vaciar la pantalla
    if (lastValidPayload) {
      const fechas = getFechasTablero();
      return {
        ...lastValidPayload,
        stale: true,
        warning: `Usando últimos datos válidos en caché (${safeErr})`,
        fechas,
        timestamp: Math.floor(Date.now() / 1000),
        fecha_consulta: fechas.isoDateTime
      };
    }

    return {
      success: false,
      error: safeErr
    };
  }
}

/**
 * Obtiene únicamente la fila más reciente de acumulados (compatible con obtener_resultados.php)
 */
export async function obtenerResultadosAcumulados() {
  const pool = getMainPool();
  const [rows] = await pool.query(
    `SELECT id, resul_baloto1, resul_baloto2, resul_baloto3, resul_baloto4, resul_baloto5, resul_baloto6,
            resul_revancha1, resul_revancha2, resul_revancha3, resul_revancha4, resul_revancha5, resul_revancha6,
            acum_baloto, acum_revancha, acum_chmillonario, acum_3cifras, acum_4cifras, fecha
     FROM acumulados
     ORDER BY id DESC
     LIMIT 1`
  );

  if (!rows || rows.length === 0) {
    return {
      success: false,
      message: 'No se encontraron resultados en la base de datos'
    };
  }

  const row = rows[0];
  return {
    success: true,
    id: row.id,
    resul_baloto1: row.resul_baloto1,
    resul_baloto2: row.resul_baloto2,
    resul_baloto3: row.resul_baloto3,
    resul_baloto4: row.resul_baloto4,
    resul_baloto5: row.resul_baloto5,
    resul_baloto6: row.resul_baloto6,
    resul_revancha1: row.resul_revancha1,
    resul_revancha2: row.resul_revancha2,
    resul_revancha3: row.resul_revancha3,
    resul_revancha4: row.resul_revancha4,
    resul_revancha5: row.resul_revancha5,
    resul_revancha6: row.resul_revancha6,
    acum_baloto: row.acum_baloto,
    acum_revancha: row.acum_revancha,
    acum_chmillonario: row.acum_chmillonario,
    acum_3cifras: row.acum_3cifras,
    acum_4cifras: row.acum_4cifras,
    fecha_actualizacion: row.fecha,
    miloto: lastExtraGames.miloto || null,
    colorloto: lastExtraGames.colorloto || null
  };
}
