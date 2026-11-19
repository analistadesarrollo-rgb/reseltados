import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { closeAllPools, sanitizeDbError } from './config/db.js';
import { env, getBogotaDateParts } from './config/env.js';
import { carouselAdminRoutes } from './routes/carouselAdmin.js';
import { healthRoutes } from './routes/health.js';
import { resultadosRoutes } from './routes/resultados.js';
import { syncRoutes } from './routes/sync.js';
import { initCarouselAuthStore } from './services/carouselAuthService.js';
import { seedCarouselIfNeeded } from './services/carouselService.js';
import {
  evaluarYEjecutarEtlSiCorresponde,
  initEtlState
} from './services/etlResultadosService.js';
import {
  evaluarYEjecutarSincronizacionSiCorresponde,
  initSyncState
} from './services/syncPowerBiService.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: env.logLevel
    },
    trustProxy: true
  });

  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
    credentials: true
  });

  await fastify.register(cookie);
  await fastify.register(formbody);
  await fastify.register(multipart, {
    limits: {
      fileSize: env.carousel.maxFileSizeBytes,
      files: 1
    }
  });

  // Manejo centralizado de excepciones sin exponer credenciales ni detalles internos sensibles
  fastify.setErrorHandler((error, request, reply) => {
    const safeMsg = sanitizeDbError(error);
    request.log.error({ err: safeMsg, url: request.url }, 'Error procesando solicitud');
    reply.status(error.statusCode || 500).send({
      success: false,
      error: safeMsg
    });
  });

  await fastify.register(healthRoutes);
  await fastify.register(resultadosRoutes);
  await fastify.register(syncRoutes);
  await fastify.register(carouselAdminRoutes);

  return fastify;
}

let autoSyncTimer = null;

async function startServer() {
  // Inicialización idempotente de almacenamiento persistente, usuario GESTOR_CARRUSEL, estado de sync y ETL
  await seedCarouselIfNeeded();
  await initCarouselAuthStore();
  await initSyncState();
  await initEtlState();

  const fastify = await buildServer();

  const shutdown = async (signal) => {
    fastify.log.info(`Señal ${signal} recibida. Cerrando servidor y pools de base de datos...`);
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer);
      autoSyncTimer = null;
    }
    await fastify.close().catch(() => {});
    await closeAllPools();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await fastify.listen({
    host: env.host,
    port: env.port
  });

  const bogota = getBogotaDateParts();
  fastify.log.info(
    `Servidor resultados-astro-api escuchando en http://${env.host}:${env.port} (TZ=${env.tz}, Hora=${bogota.isoDateTime})`
  );

  // Planificadores centrales en el backend (independientes del navegador; evalúan intervalos en America/Bogota)
  if (env.sync.autoSyncEnabled && env.sync.autoSyncOnStartup) {
    setTimeout(() => {
      evaluarYEjecutarSincronizacionSiCorresponde({
        trigger: 'startup',
        blocking: true
      })
        .then((res) => {
          fastify.log.info(
            { triggered: res.triggered, status: res.status, powerBiSyncedCount: res.powerBiSyncedCount },
            'Evaluación inicial de sincronización completada'
          );
        })
        .catch((err) => {
          fastify.log.warn({ err: sanitizeDbError(err) }, 'Error en evaluación inicial de sincronización');
        });
    }, 3000);
  }

  if (env.etl.enabled && env.etl.onStartup) {
    setTimeout(() => {
      evaluarYEjecutarEtlSiCorresponde({
        trigger: 'startup',
        blocking: true
      })
        .then((res) => {
          fastify.log.info(
            { triggered: res.triggered, status: res.status, sourceUsed: res.sourceUsed, rowsUpserted: res.rowsUpserted },
            'Evaluación inicial de ETL de loterías completada'
          );
        })
        .catch((err) => {
          fastify.log.warn({ err: sanitizeDbError(err) }, 'Error en evaluación inicial de ETL de loterías');
        });
    }, 4500);
  }

  if (env.sync.autoSyncEnabled || env.etl.enabled) {
    autoSyncTimer = setInterval(() => {
      if (env.sync.autoSyncEnabled) {
        evaluarYEjecutarSincronizacionSiCorresponde({
          trigger: 'scheduler',
          blocking: true
        })
          .then((res) => {
            if (res.triggered) {
              fastify.log.info(
                { status: res.status, powerBiSyncedCount: res.powerBiSyncedCount },
                'Sincronización programada completada'
              );
            }
          })
          .catch((err) => {
            fastify.log.warn({ err: sanitizeDbError(err) }, 'Error en sincronización programada');
          });
      }

      if (env.etl.enabled) {
        evaluarYEjecutarEtlSiCorresponde({
          trigger: 'scheduler',
          blocking: true
        })
          .then((res) => {
            if (res.triggered) {
              fastify.log.info(
                { status: res.status, sourceUsed: res.sourceUsed, rowsUpserted: res.rowsUpserted },
                'ETL programado de loterías completado'
              );
            }
          })
          .catch((err) => {
            fastify.log.warn({ err: sanitizeDbError(err) }, 'Error en ETL programado de loterías');
          });
      }
    }, env.sync.schedulerTickMs);

    autoSyncTimer.unref();
  }
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  startServer().catch((err) => {
    console.error('Error fatal al iniciar el servidor:', sanitizeDbError(err));
    process.exit(1);
  });
}
