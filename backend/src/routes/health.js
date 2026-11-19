import { checkDatabasesHealth } from '../config/db.js';
import { getBogotaDateParts } from '../config/env.js';
import { getEtlStatus, getOracleSourceDiagnostics } from '../services/etlResultadosService.js';
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
    const etl = getEtlStatus();
    const oracleDiag = getOracleSourceDiagnostics();
    const bogota = getBogotaDateParts();

    const allHealthy = dbs.mainDb.available && dbs.powerBiDb.available;
    return {
      status: allHealthy ? 'ok' : 'degraded',
      timezone: 'America/Bogota',
      serverTime: bogota.isoDateTime,
      dependencies: {
        mainDatabase: dbs.mainDb,
        externalPowerBiDatabase: dbs.powerBiDb,
        oracleEtlSource: oracleDiag
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
      },
      etl: {
        enabled: etl.enabled,
        inProgress: etl.inProgress,
        schedule: etl.schedule,
        sourceMode: etl.sourceMode,
        sourceUsed: etl.sourceUsed,
        lastRunAt: etl.lastRunAt,
        lastSuccessAt: etl.lastSuccessAt,
        lastCompletedSlotKey: etl.lastCompletedSlotKey,
        nextScheduledAt: etl.nextScheduledAt,
        lastStatus: etl.status,
        rowsExtracted: etl.rowsExtracted,
        rowsUpserted: etl.rowsUpserted,
        durationMs: etl.durationMs
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
