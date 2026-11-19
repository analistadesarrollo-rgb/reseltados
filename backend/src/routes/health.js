import { checkDatabasesHealth } from '../config/db.js';
import { getBogotaDateParts } from '../config/env.js';
import { getSyncStatus } from '../services/syncPowerBiService.js';

export async function healthRoutes(fastify) {
  const healthHandler = async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'ok' };
  };

  const dependenciesHandler = async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const dbs = await checkDatabasesHealth();
    const sync = getSyncStatus();
    const bogota = getBogotaDateParts();

    const allHealthy = dbs.mainDb.available && dbs.powerBiDb.available;
    return {
      status: allHealthy ? 'ok' : 'degraded',
      timezone: 'America/Bogota',
      serverTime: bogota.isoDateTime,
      dependencies: {
        mainDatabase: dbs.mainDb,
        externalPowerBiDatabase: dbs.powerBiDb
      },
      sync: {
        inProgress: sync.inProgress,
        lastRunAt: sync.lastRunAt,
        lastSuccessAt: sync.lastSuccessAt,
        lastPowerBiSyncAt: sync.lastPowerBiSyncAt,
        nextScheduledAt: sync.nextScheduledAt,
        lastStatus: sync.status,
        durationMs: sync.durationMs,
        powerBiPendingRetry: sync.powerBiPendingRetry,
        lastPowerBiSyncedCount: sync.powerBiSyncedCount,
        databases: sync.databases
      }
    };
  };

  fastify.get('/health', healthHandler);
  fastify.get('/api/health', healthHandler);

  fastify.get('/health/dependencies', dependenciesHandler);
  fastify.get('/api/health/dependencies', dependenciesHandler);
  fastify.get('/health/db', dependenciesHandler);
  fastify.get('/api/health/db', dependenciesHandler);
}
