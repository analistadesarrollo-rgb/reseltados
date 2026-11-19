# ============================================================================
# ETAPA 1: Instalación de dependencias de producción
# ============================================================================
FROM node:22-alpine AS deps

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

# ============================================================================
# ETAPA 2: Ejecución del Backend Node.js (Fastify)
# ============================================================================
FROM node:22-alpine AS production

ENV TZ=America/Bogota
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV APP_DATA_DIR=/app/data
ENV CAROUSEL_IMAGES_DIR=/app/carousel
ENV CAROUSEL_SEED_DIR=/app/carousel-seed

RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/America/Bogota /etc/localtime && \
    echo "America/Bogota" > /etc/timezone && \
    mkdir -p /app/carousel /app/carousel-seed /app/data

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY backend/package.json ./
COPY backend/src ./src
COPY frontend/public/img/carousel ./carousel-seed

EXPOSE 3000

CMD ["node", "src/server.js"]
