import { getBogotaDateParts } from '../config/env.js';
import { listarImagenesCarrusel } from '../services/carouselService.js';
import {
  getFechasTablero,
  obtenerDatosCompletos,
  obtenerResultadosAcumulados
} from '../services/resultadosService.js';
import { evaluarYEjecutarSincronizacionSiCorresponde } from '../services/syncPowerBiService.js';

function setNoCacheHeaders(reply) {
  reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  reply.header('Pragma', 'no-cache');
  reply.header('Expires', '0');
}

export async function resultadosRoutes(fastify) {
  // 1. Tablero completo (equivalente a obtener_datos.php) + evaluación opcional al abrir TV/URL pública
  const datosHandler = async (request, reply) => {
    setNoCacheHeaders(reply);

    let syncCheck = null;
    if (request.query?.checkSync === '1') {
      try {
        syncCheck = await evaluarYEjecutarSincronizacionSiCorresponde({
          trigger: 'public_visit',
          blocking: false
        });
      } catch {
        // Nunca bloquear la carga del tablero si falla la evaluación automática
      }
    }

    const clientHash = request.query?.hash;
    const result = await obtenerDatosCompletos();

    if (result.success && clientHash && result.hash === clientHash) {
      return {
        success: true,
        unchanged: true,
        hash: result.hash,
        fechas: result.fechas,
        timestamp: result.timestamp,
        fecha_consulta: result.fecha_consulta,
        ...(syncCheck ? { syncCheck } : {})
      };
    }

    return {
      ...result,
      ...(syncCheck ? { syncCheck } : {})
    };
  };

  fastify.get('/datos', datosHandler);
  fastify.get('/api/datos', datosHandler);
  fastify.get('/obtener_datos.php', datosHandler);

  // 2. Acumulados y Baloto/Revancha (equivalente a obtener_resultados.php)
  const resultadosHandler = async (_request, reply) => {
    setNoCacheHeaders(reply);
    return await obtenerResultadosAcumulados();
  };

  fastify.get('/resultados', resultadosHandler);
  fastify.get('/api/resultados', resultadosHandler);
  fastify.get('/obtener_resultados.php', resultadosHandler);

  // 3. Reloj y fecha del servidor en America/Bogota (equivalente a get_server_time.php)
  const timeHandler = async (_request, reply) => {
    setNoCacheHeaders(reply);
    const now = new Date();
    const parts = getBogotaDateParts(now);
    const fechas = getFechasTablero(now);

    return {
      success: true,
      timestamp: Math.floor(now.getTime() / 1000),
       timestampMs: now.getTime(),
      datetime: parts.isoDateTime,
      timezone: 'America/Bogota',
      fechas
    };
  };

  fastify.get('/time', timeHandler);
  fastify.get('/api/time', timeHandler);
  fastify.get('/get_server_time.php', timeHandler);

  // 4. Lista de imágenes del carrusel (equivalente a list_carousel_images.php)
  const carouselHandler = async (_request, reply) => {
    setNoCacheHeaders(reply);
    return await listarImagenesCarrusel();
  };

  fastify.get('/carousel-images', carouselHandler);
  fastify.get('/api/carousel-images', carouselHandler);
  fastify.get('/list_carousel_images.php', carouselHandler);
}
