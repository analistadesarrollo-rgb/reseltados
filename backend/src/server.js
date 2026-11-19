import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { closeAllPools, sanitizeDbError } from './config/db.js';
import { env, getBogotaDateParts } from './config/env.js';
import { adminRoutes } from './routes/admin.js';
import { healthRoutes } from './routes/health.js';
import { resultadosRoutes } from './routes/resultados.js';
import { syncRoutes } from './routes/sync.js';
import { ejecutarSincronizacionCompleta } from './services/syncPowerBiService.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: env.logLevel
    },
    trustProxy: true
  });

  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'HEAD', 'OPTIONS']
  });

  await fastify.register(formbody);

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
  await fastify.register(adminRoutes);

  return fastify;
}

let autoSyncTimer = null;

async function startServer() {
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

  // Planificador de sincronización automática en segundo plano (actualiza_baloto + INFORESULTADOS PowerBI)
  if (env.sync.autoSyncEnabled) {
    if (env.sync.autoSyncOnStartup) {
      setTimeout(() => {
        ejecutarSincronizacionCompleta()
          .then((res) => {
            fastify.log.info(
              { status: res.status, powerBiSyncedCount: res.powerBiSyncedCount },
              'Sincronización inicial completada'
            );
          })
          .catch((err) => {
            fastify.log.warn({ err: sanitizeDbError(err) }, 'Error en sincronización inicial');
          });
      }, 3000);
    }

    autoSyncTimer = setInterval(() => {
      ejecutarSincronizacionCompleta()
        .then((res) => {
          fastify.log.info(
            { status: res.status, powerBiSyncedCount: res.powerBiSyncedCount },
            'Sincronización periódica completada'
          );
        })
        .catch((err) => {
          fastify.log.warn({ err: sanitizeDbError(err) }, 'Error en sincronización periódica');
        });
    }, env.sync.autoSyncIntervalMs);

    autoSyncTimer.unref();
  }
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  startServer().catch((err) => {
    console.error('Error fatal al iniciar el servidor:', sanitizeDbError(err));
    process.exit(1);
  });
}
