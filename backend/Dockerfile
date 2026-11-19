# ============================================================================
# ETAPA 1: Instalación de dependencias de producción
# ============================================================================
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

# ============================================================================
# ETAPA 2: Ejecución del Backend Node.js (Fastify)
# ============================================================================
FROM node:22-alpine AS production

ENV TZ=America/Bogota
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/America/Bogota /etc/localtime && \
    echo "America/Bogota" > /etc/timezone && \
    mkdir -p /app/carousel

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

EXPOSE 3000

CMD ["node", "src/server.js"]
