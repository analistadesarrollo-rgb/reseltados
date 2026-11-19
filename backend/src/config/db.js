import mysql from 'mysql2/promise';
import { env } from './env.js';

let mainPool = null;
let powerBiPool = null;

/**
 * Sanitiza mensajes de error de base de datos para nunca exponer contraseñas ni datos sensibles
 */
export function sanitizeDbError(err) {
  if (!err) return 'Error desconocido de base de datos';
  const msg = String(err.message || err.code || 'Error de conexión');
  const secrets = [
    env.dbMain.password,
    env.dbPowerBi.password
  ].filter(Boolean);

  let safe = msg;
  for (const secret of secrets) {
    safe = safe.split(secret).join('***');
  }
  return safe;
}

/**
 * Pool de conexión independiente para Base de Datos Principal (chatbot - MariaDB)
 */
export function getMainPool() {
  if (!mainPool) {
    mainPool = mysql.createPool({
      host: env.dbMain.host,
      port: env.dbMain.port,
      user: env.dbMain.user,
      password: env.dbMain.password,
      database: env.dbMain.database,
      charset: 'utf8',
      waitForConnections: true,
      connectionLimit: env.dbMain.connectionLimit,
      queueLimit: 0,
      connectTimeout: env.dbMain.connectTimeout,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      dateStrings: true
    });
  }
  return mainPool;
}

/**
 * Pool de conexión independiente para Base de Datos Externa PowerBI (POWERBI - MySQL 8)
 */
export function getPowerBiPool() {
  if (!powerBiPool) {
    const poolConfig = {
      host: env.dbPowerBi.host,
      port: env.dbPowerBi.port,
      user: env.dbPowerBi.user,
      password: env.dbPowerBi.password,
      database: env.dbPowerBi.database,
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: env.dbPowerBi.connectionLimit,
      queueLimit: 0,
      connectTimeout: env.dbPowerBi.connectTimeout,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      dateStrings: true
    };

    if (env.dbPowerBi.ssl) {
      poolConfig.ssl = { rejectUnauthorized: false };
    }

    powerBiPool = mysql.createPool(poolConfig);
  }
  return powerBiPool;
}

/**
 * Ejecuta una operación contra un pool con reintentos controlados ante fallos transitorios
 */
export async function withRetry(fn, { maxRetries = 3, delayMs = 1000, label = 'DB Operation' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const transientCodes = new Set([
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNREFUSED',
        'PROTOCOL_CONNECTION_LOST',
        'ER_LOCK_DEADLOCK',
        'ER_LOCK_WAIT_TIMEOUT',
        'EPIPE'
      ]);
      const isTransient = transientCodes.has(err?.code) || /timeout|lost|reset|deadlock/i.test(String(err?.message));
      if (!isTransient || attempt === maxRetries) {
        break;
      }
      const waitTime = delayMs * attempt;
      await new Promise((r) => setTimeout(r, waitTime));
    }
  }
  throw new Error(`${label} falló tras ${maxRetries} intento(s): ${sanitizeDbError(lastError)}`);
}

/**
 * Verifica conectividad de las bases de datos sin exponer credenciales
 */
export async function checkDatabasesHealth() {
  const status = {
    mainDb: { available: false, latencyMs: null },
    powerBiDb: { available: false, latencyMs: null }
  };

  try {
    const t0 = Date.now();
    const pool = getMainPool();
    await pool.query('SELECT 1 AS ok');
    status.mainDb = { available: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    status.mainDb = { available: false, error: sanitizeDbError(err) };
  }

  try {
    const t0 = Date.now();
    const pool = getPowerBiPool();
    await pool.query('SELECT 1 AS ok');
    status.powerBiDb = { available: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    status.powerBiDb = { available: false, error: sanitizeDbError(err) };
  }

  return status;
}

export async function closeAllPools() {
  const promises = [];
  if (mainPool) promises.push(mainPool.end().catch(() => {}));
  if (powerBiPool) promises.push(powerBiPool.end().catch(() => {}));
  await Promise.all(promises);
}
