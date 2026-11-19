import { env } from '../config/env.js';
import { ejecutarSincronizacionCompleta, getSyncStatus } from '../services/syncPowerBiService.js';
import { verifyAdminToken } from './admin.js';

function isAuthorizedSyncRequest(request) {
  const configuredToken = env.sync.syncApiToken;
  const headerToken =
    request.headers['x-sync-token'] ||
    (request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7).trim()
      : '');

  if (configuredToken && headerToken === configuredToken) {
    return true;
  }

  // Permitir token de sesión administrativa válida
  if (headerToken && verifyAdminToken(headerToken)) {
    return true;
  }

  // Permitir disparo desde el Panel de Validación interno cuando incluye cabecera X-Requested-With
  const xRequestedWith = request.headers['x-requested-with'];
  if (xRequestedWith === 'XMLHttpRequest') {
    return true;
  }

  return false;
}

export async function syncRoutes(fastify) {
  const triggerSyncHandler = async (request, reply) => {
    reply.header('Cache-Control', 'no-store');

    if (!isAuthorizedSyncRequest(request)) {
      return reply.code(401).send({
        success: false,
        error: 'No autorizado para ejecutar procesos de escritura/sincronización.'
      });
    }

    const fechaParam = request.query?.fecha || request.body?.fecha || '';
    const urlResultadosParam = request.query?.url_resultados || request.body?.url_resultados || '';

    const result = await ejecutarSincronizacionCompleta({
      fechaParam,
      urlResultadosParam
    });

    return result;
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

  fastify.get('/sync/status', statusSyncHandler);
  fastify.get('/api/sync/status', statusSyncHandler);
}
