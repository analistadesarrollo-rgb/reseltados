import crypto from 'node:crypto';
import { getAuthPool, getMainPool, sanitizeDbError } from '../config/db.js';
import { env, getBogotaDateParts } from '../config/env.js';
import { getCarouselSessionFromRequest } from '../services/carouselAuthService.js';
import { sincronizarAcumuladosActualesAPowerBi } from '../services/syncPowerBiService.js';

const TOKEN_SECRET = env.sync.syncApiToken || 'resultados-astro-secret-key';

export function createAdminToken(user) {
  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      login: user.login,
      nombre: user.nombre,
      role: 'ADMIN_RESULTADOS',
      exp: Date.now() + 8 * 3600 * 1000
    })
  ).toString('base64url');

  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAdminToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    if (data.role !== 'ADMIN_RESULTADOS') return null;
    return data;
  } catch {
    return null;
  }
}

async function requireAdminAuth(request, reply) {
  const authHeader = request.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : request.headers['x-admin-token'] || '';
  const user = verifyAdminToken(token);
  if (!user) {
    const carouselSession = await getCarouselSessionFromRequest(request);
    if (carouselSession) {
      reply.code(403).send({
        success: false,
        error: 'Acceso denegado: el rol GESTOR_CARRUSEL solo tiene permisos para administrar imágenes del carrusel.'
      });
      return null;
    }
    reply.code(401).send({ success: false, error: 'Sesión administrativa inválida o expirada' });
    return null;
  }
  return user;
}

export async function adminRoutes(fastify) {
  // 1. Login contra bdpersona.tbusuario (reemplaza login_down/login.php con consulta parametrizada)
  const loginHandler = async (request, reply) => {
    const uname = String(request.body?.uname || request.body?.username || '').trim();
    const pass = String(request.body?.pass || request.body?.password || '').trim();

    if (!uname) {
      return reply.code(400).send({ success: false, error: 'Se requiere un usuario' });
    }
    if (!pass) {
      return reply.code(400).send({ success: false, error: 'Se requiere una clave' });
    }

    try {
      const authPool = getAuthPool();
      const [rows] = await authPool.execute(
        'SELECT id, login, nombre, perfil, activo FROM tbusuario WHERE login = ? AND pass = ? LIMIT 1',
        [uname, pass]
      );

      if (!rows || rows.length === 0) {
        return reply.code(401).send({ success: false, error: 'Usuario o Clave incorrectos' });
      }

      const user = rows[0];
      const token = createAdminToken(user);

      return {
        success: true,
        token,
        user: {
          id: user.id,
          login: user.login,
          nombre: user.nombre,
          perfil: user.perfil
        }
      };
    } catch (err) {
      return reply.code(500).send({
        success: false,
        error: `Error al autenticar: ${sanitizeDbError(err)}`
      });
    }
  };

  fastify.post('/admin/login', loginHandler);
  fastify.post('/api/admin/login', loginHandler);

  // 2. Listar registros de acumulados (reemplaza login_down/editar/index.php)
  const listAcumuladosHandler = async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;
    const pool = getMainPool();
    const [rows] = await pool.query('SELECT * FROM acumulados ORDER BY id DESC');
    return { success: true, rows };
  };

  fastify.get('/admin/acumulados', listAcumuladosHandler);
  fastify.get('/api/admin/acumulados', listAcumuladosHandler);

  // 3. Actualizar valores de acumulados (reemplaza login_down/editar/update.php + sincroniza PowerBI)
  const updateAcumuladosHandler = async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;

    const id = Number.parseInt(String(request.body?.id || '1'), 10);
    const acum_3cifras = String(request.body?.acum_3cifras ?? '').trim();
    const acum_4cifras = String(request.body?.acum_4cifras ?? '').trim();
    const acum_chmillonario = String(request.body?.acum_chmillonario ?? '').trim();
    const acum_baloto = String(request.body?.acum_baloto ?? '').trim();
    const acum_revancha = String(request.body?.acum_revancha ?? '').trim();
    const fecha = getBogotaDateParts().isoDate;

    if (!acum_3cifras || !acum_4cifras || !acum_chmillonario || !acum_baloto || !acum_revancha) {
      return reply.code(400).send({ success: false, error: 'Todos los campos de acumulados son obligatorios' });
    }

    const pool = getMainPool();
    await pool.execute(
      `UPDATE acumulados
       SET acum_3cifras = ?, acum_4cifras = ?, acum_chmillonario = ?, acum_baloto = ?, acum_revancha = ?, fecha = ?
       WHERE id = ?`,
      [acum_3cifras, acum_4cifras, acum_chmillonario, acum_baloto, acum_revancha, fecha, id]
    );

    let powerBiSynced = [];
    try {
      powerBiSynced = await sincronizarAcumuladosActualesAPowerBi();
    } catch {
      // No bloquear respuesta si PowerBI falla momentáneamente
    }

    return {
      success: true,
      message: 'Acumulados actualizados correctamente y sincronizados con PowerBI',
      powerBiSyncedCount: powerBiSynced.length
    };
  };

  fastify.put('/admin/acumulados', updateAcumuladosHandler);
  fastify.put('/api/admin/acumulados', updateAcumuladosHandler);

  // 4. Actualizar balotas de Baloto (reemplaza login_down/editar/update2.php + sincroniza PowerBI)
  const updateBalotoHandler = async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;

    const id = Number.parseInt(String(request.body?.id || '1'), 10);
    const balls = [
      request.body?.resul_baloto1,
      request.body?.resul_baloto2,
      request.body?.resul_baloto3,
      request.body?.resul_baloto4,
      request.body?.resul_baloto5,
      request.body?.resul_baloto6
    ].map((b) => String(b ?? '').trim().padStart(2, '0'));

    if (balls.some((b) => !/^\d{2}$/.test(b))) {
      return reply.code(400).send({ success: false, error: 'Las 6 balotas de Baloto deben ser números de 2 dígitos' });
    }

    const pool = getMainPool();
    await pool.execute(
      `UPDATE acumulados
       SET resul_baloto1 = ?, resul_baloto2 = ?, resul_baloto3 = ?, resul_baloto4 = ?, resul_baloto5 = ?, resul_baloto6 = ?
       WHERE id = ?`,
      [...balls, id]
    );

    let powerBiSynced = [];
    try {
      powerBiSynced = await sincronizarAcumuladosActualesAPowerBi();
    } catch {
      // Ignorar fallo secundario
    }

    return {
      success: true,
      message: 'Resultados de Baloto actualizados y sincronizados con PowerBI',
      powerBiSyncedCount: powerBiSynced.length
    };
  };

  fastify.put('/admin/baloto', updateBalotoHandler);
  fastify.put('/api/admin/baloto', updateBalotoHandler);

  // 5. Actualizar balotas de Revancha (reemplaza login_down/editar/update3.php + sincroniza PowerBI)
  const updateRevanchaHandler = async (request, reply) => {
    if (!(await requireAdminAuth(request, reply))) return;

    const id = Number.parseInt(String(request.body?.id || '1'), 10);
    const balls = [
      request.body?.resul_revancha1,
      request.body?.resul_revancha2,
      request.body?.resul_revancha3,
      request.body?.resul_revancha4,
      request.body?.resul_revancha5,
      request.body?.resul_revancha6
    ].map((b) => String(b ?? '').trim().padStart(2, '0'));

    if (balls.some((b) => !/^\d{2}$/.test(b))) {
      return reply.code(400).send({ success: false, error: 'Las 6 balotas de Revancha deben ser números de 2 dígitos' });
    }

    const pool = getMainPool();
    await pool.execute(
      `UPDATE acumulados
       SET resul_revancha1 = ?, resul_revancha2 = ?, resul_revancha3 = ?, resul_revancha4 = ?, resul_revancha5 = ?, resul_revancha6 = ?
       WHERE id = ?`,
      [...balls, id]
    );

    let powerBiSynced = [];
    try {
      powerBiSynced = await sincronizarAcumuladosActualesAPowerBi();
    } catch {
      // Ignorar fallo secundario
    }

    return {
      success: true,
      message: 'Resultados de Revancha actualizados y sincronizados con PowerBI',
      powerBiSyncedCount: powerBiSynced.length
    };
  };

  fastify.put('/admin/revancha', updateRevanchaHandler);
  fastify.put('/api/admin/revancha', updateRevanchaHandler);
}
