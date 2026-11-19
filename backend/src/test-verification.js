import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Aislar el almacenamiento persistente de pruebas en un directorio temporal antes de importar env/server
const testTempRoot = await mkdtemp(join(tmpdir(), 'resultados-astro-test-'));
const isolatedDataDir = join(testTempRoot, 'data');
process.env.APP_DATA_DIR = isolatedDataDir;

const { checkDatabasesHealth, closeAllPools, getMainPool, getPowerBiPool } = await import('./config/db.js');
const { env } = await import('./config/env.js');
const { buildServer } = await import('./server.js');
const {
  SESSION_COOKIE_NAME,
  clearRateLimitStoreForTests,
  initCarouselAuthStore
} = await import('./services/carouselAuthService.js');
const {
  guardarImagenCarrusel,
  listarImagenesCarrusel,
  seedCarouselIfNeeded
} = await import('./services/carouselService.js');
const { extraerFuentesExternas } = await import('./services/scraperService.js');
const {
  ejecutarSincronizacionCompleta,
  evaluarYEjecutarSincronizacionSiCorresponde,
  getSyncStatus,
  initSyncState,
  reintentarSincronizacionPowerBiPendiente,
  upsertInfoResultado
} = await import('./services/syncPowerBiService.js');

// PNG válido mínimo (1x1 px transparente) con firma mágica binaria real
const VALID_PNG_BUFFER = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

function buildMultipartPayload(fieldName, filename, mimeType, fileBuffer) {
  const boundary = `----AstroTestBoundary${crypto.randomBytes(6).toString('hex')}`;
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([header, fileBuffer, footer])
  };
}

function extractCookies(res) {
  const map = {};
  const setCookie = res.headers['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      map[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
  }
  return { map, rawList: list };
}

async function runTests() {
  console.log('======================================================================');
  console.log('PRUEBAS DE VERIFICACIÓN REAL - RESULTADOS ASTRO + NODE.JS (COMPLETA)');
  console.log('======================================================================\n');

  const testInitialPassword = env.carouselAdmin.initialPassword || 'TestCarouselPass#2026';
  await seedCarouselIfNeeded({ dataDir: isolatedDataDir });
  await initCarouselAuthStore({ dataDir: isolatedDataDir, initialPassword: testInitialPassword });
  await initSyncState({ dataDir: isolatedDataDir });

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

  try {
    // 1. Health endpoints
    await test('GET /health y /api/health retornan {"status":"ok"} (HTTP 200)', async () => {
      const r1 = await fastify.inject({ method: 'GET', url: '/health' });
      const r2 = await fastify.inject({ method: 'GET', url: '/api/health' });
      assert.equal(r1.statusCode, 200);
      assert.deepEqual(r1.json(), { status: 'ok' });
      assert.equal(r2.statusCode, 200);
      assert.deepEqual(r2.json(), { status: 'ok' });
    });

    // 2. Conectividad real de bases de datos + GET /api/health/db
    await test('Conectividad real a BD Principal y PowerBI + GET /api/health/db', async () => {
      const health = await checkDatabasesHealth();
      console.log('     -> Main DB:', JSON.stringify(health.mainDb));
      console.log('     -> PowerBI DB:', JSON.stringify(health.powerBiDb));
      assert.equal(health.mainDb.available, true, 'BD Principal no disponible');
      assert.equal(health.powerBiDb.available, true, 'BD Externa PowerBI no disponible');

      const res = await fastify.inject({ method: 'GET', url: '/api/health/db' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().timezone, 'America/Bogota');
    });

    // 3. Consulta completa de resultados (/api/datos) y control por hash
    let datosHash = null;
    await test('GET /api/datos retorna tablero completo y soporta cache por hash', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/api/datos' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.success, true);
      assert.ok(body.hash);
      datosHash = body.hash;

      const oficialesCount = Object.keys(body.data.loteriaOficial).length;
      const diariosCount = Object.keys(body.data.sorteosDiarios).length;
      const semanalCount = Object.keys(body.data.resumenSemanal).length;

      assert.equal(oficialesCount, 20, 'Se esperaban 20 loterías oficiales');
      assert.ok(diariosCount >= 20, 'Se esperaban al menos 20 sorteos diarios');
      assert.equal(semanalCount, 5, 'Se esperaban 5 filas de resumen semanal');
      assert.ok(body.data.baloto.resul_baloto1);
      assert.ok(body.data.revancha.resul_revancha1);

      const resCached = await fastify.inject({ method: 'GET', url: `/api/datos?hash=${datosHash}` });
      assert.equal(resCached.statusCode, 200);
      assert.equal(resCached.json().unchanged, true);
    });

    // 4. Reloj y fecha en zona horaria America/Bogota
    await test('GET /api/time retorna hora y fechas en zona horaria America/Bogota', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/api/time' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.success, true);
      assert.equal(body.timezone, 'America/Bogota');
      assert.ok(body.fechas.diaSemana);
      assert.ok(body.fechas.ultimoSorteo.diaSemana);
    });

    // 5. Protección de escritura sin autorización en /api/sync
    await test('POST /api/sync sin autorización retorna HTTP 401', async () => {
      const res = await fastify.inject({ method: 'POST', url: '/api/sync' });
      assert.equal(res.statusCode, 401);
    });

    // 6. Inicialización idempotente del usuario admin y semilla persistente del carrusel
    await test('Inicialización idempotente de usuario admin y persistencia de carrusel ante reinicios', async () => {
      const secondInit = await initCarouselAuthStore({ dataDir: isolatedDataDir, initialPassword: testInitialPassword });
      assert.equal(secondInit.initialized, false);
      assert.equal(secondInit.reason, 'already_exists');

      // Simular volumen persistente aislado con seed + borrado + reinicio
      const simSeed = join(testTempRoot, 'sim-seed');
      const simCarousel = join(testTempRoot, 'sim-carousel');
      const simData = join(testTempRoot, 'sim-data');
      await mkdir(simSeed, { recursive: true });
      await writeFile(join(simSeed, 'uno.png'), VALID_PNG_BUFFER);
      await writeFile(join(simSeed, 'dos.png'), VALID_PNG_BUFFER);

      const r1 = await seedCarouselIfNeeded({ carouselDir: simCarousel, seedDir: simSeed, dataDir: simData });
      assert.equal(r1.seeded, true);
      assert.equal(r1.copiedCount, 2);

      // Eliminar una imagen y agregar otra nueva
      await rm(join(simCarousel, 'uno.png'));
      const savedExtra = await guardarImagenCarrusel(VALID_PNG_BUFFER, 'nueva-promo.png', { carouselDir: simCarousel });
      assert.ok(savedExtra.filename.endsWith('.png'));

      // Simular segundo arranque del contenedor Docker -> NO debe resucitar uno.png ni borrar nueva-promo.png
      const r2 = await seedCarouselIfNeeded({ carouselDir: simCarousel, seedDir: simSeed, dataDir: simData });
      assert.equal(r2.seeded, false);
      const filesAfterRestart = await readdir(simCarousel);
      assert.equal(filesAfterRestart.includes('uno.png'), false, 'La imagen eliminada NO debe reaparecer tras reinicio');
      assert.equal(filesAfterRestart.includes('dos.png'), true);
      assert.equal(filesAfterRestart.includes(savedExtra.filename), true);
    });

    // 7. Login admin (GESTOR_CARRUSEL), cookies seguras y aislamiento absoluto de permisos
    let sessionCookieHeader = '';
    let csrfToken = '';
    await test('Login de admin (GESTOR_CARRUSEL), cookies HttpOnly/SameSite/Secure y aislamiento RBAC (HTTP 403)', async () => {
      const initialPassword = testInitialPassword;

      // Comprobar flag Secure cuando llega por HTTPS (proxy)
      const resHttps = await fastify.inject({
        method: 'POST',
        url: '/api/carousel-admin/login',
        headers: { 'x-forwarded-proto': 'https', 'content-type': 'application/json' },
        payload: { username: 'admin', password: initialPassword }
      });
      assert.equal(resHttps.statusCode, 200);
      const httpsCookies = extractCookies(resHttps);
      const sidCookieStr = httpsCookies.rawList.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)) || '';
      assert.match(sidCookieStr, /HttpOnly/i);
      assert.match(sidCookieStr, /SameSite=Lax/i);
      assert.match(sidCookieStr, /Secure/i);

      const body = resHttps.json();
      assert.equal(body.success, true);
      assert.equal(body.user.username, 'admin');
      assert.equal(body.user.role, 'GESTOR_CARRUSEL');
      assert.equal(body.user.mustChangePassword, true);
      csrfToken = body.csrfToken;
      sessionCookieHeader = `${SESSION_COOKIE_NAME}=${httpsCookies.map[SESSION_COOKIE_NAME]}`;

      // Verificar /me
      const meRes = await fastify.inject({
        method: 'GET',
        url: '/api/carousel-admin/me',
        headers: { cookie: sessionCookieHeader }
      });
      assert.equal(meRes.statusCode, 200);

      // Verificar que las rutas eliminadas de /admin retornan 404
      for (const removedEp of [
        { method: 'POST', url: '/api/admin/login', payload: { uname: 'test', pass: 'test' } },
        { method: 'GET', url: '/api/admin/acumulados' }
      ]) {
        const res404 = await fastify.inject({
          method: removedEp.method,
          url: removedEp.url,
          headers: removedEp.payload ? { 'content-type': 'application/json' } : {},
          payload: removedEp.payload
        });
        assert.equal(res404.statusCode, 404, `Ruta eliminada ${removedEp.url} debería retornar 404`);
      }

      // Comprobar que GESTOR_CARRUSEL tiene acceso bloqueado con 403 en endpoints de sincronización
      const blockedEndpoints = [
        { method: 'POST', url: '/api/sync', headers: { 'x-requested-with': 'XMLHttpRequest' } },
        { method: 'POST', url: '/api/sync/retry-powerbi', headers: { 'x-requested-with': 'XMLHttpRequest' } }
      ];

      for (const ep of blockedEndpoints) {
        const blockedRes = await fastify.inject({
          method: ep.method,
          url: ep.url,
          headers: {
            cookie: sessionCookieHeader,
            ...(ep.headers || {})
          }
        });
        assert.equal(
          blockedRes.statusCode,
          403,
          `GESTOR_CARRUSEL debería recibir 403 en ${ep.method} ${ep.url}, recibió ${blockedRes.statusCode}`
        );
      }
    });

    // 8. Subida válida, reflejo en carrusel público, rechazo de archivos peligrosos, CSRF y eliminación
    await test('Gestión completa de imágenes (CSRF, validación mágica, reflejo en carrusel público, path traversal y borrado)', async () => {
      const beforePublic = await listarImagenesCarrusel();
      const initialCount = beforePublic.images.length;

      // CSRF obligatorio en escritura
      const mpNoCsrf = buildMultipartPayload('image', 'test-no-csrf.png', 'image/png', VALID_PNG_BUFFER);
      const resNoCsrf = await fastify.inject({
        method: 'POST',
        url: '/api/carousel-admin/images',
        headers: { cookie: sessionCookieHeader, 'content-type': mpNoCsrf.contentType },
        payload: mpNoCsrf.payload
      });
      assert.equal(resNoCsrf.statusCode, 403);

      // Rechazar SVG peligroso
      const mpSvg = buildMultipartPayload(
        'image',
        'xss.svg',
        'image/svg+xml',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
      );
      const resSvg = await fastify.inject({
        method: 'POST',
        url: '/api/carousel-admin/images',
        headers: {
          cookie: sessionCookieHeader,
          'x-csrf-token': csrfToken,
          'content-type': mpSvg.contentType
        },
        payload: mpSvg.payload
      });
      assert.equal(resSvg.statusCode, 400);

      // Rechazar HTML camuflado como .png (validación real de magic bytes)
      const mpFakePng = buildMultipartPayload(
        'image',
        'malicioso.png',
        'image/png',
        Buffer.from('<html><script>alert(1)</script></html>')
      );
      const resFake = await fastify.inject({
        method: 'POST',
        url: '/api/carousel-admin/images',
        headers: {
          cookie: sessionCookieHeader,
          'x-csrf-token': csrfToken,
          'content-type': mpFakePng.contentType
        },
        payload: mpFakePng.payload
      });
      assert.equal(resFake.statusCode, 400);

      // Rechazar path traversal al eliminar
      const resTraversal = await fastify.inject({
        method: 'DELETE',
        url: '/api/carousel-admin/images/..%2Fresult-fondo.png',
        headers: { cookie: sessionCookieHeader, 'x-csrf-token': csrfToken }
      });
      assert.equal(resTraversal.statusCode, 400);

      // Subida válida de PNG auténtico
      let uploadedName = null;
      try {
        const mpOk = buildMultipartPayload('image', 'promo verificación 2026.png', 'image/png', VALID_PNG_BUFFER);
        const resUpload = await fastify.inject({
          method: 'POST',
          url: '/api/carousel-admin/images',
          headers: {
            cookie: sessionCookieHeader,
            'x-csrf-token': csrfToken,
            'content-type': mpOk.contentType
          },
          payload: mpOk.payload
        });
        assert.equal(resUpload.statusCode, 201);
        const upBody = resUpload.json();
        assert.equal(upBody.success, true);
        uploadedName = upBody.image.filename;

        // Verificar reflejo inmediato en galería admin y en carrusel público
        const adminListRes = await fastify.inject({
          method: 'GET',
          url: '/api/carousel-admin/images',
          headers: { cookie: sessionCookieHeader }
        });
        assert.equal(adminListRes.statusCode, 200);
        assert.ok(adminListRes.json().images.some((i) => i.filename === uploadedName));

        const publicRes = await fastify.inject({ method: 'GET', url: '/api/carousel-images' });
        assert.equal(publicRes.statusCode, 200);
        assert.ok(publicRes.json().images.includes(uploadedName));
        assert.equal(publicRes.json().images.length, initialCount + 1);

        // Eliminar imagen subida
        const delRes = await fastify.inject({
          method: 'DELETE',
          url: `/api/carousel-admin/images/${encodeURIComponent(uploadedName)}`,
          headers: { cookie: sessionCookieHeader, 'x-csrf-token': csrfToken }
        });
        assert.equal(delRes.statusCode, 200);
        uploadedName = null;

        // Verificar que desapareció del carrusel público y las 12 originales siguen intactas
        const publicAfterDel = await fastify.inject({ method: 'GET', url: '/api/carousel-images' });
        assert.equal(publicAfterDel.json().images.length, initialCount);
      } finally {
        if (uploadedName) {
          await fastify.inject({
            method: 'DELETE',
            url: `/api/carousel-admin/images/${encodeURIComponent(uploadedName)}`,
            headers: { cookie: sessionCookieHeader, 'x-csrf-token': csrfToken }
          }).catch(() => {});
        }
      }
    });

    // 9. Cambio de contraseña, persistencia ante reinicio simulado, logout y protección fuerza bruta
    await test('Cambio de contraseña persistente, cierre de sesión y bloqueo por intentos repetidos (HTTP 429)', async () => {
      const initialPassword = testInitialPassword;
      const newPass = 'GaneSegura2026!';

      const pwdRes = await fastify.inject({
        method: 'POST',
        url: '/api/carousel-admin/change-password',
        headers: {
          cookie: sessionCookieHeader,
          'x-csrf-token': csrfToken,
          'content-type': 'application/json'
        },
        payload: { currentPassword: initialPassword, newPassword: newPass }
      });
      assert.equal(pwdRes.statusCode, 200);

      // Simular reinicio del servidor: initCarouselAuthStore NO debe restablecer la contraseña inicial
      const reinitRes = await initCarouselAuthStore({ dataDir: isolatedDataDir });
      assert.equal(reinitRes.reason, 'already_exists');

      // Logout
      const logoutRes = await fastify.inject({
        method: 'POST',
        url: '/api/carousel-admin/logout',
        headers: { cookie: sessionCookieHeader, 'x-csrf-token': csrfToken }
      });
      assert.equal(logoutRes.statusCode, 200);

      const meAfterLogout = await fastify.inject({
        method: 'GET',
        url: '/api/carousel-admin/me',
        headers: { cookie: sessionCookieHeader }
      });
      assert.equal(meAfterLogout.statusCode, 401);

      // Login con la nueva contraseña funciona y mustChangePassword es false
      const loginNewRes = await fastify.inject({
        method: 'POST',
        url: '/api/carousel-admin/login',
        headers: { 'content-type': 'application/json' },
        payload: { username: 'admin', password: newPass }
      });
      assert.equal(loginNewRes.statusCode, 200);
      assert.equal(loginNewRes.json().user.mustChangePassword, false);

      // Fuerza bruta: 5 intentos fallidos bloquean el acceso (429)
      clearRateLimitStoreForTests();
      let got429 = false;
      for (let i = 0; i < 6; i++) {
        const bad = await fastify.inject({
          method: 'POST',
          url: '/api/carousel-admin/login',
          headers: { 'x-forwarded-for': '192.0.2.77', 'content-type': 'application/json' },
          payload: { username: 'admin', password: 'incorrecta-password' }
        });
        if (bad.statusCode === 429) {
          got429 = true;
          assert.ok(bad.headers['retry-after']);
          break;
        }
      }
      assert.equal(got429, true, 'Se esperaba bloqueo HTTP 429 tras intentos repetidos');
    });

    // 10. Lock distribuido/persistente de sincronización ante 5 televisores simultáneos
    await test('Concurrencia de 5 televisores simultáneos ejecuta 1 sola sincronización (4 reciben alreadyRunning)', async () => {
      const concurrentDataDir = join(testTempRoot, 'sync-concurrent');
      await initSyncState({ dataDir: concurrentDataDir });

      let executionCount = 0;
      const fakeDeps = {
        useDbLock: true,
        mainPool: {
          query: async () => [[{ id: 1, resul_baloto1: '01', resul_baloto2: '02', resul_baloto3: '03', resul_baloto4: '04', resul_baloto5: '05', resul_baloto6: '06', resul_revancha1: '07', resul_revancha2: '08', resul_revancha3: '09', resul_revancha4: '10', resul_revancha5: '11', resul_revancha6: '12', acum_baloto: '10.000', acum_revancha: '2.000', acum_chmillonario: '1.000', acum_3cifras: '40', acum_4cifras: '1.800' }]],
          execute: async () => [{}]
        },
        extraerFuentesExternas: async () => {
          executionCount++;
          await new Promise((r) => setTimeout(r, 150));
          return {
            results: {
              numerosBaloto: ['01', '02', '03', '04', '05', '06'],
              numerosRevancha: ['07', '08', '09', '10', '11', '12'],
              acumuladoBaloto: '10.000',
              acumuladoRevancha: '2.000',
              acumuladoChance: '1.000',
              acumulado3Cifras: '40',
              acumulado4Cifras: '1.800',
              resultadoMiloto: '01-02-03-04-05',
              resultadoColorloto: '01-02-03-04-05-06'
            },
            logs: []
          };
        },
        obtenerResultadoDesdeApiInterna: async () => null,
        sincronizarRegistrosPowerBi: async (_f, recs) => ({ synced: recs, verifiedCount: recs.length })
      };

      const promises = Array.from({ length: 5 }, (_, idx) =>
        ejecutarSincronizacionCompleta({
          trigger: idx === 0 ? 'public_visit' : 'manual',
          _dataDir: concurrentDataDir,
          _injectDeps: fakeDeps
        })
      );

      const results = await Promise.all(promises);
      const ran = results.filter((r) => !r.alreadyRunning);
      const coalesced = results.filter((r) => r.alreadyRunning);
      assert.equal(executionCount, 1, 'Solo 1 proceso debe ejecutar el pipeline');
      assert.equal(ran.length, 1);
      assert.equal(coalesced.length, 4);

      // Además, justo después de completarse no debe re-ejecutar porque no ha vencido el intervalo de 1 hora
      const evalNotDue = await evaluarYEjecutarSincronizacionSiCorresponde({
        trigger: 'public_visit',
        blocking: true,
        _dataDir: concurrentDataDir,
        _injectDeps: { ...fakeDeps, forceEnabled: true, intervalMs: 3600000 }
      });
      assert.equal(evalNotDue.triggered, false);
      assert.equal(evalNotDue.reason, 'not_due');
    });

    // 11. Simulación de fallo PowerBI, persistencia de estado pendiente y reintento sin duplicados
    await test('Error en PowerBI queda marcado como powerbi_db_error + pendiente, persiste tras reinicio y reintenta sin duplicar', async () => {
      const pbiTestDir = join(testTempRoot, 'sync-pbi-fail');
      await initSyncState({ dataDir: pbiTestDir });

      const fakeMainPool = {
        query: async () => [[{ id: 1 }]],
        execute: async () => [{}]
      };
      const fakeScrape = async () => ({
        results: {
          numerosBaloto: ['01', '02', '03', '04', '05', '06'],
          numerosRevancha: ['07', '08', '09', '10', '11', '12'],
          acumuladoBaloto: '21.600',
          acumuladoRevancha: '2.400',
          acumuladoChance: '2.189,0',
          acumulado3Cifras: '40,1',
          acumulado4Cifras: '1.810,4',
          resultadoMiloto: '01-02-03-04-05',
          resultadoColorloto: '01-02-03-04-05-06'
        },
        logs: []
      });

      const failRes = await ejecutarSincronizacionCompleta({
        trigger: 'scheduler',
        _dataDir: pbiTestDir,
        _injectDeps: {
          useDbLock: false,
          mainPool: fakeMainPool,
          extraerFuentesExternas: fakeScrape,
          obtenerResultadoDesdeApiInterna: async () => null,
          sincronizarRegistrosPowerBi: async () => {
            throw new Error('ETIMEDOUT simulado conectando con PowerBI');
          }
        }
      });

      assert.equal(failRes.success, false, 'Nunca debe reportar éxito si falló PowerBI');
      assert.equal(failRes.status, 'powerbi_db_error');
      assert.equal(failRes.localDbUpdated, true);
      assert.equal(failRes.powerBiPendingRetry, true);

      // Simular reinicio recargando estado desde disco
      const restored = await initSyncState({ dataDir: pbiTestDir });
      assert.equal(restored.status, 'powerbi_db_error');
      assert.equal(restored.powerBiPendingRetry, true);
      assert.ok(restored.pendingPowerBiCount >= 5);

      // Reintentar pendiente exitosamente
      const retryRes = await reintentarSincronizacionPowerBiPendiente({
        _dataDir: pbiTestDir,
        _injectDeps: {
          useDbLock: false,
          sincronizarRegistrosPowerBi: async (_f, recs) => ({ synced: recs, verifiedCount: recs.length })
        }
      });
      assert.equal(retryRes.success, true);
      assert.equal(retryRes.status, 'completed');
      assert.equal(retryRes.powerBiPendingRetry, false);
      assert.ok(retryRes.lastPowerBiSyncAt);
    });

    // 12. Verificar evaluación automática al abrir URL pública (/api/datos?checkSync=1)
    await test('GET /api/datos?checkSync=1 evalúa intervalos en America/Bogota sin bloquear el tablero', async () => {
      // Simular última actualización reciente en el estado aislado para no escribir innecesariamente en BD real durante npm test
      await writeFile(
        join(isolatedDataDir, 'sync-state.json'),
        JSON.stringify({
          status: 'completed',
          lastSuccessAtMs: Date.now(),
          lastRunAt: '2026-11-19 12:00:00',
          lastSuccessAt: '2026-11-19 12:00:00'
        }),
        'utf8'
      );
      await initSyncState({ dataDir: isolatedDataDir });

      const rStatus = await fastify.inject({ method: 'GET', url: '/api/sync/status' });
      assert.equal(rStatus.statusCode, 200);
      assert.ok(rStatus.json().nextScheduledAt);

      const rDatos = await fastify.inject({ method: 'GET', url: '/api/datos?checkSync=1' });
      assert.equal(rDatos.statusCode, 200);
      const body = rDatos.json();
      assert.equal(body.success, true);
      assert.ok(body.syncCheck);
      assert.equal(body.syncCheck.triggered, false);
      assert.equal(body.syncCheck.reason, 'not_due');
    });

    // 13. Verificar GET_LOCK / RELEASE_LOCK real en MariaDB 172.20.1.92
    await test('MariaDB soporta GET_LOCK / RELEASE_LOCK distribuido en 172.20.1.92', async () => {
      const conn = await getMainPool().getConnection();
      try {
        const [acq] = await conn.query("SELECT GET_LOCK('resultados_astro_test_lock', 0) AS acquired");
        assert.equal(Number(acq[0].acquired), 1);
        await conn.query("SELECT RELEASE_LOCK('resultados_astro_test_lock')");
      } finally {
        conn.release();
      }
    });

    // 14. Extracción real de fuentes externas (Baloto, Revancha, MiLoto, ColorLOTO, Chance Millonario, Doble Chance)
    await test('Extracción externa real de todas las fuentes configuradas', async () => {
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

    // 15. Prueba transaccional no destructiva de INSERT + UPDATE + verificación + ROLLBACK en POWERBI.INFORESULTADOS
    await test('Prueba transaccional no destructiva (INSERT + UPDATE + verificación post-escritura + ROLLBACK) en POWERBI.INFORESULTADOS', async () => {
      const pool = getPowerBiPool();
      const conn = await pool.getConnection();
      const testDate = '2099-12-31';
      const testCode = '9999';

      try {
        await conn.beginTransaction();

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
        assert.equal(rowsAfterInsert.length, 1);
        assert.equal(rowsAfterInsert[0].RESULTADO, '01-02-03-04-05');

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
        assert.equal(rowsAfterUpdate.length, 1);
        assert.equal(rowsAfterUpdate[0].RESULTADO, '10-20-30-40-43');
        assert.equal(rowsAfterUpdate[0].SERIE, '12');

        await conn.rollback();
        console.log('     -> INSERT, UPDATE, prevención de duplicados y ROLLBACK verificados limpiamente.');
      } finally {
        conn.release();
      }
    });
  } finally {
    await fastify.close();
    await closeAllPools();
    if (existsSync(testTempRoot)) {
      await rm(testTempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

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
