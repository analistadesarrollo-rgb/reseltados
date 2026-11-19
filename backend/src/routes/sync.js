import { env } from '../config/env.js';
import { getCarouselSessionFromRequest } from '../services/carouselAuthService.js';
import {
  ejecutarEtlResultados,
  evaluarYEjecutarEtlSiCorresponde,
  getEtlStatus
} from '../services/etlResultadosService.js';
import {
  ejecutarSincronizacionCompleta,
  evaluarYEjecutarSincronizacionSiCorresponde,
  getSyncStatus,
  reintentarSincronizacionPowerBiPendiente
} from '../services/syncPowerBiService.js';

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

    const [syncResult, etlResult] = await Promise.all([
      ejecutarSincronizacionCompleta({
        fechaParam,
        urlResultadosParam,
        trigger: 'manual'
      }),
      ejecutarEtlResultados({
        trigger: 'manual_sync'
      })
    ]);

    return {
      ...syncResult,
      success: Boolean(syncResult.success && etlResult.success),
      etl: etlResult
    };
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
    const [evaluation, etlCheck] = await Promise.all([
      evaluarYEjecutarSincronizacionSiCorresponde({
        trigger: 'public_visit',
        blocking: false
      }),
      evaluarYEjecutarEtlSiCorresponde({
        trigger: 'public_visit',
        blocking: false
      })
    ]);
    return {
      success: true,
      ...evaluation,
      etlCheck
    };
  };

  const statusSyncHandler = async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      success: true,
      ...getSyncStatus()
    };
  };

  const etlStatusHandler = async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      success: true,
      ...getEtlStatus()
    };
  };

  const etlRunHandler = async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!(await authorizeSyncRequest(request, reply))) return;

    return await ejecutarEtlResultados({
      trigger: 'manual'
    });
  };

  const etlCheckDueHandler = async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const evaluation = await evaluarYEjecutarEtlSiCorresponde({
      trigger: 'public_visit',
      blocking: false
    });
    return {
      success: true,
      ...evaluation
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

  fastify.get('/etl/status', etlStatusHandler);
  fastify.get('/api/etl/status', etlStatusHandler);

  fastify.post('/etl/run', etlRunHandler);
  fastify.post('/api/etl/run', etlRunHandler);

  fastify.get('/etl/check-due', etlCheckDueHandler);
  fastify.post('/etl/check-due', etlCheckDueHandler);
  fastify.get('/api/etl/check-due', etlCheckDueHandler);
  fastify.post('/api/etl/check-due', etlCheckDueHandler);
}
