import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cargar .env desde la raíz del proyecto o desde el directorio backend
const rootEnvPath = resolve(__dirname, '../../../.env');
const localEnvPath = resolve(__dirname, '../../.env');

if (existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
} else if (existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath });
} else {
  dotenv.config();
}

// Garantizar zona horaria de Colombia
process.env.TZ = process.env.TZ || 'America/Bogota';

export const env = {
  nodeEnv: process.env.NODE_ENV || 'production',
  tz: process.env.TZ || 'America/Bogota',
  port: Number.parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || 'info',

  dbMain: {
    host: process.env.DB_MAIN_HOST || '',
    port: Number.parseInt(process.env.DB_MAIN_PORT || '3306', 10),
    user: process.env.DB_MAIN_USER || '',
    password: process.env.DB_MAIN_PASSWORD || '',
    database: process.env.DB_MAIN_NAME || 'chatbot',
    connectionLimit: Number.parseInt(process.env.DB_MAIN_POOL_LIMIT || '10', 10),
    connectTimeout: Number.parseInt(process.env.DB_MAIN_CONNECT_TIMEOUT || '10000', 10)
  },

  dbAuth: {
    host: process.env.DB_AUTH_HOST || process.env.DB_MAIN_HOST || '',
    port: Number.parseInt(process.env.DB_AUTH_PORT || process.env.DB_MAIN_PORT || '3306', 10),
    user: process.env.DB_AUTH_USER || '',
    password: process.env.DB_AUTH_PASSWORD || '',
    database: process.env.DB_AUTH_NAME || 'bdpersona',
    connectionLimit: Number.parseInt(process.env.DB_AUTH_POOL_LIMIT || '5', 10),
    connectTimeout: Number.parseInt(process.env.DB_AUTH_CONNECT_TIMEOUT || '10000', 10)
  },

  dbPowerBi: {
    host: process.env.DB_POWERBI_HOST || '',
    port: Number.parseInt(process.env.DB_POWERBI_PORT || '5010', 10),
    user: process.env.DB_POWERBI_USER || '',
    password: process.env.DB_POWERBI_PASSWORD || '',
    database: process.env.DB_POWERBI_NAME || 'POWERBI',
    connectionLimit: Number.parseInt(process.env.DB_POWERBI_POOL_LIMIT || '5', 10),
    connectTimeout: Number.parseInt(process.env.DB_POWERBI_CONNECT_TIMEOUT || '15000', 10),
    ssl: process.env.DB_POWERBI_SSL === 'true',
    maxRetries: Number.parseInt(process.env.DB_POWERBI_MAX_RETRIES || '3', 10),
    retryDelayMs: Number.parseInt(process.env.DB_POWERBI_RETRY_DELAY_MS || '1500', 10)
  },

  scraper: {
    apiResultadosBaseUrl: process.env.API_RESULTADOS_BASE_URL || 'http://172.20.1.221:7080/api/v1/resultados',
    urlBaloto: process.env.SCRAPER_URL_BALOTO || 'https://baloto.com/resultados',
    urlMiloto: process.env.SCRAPER_URL_MILOTO || 'https://baloto.com/miloto/resultados/',
    urlColorloto: process.env.SCRAPER_URL_COLORLOTO || 'https://baloto.com/colorloto/resultados',
    urlChanceMillonario: process.env.SCRAPER_URL_CHANCE_MILLONARIO || 'https://www.chancemillonario.com/resultados.php',
    urlDobleChance: process.env.SCRAPER_URL_DOBLE_CHANCE || 'https://supergirosnortedelvalle.com/juegos/doble-chance/',
    httpTimeoutMs: Number.parseInt(process.env.SCRAPER_HTTP_TIMEOUT_MS || '12000', 10),
    maxRetries: Number.parseInt(process.env.SCRAPER_MAX_RETRIES || '3', 10),
    allowInsecureTlsFallback: process.env.SCRAPER_ALLOW_INSECURE_TLS_FALLBACK !== 'false'
  },

  sync: {
    autoSyncEnabled: process.env.AUTO_SYNC_ENABLED !== 'false',
    autoSyncIntervalMs: Number.parseInt(process.env.AUTO_SYNC_INTERVAL_MS || '3600000', 10),
    autoSyncOnStartup: process.env.AUTO_SYNC_ON_STARTUP !== 'false',
    syncApiToken: process.env.SYNC_API_TOKEN || '',
    versionTag: process.env.SYNC_VERSION_TAG || 'WS-SCRAPER-2.0',
    lockTtlMs: Number.parseInt(process.env.SYNC_LOCK_TTL_MS || '180000', 10),
    powerBiRetryCooldownMs: Number.parseInt(process.env.POWERBI_RETRY_COOLDOWN_MS || '300000', 10),
    schedulerTickMs: Number.parseInt(process.env.SYNC_SCHEDULER_TICK_MS || '60000', 10)
  },

  storage: {
    appDataDir: process.env.APP_DATA_DIR || './data'
  },

  carousel: {
    imagesDir: process.env.CAROUSEL_IMAGES_DIR || '../frontend/public/img/carousel',
    seedDir: process.env.CAROUSEL_SEED_DIR || '../frontend/public/img/carousel',
    maxFileSizeBytes: Number.parseInt(process.env.CAROUSEL_MAX_FILE_SIZE_BYTES || '10485760', 10)
  },

  carouselAdmin: {
    initialUser: process.env.CAROUSEL_ADMIN_INITIAL_USER || 'admin',
    initialPassword: process.env.CAROUSEL_ADMIN_INITIAL_PASSWORD || '',
    requirePasswordChange: process.env.CAROUSEL_ADMIN_REQUIRE_PASSWORD_CHANGE !== 'false',
    sessionTtlMs: Number.parseInt(process.env.CAROUSEL_SESSION_TTL_MS || '28800000', 10),
    loginMaxAttempts: Number.parseInt(process.env.CAROUSEL_LOGIN_MAX_ATTEMPTS || '5', 10),
    loginWindowMs: Number.parseInt(process.env.CAROUSEL_LOGIN_WINDOW_MS || '900000', 10),
    cookieSecure: process.env.COOKIE_SECURE || 'auto'
  }
};

/**
 * Resuelve el directorio persistente de datos de la aplicación (usuarios del carrusel, sesiones, locks, estado de sync)
 */
export function resolveDataDir() {
  const backendRoot = resolve(__dirname, '../..');
  return resolve(backendRoot, env.storage.appDataDir);
}

/**
 * Obtiene la fecha y hora actuales formateadas en zona horaria America/Bogota
 */
export function getBogotaDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  }

  const hour = parts.hour === '24' ? '00' : parts.hour;
  const isoDate = `${parts.year}-${parts.month}-${parts.day}`;
  const isoDateTime = `${isoDate} ${hour}:${parts.minute}:${parts.second}`;

  // Obtener día de la semana en America/Bogota (0=Domingo .. 6=Sábado)
  const bogotaNoon = new Date(`${isoDate}T12:00:00-05:00`);
  const dayOfWeek = bogotaNoon.getUTCDay();

  return {
    year: Number.parseInt(parts.year, 10),
    month: Number.parseInt(parts.month, 10),
    day: Number.parseInt(parts.day, 10),
    dayStr: parts.day,
    monthStr: parts.month,
    yearStr: parts.year,
    hour,
    minute: parts.minute,
    second: parts.second,
    isoDate,
    isoDateTime,
    dayOfWeek
  };
}
