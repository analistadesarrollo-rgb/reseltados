import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open as fsOpen, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import oracledb from 'oracledb';
import { getMainPool, sanitizeDbError, withRetry } from '../config/db.js';
import { env, getBogotaDateParts, resolveDataDir } from '../config/env.js';
import { fetchUrlWithRetry } from './scraperService.js';

/**
 * Reglas exactas heredadas de CHATBOT_CONSULTAS_MYSQL.sql (servidor legado 172.20.1.92):
 * - Códigos con serie al final separada por guion (-último_dígito): 1, 10, 13, 17, 22, 26, 27, 63
 * - Códigos Astro (resultado + signo concatenado sin guion): 47 (Astro Sol), 48 (Astro Luna)
 * - Códigos excluidos de chatbot.resultados cuando se lee de API interna: 235, 2351, 245, 273, 3000, 4000, 5000
 */
export const CODIGOS_CON_SERIE_ULTIMO_DIGITO = new Set([1, 10, 13, 17, 22, 26, 27, 63]);
export const CODIGOS_ASTRO = new Set([47, 48]);
export const CODIGOS_EXCLUIDOS_API_INTERNA = new Set([235, 2351, 245, 273, 3000, 4000, 5000]);

const activeEtlLocks = new Set();
const DB_ETL_LOCK_NAME = 'resultados_astro_etl_loterias_lock';
const MAX_LOGS = 60;
const MAX_HISTORY = 20;

let activeDataDir = null;
let stateLoaded = false;

let oracleClientState = {
  initialized: false,
  available: false,
  mode: 'thick',
  libDir: '',
  error: null
};

function createDefaultEtlState() {
  return {
    status: 'idle',
    inProgress: false,
    enabled: env.etl.enabled,
    schedule: getCronExpression(),
    hours: [...env.etl.hours],
    minute: env.etl.minute,
    sourceMode: env.etl.source,
    sourceUsed: null,
    oracleClientReady: false,
    oracleClientError: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastCompletedSlotKey: null,
    lastAttemptedSlotKey: null,
    lastAttemptAtMs: null,
    lastTrigger: null,
    durationMs: null,
    rowsExtracted: 0,
    rowsUpserted: 0,
    datesProcessed: [],
    nextScheduledAt: calcularProximoHorarioEtl(),
    errors: [],
    logs: [],
    history: []
  };
}

let cachedEtlState = createDefaultEtlState();

function getEffectiveDataDir(customDataDir) {
  if (customDataDir) return resolve(customDataDir);
  if (activeDataDir) return activeDataDir;
  return resolveDataDir();
}

function getStateFilePath(dataDir) {
  return join(dataDir, 'etl-loterias-state.json');
}

function getLockFilePath(dataDir) {
  return join(dataDir, 'etl-loterias-lock.json');
}

function sanitizeText(msg) {
  if (!msg) return '';
  let safe = sanitizeDbError(typeof msg === 'string' ? { message: msg } : msg);
  const extraSecrets = [env.sync.syncApiToken, env.carouselAdmin.initialPassword].filter(Boolean);
  for (const sec of extraSecrets) {
    safe = safe.split(sec).join('***');
  }
  return safe;
}

function validarFechaIso(fecha) {
  if (!fecha || typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha.trim())) {
    return false;
  }
  const [y, m, d] = fecha.trim().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function shiftBogotaIsoDate(isoDate, deltaDays) {
  const baseNoon = new Date(`${isoDate}T12:00:00-05:00`);
  const shifted = new Date(baseNoon.getTime() + deltaDays * 86400000);
  return getBogotaDateParts(shifted).isoDate;
}

/**
 * Devuelve la expresión cron equivalente en zona America/Bogota (por defecto "24 1,11,12,13,16,19,21,23 * * *")
 */
export function getCronExpression(hours = env.etl.hours, minute = env.etl.minute) {
  return `${minute} ${hours.join(',')} * * *`;
}

/**
 * Calcula la franja programada más reciente que ya debería haberse ejecutado (<= hora actual en America/Bogota)
 */
export function getMostRecentDueSlot(
  now = new Date(),
  { hours = env.etl.hours, minute = env.etl.minute } = {}
) {
  const sortedHours = [...hours].sort((a, b) => a - b);
  const bogota = getBogotaDateParts(now);
  const currentMins = Number.parseInt(bogota.hour, 10) * 60 + Number.parseInt(bogota.minute, 10);

  let slotHour = null;
  for (const h of sortedHours) {
    if (h * 60 + minute <= currentMins) {
      slotHour = h;
    }
  }

  let slotDate = bogota.isoDate;
  if (slotHour === null) {
    slotDate = shiftBogotaIsoDate(bogota.isoDate, -1);
    slotHour = sortedHours[sortedHours.length - 1];
  }

  const hh = String(slotHour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const slotKey = `${slotDate} ${hh}:${mm}`;
  const scheduledAt = `${slotKey}:00`;
  const scheduledAtMs = Date.parse(`${slotDate}T${hh}:${mm}:00-05:00`);

  return {
    date: slotDate,
    hour: slotHour,
    minute,
    slotKey,
    scheduledAt,
    scheduledAtMs
  };
}

/**
 * Calcula la próxima ejecución programada en formato YYYY-MM-DD HH:MM:00 (America/Bogota)
 */
export function calcularProximoHorarioEtl(
  now = new Date(),
  { hours = env.etl.hours, minute = env.etl.minute } = {}
) {
  const sortedHours = [...hours].sort((a, b) => a - b);
  const bogota = getBogotaDateParts(now);
  const currentMins = Number.parseInt(bogota.hour, 10) * 60 + Number.parseInt(bogota.minute, 10);

  let nextHour = null;
  for (const h of sortedHours) {
    if (h * 60 + minute > currentMins) {
      nextHour = h;
      break;
    }
  }

  let nextDate = bogota.isoDate;
  if (nextHour === null) {
    nextDate = shiftBogotaIsoDate(bogota.isoDate, 1);
    nextHour = sortedHours[0];
  }

  const hh = String(nextHour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `${nextDate} ${hh}:${mm}:00`;
}

/**
 * Aplica exactamente el formateo heredado de CHATBOT_CONSULTAS_MYSQL.sql según el código de lotería.
 */
export function formatLotteryResult(codigo, resultadoRaw, serieRaw = '') {
  const codigoNum = Number.parseInt(String(codigo), 10);
  const resultado = String(resultadoRaw ?? '').trim();
  const serie = String(serieRaw ?? '').trim();

  if (!resultado) {
    return '';
  }

  if (CODIGOS_CON_SERIE_ULTIMO_DIGITO.has(codigoNum)) {
    if (resultado.includes('-')) {
      return resultado;
    }
    const lastDigit = serie ? serie.slice(-1) : '';
    return `${resultado}-${lastDigit}`;
  }

  if (CODIGOS_ASTRO.has(codigoNum)) {
    if (/[A-Za-z]{2,3}$/.test(resultado)) {
      return resultado;
    }
    return `${resultado}${serie}`;
  }

  return resultado;
}

/**
 * Valida y trunca un registro conforme al esquema real de MariaDB chatbot.resultados:
 * fecha DATE NOT NULL, codigo INT NOT NULL, loteria VARCHAR(30), resultado VARCHAR(10), version VARCHAR(20)
 */
export function normalizeResultadoRow({
  fecha,
  codigo,
  loteria,
  resultado,
  serie = '',
  version = env.etl.version
}) {
  const fechaStr = String(fecha ?? '').trim().slice(0, 10);
  const codigoNum = Number.parseInt(String(codigo ?? ''), 10);

  if (!validarFechaIso(fechaStr) || !Number.isInteger(codigoNum) || codigoNum <= 0) {
    return null;
  }

  const formatted = formatLotteryResult(codigoNum, resultado, serie).trim().slice(0, 10);
  if (!formatted) {
    return null;
  }

  const loteriaName = String(loteria ?? '').trim().slice(0, 30);
  const versionTag = String(version ?? '0').trim().slice(0, 20) || '0';

  return {
    fecha: fechaStr,
    codigo: codigoNum,
    loteria: loteriaName,
    resultado: formatted,
    version: versionTag
  };
}

/**
 * Inicializa Oracle Instant Client en modo Thick (obligatorio para Oracle 11g 11.2.0.4.0)
 * sin fallar en el arranque si el entorno actual no dispone de binarios nativos de Instant Client.
 */
export function ensureOracleThickClient() {
  if (oracleClientState.initialized) {
    return { ...oracleClientState };
  }

  const configuredDir = env.dbOracle.libDir ? resolve(env.dbOracle.libDir) : '';

  if (configuredDir) {
    const clientMarkers = ['libclntsh.so', 'libclntsh.so.11.1', 'oci.dll', 'libclntsh.dylib'];
    const hasNativeBinary =
      existsSync(configuredDir) && clientMarkers.some((name) => existsSync(join(configuredDir, name)));

    if (!hasNativeBinary) {
      oracleClientState = {
        initialized: true,
        available: false,
        mode: 'thick',
        libDir: configuredDir,
        error: `Binarios de Oracle Instant Client no encontrados en ${configuredDir}`
      };
      return { ...oracleClientState };
    }
  }

  try {
    if (configuredDir) {
      oracledb.initOracleClient({ libDir: configuredDir });
    } else {
      oracledb.initOracleClient();
    }
    oracleClientState = {
      initialized: true,
      available: true,
      mode: 'thick',
      libDir: configuredDir || 'system',
      error: null
    };
  } catch (err) {
    oracleClientState = {
      initialized: true,
      available: false,
      mode: 'thick',
      libDir: configuredDir || 'system',
      error: sanitizeText(err)
    };
  }

  return { ...oracleClientState };
}

export function getOracleSourceDiagnostics() {
  const diag = ensureOracleThickClient();
  const configured = Boolean(
    env.dbOracle.user && env.dbOracle.password && env.dbOracle.connectString
  );
  return {
    configured,
    connectString: env.dbOracle.connectString || null,
    mode: diag.mode,
    libDir: diag.libDir || null,
    clientReady: diag.available,
    clientError: diag.error
  };
}

/**
 * Extrae los resultados de ayer (SYSDATE-1) y hoy (SYSDATE) directamente desde Oracle 11g (modo Thick),
 * replicando exactamente la consulta y reglas de CHATBOT_CONSULTAS_MYSQL.sql.
 */
export async function extraerDesdeOracle(logs = []) {
  if (!env.dbOracle.user || !env.dbOracle.password || !env.dbOracle.connectString) {
    throw new Error('Credenciales Oracle (DB_ORACLE_USER/PASSWORD/CONNECT_STRING) no configuradas.');
  }

  const clientDiag = ensureOracleThickClient();
  if (!clientDiag.available) {
    throw new Error(
      `Oracle Instant Client (Thick Mode para 11g) no disponible: ${clientDiag.error || 'sin detalle'}`
    );
  }

  const sqlOracle = `
    SELECT
      TO_CHAR(rl.fechasorteo, 'YYYY-MM-DD') AS FECHA,
      rl.ltry_codigo AS CODIGO,
      TRIM(lo.nombre) AS LOTERIA,
      TRIM(rl.resultado) AS RESULTADO,
      TRIM(rl.serieresultado) AS SERIERESULTADO
    FROM resultadosloteries rl
    INNER JOIN loteries lo ON lo.codigo = rl.ltry_codigo
    WHERE TRUNC(rl.fechasorteo) IN (TRUNC(SYSDATE - 1), TRUNC(SYSDATE))
      AND rl.resultado IS NOT NULL
    ORDER BY rl.fechasorteo ASC, rl.ltry_codigo ASC
  `;

  let conn;
  try {
    conn = await oracledb.getConnection({
      user: env.dbOracle.user,
      password: env.dbOracle.password,
      connectString: env.dbOracle.connectString,
      connectTimeout: Math.max(5, Math.ceil(env.dbOracle.connectTimeoutMs / 1000))
    });

    const result = await conn.execute(sqlOracle, [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    const rawRows = Array.isArray(result?.rows) ? result.rows : [];
    const normalized = [];
    for (const r of rawRows) {
      const row = normalizeResultadoRow({
        fecha: r.FECHA,
        codigo: r.CODIGO,
        loteria: r.LOTERIA,
        resultado: r.RESULTADO,
        serie: r.SERIERESULTADO,
        version: env.etl.version
      });
      if (row) normalized.push(row);
    }

    logs.push(
      `Oracle 11g (${env.dbOracle.connectString}): ${rawRows.length} filas leídas, ${normalized.length} válidas normalizadas.`
    );
    return normalized;
  } finally {
    if (conn) {
      await conn.close().catch(() => {});
    }
  }
}

/**
 * Extrae resultados de ayer y hoy desde la API interna corporativa (paridad 1-a-1 con Oracle para loterías),
 * filtrando códigos especiales de acumulados/Baloto y manejando HTTP 404 cuando aún no hay sorteos en la fecha.
 */
export async function extraerDesdeApiInterna(logs = [], now = new Date()) {
  const baseUrl = env.scraper.apiResultadosBaseUrl;
  if (!baseUrl) {
    throw new Error('API_RESULTADOS_BASE_URL no configurada para respaldo del ETL.');
  }

  const todayIso = getBogotaDateParts(now).isoDate;
  const yesterdayIso = shiftBogotaIsoDate(todayIso, -1);
  const dates = [yesterdayIso, todayIso];

  const fetchForDate = async (fecha) => {
    const url = `${baseUrl}?fecha=${encodeURIComponent(fecha)}`;
    try {
      const raw = await fetchUrlWithRetry(url, `ETL API Interna (${fecha})`);
      const json = JSON.parse(raw);
      if (!json || !json.success || !Array.isArray(json.data)) {
        return { fecha, rows: [], noData: true };
      }
      return { fecha, rows: json.data, noData: false };
    } catch (err) {
      if (/HTTP 404/i.test(String(err?.message))) {
        return { fecha, rows: [], noData: true };
      }
      throw err;
    }
  };

  const settled = await Promise.allSettled(dates.map(fetchForDate));
  const combined = new Map();
  let networkFailures = 0;
  let lastErrorMsg = '';

  for (let i = 0; i < settled.length; i++) {
    const dateStr = dates[i];
    const outcome = settled[i];

    if (outcome.status === 'rejected') {
      networkFailures++;
      lastErrorMsg = sanitizeText(outcome.reason);
      logs.push(`ADVERTENCIA API interna (${dateStr}): ${lastErrorMsg}`);
      continue;
    }

    const { rows, noData } = outcome.value;
    if (noData || rows.length === 0) {
      logs.push(`API interna (${dateStr}): sin resultados publicados aún.`);
      continue;
    }

    let keptForDate = 0;
    for (const item of rows) {
      const codigoNum = Number.parseInt(String(item.codigoloteria ?? ''), 10);
      if (!Number.isInteger(codigoNum) || CODIGOS_EXCLUIDOS_API_INTERNA.has(codigoNum)) {
        continue;
      }

      const normalized = normalizeResultadoRow({
        fecha: item.fecha || dateStr,
        codigo: codigoNum,
        loteria: item.nombreloteria,
        resultado: item.resultado,
        serie: item.serie,
        version: env.etl.version
      });

      if (normalized) {
        combined.set(`${normalized.fecha}|${normalized.codigo}`, normalized);
        keptForDate++;
      }
    }

    logs.push(`API interna (${dateStr}): ${rows.length} recibidos, ${keptForDate} de loterías/sorteos válidos.`);
  }

  if (networkFailures === dates.length) {
    throw new Error(`Todas las consultas a API interna fallaron: ${lastErrorMsg}`);
  }

  return Array.from(combined.values());
}

/**
 * Inserta o actualiza atómicamente un resultado en chatbot.resultados respetando UNIQUE KEY (fecha, codigo).
 */
export async function upsertResultadoLoteria(connectionOrPool, record) {
  const row = normalizeResultadoRow(record);
  if (!row) {
    throw new Error('Registro inválido al intentar guardar en chatbot.resultados');
  }

  const sql = `
    INSERT INTO resultados (fecha, codigo, loteria, resultado, version)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      loteria = VALUES(loteria),
      resultado = VALUES(resultado),
      version = VALUES(version)
  `;

  const [execRes] = await connectionOrPool.execute(sql, [
    row.fecha,
    row.codigo,
    row.loteria,
    row.resultado,
    row.version
  ]);

  return { row, affectedRows: Number(execRes?.affectedRows || 0) };
}

/**
 * Persiste un lote de resultados en chatbot.resultados dentro de una transacción con reintentos.
 */
export async function guardarResultadosEnBdPrincipal(registros, { mainPool = null } = {}) {
  const dedupMap = new Map();
  for (const item of registros) {
    const normalized = normalizeResultadoRow(item);
    if (normalized) {
      dedupMap.set(`${normalized.fecha}|${normalized.codigo}`, normalized);
    }
  }

  const rows = Array.from(dedupMap.values());
  if (rows.length === 0) {
    return { upsertedCount: 0, insertedCount: 0, updatedCount: 0, dates: [] };
  }

  const pool = mainPool || getMainPool();
  return await withRetry(
    async () => {
      const conn = await pool.getConnection();
      let insertedCount = 0;
      let updatedCount = 0;
      const dateSet = new Set();
      try {
        await conn.beginTransaction();
        for (const item of rows) {
          const { affectedRows, row } = await upsertResultadoLoteria(conn, item);
          dateSet.add(row.fecha);
          if (affectedRows === 1) insertedCount++;
          else if (affectedRows >= 2) updatedCount++;
        }
        await conn.commit();
        return {
          upsertedCount: rows.length,
          insertedCount,
          updatedCount,
          dates: Array.from(dateSet).sort()
        };
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    { maxRetries: 2, delayMs: 500, label: 'Upsert ETL chatbot.resultados' }
  );
}

async function readStateFile(dataDir) {
  const filePath = getStateFilePath(dataDir);
  try {
    if (!existsSync(filePath)) return null;
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function persistStateFile(dataDir, state) {
  await mkdir(dataDir, { recursive: true });
  const filePath = getStateFilePath(dataDir);
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmpPath, filePath);
}

async function isPersistentLockActive(dataDir) {
  const lockPath = getLockFilePath(dataDir);
  if (activeEtlLocks.has(lockPath)) return true;
  if (!existsSync(lockPath)) return false;

  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Boolean(parsed && parsed.expiresAtMs && parsed.expiresAtMs > Date.now());
  } catch {
    return false;
  }
}

async function acquireEtlLock({
  trigger = 'manual',
  dataDir,
  lockTtlMs = env.etl.lockTtlMs,
  useDbLock = true
} = {}) {
  const lockPath = getLockFilePath(dataDir);

  if (activeEtlLocks.has(lockPath)) {
    return { acquired: false, reason: 'in_process_active' };
  }
  activeEtlLocks.add(lockPath);

  const ownerId = crypto.randomBytes(12).toString('hex');
  const warnings = [];
  let fileAcquired = false;
  let dbConn = null;

  try {
    await mkdir(dataDir, { recursive: true });
    const now = Date.now();
    const lockPayload = JSON.stringify({
      ownerId,
      pid: process.pid,
      trigger,
      acquiredAtMs: now,
      expiresAtMs: now + lockTtlMs
    });

    const tryCreateExclusive = async () => {
      const fh = await fsOpen(lockPath, 'wx');
      try {
        await fh.writeFile(lockPayload, 'utf8');
      } finally {
        await fh.close();
      }
    };

    try {
      await tryCreateExclusive();
      fileAcquired = true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      let stale = false;
      try {
        const existingRaw = await readFile(lockPath, 'utf8');
        const existing = JSON.parse(existingRaw);
        if (!existing?.expiresAtMs || existing.expiresAtMs <= Date.now()) {
          stale = true;
        }
      } catch {
        stale = true;
      }

      if (!stale) {
        activeEtlLocks.delete(lockPath);
        return { acquired: false, reason: 'persistent_lock_active' };
      }

      await unlink(lockPath).catch(() => {});
      try {
        await tryCreateExclusive();
        fileAcquired = true;
        warnings.push('ADVERTENCIA: Se recuperó un bloqueo ETL expirado.');
      } catch (retryErr) {
        if (retryErr?.code === 'EEXIST') {
          activeEtlLocks.delete(lockPath);
          return { acquired: false, reason: 'persistent_lock_race' };
        }
        throw retryErr;
      }
    }

    if (useDbLock) {
      try {
        dbConn = await getMainPool().getConnection();
        const [rows] = await dbConn.query('SELECT GET_LOCK(?, 0) AS acquired', [DB_ETL_LOCK_NAME]);
        const gotDbLock = Number(rows?.[0]?.acquired) === 1;
        if (!gotDbLock) {
          dbConn.release();
          dbConn = null;
          if (fileAcquired) {
            await unlink(lockPath).catch(() => {});
          }
          activeEtlLocks.delete(lockPath);
          return { acquired: false, reason: 'distributed_db_lock_active' };
        }
      } catch (err) {
        if (dbConn) {
          dbConn.release();
          dbConn = null;
        }
        warnings.push(
          `ADVERTENCIA: Bloqueo distribuido en MariaDB no disponible para ETL (${sanitizeText(err)}); usando lock local.`
        );
      }
    }

    return { acquired: true, lockPath, ownerId, dbConn, warnings };
  } catch (err) {
    if (dbConn) dbConn.release();
    if (fileAcquired) await unlink(lockPath).catch(() => {});
    activeEtlLocks.delete(lockPath);
    throw err;
  }
}

async function releaseEtlLock(handle) {
  if (!handle || !handle.acquired) return;
  try {
    if (handle.dbConn) {
      await handle.dbConn.query('SELECT RELEASE_LOCK(?)', [DB_ETL_LOCK_NAME]).catch(() => {});
      handle.dbConn.release();
    }
  } finally {
    try {
      if (existsSync(handle.lockPath)) {
        const raw = await readFile(handle.lockPath, 'utf8').catch(() => '');
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || parsed.ownerId === handle.ownerId) {
          await unlink(handle.lockPath).catch(() => {});
        }
      }
    } catch {
      await unlink(handle.lockPath).catch(() => {});
    } finally {
      activeEtlLocks.delete(handle.lockPath);
    }
  }
}

/**
 * Inicializa estado persistente del ETL en disco al arrancar el backend.
 */
export async function initEtlState(options = {}) {
  const dataDir = getEffectiveDataDir(options.dataDir);
  activeDataDir = dataDir;
  await mkdir(dataDir, { recursive: true });

  const diskState = await readStateFile(dataDir);
  const lockActive = await isPersistentLockActive(dataDir);
  const base = createDefaultEtlState();
  const oracleDiag = ensureOracleThickClient();

  cachedEtlState = {
    ...base,
    ...(diskState || {}),
    enabled: env.etl.enabled,
    schedule: getCronExpression(),
    hours: [...env.etl.hours],
    minute: env.etl.minute,
    sourceMode: env.etl.source,
    oracleClientReady: oracleDiag.available,
    oracleClientError: oracleDiag.error,
    inProgress: lockActive,
    status: diskState?.status === 'running' && !lockActive ? 'partial' : diskState?.status || 'idle',
    nextScheduledAt: calcularProximoHorarioEtl()
  };

  stateLoaded = true;
  await persistStateFile(dataDir, cachedEtlState);
  return getEtlStatus({ dataDir });
}

export function getEtlStatus(options = {}) {
  const dataDir = getEffectiveDataDir(options.dataDir);
  const lockPath = getLockFilePath(dataDir);
  const running = activeEtlLocks.has(lockPath) || Boolean(cachedEtlState.inProgress);
  const oracleDiag = getOracleSourceDiagnostics();

  return {
    ...cachedEtlState,
    inProgress: running,
    timezone: 'America/Bogota',
    enabled: env.etl.enabled,
    schedule: getCronExpression(),
    hours: [...env.etl.hours],
    minute: env.etl.minute,
    sourceMode: env.etl.source,
    oracleClientReady: oracleDiag.clientReady,
    oracleClientError: oracleDiag.clientError,
    oracleConfigured: oracleDiag.configured,
    nextScheduledAt: calcularProximoHorarioEtl(),
    currentSlotKey: getMostRecentDueSlot().slotKey
  };
}

/**
 * Ejecuta el ETL completo de Loterías Oficiales, Sorteos Diarios y Resumen Semanal -> chatbot.resultados.
 */
export async function ejecutarEtlResultados({
  trigger = 'manual',
  slotKey = null,
  _dataDir = null,
  _injectDeps = null
} = {}) {
  const dataDir = getEffectiveDataDir(_dataDir);
  if (!stateLoaded && !activeDataDir) {
    await initEtlState({ dataDir });
  }

  let lockHandle;
  try {
    lockHandle = await acquireEtlLock({
      trigger,
      dataDir,
      useDbLock: _injectDeps?.useDbLock ?? true,
      lockTtlMs: _injectDeps?.lockTtlMs ?? env.etl.lockTtlMs
    });
  } catch (err) {
    return {
      success: false,
      alreadyRunning: false,
      message: `No se pudo adquirir bloqueo del ETL de loterías: ${sanitizeText(err)}`,
      ...getEtlStatus({ dataDir })
    };
  }

  if (!lockHandle.acquired) {
    return {
      success: true,
      alreadyRunning: true,
      message: 'Ya existe una ejecución del ETL de loterías en progreso.',
      ...getEtlStatus({ dataDir })
    };
  }

  const t0 = Date.now();
  const logs = [...(lockHandle.warnings || [])];
  const errors = [];
  const bogotaNow = getBogotaDateParts();
  const effectiveSlotKey = slotKey || getMostRecentDueSlot().slotKey;

  cachedEtlState = {
    ...cachedEtlState,
    inProgress: true,
    status: 'running',
    lastTrigger: trigger,
    lastAttemptedSlotKey: effectiveSlotKey,
    lastAttemptAtMs: t0
  };
  await persistStateFile(dataDir, cachedEtlState).catch(() => {});

  try {
    const sourceMode = (_injectDeps?.sourceMode || env.etl.source || 'auto').toLowerCase();
    const extractOracleFn = _injectDeps?.extraerDesdeOracle || extraerDesdeOracle;
    const extractApiFn = _injectDeps?.extraerDesdeApiInterna || extraerDesdeApiInterna;
    const saveFn = _injectDeps?.guardarResultadosEnBdPrincipal || guardarResultadosEnBdPrincipal;

    logs.push(
      `[${bogotaNow.isoDateTime}] Iniciando ETL de loterías (${trigger}, franja ${effectiveSlotKey}, modo=${sourceMode}).`
    );

    let extractedRows = [];
    let sourceUsed = null;
    let usedFallback = false;

    if (sourceMode === 'oracle') {
      extractedRows = await extractOracleFn(logs);
      sourceUsed = 'oracle';
    } else if (sourceMode === 'api') {
      extractedRows = await extractApiFn(logs);
      sourceUsed = 'internal_api';
    } else {
      // Modo auto: Oracle 11g (Thick Mode) primario con respaldo automático en API interna
      try {
        extractedRows = await extractOracleFn(logs);
        sourceUsed = 'oracle';
      } catch (oracleErr) {
        usedFallback = true;
        logs.push(
          `ADVERTENCIA Oracle 11g no disponible (${sanitizeText(oracleErr)}). Activando respaldo API interna.`
        );
        extractedRows = await extractApiFn(logs);
        sourceUsed = 'internal_api';
      }
    }

    let dbSaveResult = { upsertedCount: 0, insertedCount: 0, updatedCount: 0, dates: [] };
    if (extractedRows.length > 0) {
      dbSaveResult = await saveFn(extractedRows, { mainPool: _injectDeps?.mainPool });
      logs.push(
        `ÉXITO MariaDB chatbot.resultados: ${dbSaveResult.upsertedCount} procesados (${dbSaveResult.insertedCount} nuevos, ${dbSaveResult.updatedCount} actualizados) para fechas [${dbSaveResult.dates.join(', ')}].`
      );
    } else {
      logs.push('Información: Sin filas nuevas para guardar en chatbot.resultados en esta ejecución.');
    }

    const finishedMs = Date.now();
    const finishedBogota = getBogotaDateParts(new Date(finishedMs)).isoDateTime;
    const durationMs = finishedMs - t0;
    const status = usedFallback ? 'completed_fallback' : 'completed';

    const historyEntry = {
      runAt: finishedBogota,
      slotKey: effectiveSlotKey,
      trigger,
      status,
      sourceUsed,
      rowsExtracted: extractedRows.length,
      rowsUpserted: dbSaveResult.upsertedCount,
      durationMs,
      errors: []
    };

    cachedEtlState = {
      ...cachedEtlState,
      status,
      inProgress: false,
      sourceUsed,
      lastRunAt: finishedBogota,
      lastSuccessAt: finishedBogota,
      lastCompletedSlotKey: effectiveSlotKey,
      lastAttemptedSlotKey: effectiveSlotKey,
      lastAttemptAtMs: finishedMs,
      lastTrigger: trigger,
      durationMs,
      rowsExtracted: extractedRows.length,
      rowsUpserted: dbSaveResult.upsertedCount,
      datesProcessed: dbSaveResult.dates,
      nextScheduledAt: calcularProximoHorarioEtl(new Date(finishedMs)),
      errors: [],
      logs: logs.slice(-MAX_LOGS),
      history: [historyEntry, ...(cachedEtlState.history || [])].slice(0, MAX_HISTORY)
    };

    return {
      success: true,
      alreadyRunning: false,
      message: `ETL completado (${sourceUsed}): ${dbSaveResult.upsertedCount} registros procesados en chatbot.resultados.`,
      ...getEtlStatus({ dataDir })
    };
  } catch (err) {
    const safeErr = sanitizeText(err);
    const finishedMs = Date.now();
    const finishedBogota = getBogotaDateParts(new Date(finishedMs)).isoDateTime;
    const durationMs = finishedMs - t0;

    errors.push(safeErr);
    logs.push(`ERROR ETL de loterías: ${safeErr}`);

    const historyEntry = {
      runAt: finishedBogota,
      slotKey: effectiveSlotKey,
      trigger,
      status: 'error',
      sourceUsed: null,
      rowsExtracted: 0,
      rowsUpserted: 0,
      durationMs,
      errors: [...errors]
    };

    cachedEtlState = {
      ...cachedEtlState,
      status: 'error',
      inProgress: false,
      lastRunAt: finishedBogota,
      lastAttemptedSlotKey: effectiveSlotKey,
      lastAttemptAtMs: finishedMs,
      lastTrigger: trigger,
      durationMs,
      nextScheduledAt: calcularProximoHorarioEtl(new Date(finishedMs)),
      errors,
      logs: logs.slice(-MAX_LOGS),
      history: [historyEntry, ...(cachedEtlState.history || [])].slice(0, MAX_HISTORY)
    };

    return {
      success: false,
      alreadyRunning: false,
      message: `Error ejecutando ETL de loterías: ${safeErr}`,
      ...getEtlStatus({ dataDir })
    };
  } finally {
    cachedEtlState.inProgress = false;
    await persistStateFile(dataDir, cachedEtlState).catch(() => {});
    await releaseEtlLock(lockHandle).catch(() => {});
  }
}

/**
 * Evalúa si ya corresponde ejecutar el ETL de loterías según el horario exacto
 * (por defecto "24 1,11,12,13,16,19,21,23 * * *" en America/Bogota).
 */
export async function evaluarYEjecutarEtlSiCorresponde({
  trigger = 'scheduler',
  blocking = false,
  now = new Date(),
  _dataDir = null,
  _injectDeps = null
} = {}) {
  const dataDir = getEffectiveDataDir(_dataDir);
  if (!stateLoaded && !activeDataDir) {
    await initEtlState({ dataDir });
  }

  if (!env.etl.enabled && !_injectDeps?.forceEnabled) {
    return {
      triggered: false,
      reason: 'disabled',
      inProgress: false,
      ...getEtlStatus({ dataDir })
    };
  }

  if (await isPersistentLockActive(dataDir)) {
    return {
      triggered: false,
      alreadyRunning: true,
      reason: 'already_running',
      inProgress: true,
      ...getEtlStatus({ dataDir })
    };
  }

  const dueSlot = getMostRecentDueSlot(now);
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const retryCooldownMs = _injectDeps?.retryCooldownMs ?? env.etl.retryCooldownMs;

  if (cachedEtlState.lastCompletedSlotKey === dueSlot.slotKey) {
    return {
      triggered: false,
      reason: 'not_due',
      inProgress: false,
      currentSlotKey: dueSlot.slotKey,
      nextScheduledAt: calcularProximoHorarioEtl(now),
      status: cachedEtlState.status
    };
  }

  if (
    cachedEtlState.lastAttemptedSlotKey === dueSlot.slotKey &&
    cachedEtlState.lastAttemptAtMs &&
    nowMs - cachedEtlState.lastAttemptAtMs < retryCooldownMs
  ) {
    return {
      triggered: false,
      reason: 'retry_cooldown',
      inProgress: false,
      currentSlotKey: dueSlot.slotKey,
      nextScheduledAt: calcularProximoHorarioEtl(now),
      status: cachedEtlState.status
    };
  }

  const runPromise = ejecutarEtlResultados({
    trigger,
    slotKey: dueSlot.slotKey,
    _dataDir: dataDir,
    _injectDeps
  });

  if (blocking) {
    const result = await runPromise;
    return {
      triggered: !result.alreadyRunning,
      reason: 'schedule_due',
      ...result
    };
  }

  runPromise.catch(() => {});
  return {
    triggered: true,
    background: true,
    reason: 'schedule_due',
    currentSlotKey: dueSlot.slotKey,
    inProgress: true,
    status: cachedEtlState.status
  };
}
