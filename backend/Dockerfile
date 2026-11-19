# ============================================================================
# ETAPA 1: Instalación de dependencias de producción
# ============================================================================
FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# ============================================================================
# ETAPA 2: Ejecución del Backend Node.js (Fastify + Oracle Instant Client 11g)
# ============================================================================
FROM node:22-bookworm-slim AS production

ENV TZ=America/Bogota
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV APP_DATA_DIR=/app/data
ENV CAROUSEL_IMAGES_DIR=/app/carousel
ENV CAROUSEL_SEED_DIR=/app/carousel-seed
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient_11_2
ENV DB_ORACLE_LIB_DIR=/opt/oracle/instantclient_11_2

RUN apt-get update && \
    apt-get install -y --no-install-recommends libaio1 tzdata ca-certificates && \
    ln -sf /usr/share/zoneinfo/America/Bogota /etc/localtime && \
    echo "America/Bogota" > /etc/timezone && \
    dpkg-reconfigure -f noninteractive tzdata && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /app/carousel /app/carousel-seed /app/data /opt/oracle/instantclient_11_2

# Copiar Oracle Instant Client 11.2 si Jenkins lo suministró antes de compilar
COPY backend/instantclient_11_2/ /opt/oracle/instantclient_11_2/

RUN if [ -f /opt/oracle/instantclient_11_2/libclntsh.so.11.1 ]; then \
      cd /opt/oracle/instantclient_11_2 && \
      ln -sf libclntsh.so.11.1 libclntsh.so && \
      ln -sf libocci.so.11.1 libocci.so && \
      echo "/opt/oracle/instantclient_11_2" > /etc/ld.so.conf.d/oracle-instantclient.conf && \
      ldconfig; \
    fi

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/src ./src
COPY frontend/public/img/carousel ./carousel-seed

EXPOSE 3000

CMD ["node", "src/server.js"]
