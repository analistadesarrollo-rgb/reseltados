import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

function generateBuildVersion() {
  if (process.env.APP_BUILD_VERSION && process.env.APP_BUILD_VERSION.trim()) {
    return process.env.APP_BUILD_VERSION.trim();
  }
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

const buildVersion = generateBuildVersion();
const buildTimestamp = new Date().toISOString();

// Exponer la misma versión de compilación para el frontmatter Astro y Vite
process.env.PUBLIC_APP_BUILD_VERSION = buildVersion;

function versionManifestIntegration() {
  const manifestJson = JSON.stringify(
    {
      version: buildVersion,
      builtAt: buildTimestamp
    },
    null,
    2
  );

  return {
    name: 'resultados-build-version',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use('/version.json', (_req, res) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
          res.end(manifestJson);
        });
      },
      'astro:build:done': ({ dir }) => {
        const outPath = fileURLToPath(new URL('version.json', dir));
        writeFileSync(outPath, `${manifestJson}\n`, 'utf8');
      }
    }
  };
}

export default defineConfig({
  output: 'static',
  build: {
    format: 'directory'
  },
  integrations: [versionManifestIntegration()],
  server: {
    port: 4321,
    host: true
  },
  vite: {
    define: {
      'import.meta.env.PUBLIC_APP_BUILD_VERSION': JSON.stringify(buildVersion)
    },
    server: {
      proxy: {
        '/api': {
          target: process.env.API_PROXY_TARGET || 'http://localhost:3000',
          changeOrigin: false,
          xfwd: true
        }
      }
    }
  }
});
