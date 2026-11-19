# ============================================================================
# ETAPA 1: Construcción estática de Astro
# ============================================================================
FROM node:22-alpine AS builder

WORKDIR /app

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# ============================================================================
# ETAPA 2: Servidor Web Nginx de Producción
# ============================================================================
FROM nginx:stable-alpine3.19-slim AS production

ENV TZ=America/Bogota

RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/America/Bogota /etc/localtime && \
    echo "America/Bogota" > /etc/timezone

COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
