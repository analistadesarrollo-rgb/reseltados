import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { env, getBogotaDateParts, resolveDataDir } from '../config/env.js';

const scryptAsync = promisify(crypto.scrypt);

export const ROLE_GESTOR_CARRUSEL = 'GESTOR_CARRUSEL';
export const CAROUSEL_PERMISSIONS = Object.freeze([
  'carousel:read',
  'carousel:upload',
  'carousel:delete'
]);
export const SESSION_COOKIE_NAME = 'resultados_carousel_sid';
export const CSRF_COOKIE_NAME = 'resultados_carousel_csrf';

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

// Control en memoria contra fuerza bruta por IP + usuario
const loginAttemptStore = new Map();

function getUsersFilePath(dataDir) {
  return join(dataDir, 'carousel-users.json');
}

function getSessionsFilePath(dataDir) {
  return join(dataDir, 'carousel-sessions.json');
}

async function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  const dir = resolve(filePath, '..');
  await mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, filePath);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;

  try {
    const derived = await scryptAsync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
    const actualBuf = Buffer.from(derived);
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (actualBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

function safeTimingEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Inicialización segura e idempotente del usuario restringido de carrusel (GESTOR_CARRUSEL).
 * Si el usuario ya existe en el volumen persistente, NO lo duplica ni restablece su contraseña.
 */
export async function initCarouselAuthStore(options = {}) {
  const dataDir = options.dataDir ? resolve(options.dataDir) : resolveDataDir();
  const initialUser = String(options.initialUser ?? env.carouselAdmin.initialUser ?? 'admin').trim();
  const initialPassword = String(options.initialPassword ?? env.carouselAdmin.initialPassword ?? '');
  const requirePasswordChange =
    options.requirePasswordChange ?? env.carouselAdmin.requirePasswordChange;

  await mkdir(dataDir, { recursive: true });
  const usersFile = getUsersFilePath(dataDir);
  const store = await readJsonSafe(usersFile, { users: [] });
  if (!Array.isArray(store.users)) {
    store.users = [];
  }

  const existing = store.users.find((u) => u.username === initialUser);
  if (existing) {
    return { initialized: false, reason: 'already_exists', username: initialUser };
  }

  if (!initialPassword || initialPassword.startsWith('replace_with_')) {
    return { initialized: false, reason: 'missing_initial_password', username: initialUser };
  }

  const passwordHash = await hashPassword(initialPassword);
  const nowBogota = getBogotaDateParts().isoDateTime;

  store.users.push({
    username: initialUser,
    passwordHash,
    role: ROLE_GESTOR_CARRUSEL,
    permissions: [...CAROUSEL_PERMISSIONS],
    mustChangePassword: Boolean(requirePasswordChange),
    createdAt: nowBogota,
    updatedAt: null
  });

  await writeJsonAtomic(usersFile, store);
  return { initialized: true, reason: 'created', username: initialUser };
}

function getAttemptKey(ip, username) {
  return `${String(ip || 'unknown')}::${String(username || '').toLowerCase()}`;
}

export function clearRateLimitStoreForTests() {
  loginAttemptStore.clear();
}

export function checkLoginRateLimit(ip, username, options = {}) {
  const windowMs = options.loginWindowMs ?? env.carouselAdmin.loginWindowMs;
  const key = getAttemptKey(ip, username);
  const record = loginAttemptStore.get(key);
  if (!record) return { blocked: false, retryAfterSec: 0 };

  const now = Date.now();
  if (record.blockedUntilMs && record.blockedUntilMs > now) {
    return {
      blocked: true,
      retryAfterSec: Math.max(1, Math.ceil((record.blockedUntilMs - now) / 1000))
    };
  }

  if (now - record.firstAttemptMs > windowMs) {
    loginAttemptStore.delete(key);
  }
  return { blocked: false, retryAfterSec: 0 };
}

function recordFailedLogin(ip, username, options = {}) {
  const maxAttempts = options.loginMaxAttempts ?? env.carouselAdmin.loginMaxAttempts;
  const windowMs = options.loginWindowMs ?? env.carouselAdmin.loginWindowMs;
  const key = getAttemptKey(ip, username);
  const now = Date.now();
  const prev = loginAttemptStore.get(key);

  let record;
  if (!prev || now - prev.firstAttemptMs > windowMs) {
    record = { count: 1, firstAttemptMs: now, blockedUntilMs: 0 };
  } else {
    record = {
      count: prev.count + 1,
      firstAttemptMs: prev.firstAttemptMs,
      blockedUntilMs: prev.blockedUntilMs || 0
    };
  }

  if (record.count >= maxAttempts) {
    record.blockedUntilMs = now + windowMs;
  }

  loginAttemptStore.set(key, record);
  return record;
}

function clearFailedLogin(ip, username) {
  loginAttemptStore.delete(getAttemptKey(ip, username));
}

export function isSecureCookieRequest(request) {
  const mode = env.carouselAdmin.cookieSecure;
  if (mode === 'true') return true;
  if (mode === 'false') return false;
  const forwardedProto = String(request?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return request?.protocol === 'https' || forwardedProto === 'https';
}

export function getSessionCookieOptions(request, sessionTtlMs = env.carouselAdmin.sessionTtlMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureCookieRequest(request),
    path: '/',
    maxAge: Math.max(60, Math.floor(sessionTtlMs / 1000))
  };
}

export function getCsrfCookieOptions(request, sessionTtlMs = env.carouselAdmin.sessionTtlMs) {
  return {
    httpOnly: false,
    sameSite: 'lax',
    secure: isSecureCookieRequest(request),
    path: '/',
    maxAge: Math.max(60, Math.floor(sessionTtlMs / 1000))
  };
}

export async function loginCarouselUser({
  username,
  password,
  ip = 'unknown',
  dataDir: customDataDir,
  sessionTtlMs = env.carouselAdmin.sessionTtlMs,
  loginMaxAttempts = env.carouselAdmin.loginMaxAttempts,
  loginWindowMs = env.carouselAdmin.loginWindowMs
}) {
  const cleanUser = String(username || '').trim();
  const cleanPass = String(password || '');

  const rate = checkLoginRateLimit(ip, cleanUser, { loginWindowMs });
  if (rate.blocked) {
    return {
      success: false,
      statusCode: 429,
      retryAfterSec: rate.retryAfterSec,
      error: `Demasiados intentos fallidos. Intenta nuevamente en ${rate.retryAfterSec} segundos.`
    };
  }

  if (!cleanUser || !cleanPass) {
    return {
      success: false,
      statusCode: 400,
      error: 'Debes ingresar usuario y contraseña.'
    };
  }

  const dataDir = customDataDir ? resolve(customDataDir) : resolveDataDir();
  const usersStore = await readJsonSafe(getUsersFilePath(dataDir), { users: [] });
  const user = (usersStore.users || []).find((u) => u.username === cleanUser);

  const valid = user
    ? await verifyPassword(cleanPass, user.passwordHash)
    : await verifyPassword(cleanPass, 'scrypt$00000000000000000000000000000000$00'.padEnd(168, '0')).then(() => false);

  if (!valid || !user || user.role !== ROLE_GESTOR_CARRUSEL) {
    const attempt = recordFailedLogin(ip, cleanUser, { loginMaxAttempts, loginWindowMs });
    if (attempt.blockedUntilMs > Date.now()) {
      const retryAfterSec = Math.max(1, Math.ceil((attempt.blockedUntilMs - Date.now()) / 1000));
      return {
        success: false,
        statusCode: 429,
        retryAfterSec,
        error: `Demasiados intentos fallidos. Cuenta bloqueada temporalmente por ${retryAfterSec} segundos.`
      };
    }
    return {
      success: false,
      statusCode: 401,
      error: 'Usuario o contraseña incorrectos.'
    };
  }

  clearFailedLogin(ip, cleanUser);

  const sessionsFile = getSessionsFilePath(dataDir);
  const sessionsStore = await readJsonSafe(sessionsFile, { sessions: {} });
  if (!sessionsStore.sessions || typeof sessionsStore.sessions !== 'object') {
    sessionsStore.sessions = {};
  }

  const now = Date.now();
  // Depurar sesiones expiradas al crear una nueva
  for (const [sidKey, sess] of Object.entries(sessionsStore.sessions)) {
    if (!sess || !sess.expiresAtMs || sess.expiresAtMs <= now) {
      delete sessionsStore.sessions[sidKey];
    }
  }

  const sid = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(32).toString('hex');

  sessionsStore.sessions[sid] = {
    sid,
    csrfToken,
    username: user.username,
    role: user.role,
    permissions: Array.isArray(user.permissions) ? [...user.permissions] : [...CAROUSEL_PERMISSIONS],
    createdAtMs: now,
    expiresAtMs: now + sessionTtlMs
  };

  await writeJsonAtomic(sessionsFile, sessionsStore);

  return {
    success: true,
    sid,
    csrfToken,
    user: {
      username: user.username,
      role: user.role,
      permissions: sessionsStore.sessions[sid].permissions,
      mustChangePassword: Boolean(user.mustChangePassword)
    }
  };
}

export async function getCarouselSessionFromRequest(request, options = {}) {
  const sid = request?.cookies?.[SESSION_COOKIE_NAME];
  if (!sid || typeof sid !== 'string' || !/^[a-f0-9]{64}$/.test(sid)) {
    return null;
  }

  const dataDir = options.dataDir ? resolve(options.dataDir) : resolveDataDir();
  const sessionsFile = getSessionsFilePath(dataDir);
  const sessionsStore = await readJsonSafe(sessionsFile, { sessions: {} });
  const session = sessionsStore?.sessions?.[sid];
  if (!session) return null;

  const now = Date.now();
  if (!session.expiresAtMs || session.expiresAtMs <= now) {
    delete sessionsStore.sessions[sid];
    await writeJsonAtomic(sessionsFile, sessionsStore).catch(() => {});
    return null;
  }

  // Consultar bandera actualizada del usuario (p. ej. mustChangePassword)
  const usersStore = await readJsonSafe(getUsersFilePath(dataDir), { users: [] });
  const user = (usersStore.users || []).find((u) => u.username === session.username);
  if (!user || user.role !== ROLE_GESTOR_CARRUSEL) {
    return null;
  }

  return {
    ...session,
    mustChangePassword: Boolean(user.mustChangePassword)
  };
}

export async function logoutCarouselSession(sid, options = {}) {
  if (!sid || typeof sid !== 'string') return;
  const dataDir = options.dataDir ? resolve(options.dataDir) : resolveDataDir();
  const sessionsFile = getSessionsFilePath(dataDir);
  const sessionsStore = await readJsonSafe(sessionsFile, { sessions: {} });
  if (sessionsStore.sessions && sessionsStore.sessions[sid]) {
    delete sessionsStore.sessions[sid];
    await writeJsonAtomic(sessionsFile, sessionsStore);
  }
}

export async function requireCarouselPermission(request, reply, permission, options = {}) {
  const session = await getCarouselSessionFromRequest(request, options);
  if (!session) {
    reply.code(401).send({
      success: false,
      error: 'No autenticado o sesión expirada. Inicia sesión en el gestor del carrusel.'
    });
    return null;
  }

  const hasRole = session.role === ROLE_GESTOR_CARRUSEL;
  const hasPerm =
    !permission || (Array.isArray(session.permissions) && session.permissions.includes(permission));

  if (!hasRole || !hasPerm) {
    reply.code(403).send({
      success: false,
      error: 'Acceso denegado: no tienes permisos suficientes para realizar esta acción.'
    });
    return null;
  }

  return session;
}

export function requireCarouselCsrf(request, reply, session) {
  const headerToken = String(request?.headers?.['x-csrf-token'] || '');
  if (!session?.csrfToken || !safeTimingEqualStrings(headerToken, session.csrfToken)) {
    reply.code(403).send({
      success: false,
      error: 'Validación CSRF fallida. Recarga el panel e intenta nuevamente.'
    });
    return false;
  }

  const originHeader = request?.headers?.origin;
  if (originHeader) {
    try {
      const originHost = new URL(originHeader).host;
      const expectedHost = String(
        request?.headers?.['x-forwarded-host'] || request?.headers?.host || ''
      )
        .split(',')[0]
        .trim();
      if (expectedHost && originHost !== expectedHost) {
        reply.code(403).send({
          success: false,
          error: 'Origen de solicitud no autorizado.'
        });
        return false;
      }
    } catch {
      reply.code(403).send({
        success: false,
        error: 'Cabecera Origin inválida.'
      });
      return false;
    }
  }

  return true;
}

export async function changeCarouselPassword({
  username,
  currentPassword,
  newPassword,
  dataDir: customDataDir
}) {
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    return {
      success: false,
      statusCode: 400,
      error: 'La nueva contraseña debe tener al menos 8 caracteres.'
    };
  }
  if (newPassword === currentPassword) {
    return {
      success: false,
      statusCode: 400,
      error: 'La nueva contraseña debe ser diferente a la contraseña actual.'
    };
  }

  const dataDir = customDataDir ? resolve(customDataDir) : resolveDataDir();
  const usersFile = getUsersFilePath(dataDir);
  const store = await readJsonSafe(usersFile, { users: [] });
  const idx = (store.users || []).findIndex((u) => u.username === username);
  if (idx === -1) {
    return { success: false, statusCode: 404, error: 'Usuario no encontrado.' };
  }

  const valid = await verifyPassword(currentPassword, store.users[idx].passwordHash);
  if (!valid) {
    return { success: false, statusCode: 401, error: 'La contraseña actual no es correcta.' };
  }

  store.users[idx] = {
    ...store.users[idx],
    passwordHash: await hashPassword(newPassword),
    mustChangePassword: false,
    updatedAt: getBogotaDateParts().isoDateTime
  };

  await writeJsonAtomic(usersFile, store);
  return {
    success: true,
    message: 'Contraseña actualizada correctamente.'
  };
}
