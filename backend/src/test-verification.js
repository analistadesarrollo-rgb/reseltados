import assert from 'node:assert/strict';
import { checkDatabasesHealth, closeAllPools, getPowerBiPool } from './config/db.js';
import { buildServer } from './server.js';
import { extraerFuentesExternas } from './services/scraperService.js';
import { upsertInfoResultado } from './services/syncPowerBiService.js';

async function runTests() {
  console.log('======================================================================');
  console.log('PRUEBAS DE VERIFICACIÓN REAL - SISTEMA DE RESULTADOS ASTRO + NODE.JS');
  console.log('======================================================================\n');

  const fastify = await buildServer();
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  // 1. Endpoint /health
  await test('GET /health retorna {"status":"ok"} (HTTP 200)', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  });

  // 2. Endpoint /api/health (compatibilidad con y sin rewrite Nginx)
  await test('GET /api/health retorna {"status":"ok"} (HTTP 200)', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
  });

  // 3. Conectividad real de bases de datos (Principal MariaDB + Externa PowerBI MySQL 8)
  await test('Conectividad real a BD Principal (172.20.1.92) y BD Externa PowerBI (aplicacionesgane.cloud:5010)', async () => {
    const health = await checkDatabasesHealth();
    console.log('     -> Main DB:', JSON.stringify(health.mainDb));
    console.log('     -> PowerBI DB:', JSON.stringify(health.powerBiDb));
    assert.equal(health.mainDb.available, true, 'BD Principal no disponible');
    assert.equal(health.powerBiDb.available, true, 'BD Externa PowerBI no disponible');
  });

  // 4. Consulta completa de resultados (/api/datos)
  let datosHash = null;
  await test('GET /api/datos retorna 20 Loterías Oficiales, Sorteos Diarios, Resumen Semanal, Acumulados, Baloto y Revancha', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/datos' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.ok(body.hash, 'Falta hash de control de cambios');
    datosHash = body.hash;

    const oficialesCount = Object.keys(body.data.loteriaOficial).length;
    const diariosCount = Object.keys(body.data.sorteosDiarios).length;
    const semanalCount = Object.keys(body.data.resumenSemanal).length;

    console.log(`     -> Loterías Oficiales: ${oficialesCount}/20 | Sorteos Diarios: ${diariosCount}/22 | Resumen Semanal: ${semanalCount}/5`);
    console.log(`     -> Baloto: ${Object.values(body.data.baloto).join('-')} | Acum: $${body.data.acumulados.acum_baloto}`);
    console.log(`     -> Revancha: ${Object.values(body.data.revancha).join('-')} | Acum: $${body.data.acumulados.acum_revancha}`);
    console.log(`     -> Doble Chance 3C: $${body.data.acumulados.acum_3cifras} | 4C: $${body.data.acumulados.acum_4cifras} | ChM: $${body.data.acumulados.acum_chmillonario}`);

    assert.equal(oficialesCount, 20, 'Se esperaban 20 loterías oficiales');
    assert.ok(diariosCount >= 20, 'Se esperaban al menos 20 sorteos diarios');
    assert.equal(semanalCount, 5, 'Se esperaban 5 filas de resumen semanal');
    assert.ok(body.data.baloto.resul_baloto1, 'Falta baloto 1');
    assert.ok(body.data.revancha.resul_revancha1, 'Falta revancha 1');
  });

  // 5. Control de caché por hash (evita transferencia redundante si no hay cambios)
  await test('GET /api/datos?hash=<actual> retorna unchanged: true', async () => {
    const res = await fastify.inject({ method: 'GET', url: `/api/datos?hash=${datosHash}` });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.unchanged, true);
  });

  // 6. Reloj y fecha en zona horaria America/Bogota
  await test('GET /api/time retorna hora y fechas en zona horaria America/Bogota', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/time' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.timezone, 'America/Bogota');
    assert.ok(body.fechas.diaSemana);
    assert.ok(body.fechas.fechaActual);
    assert.ok(body.fechas.ultimoSorteo.diaSemana);
    console.log(`     -> Hora Colombia: ${body.datetime} | ${body.fechas.diaSemana} ${body.fechas.fechaActual} | Último Sorteo: ${body.fechas.ultimoSorteo.diaSemana} ${body.fechas.ultimoSorteo.diaNumero} ${body.fechas.ultimoSorteo.mesNombre} ${body.fechas.ultimoSorteo.anio}`);
  });

  // 7. Lista de imágenes del carrusel
  await test('GET /api/carousel-images lista imágenes reales de img/carousel', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/carousel-images' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.images) && body.images.length > 0, 'No se encontraron imágenes del carrusel');
    console.log(`     -> Imágenes del carrusel detectadas: ${body.images.length}`);
  });

  // 8. Protección de escritura en /api/sync
  await test('POST /api/sync sin autorización retorna HTTP 401', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/api/sync' });
    assert.equal(res.statusCode, 401);
  });

  // 9. Extracción real de fuentes externas (Baloto, Revancha, MiLoto, ColorLOTO, Chance Millonario, Doble Chance)
  await test('Extracción externa real (Baloto, Revancha, MiLoto, ColorLOTO, Chance Millonario, Doble Chance)', async () => {
    const { results } = await extraerFuentesExternas();
    console.log(`     -> Baloto: ${results.numerosBaloto.join('-')} ($${results.acumuladoBaloto})`);
    console.log(`     -> Revancha: ${results.numerosRevancha.join('-')} ($${results.acumuladoRevancha})`);
    console.log(`     -> MiLoto: ${results.resultadoMiloto} | ColorLOTO: ${results.resultadoColorloto}`);
    console.log(`     -> Doble Chance: 3C=${results.acumulado3Cifras} | 4C=${results.acumulado4Cifras} | ChM=${results.acumuladoChance}`);
    assert.equal(results.numerosBaloto.length, 6, 'No se extrajeron 6 balotas de Baloto');
    assert.equal(results.numerosRevancha.length, 6, 'No se extrajeron 6 balotas de Revancha');
    assert.ok(results.resultadoMiloto, 'No se extrajo resultado MiLoto');
    assert.ok(results.resultadoColorloto, 'No se extrajo resultado ColorLOTO');
  });

  // 10. Prueba no destructiva de INSERT + UPDATE + Prevención de duplicados en POWERBI.INFORESULTADOS (con ROLLBACK)
  await test('Prueba transaccional no destructiva (INSERT + UPDATE + sin duplicados) en POWERBI.INFORESULTADOS (con ROLLBACK)', async () => {
    const pool = getPowerBiPool();
    const conn = await pool.getConnection();
    const testDate = '2099-12-31';
    const testCode = '9999';

    try {
      await conn.beginTransaction();

      // Inserción inicial
      await upsertInfoResultado(conn, {
        fecha: testDate,
        codigo: testCode,
        loteria: 'PRUEBA VERIFICACION',
        nombrecorto: 'TEST1',
        resultado: '01-02-03-04-05',
        serie: '09',
        horacierre: null,
        version: 'WS-SCRAPER-2.0'
      });

      const [rowsAfterInsert] = await conn.execute(
        'SELECT * FROM INFORESULTADOS WHERE FECHA = ? AND CODIGO = ?',
        [testDate, testCode]
      );
      assert.equal(rowsAfterInsert.length, 1, 'Debe existir exactamente 1 registro tras INSERT');
      assert.equal(rowsAfterInsert[0].RESULTADO, '01-02-03-04-05');

      // Actualización atómica sobre la misma clave (FECHA, CODIGO) -> no debe duplicar
      await upsertInfoResultado(conn, {
        fecha: testDate,
        codigo: testCode,
        loteria: 'PRUEBA VERIFICACION',
        nombrecorto: 'TEST1',
        resultado: '10-20-30-40-43',
        serie: '12',
        horacierre: null,
        version: 'WS-SCRAPER-2.0'
      });

      const [rowsAfterUpdate] = await conn.execute(
        'SELECT * FROM INFORESULTADOS WHERE FECHA = ? AND CODIGO = ?',
        [testDate, testCode]
      );
      assert.equal(rowsAfterUpdate.length, 1, 'No deben existir duplicados tras UPDATE atómico');
      assert.equal(rowsAfterUpdate[0].RESULTADO, '10-20-30-40-43');
      assert.equal(rowsAfterUpdate[0].SERIE, '12');

      // Revertir transacción para dejar la BD de producción 100% intacta
      await conn.rollback();
      console.log('     -> INSERT, UPDATE y prevención de duplicados validados y revertidos limpiamente (ROLLBACK).');
    } finally {
      conn.release();
    }
  });

  await fastify.close();
  await closeAllPools();

  console.log('\n======================================================================');
  console.log(`RESUMEN DE PRUEBAS: ${passed} aprobadas, ${failed} fallidas.`);
  console.log('======================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Error fatal ejecutando suite de pruebas:', err);
  process.exit(1);
});
