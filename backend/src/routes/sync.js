import { env } from '../config/env.js';
import { getCarouselSessionFromRequest } from '../services/carouselAuthService.js';
import {
  ejecutarSincronizacionCompleta,
  evaluarYEjecutarSincronizacionSiCorresponde,
  getSyncStatus,
  reintentarSincronizacionPowerBiPendiente
} from '../services/syncPowerBiService.js';
import { verifyAdminToken } from './admin.js';

async function authorizeSyncRequest(request, reply) {
  const configuredToken = env.sync.syncApiToken;
  const headerToken =
    request.headers['x-sync-token'] ||
    (request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7).trim()
      : '');

  if (configuredToken && headerToken === configuredToken) {
    return true;
  }

  // Permitir token de sesión administrativa válida (ADMIN_RESULTADOS)
  if (headerToken && verifyAdminToken(headerToken)) {
    return true;
  }

  // Bloquear explícitamente al rol limitado GESTOR_CARRUSEL aunque envíe X-Requested-With
  const carouselSession = await getCarouselSessionFromRequest(request);
  if (carouselSession) {
    reply.code(403).send({
      success: false,
      error: 'Acceso denegado: el rol GESTOR_CARRUSEL únicamente puede administrar imágenes del carrusel.'
    });
    return false;
  }

  // Permitir disparo desde el Panel de Validación interno cuando incluye cabecera X-Requested-With
  if (request.headers['x-requested-with'] === 'XMLHttpRequest') {
    return true;
  }

  reply.code(401).send({
    success: false,
    error: 'No autorizado para ejecutar procesos de escritura/sincronización.'
  });
  return false;
}

export async function syncRoutes(fastify) {
  const triggerSyncHandler = async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!(await authorizeSyncRequest(request, reply))) return;

    const fechaParam = request.query?.fecha || request.body?.fecha || '';
    const urlResultadosParam = request.query?.url_resultados || request.body?.url_resultados || '';

    return await ejecutarSincronizacionCompleta({
      fechaParam,
      urlResultadosParam,
      trigger: 'manual'
    });
  };

  const retryPowerBiHandler = async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!(await authorizeSyncRequest(request, reply))) return;

    return await reintentarSincronizacionPowerBiPendiente({
      trigger: 'manual'
    });
  };

  const checkDueHandler = async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const evaluation = await evaluarYEjecutarSincronizacionSiCorresponde({
      trigger: 'public_visit',
      blocking: false
    });
    return {
      success: true,
      ...evaluation
    };
  };

  const statusSyncHandler = async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      success: true,
      ...getSyncStatus()
    };
  };

  fastify.post('/sync', triggerSyncHandler);
  fastify.get('/sync', triggerSyncHandler);
  fastify.post('/api/sync', triggerSyncHandler);
  fastify.get('/api/sync', triggerSyncHandler);
  fastify.get('/actualiza_baloto.php', triggerSyncHandler);
  fastify.post('/actualiza_baloto.php', triggerSyncHandler);

  fastify.post('/sync/retry-powerbi', retryPowerBiHandler);
  fastify.post('/api/sync/retry-powerbi', retryPowerBiHandler);

  fastify.get('/sync/check-due', checkDueHandler);
  fastify.post('/sync/check-due', checkDueHandler);
  fastify.get('/api/sync/check-due', checkDueHandler);
  fastify.post('/api/sync/check-due', checkDueHandler);

  fastify.get('/sync/status', statusSyncHandler);
  fastify.get('/api/sync/status', statusSyncHandler);
}
