import { env } from '../config/env.js';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  changeCarouselPassword,
  getCsrfCookieOptions,
  getSessionCookieOptions,
  loginCarouselUser,
  logoutCarouselSession,
  requireCarouselCsrf,
  requireCarouselPermission
} from '../services/carouselAuthService.js';
import {
  ALLOWED_EXTENSIONS,
  eliminarImagenCarrusel,
  guardarImagenCarrusel,
  listarImagenesCarruselDetallado
} from '../services/carouselService.js';

function getClientIp(request) {
  const xff = request.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim();
  }
  return request.ip || 'unknown';
}

function setNoCache(reply) {
  reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  reply.header('Pragma', 'no-cache');
}

export async function carouselAdminRoutes(fastify) {
  // 1. Inicio de sesión exclusivo para GESTOR_CARRUSEL
  const loginHandler = async (request, reply) => {
    setNoCache(reply);
    const username = request.body?.username ?? request.body?.uname ?? '';
    const password = request.body?.password ?? request.body?.pass ?? '';
    const ip = getClientIp(request);

    const result = await loginCarouselUser({ username, password, ip });
    if (!result.success) {
      if (result.statusCode === 429 && result.retryAfterSec) {
        reply.header('Retry-After', String(result.retryAfterSec));
      }
      return reply.code(result.statusCode || 401).send({
        success: false,
        error: result.error
      });
    }

    reply.setCookie(SESSION_COOKIE_NAME, result.sid, getSessionCookieOptions(request));
    reply.setCookie(CSRF_COOKIE_NAME, result.csrfToken, getCsrfCookieOptions(request));

    return {
      success: true,
      csrfToken: result.csrfToken,
      user: result.user
    };
  };

  // 2. Cierre de sesión seguro
  const logoutHandler = async (request, reply) => {
    setNoCache(reply);
    const session = await requireCarouselPermission(request, reply, null);
    if (!session) return;
    if (!requireCarouselCsrf(request, reply, session)) return;

    await logoutCarouselSession(session.sid);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    reply.clearCookie(CSRF_COOKIE_NAME, { path: '/' });

    return { success: true, message: 'Sesión cerrada correctamente.' };
  };

  // 3. Sesión actual del gestor de carrusel
  const meHandler = async (request, reply) => {
    setNoCache(reply);
    const session = await requireCarouselPermission(request, reply, 'carousel:read');
    if (!session) return;

    return {
      success: true,
      csrfToken: session.csrfToken,
      user: {
        username: session.username,
        role: session.role,
        permissions: session.permissions,
        mustChangePassword: Boolean(session.mustChangePassword)
      }
    };
  };

  // 4. Cambio de contraseña del gestor de carrusel (recomendado tras primer ingreso)
  const changePasswordHandler = async (request, reply) => {
    setNoCache(reply);
    const session = await requireCarouselPermission(request, reply, 'carousel:read');
    if (!session) return;
    if (!requireCarouselCsrf(request, reply, session)) return;

    const currentPassword = String(request.body?.currentPassword ?? '');
    const newPassword = String(request.body?.newPassword ?? '');

    const result = await changeCarouselPassword({
      username: session.username,
      currentPassword,
      newPassword
    });

    if (!result.success) {
      return reply.code(result.statusCode || 400).send(result);
    }

    return result;
  };

  // 5. Listar imágenes del carrusel con metadatos
  const listImagesHandler = async (request, reply) => {
    setNoCache(reply);
    const session = await requireCarouselPermission(request, reply, 'carousel:read');
    if (!session) return;

    const list = await listarImagenesCarruselDetallado();
    return {
      ...list,
      maxFileSizeBytes: env.carousel.maxFileSizeBytes,
      allowedExtensions: Array.from(ALLOWED_EXTENSIONS)
    };
  };

  // 6. Subir nueva imagen al carrusel
  const uploadImageHandler = async (request, reply) => {
    setNoCache(reply);
    const session = await requireCarouselPermission(request, reply, 'carousel:upload');
    if (!session) return;
    if (!requireCarouselCsrf(request, reply, session)) return;

    try {
      const filePart = await request.file();
      if (!filePart) {
        return reply.code(400).send({
          success: false,
          error: 'Debes seleccionar una imagen para subir.'
        });
      }

      const buffer = await filePart.toBuffer();
      if (filePart.file?.truncated) {
        const mb = (env.carousel.maxFileSizeBytes / (1024 * 1024)).toFixed(1);
        return reply.code(413).send({
          success: false,
          error: `La imagen supera el límite máximo permitido de ${mb} MB.`
        });
      }

      const saved = await guardarImagenCarrusel(buffer, filePart.filename);
      return reply.code(201).send({
        success: true,
        image: saved,
        message: 'Imagen agregada correctamente al carrusel.'
      });
    } catch (err) {
      if (err?.code === 'FST_REQ_FILE_TOO_LARGE' || err?.statusCode === 413) {
        const mb = (env.carousel.maxFileSizeBytes / (1024 * 1024)).toFixed(1);
        return reply.code(413).send({
          success: false,
          error: `La imagen supera el límite máximo permitido de ${mb} MB.`
        });
      }
      return reply.code(err?.statusCode || 400).send({
        success: false,
        error: err?.message || 'No fue posible procesar la imagen subida.'
      });
    }
  };

  // 7. Eliminar imagen existente del carrusel
  const deleteImageHandler = async (request, reply) => {
    setNoCache(reply);
    const session = await requireCarouselPermission(request, reply, 'carousel:delete');
    if (!session) return;
    if (!requireCarouselCsrf(request, reply, session)) return;

    let filename = '';
    try {
      filename = decodeURIComponent(String(request.params?.filename || ''));
    } catch {
      return reply.code(400).send({
        success: false,
        error: 'Nombre de archivo mal formado.'
      });
    }

    try {
      const res = await eliminarImagenCarrusel(filename);
      return {
        success: true,
        filename: res.filename,
        message: 'Imagen eliminada correctamente del carrusel.'
      };
    } catch (err) {
      return reply.code(err?.statusCode || 400).send({
        success: false,
        error: err?.message || 'No fue posible eliminar la imagen.'
      });
    }
  };

  for (const prefix of ['/carousel-admin', '/api/carousel-admin']) {
    fastify.post(`${prefix}/login`, loginHandler);
    fastify.post(`${prefix}/logout`, logoutHandler);
    fastify.get(`${prefix}/me`, meHandler);
    fastify.post(`${prefix}/change-password`, changePasswordHandler);
    fastify.get(`${prefix}/images`, listImagesHandler);
    fastify.post(`${prefix}/images`, uploadImageHandler);
    fastify.delete(`${prefix}/images/:filename`, deleteImageHandler);
  }
}
