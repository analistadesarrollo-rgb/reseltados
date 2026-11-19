import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, getBogotaDateParts, resolveDataDir } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(__dirname, '../..');

export const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function createUploadError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export function resolveCarouselDir(overrideDir) {
  if (overrideDir) return resolve(overrideDir);

  const configured = env.carousel.imagesDir;
  const candidates = isAbsolute(configured)
    ? [configured]
    : [
        resolve(BACKEND_ROOT, configured),
        resolve(process.cwd(), configured),
        resolve(__dirname, '../../..', 'frontend/public/img/carousel'),
        resolve(__dirname, '../..', 'carousel'),
        '/app/carousel',
        '/usr/share/nginx/html/img/carousel'
      ];

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }
  return candidates[0];
}

export function resolveSeedDir(overrideSeedDir) {
  if (overrideSeedDir) return resolve(overrideSeedDir);

  const configured = env.carousel.seedDir;
  const candidates = isAbsolute(configured)
    ? [configured]
    : [
        resolve(BACKEND_ROOT, configured),
        resolve(__dirname, '../../..', 'frontend/public/img/carousel'),
        '/app/carousel-seed'
      ];

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }
  return candidates[0];
}

/**
 * Inicializa por única vez el volumen persistente de carrusel desde las imágenes originales.
 * Si el administrador agrega o elimina imágenes después, los reinicios o redespliegues de Docker
 * NO vuelven a copiar imágenes eliminadas ni sobrescriben archivos actuales.
 */
export async function seedCarouselIfNeeded(options = {}) {
  const dataDir = options.dataDir ? resolve(options.dataDir) : resolveDataDir();
  const carouselDir = resolveCarouselDir(options.carouselDir);
  const seedDir = resolveSeedDir(options.seedDir);
  const flagPath = join(dataDir, 'carousel-seeded.flag');

  await mkdir(dataDir, { recursive: true });
  await mkdir(carouselDir, { recursive: true });

  if (existsSync(flagPath)) {
    return { seeded: false, reason: 'already_seeded', copiedCount: 0, carouselDir };
  }

  const currentEntries = await readdir(carouselDir);
  const currentImages = currentEntries.filter((f) => ALLOWED_EXTENSIONS.has(extname(f).toLowerCase()));

  let copiedCount = 0;
  if (currentImages.length === 0 && existsSync(seedDir) && resolve(seedDir) !== resolve(carouselDir)) {
    const seedEntries = await readdir(seedDir);
    for (const entry of seedEntries) {
      const ext = extname(entry).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext)) continue;
      const srcPath = join(seedDir, entry);
      const dstPath = join(carouselDir, entry);
      const st = await lstat(srcPath).catch(() => null);
      if (st && st.isFile() && !st.isSymbolicLink()) {
        await copyFile(srcPath, dstPath);
        copiedCount++;
      }
    }
  }

  await writeFile(
    flagPath,
    JSON.stringify({
      seededAt: getBogotaDateParts().isoDateTime,
      copiedCount,
      seedDir
    }),
    'utf8'
  );

  return { seeded: true, reason: copiedCount > 0 ? 'copied_seed' : 'marked_existing', copiedCount, carouselDir };
}

function detectImageMagicType(buf) {
  if (!Buffer.isBuffer(buf)) return null;

  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }

  // GIF: GIF87a | GIF89a
  if (buf.length >= 6) {
    const head6 = buf.subarray(0, 6).toString('ascii');
    if (head6 === 'GIF87a' || head6 === 'GIF89a') {
      return 'gif';
    }
  }

  // WEBP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
}

const EXTENSION_TO_MAGIC = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.gif': 'gif',
  '.webp': 'webp'
};

/**
 * Valida extensión, tamaño y firma binaria real (magic bytes) del archivo subido.
 */
export function validateImageUpload(buffer, originalFilename, maxBytes = env.carousel.maxFileSizeBytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createUploadError(400, 'El archivo enviado está vacío o es inválido.');
  }

  if (buffer.length > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(1);
    throw createUploadError(413, `La imagen supera el tamaño máximo permitido de ${mb} MB.`);
  }

  const rawName = String(originalFilename || '').trim();
  if (!rawName || rawName.includes('\0')) {
    throw createUploadError(400, 'Nombre de archivo inválido.');
  }

  // Rechazar dobles extensiones peligrosas (.php.jpg, .svg.png, .html.gif, etc.)
  if (/\.(php\d*|phtml|phar|exe|dll|sh|bat|cmd|ps1|js|mjs|cjs|ts|html?|xhtml|svg|xml|jsp|asp|aspx)\./i.test(rawName)) {
    throw createUploadError(400, 'Nombre de archivo rechazado por seguridad (extensión doble no permitida).');
  }

  const base = basename(rawName);
  const ext = extname(base).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw createUploadError(
      400,
      'Formato no permitido. Solo se permiten imágenes JPG, JPEG, PNG, WEBP o GIF (SVG y ejecutables bloqueados).'
    );
  }

  const detectedType = detectImageMagicType(buffer);
  if (!detectedType) {
    throw createUploadError(
      400,
      'El contenido real del archivo no coincide con una imagen válida (JPG, PNG, WEBP o GIF).'
    );
  }

  const expectedType = EXTENSION_TO_MAGIC[ext];
  if (detectedType !== expectedType) {
    throw createUploadError(
      400,
      `La extensión ${ext} no corresponde al formato binario real (${detectedType.toUpperCase()}).`
    );
  }

  return { ext, detectedType, sizeBytes: buffer.length };
}

function buildSafeUniqueFilename(originalFilename, ext) {
  const baseNoExt = basename(String(originalFilename || ''), extname(String(originalFilename || '')));
  const cleanSlug = baseNoExt
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 50) || 'imagen';

  const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  return `${cleanSlug}-${uniqueSuffix}${ext}`;
}

export async function guardarImagenCarrusel(buffer, originalFilename, options = {}) {
  const maxBytes = options.maxBytes ?? env.carousel.maxFileSizeBytes;
  const { ext, sizeBytes } = validateImageUpload(buffer, originalFilename, maxBytes);

  const dir = resolveCarouselDir(options.carouselDir);
  await mkdir(dir, { recursive: true });

  const safeFilename = buildSafeUniqueFilename(originalFilename, ext);
  const resolvedDir = resolve(dir);
  const targetPath = resolve(resolvedDir, safeFilename);
  if (dirname(targetPath) !== resolvedDir) {
    throw createUploadError(400, 'Ruta de destino inválida.');
  }

  const tempPath = resolve(resolvedDir, `.upload-${crypto.randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tempPath, buffer, { mode: 0o644 });
  await rename(tempPath, targetPath);

  const info = await stat(targetPath);

  return {
    filename: safeFilename,
    url: `/img/carousel/${encodeURIComponent(safeFilename)}`,
    sizeBytes,
    updatedAt: new Date(info.mtimeMs).toISOString(),
    ext: ext.slice(1)
  };
}

export async function eliminarImagenCarrusel(filename, options = {}) {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > 255) {
    throw createUploadError(400, 'Nombre de imagen inválido.');
  }

  if (
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    filename.includes('\0') ||
    filename.startsWith('.')
  ) {
    throw createUploadError(400, 'Operación rechazada: ruta o nombre de archivo no permitido.');
  }

  if (basename(filename) !== filename) {
    throw createUploadError(400, 'Nombre de archivo inválido.');
  }

  const ext = extname(filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw createUploadError(400, 'Solo es posible eliminar archivos de imagen autorizados del carrusel.');
  }

  const resolvedDir = resolve(resolveCarouselDir(options.carouselDir));
  const targetPath = resolve(resolvedDir, filename);
  if (dirname(targetPath) !== resolvedDir) {
    throw createUploadError(403, 'Acceso denegado fuera del directorio del carrusel.');
  }

  let st;
  try {
    st = await lstat(targetPath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw createUploadError(404, 'La imagen solicitada no existe o ya fue eliminada.');
    }
    throw err;
  }

  if (!st.isFile() || st.isSymbolicLink()) {
    throw createUploadError(403, 'El recurso solicitado no es un archivo regular dentro del carrusel.');
  }

  await unlink(targetPath);
  return { deleted: true, filename };
}

/**
 * Obtiene la lista ordenada de imágenes del carrusel y sus firmas de modificación
 * (endpoint público usado por los televisores)
 */
export async function listarImagenesCarrusel(options = {}) {
  const dir = resolveCarouselDir(options.carouselDir);
  const images = [];
  const metadata = {};

  if (!existsSync(dir)) {
    return {
      success: true,
      images: [],
      metadata: {}
    };
  }

  const entries = await readdir(dir);
  for (const file of entries) {
    if (file === '.' || file === '..' || file.startsWith('.')) continue;
    const ext = extname(file).toLowerCase();
    if (ALLOWED_EXTENSIONS.has(ext)) {
      images.push(file);
      try {
        const info = await stat(join(dir, file));
        metadata[file] = `${Math.floor(info.mtimeMs)}|${info.size}`;
      } catch {
        metadata[file] = '0|0';
      }
    }
  }

  images.sort((a, b) => a.localeCompare(b));

  return {
    success: true,
    images,
    metadata
  };
}

/**
 * Obtiene listado detallado para la consola de administración de imágenes del carrusel.
 */
export async function listarImagenesCarruselDetallado(options = {}) {
  const dir = resolveCarouselDir(options.carouselDir);
  if (!existsSync(dir)) {
    return { success: true, images: [] };
  }

  const entries = await readdir(dir);
  const items = [];

  for (const file of entries) {
    if (file === '.' || file === '..' || file.startsWith('.')) continue;
    const ext = extname(file).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;

    const fullPath = join(dir, file);
    const st = await lstat(fullPath).catch(() => null);
    if (!st || !st.isFile() || st.isSymbolicLink()) continue;

    items.push({
      filename: file,
      url: `/img/carousel/${encodeURIComponent(file)}`,
      sizeBytes: st.size,
      updatedAt: new Date(st.mtimeMs).toISOString(),
      ext: ext.slice(1),
      protectedHint: /no\s+eliminar/i.test(file)
    });
  }

  items.sort((a, b) => a.filename.localeCompare(b.filename));
  return { success: true, images: items };
}
