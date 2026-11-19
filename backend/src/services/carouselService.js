import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function resolveCarouselDir() {
  const candidates = [
    resolve(process.cwd(), env.carousel.imagesDir),
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

/**
 * Obtiene la lista ordenada de imágenes del carrusel y sus firmas de modificación
 */
export async function listarImagenesCarrusel() {
  const dir = resolveCarouselDir();
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
    if (file === '.' || file === '..') continue;
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
