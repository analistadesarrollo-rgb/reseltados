import http from 'node:http';
import https from 'node:https';
import { env } from '../config/env.js';

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
  'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8'
};

/**
 * Realiza petición HTTP/HTTPS con soporte de redirecciones, timeout y fallback TLS controlado
 */
function requestRaw(urlStr, { timeoutMs = 12000, rejectUnauthorized = true, maxRedirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr);
    } catch (err) {
      return reject(err);
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'GET',
      headers: DEFAULT_HEADERS,
      timeout: timeoutMs,
      ...(isHttps ? { rejectUnauthorized } : {})
    };

    const req = lib.request(options, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        maxRedirects > 0
      ) {
        res.resume();
        const nextUrl = new URL(res.headers.location, urlStr).toString();
        return resolve(
          requestRaw(nextUrl, {
            timeoutMs,
            rejectUnauthorized,
            maxRedirects: maxRedirects - 1
          })
        );
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} en ${urlStr}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout (${timeoutMs}ms) al consultar ${urlStr}`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * Obtiene contenido de una URL con reintentos y fallback TLS cuando el certificado local falla
 */
export async function fetchUrlWithRetry(urlStr, label = 'HTTP GET') {
  const timeoutMs = env.scraper.httpTimeoutMs;
  const maxRetries = env.scraper.maxRetries;
  let lastErr;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await requestRaw(urlStr, {
        timeoutMs,
        rejectUnauthorized: true
      });
    } catch (err) {
      lastErr = err;
      const isTlsError =
        /SSL|TLS|CERT|certificate|unable to verify|self-signed/i.test(String(err?.message)) ||
        /CERT_|UNABLE_TO_VERIFY/i.test(String(err?.code));

      if (isTlsError && env.scraper.allowInsecureTlsFallback) {
        try {
          return await requestRaw(urlStr, {
            timeoutMs,
            rejectUnauthorized: false
          });
        } catch (fallbackErr) {
          lastErr = fallbackErr;
        }
      }

      // No reintentar en 404
      if (/HTTP 404/i.test(String(lastErr?.message))) {
        break;
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }

  throw new Error(`${label} (${urlStr}) falló: ${lastErr?.message || 'Error de red'}`);
}

/**
 * Formatea un valor en pesos (ej. 1810457000) a millones truncado a 1 decimal con formato colombiano (ej. "1.810,4")
 * Replica exactamente: number_format(floor((float)$valor / 100000) / 10, 1, ',', '.')
 */
export function formatMillionsColombian(rawNumber) {
  const num = Number(rawNumber);
  if (!Number.isFinite(num) || num <= 0) return '';

  const tenths = Math.floor(num / 100000);
  const integerPart = Math.floor(tenths / 10);
  const decimalPart = tenths % 10;

  const formattedInt = String(integerPart).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${formattedInt},${decimalPart}`;
}

/**
 * Extrae números y acumulados de Baloto y Revancha desde HTML
 */
export function parseBalotoHtml(html) {
  if (!html || typeof html !== 'string') {
    return { numerosBaloto: [], numerosRevancha: [], acumuladoBaloto: '', acumuladoRevancha: '' };
  }

  const ballRegex = /<div class="(?:yellow-ball|red-ball)[^"]*">\s*(\d{1,2})\s*<\/div>/gi;
  const balls = [];
  let match;
  while ((match = ballRegex.exec(html)) !== null) {
    balls.push(String(Number.parseInt(match[1], 10)).padStart(2, '0'));
  }

  const numerosBaloto = balls.length >= 6 ? balls.slice(0, 6) : [];
  const numerosRevancha = balls.length >= 12 ? balls.slice(6, 12) : [];

  const acumBalotoMatch = html.match(
    /<div class="gotham-black light-blue title-next-contest"><strong>BALOTO<\/strong><\/div>\s*<div class="next-contest-new gotham-black">\$([0-9.,]+)/is
  );
  const acumRevanchaMatch = html.match(
    /<div class="gotham-black light-blue title-next-contest"><strong>REVANCHA<\/strong><\/div>\s*<div class="next-contest-new gotham-black">\$([0-9.,]+)/is
  );

  return {
    numerosBaloto,
    numerosRevancha,
    acumuladoBaloto: acumBalotoMatch ? acumBalotoMatch[1].trim() : '',
    acumuladoRevancha: acumRevanchaMatch ? acumRevanchaMatch[1].trim() : ''
  };
}

/**
 * Extrae acumulado de Chance Millonario desde HTML
 */
export function parseChanceMillonarioHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const match = html.match(
    /<h1 class="fuenteacumulado"><span class="signopesosacumulado">\$<\/span>\s*([0-9.,]+)/i
  );
  if (!match || !match[1]) return '';
  const cleanDigits = match[1].replace(/\./g, '').replace(/,/g, '');
  return formatMillionsColombian(Number.parseFloat(cleanDigits));
}

/**
 * Extrae acumulados de Doble Chance (3 cifras y 4 cifras) desde HTML
 */
export function parseDobleChanceHtml(html) {
  if (!html || typeof html !== 'string') {
    return { acumulado3Cifras: '', acumulado4Cifras: '' };
  }
  const regex = /<span class="elementor-counter-number" data-duration="1000" data-to-value="(\d+)"/gi;
  const values = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    values.push(match[1]);
  }

  if (values.length < 2) {
    return { acumulado3Cifras: '', acumulado4Cifras: '' };
  }

  return {
    acumulado3Cifras: formatMillionsColombian(Number.parseFloat(values[0])),
    acumulado4Cifras: formatMillionsColombian(Number.parseFloat(values[1]))
  };
}

/**
 * Extrae resultado de MiLoto desde HTML (5 balotas separadas por guion con 2 dígitos: ej. 05-13-19-25-29)
 */
export function parseMilotoHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const regex = /<div class="yellow-ball[^"]*">\s*(\d{1,2})\s*<\/div>/gi;
  const balls = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    balls.push(String(Number.parseInt(match[1], 10)).padStart(2, '0'));
  }
  if (balls.length < 5) return '';
  return balls.slice(0, 5).join('-');
}

/**
 * Extrae resultado de ColorLoto desde HTML (6 balotas separadas por guion sin cero a la izquierda: ej. 7-1-7-1-1-4)
 */
export function parseColorlotoHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const regex = /<div class="balota balota-[^"]+[^>]*>\s*(\d{1,2})\s*<\/div>/gi;
  const balls = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    balls.push(String(Number.parseInt(match[1], 10)));
  }
  if (balls.length < 6) return '';
  return balls.slice(0, 6).join('-');
}

/**
 * Consulta la API interna de resultados (http://172.20.1.221:7080/api/v1/resultados) para fecha y código
 */
export async function obtenerResultadoDesdeApiInterna(fecha, codigo) {
  const baseUrl = env.scraper.apiResultadosBaseUrl;
  if (!baseUrl) return null;

  const url = `${baseUrl}?fecha=${encodeURIComponent(fecha)}&codigoloteria=${encodeURIComponent(String(codigo))}`;
  try {
    const raw = await fetchUrlWithRetry(url, `API Interna codigo=${codigo}`);
    const json = JSON.parse(raw);
    if (!json || !json.success || !json.data || !json.data.resultado) {
      return null;
    }

    const d = json.data;
    return {
      fecha: d.fecha ? String(d.fecha).trim() : fecha,
      codigo: d.codigoloteria ? String(d.codigoloteria).trim() : String(codigo),
      loteria: d.nombreloteria ? String(d.nombreloteria).trim() : '',
      nombrecorto: d.nombrecorto ? String(d.nombrecorto).trim() : '',
      resultado: String(d.resultado).trim(),
      serie: d.serie !== undefined && d.serie !== null ? String(d.serie).trim() : '',
      horacierre: d.horacierre ? String(d.horacierre).trim() : null
    };
  } catch {
    return null;
  }
}

/**
 * Ejecuta la extracción de todas las fuentes externas en paralelo de forma tolerante a fallos
 */
export async function extraerFuentesExternas() {
  const logs = [];
  const results = {
    numerosBaloto: [],
    numerosRevancha: [],
    acumuladoBaloto: '',
    acumuladoRevancha: '',
    acumuladoChance: '',
    acumulado3Cifras: '',
    acumulado4Cifras: '',
    resultadoMiloto: '',
    resultadoColorloto: ''
  };

  const [balotoRes, chanceRes, dobleRes, milotoRes, colorlotoRes] = await Promise.allSettled([
    fetchUrlWithRetry(env.scraper.urlBaloto, 'Scraping Baloto'),
    fetchUrlWithRetry(env.scraper.urlChanceMillonario, 'Scraping Chance Millonario'),
    fetchUrlWithRetry(env.scraper.urlDobleChance, 'Scraping Doble Chance'),
    fetchUrlWithRetry(env.scraper.urlMiloto, 'Scraping MiLoto'),
    fetchUrlWithRetry(env.scraper.urlColorloto, 'Scraping ColorLoto')
  ]);

  if (balotoRes.status === 'fulfilled') {
    const parsed = parseBalotoHtml(balotoRes.value);
    results.numerosBaloto = parsed.numerosBaloto;
    results.numerosRevancha = parsed.numerosRevancha;
    results.acumuladoBaloto = parsed.acumuladoBaloto;
    results.acumuladoRevancha = parsed.acumuladoRevancha;
    if (parsed.numerosBaloto.length === 6) {
      logs.push(`Números Baloto extraídos: ${parsed.numerosBaloto.join(', ')}`);
    } else {
      logs.push('ADVERTENCIA: No se encontraron las 6 balotas de Baloto en scraping.');
    }
    if (parsed.numerosRevancha.length === 6) {
      logs.push(`Números Revancha extraídos: ${parsed.numerosRevancha.join(', ')}`);
    }
    if (parsed.acumuladoBaloto) logs.push(`Acumulado Baloto extraído: $${parsed.acumuladoBaloto}`);
    if (parsed.acumuladoRevancha) logs.push(`Acumulado Revancha extraído: $${parsed.acumuladoRevancha}`);
  } else {
    logs.push(`ADVERTENCIA: Falló scraping de Baloto (${balotoRes.reason?.message}). Se usará respaldo de API/BD.`);
  }

  if (chanceRes.status === 'fulfilled') {
    results.acumuladoChance = parseChanceMillonarioHtml(chanceRes.value);
    if (results.acumuladoChance) {
      logs.push(`Acumulado Chance Millonario extraído: ${results.acumuladoChance}`);
    } else {
      logs.push('ADVERTENCIA: No se pudo extraer acumulado de Chance Millonario desde HTML.');
    }
  } else {
    logs.push(`ADVERTENCIA: Falló scraping de Chance Millonario (${chanceRes.reason?.message}).`);
  }

  if (dobleRes.status === 'fulfilled') {
    const parsed = parseDobleChanceHtml(dobleRes.value);
    results.acumulado3Cifras = parsed.acumulado3Cifras;
    results.acumulado4Cifras = parsed.acumulado4Cifras;
    if (results.acumulado3Cifras && results.acumulado4Cifras) {
      logs.push(`Acumulados Doble Chance extraídos: 3C=${results.acumulado3Cifras} | 4C=${results.acumulado4Cifras}`);
    } else {
      logs.push('ADVERTENCIA: No se pudieron extraer los acumulados de Doble Chance desde HTML.');
    }
  } else {
    logs.push(`ADVERTENCIA: Falló scraping de Doble Chance (${dobleRes.reason?.message}).`);
  }

  if (milotoRes.status === 'fulfilled') {
    results.resultadoMiloto = parseMilotoHtml(milotoRes.value);
    if (results.resultadoMiloto) {
      logs.push(`Resultado MiLoto extraído por scraping: ${results.resultadoMiloto}`);
    } else {
      logs.push('ADVERTENCIA: No se pudo extraer resultado MiLoto por scraping.');
    }
  } else {
    logs.push(`ADVERTENCIA: Falló scraping de MiLoto (${milotoRes.reason?.message}).`);
  }

  if (colorlotoRes.status === 'fulfilled') {
    results.resultadoColorloto = parseColorlotoHtml(colorlotoRes.value);
    if (results.resultadoColorloto) {
      logs.push(`Resultado ColorLOTO extraído por scraping: ${results.resultadoColorloto}`);
    } else {
      logs.push('ADVERTENCIA: No se pudo extraer resultado ColorLOTO por scraping.');
    }
  } else {
    logs.push(`ADVERTENCIA: Falló scraping de ColorLOTO (${colorlotoRes.reason?.message}).`);
  }

  return { results, logs };
}
