import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open as fsOpen, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getMainPool, getPowerBiPool, sanitizeDbError, withRetry } from '../config/db.js';
import { env, getBogotaDateParts, resolveDataDir } from '../config/env.js';
import { setExtraGamesCache } from './resultadosService.js';
import { extraerFuentesExternas, obtenerResultadoDesdeApiInterna } from './scraperService.js';

const activeInProcessLocks = new Set();
const DB_LOCK_NAME = 'resultados_astro_sync_lock';
const MAX_LOGS = 80;
const MAX_HISTORY = 20;

function createDefaultState() {
  return {
    status: 'idle',
    inProgress: false,
    syncInProgress: false,
    lastRunAt: null,
    lastSuccessAt: null,
    lastSuccessAtMs: null,
    lastPowerBiSyncAt: null,
    lastPowerBiRetryAttemptMs: null,
    lastTrigger: null,
    durationMs: null,
    fechaObjetivo: null,
    localDbUpdated: false,
    powerBiSyncedCount: 0,
    powerBiVerifiedCount: 0,
    powerBiPendingRetry: false,
    pendingPowerBi: null,
    powerBiRecords: [],
    databases: {
      mainDb: { status: 'unknown', updated: false, error: null },
      powerBiDb: {
        status: 'unknown',
        syncedCount: 0,
        verifiedCount: 0,
        pendingRetry: false,
        error: null
      }
    },
    errors: [],
    logs: [],
    history: [],
    intervalMs: env.sync.autoSyncIntervalMs,
    nextScheduledAt: null,
    nextPowerBiRetryAt: null
  };
}

let activeDataDir = null;
let cachedSyncState = createDefaultState();
let stateLoaded = false;

function getEffectiveDataDir(customDataDir) {
  if (customDataDir) return resolve(customDataDir);
  if (activeDataDir) return activeDataDir;
  return resolveDataDir();
}

function getStateFilePath(dataDir) {
  return join(dataDir, 'sync-state.json');
}

function getLockFilePath(dataDir) {
  return join(dataDir, 'sync-lock.json');
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

function formatBogotaFromMs(ms) {
  if (!ms || !Number.isFinite(ms)) return null;
  return getBogotaDateParts(new Date(ms)).isoDateTime;
}

function computeNextScheduledAt(state, intervalMs = env.sync.autoSyncIntervalMs) {
  const baseMs = state.lastSuccessAtMs || Date.now();
  return formatBogotaFromMs(baseMs + intervalMs);
}

function computeNextPowerBiRetryAt(state, cooldownMs = env.sync.powerBiRetryCooldownMs) {
  if (!state.powerBiPendingRetry) return null;
  const baseMs = state.lastPowerBiRetryAttemptMs || Date.now();
  return formatBogotaFromMs(baseMs + cooldownMs);
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
  if (activeInProcessLocks.has(lockPath)) return true;
  if (!existsSync(lockPath)) return false;

  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Boolean(parsed && parsed.expiresAtMs && parsed.expiresAtMs > Date.now());
  } catch {
    return false;
  }
}

/**
 * Carga el estado persistente al iniciar el backend para recuperarse tras reinicios.
 */
export async function initSyncState(options = {}) {
  const dataDir = getEffectiveDataDir(options.dataDir);
  activeDataDir = dataDir;
  await mkdir(dataDir, { recursive: true });

  const diskState = await readStateFile(dataDir);
  const lockActive = await isPersistentLockActive(dataDir);
  const base = createDefaultState();

  cachedSyncState = {
    ...base,
    ...(diskState || {}),
    inProgress: lockActive,
    syncInProgress: lockActive,
    intervalMs: env.sync.autoSyncIntervalMs,
    status:
      diskState?.status === 'running' && !lockActive
        ? diskState?.pendingPowerBi
          ? 'powerbi_db_error'
          : 'partial'
        : diskState?.status || 'idle',
    databases: {
      mainDb: {
        ...base.databases.mainDb,
        ...(diskState?.databases?.mainDb || {})
      },
      powerBiDb: {
        ...base.databases.powerBiDb,
        ...(diskState?.databases?.powerBiDb || {})
      }
    }
  };

  cachedSyncState.powerBiPendingRetry = Boolean(cachedSyncState.pendingPowerBi);
  cachedSyncState.nextScheduledAt = computeNextScheduledAt(cachedSyncState);
  cachedSyncState.nextPowerBiRetryAt = computeNextPowerBiRetryAt(cachedSyncState);
  stateLoaded = true;

  await persistStateFile(dataDir, cachedSyncState);
  return getSyncStatus({ dataDir });
}

export function getSyncStatus(options = {}) {
  const dataDir = getEffectiveDataDir(options.dataDir);
  const lockPath = getLockFilePath(dataDir);
  const running = activeInProcessLocks.has(lockPath) || Boolean(cachedSyncState.inProgress);

  const safeStatus = {
    ...cachedSyncState,
    inProgress: running,
    syncInProgress: running,
    timezone: 'America/Bogota',
    intervalMs: env.sync.autoSyncIntervalMs,
    nextScheduledAt: computeNextScheduledAt(cachedSyncState),
    nextPowerBiRetryAt: computeNextPowerBiRetryAt(cachedSyncState),
    pendingPowerBiFecha: cachedSyncState.pendingPowerBi?.fechaObjetivo || null,
    pendingPowerBiCount: cachedSyncState.pendingPowerBi?.registros?.length || 0
  };
  delete safeStatus.pendingPowerBi;
  return safeStatus;
}

async function acquireSyncLock({ trigger = 'manual', dataDir, lockTtlMs = env.sync.lockTtlMs, useDbLock = true } = {}) {
  const lockPath = getLockFilePath(dataDir);

  // Guard síncrono en el mismo tick de eventos para evitar carrera entre peticiones paralelas
  if (activeInProcessLocks.has(lockPath)) {
    return { acquired: false, reason: 'in_process_active' };
  }
  activeInProcessLocks.add(lockPath);

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
        activeInProcessLocks.delete(lockPath);
        return { acquired: false, reason: 'persistent_lock_active' };
      }

      // Reclamar lock vencido de un proceso anterior interrumpido
      await unlink(lockPath).catch(() => {});
      try {
        await tryCreateExclusive();
        fileAcquired = true;
        warnings.push('ADVERTENCIA: Se recuperó un bloqueo de sincronización expirado.');
      } catch (retryErr) {
        if (retryErr?.code === 'EEXIST') {
          activeInProcessLocks.delete(lockPath);
          return { acquired: false, reason: 'persistent_lock_race' };
        }
        throw retryErr;
      }
    }

    // Lock distribuido adicional en MariaDB si está habilitado
    if (useDbLock) {
      try {
        dbConn = await getMainPool().getConnection();
        const [rows] = await dbConn.query('SELECT GET_LOCK(?, 0) AS acquired', [DB_LOCK_NAME]);
        const gotDbLock = Number(rows?.[0]?.acquired) === 1;
        if (!gotDbLock) {
          dbConn.release();
          dbConn = null;
          if (fileAcquired) {
            await unlink(lockPath).catch(() => {});
          }
          activeInProcessLocks.delete(lockPath);
          return { acquired: false, reason: 'distributed_db_lock_active' };
        }
      } catch (err) {
        if (dbConn) {
          dbConn.release();
          dbConn = null;
        }
        warnings.push(`ADVERTENCIA: Bloqueo distribuido en BD principal no disponible (${sanitizeText(err)}); usando lock persistente en disco.`);
      }
    }

    return {
      acquired: true,
      lockPath,
      ownerId,
      dbConn,
      warnings
    };
  } catch (err) {
    if (dbConn) {
      dbConn.release();
    }
    if (fileAcquired) {
      await unlink(lockPath).catch(() => {});
    }
    activeInProcessLocks.delete(lockPath);
    throw err;
  }
}

async function releaseSyncLock(handle) {
  if (!handle || !handle.acquired) return;
  try {
    if (handle.dbConn) {
      await handle.dbConn.query('SELECT RELEASE_LOCK(?)', [DB_LOCK_NAME]).catch(() => {});
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
      activeInProcessLocks.delete(handle.lockPath);
    }
  }
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
 * Sincroniza un lote de registros en POWERBI.INFORESULTADOS dentro de una transacción con reintentos
 * y verifica post-commit que todas las escrituras quedaron efectivamente guardadas.
 */
export async function sincronizarRegistrosPowerBi(fechaObjetivo, registros, logs = [], options = {}) {
  const validRecords = registros.filter(
    (r) => r.resultado !== undefined && r.resultado !== null && String(r.resultado).trim() !== ''
  );

  for (const r of registros) {
    if (r.resultado === undefined || r.resultado === null || String(r.resultado).trim() === '') {
      logs.push(`ADVERTENCIA: Se omite código ${r.codigo} en PowerBI por resultado vacío.`);
    }
  }

  if (validRecords.length === 0) {
    return { synced: [], verifiedCount: 0 };
  }

  if (typeof options.customSyncFn === 'function') {
    return await options.customSyncFn(fechaObjetivo, validRecords, logs);
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

        // Verificación real post-commit sobre INFORESULTADOS
        const codes = synced.map((s) => s.codigo);
        const placeholders = codes.map(() => '?').join(', ');
        const [verifyRows] = await conn.execute(
          `SELECT CODIGO, RESULTADO, SERIE FROM INFORESULTADOS WHERE FECHA = ? AND CODIGO IN (${placeholders})`,
          [fechaObjetivo, ...codes]
        );

        const rowMap = new Map((verifyRows || []).map((row) => [String(row.CODIGO).trim(), row]));
        let verifiedCount = 0;
        for (const s of synced) {
          const persisted = rowMap.get(String(s.codigo).trim());
          if (!persisted || String(persisted.RESULTADO).trim() !== String(s.resultado).trim()) {
            throw new Error(
              `Verificación post-escritura fallida en INFORESULTADOS para código ${s.codigo} fecha ${s.fecha}`
            );
          }
          verifiedCount++;
          logs.push(
            `ÉXITO [verificado]: INFORESULTADOS código ${s.codigo} fecha ${s.fecha} (${s.resultado}${s.serie ? ' / serie ' + s.serie : ''}).`
          );
        }

        return { synced, verifiedCount };
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    {
      maxRetries: options.maxRetries ?? env.dbPowerBi.maxRetries,
      delayMs: options.delayMs ?? env.dbPowerBi.retryDelayMs,
      label: 'Sincronización INFORESULTADOS PowerBI'
    }
  );
}

/**
 * Servicio central único de actualización completa invocado por:
 * - el scheduler automático del backend
 * - la verificación al ingresar a https://resultados.serviredgane.cloud
 * - el botón manual "Actualizar y Sincronizar Ahora"
 */
export async function ejecutarSincronizacionCompleta({
  fechaParam = '',
  urlResultadosParam = '',
  trigger = 'manual',
  _dataDir = null,
  _injectDeps = null
} = {}) {
  const dataDir = getEffectiveDataDir(_dataDir);
  if (!stateLoaded && !activeDataDir) {
    await initSyncState({ dataDir });
  }

  let lockHandle;
  try {
    lockHandle = await acquireSyncLock({
      trigger,
      dataDir,
      useDbLock: _injectDeps?.useDbLock ?? true,
      lockTtlMs: _injectDeps?.lockTtlMs ?? env.sync.lockTtlMs
    });
  } catch (err) {
    const safeErr = sanitizeText(err);
    return {
      success: false,
      alreadyRunning: false,
      message: `No se pudo iniciar bloqueo de sincronización: ${safeErr}`,
      ...getSyncStatus({ dataDir })
    };
  }

  if (!lockHandle.acquired) {
    return {
      success: true,
      alreadyRunning: true,
      message: 'Ya existe una sincronización en ejecución.',
      ...getSyncStatus({ dataDir })
    };
  }

  const t0 = Date.now();
  const logs = [...(lockHandle.warnings || [])];
  const errors = [];
  const bogotaNow = getBogotaDateParts();

  // Marcar estado en ejecución y persistir inmediatamente
  cachedSyncState = {
    ...cachedSyncState,
    inProgress: true,
    syncInProgress: true,
    status: 'running',
    lastTrigger: trigger
  };
  await persistStateFile(dataDir, cachedSyncState).catch(() => {});

  try {
    const fechaDesdeUrl = extraerFechaDesdeUrl(urlResultadosParam);
    let fechaObjetivo =
      fechaDesdeUrl !== ''
        ? fechaDesdeUrl
        : validarFechaIso(fechaParam)
          ? fechaParam.trim()
          : bogotaNow.isoDate;

    logs.push(
      `[${bogotaNow.isoDateTime}] Iniciando sincronización (${trigger}) para fecha objetivo: ${fechaObjetivo} (TZ: America/Bogota)`
    );

    // 1. Leer últimos datos válidos en BD principal para no sobrescribir con vacíos
    const mainPool = _injectDeps?.mainPool || getMainPool();
    let currentAcum = null;
    let mainReadError = null;
    try {
      const [rows] = await mainPool.query('SELECT * FROM acumulados ORDER BY id DESC LIMIT 1');
      if (rows && rows.length > 0) {
        currentAcum = rows[0];
      }
    } catch (err) {
      mainReadError = sanitizeText(err);
      logs.push(`ADVERTENCIA: No se pudo leer estado previo de acumulados (${mainReadError}).`);
    }

    // 2. Extraer datos de fuentes externas web
    const scrapeFn = _injectDeps?.extraerFuentesExternas || extraerFuentesExternas;
    const { results: scraped, logs: scraperLogs } = await scrapeFn();
    for (const entry of scraperLogs) {
      logs.push(sanitizeText(entry));
    }
    const hasScraperWarnings = scraperLogs.some((l) => /ADVERTENCIA|ERROR/i.test(l));

    // 3. Consultar API interna para códigos 235 (Baloto), 2351 (Revancha), 245 (MiLoto), 273 (ColorLoto)
    const apiFn = _injectDeps?.obtenerResultadoDesdeApiInterna || obtenerResultadoDesdeApiInterna;
    const [balotoApi, revanchaApi, milotoApi, colorlotoApi] = await Promise.all([
      apiFn(fechaObjetivo, 235),
      apiFn(fechaObjetivo, 2351),
      apiFn(fechaObjetivo, 245),
      apiFn(fechaObjetivo, 273)
    ]);

    // 4. Combinar resultados priorizando datos nuevos confirmados y conservando últimos valores válidos
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
    let mainDbError = null;
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
          { maxRetries: _injectDeps?.mainMaxRetries ?? 2, delayMs: 200, label: 'Actualización de tabla acumulados' }
        );
        localDbUpdated = true;
        logs.push('ÉXITO: Tabla acumulados actualizada en base de datos principal.');
      } catch (err) {
        mainDbError = sanitizeText(err);
        errors.push(`BD Principal: ${mainDbError}`);
        logs.push(`ERROR BD Principal (acumulados): ${mainDbError}`);
      }
    } else if (mainReadError) {
      mainDbError = mainReadError;
      errors.push(`BD Principal: ${mainDbError}`);
      logs.push(`ERROR BD Principal: ${mainDbError}`);
    } else {
      mainDbError = 'No se contaban con las 6 balotas válidas de Baloto/Revancha para actualizar.';
      errors.push(mainDbError);
      logs.push(`ADVERTENCIA: ${mainDbError}`);
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

    // 7. Sincronizar y verificar en POWERBI.INFORESULTADOS
    let syncedRecords = [];
    let verifiedCount = 0;
    let powerBiError = null;
    try {
      const syncPowerBiFn = _injectDeps?.sincronizarRegistrosPowerBi || sincronizarRegistrosPowerBi;
      const pbiRes = await syncPowerBiFn(fechaObjetivo, registrosPowerBi, logs);
      syncedRecords = pbiRes.synced || [];
      verifiedCount = pbiRes.verifiedCount ?? syncedRecords.length;
    } catch (err) {
      powerBiError = sanitizeText(err);
      errors.push(`PowerBI (INFORESULTADOS): ${powerBiError}`);
      logs.push(`ERROR PowerBI: ${powerBiError}`);
    }

    const finishedMs = Date.now();
    const durationMs = finishedMs - t0;
    const finishedBogota = formatBogotaFromMs(finishedMs);

    let status;
    let success = false;
    let message;

    if (mainDbError) {
      status = 'main_db_error';
      message = powerBiError
        ? `Error en BD principal (${mainDbError}) y en PowerBI (${powerBiError}).`
        : `Error actualizando BD principal: ${mainDbError}.`;
    } else if (powerBiError) {
      status = 'powerbi_db_error';
      message = `BD principal actualizada, pero falló la sincronización con PowerBI (reintento pendiente): ${powerBiError}`;
    } else if (hasScraperWarnings) {
      status = 'partial';
      success = true;
      message = 'Actualización parcial completada (algunas fuentes web usaron respaldo); BD principal y PowerBI sincronizados y verificados.';
    } else {
      status = 'completed';
      success = true;
      message = 'Actualización completada. BD principal y POWERBI.INFORESULTADOS sincronizados y verificados.';
    }

    const pendingPowerBi = powerBiError
      ? {
          fechaObjetivo,
          registros: registrosPowerBi,
          failedAt: finishedBogota
        }
      : null;

    const historyEntry = {
      runAt: finishedBogota,
      trigger,
      status,
      durationMs,
      localDbUpdated,
      powerBiSyncedCount: syncedRecords.length,
      powerBiVerifiedCount: verifiedCount,
      errors: [...errors]
    };

    const nextHistory = [historyEntry, ...(cachedSyncState.history || [])].slice(0, MAX_HISTORY);
    const allCompletedOk = !mainDbError && !powerBiError;

    cachedSyncState = {
      ...cachedSyncState,
      status,
      inProgress: false,
      syncInProgress: false,
      lastRunAt: finishedBogota,
      lastSuccessAt: allCompletedOk ? finishedBogota : cachedSyncState.lastSuccessAt,
      lastSuccessAtMs: allCompletedOk ? finishedMs : cachedSyncState.lastSuccessAtMs,
      lastPowerBiSyncAt: !powerBiError && syncedRecords.length > 0 ? finishedBogota : cachedSyncState.lastPowerBiSyncAt,
      lastPowerBiRetryAttemptMs: powerBiError ? finishedMs : null,
      lastTrigger: trigger,
      durationMs,
      fechaObjetivo,
      localDbUpdated,
      powerBiSyncedCount: syncedRecords.length,
      powerBiVerifiedCount: verifiedCount,
      powerBiPendingRetry: Boolean(pendingPowerBi),
      pendingPowerBi,
      powerBiRecords: syncedRecords,
      databases: {
        mainDb: {
          status: mainDbError ? 'error' : 'ok',
          updated: localDbUpdated,
          error: mainDbError
        },
        powerBiDb: {
          status: powerBiError ? 'error' : 'ok',
          syncedCount: syncedRecords.length,
          verifiedCount,
          pendingRetry: Boolean(pendingPowerBi),
          error: powerBiError
        }
      },
      errors,
      logs: logs.slice(-MAX_LOGS),
      history: nextHistory,
      intervalMs: env.sync.autoSyncIntervalMs
    };

    cachedSyncState.nextScheduledAt = computeNextScheduledAt(cachedSyncState);
    cachedSyncState.nextPowerBiRetryAt = computeNextPowerBiRetryAt(cachedSyncState);

    return {
      success,
      alreadyRunning: false,
      message,
      ...getSyncStatus({ dataDir })
    };
  } finally {
    cachedSyncState.inProgress = false;
    cachedSyncState.syncInProgress = false;
    await persistStateFile(dataDir, cachedSyncState).catch(() => {});
    await releaseSyncLock(lockHandle).catch(() => {});
  }
}

/**
 * Reintenta exclusivamente la sincronización pendiente hacia POWERBI.INFORESULTADOS
 * usando upsert atómico (ON DUPLICATE KEY UPDATE) para evitar duplicados.
 */
export async function reintentarSincronizacionPowerBiPendiente({
  trigger = 'powerbi_retry',
  _dataDir = null,
  _injectDeps = null
} = {}) {
  const dataDir = getEffectiveDataDir(_dataDir);
  if (!stateLoaded && !activeDataDir) {
    await initSyncState({ dataDir });
  }

  const pending = cachedSyncState.pendingPowerBi;
  if (!pending || !Array.isArray(pending.registros) || pending.registros.length === 0) {
    return {
      success: true,
      nothingPending: true,
      message: 'No hay sincronización pendiente hacia PowerBI.',
      ...getSyncStatus({ dataDir })
    };
  }

  let lockHandle;
  try {
    lockHandle = await acquireSyncLock({
      trigger,
      dataDir,
      useDbLock: _injectDeps?.useDbLock ?? true,
      lockTtlMs: _injectDeps?.lockTtlMs ?? env.sync.lockTtlMs
    });
  } catch (err) {
    return {
      success: false,
      message: `Error adquiriendo lock para reintento PowerBI: ${sanitizeText(err)}`,
      ...getSyncStatus({ dataDir })
    };
  }

  if (!lockHandle.acquired) {
    return {
      success: true,
      alreadyRunning: true,
      message: 'Ya existe una sincronización en progreso.',
      ...getSyncStatus({ dataDir })
    };
  }

  const t0 = Date.now();
  const logs = [...(lockHandle.warnings || []), `[${getBogotaDateParts().isoDateTime}] Reintentando sincronización pendiente hacia PowerBI (fecha ${pending.fechaObjetivo})...`];
  let syncedRecords = [];
  let verifiedCount = 0;
  let retryError = null;

  cachedSyncState.inProgress = true;
  cachedSyncState.syncInProgress = true;
  cachedSyncState.status = 'running';
  cachedSyncState.lastTrigger = trigger;
  await persistStateFile(dataDir, cachedSyncState).catch(() => {});

  try {
    const syncPowerBiFn = _injectDeps?.sincronizarRegistrosPowerBi || sincronizarRegistrosPowerBi;
    const res = await syncPowerBiFn(pending.fechaObjetivo, pending.registros, logs);
    syncedRecords = res.synced || [];
    verifiedCount = res.verifiedCount ?? syncedRecords.length;
  } catch (err) {
    retryError = sanitizeText(err);
    logs.push(`ERROR reintento PowerBI: ${retryError}`);
  } finally {
    const finishedMs = Date.now();
    const durationMs = finishedMs - t0;
    const finishedBogota = formatBogotaFromMs(finishedMs);
    const errors = retryError ? [`PowerBI retry: ${retryError}`] : [];
    const resolvedStatus = retryError
      ? 'powerbi_db_error'
      : cachedSyncState.databases?.mainDb?.error
        ? 'main_db_error'
        : 'completed';

    const historyEntry = {
      runAt: finishedBogota,
      trigger,
      status: resolvedStatus,
      durationMs,
      localDbUpdated: cachedSyncState.localDbUpdated,
      powerBiSyncedCount: syncedRecords.length,
      powerBiVerifiedCount: verifiedCount,
      errors
    };

    cachedSyncState = {
      ...cachedSyncState,
      status: resolvedStatus,
      inProgress: false,
      syncInProgress: false,
      lastRunAt: finishedBogota,
      lastSuccessAt: !retryError && resolvedStatus === 'completed' ? finishedBogota : cachedSyncState.lastSuccessAt,
      lastSuccessAtMs: !retryError && resolvedStatus === 'completed' ? finishedMs : cachedSyncState.lastSuccessAtMs,
      lastPowerBiSyncAt: !retryError && syncedRecords.length > 0 ? finishedBogota : cachedSyncState.lastPowerBiSyncAt,
      lastPowerBiRetryAttemptMs: retryError ? finishedMs : null,
      lastTrigger: trigger,
      durationMs,
      powerBiSyncedCount: syncedRecords.length,
      powerBiVerifiedCount: verifiedCount,
      powerBiPendingRetry: Boolean(retryError),
      pendingPowerBi: retryError ? pending : null,
      powerBiRecords: syncedRecords,
      databases: {
        ...cachedSyncState.databases,
        powerBiDb: {
          status: retryError ? 'error' : 'ok',
          syncedCount: syncedRecords.length,
          verifiedCount,
          pendingRetry: Boolean(retryError),
          error: retryError
        }
      },
      errors,
      logs: [...(cachedSyncState.logs || []), ...logs].slice(-MAX_LOGS),
      history: [historyEntry, ...(cachedSyncState.history || [])].slice(0, MAX_HISTORY)
    };

    cachedSyncState.nextScheduledAt = computeNextScheduledAt(cachedSyncState);
    cachedSyncState.nextPowerBiRetryAt = computeNextPowerBiRetryAt(cachedSyncState);

    await persistStateFile(dataDir, cachedSyncState).catch(() => {});
    await releaseSyncLock(lockHandle).catch(() => {});
  }

  return {
    success: !retryError,
    message: retryError
      ? `El reintento a PowerBI falló nuevamente: ${retryError}`
      : 'Reintento a POWERBI.INFORESULTADOS completado y verificado sin duplicados.',
    ...getSyncStatus({ dataDir })
  };
}

/**
 * Evalúa si ya corresponde ejecutar una actualización completa o reintento PowerBI
 * respetando exactamente los intervalos configurados en America/Bogota.
 */
export async function evaluarYEjecutarSincronizacionSiCorresponde({
  trigger = 'public_visit',
  blocking = false,
  _dataDir = null,
  _injectDeps = null
} = {}) {
  const dataDir = getEffectiveDataDir(_dataDir);
  if (!stateLoaded && !activeDataDir) {
    await initSyncState({ dataDir });
  }

  if (!env.sync.autoSyncEnabled && !_injectDeps?.forceEnabled) {
    return {
      triggered: false,
      reason: 'disabled',
      inProgress: false,
      ...getSyncStatus({ dataDir })
    };
  }

  if (await isPersistentLockActive(dataDir)) {
    return {
      triggered: false,
      alreadyRunning: true,
      reason: 'already_running',
      inProgress: true,
      ...getSyncStatus({ dataDir })
    };
  }

  const now = Date.now();
  const intervalMs = _injectDeps?.intervalMs ?? env.sync.autoSyncIntervalMs;
  const retryCooldownMs = _injectDeps?.retryCooldownMs ?? env.sync.powerBiRetryCooldownMs;

  const fullSyncDue = !cachedSyncState.lastSuccessAtMs || now - cachedSyncState.lastSuccessAtMs >= intervalMs;
  const powerBiRetryDue =
    !fullSyncDue &&
    Boolean(cachedSyncState.pendingPowerBi) &&
    (!cachedSyncState.lastPowerBiRetryAttemptMs || now - cachedSyncState.lastPowerBiRetryAttemptMs >= retryCooldownMs);

  if (!fullSyncDue && !powerBiRetryDue) {
    return {
      triggered: false,
      reason: 'not_due',
      inProgress: false,
      nextScheduledAt: computeNextScheduledAt(cachedSyncState),
      status: cachedSyncState.status
    };
  }

  const runPromise = fullSyncDue
    ? ejecutarSincronizacionCompleta({ trigger, _dataDir: dataDir, _injectDeps })
    : reintentarSincronizacionPowerBiPendiente({ trigger: 'powerbi_retry', _dataDir: dataDir, _injectDeps });

  if (blocking) {
    const result = await runPromise;
    return {
      triggered: !result.alreadyRunning,
      reason: fullSyncDue ? 'interval_due' : 'powerbi_retry_due',
      ...result
    };
  }

  // Modo no bloqueante para visitas de televisores (dispara en segundo plano sin frenar el tablero)
  runPromise.catch(() => {});
  return {
    triggered: true,
    background: true,
    reason: fullSyncDue ? 'interval_due' : 'powerbi_retry_due',
    inProgress: true,
    status: cachedSyncState.status
  };
}
