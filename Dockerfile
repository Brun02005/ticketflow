# syntax=docker/dockerfile:1
# Imagen genérica para cualquier servicio del monorepo.
#   docker build --build-arg SERVICE=auth -t ticketflow/auth .
# SERVICE es el nombre de la carpeta dentro de services/.
ARG SERVICE

# ── build: instala todo y compila ───────────────────────────────
FROM node:24-alpine AS build
ARG SERVICE
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/common/package.json packages/common/
COPY services/${SERVICE}/package.json services/${SERVICE}/
RUN npm ci -w services/${SERVICE} --include-workspace-root
COPY packages/common packages/common
COPY services/${SERVICE} services/${SERVICE}
RUN npm run build -w services/${SERVICE} \
 && mkdir -p services/${SERVICE}/migrations

# ── runtime: solo dependencias de producción y el bundle ────────
FROM node:24-alpine AS runtime
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/${SERVICE}/package.json services/${SERVICE}/
RUN npm ci --omit=dev -w services/${SERVICE} && npm cache clean --force
COPY --from=build /app/services/${SERVICE}/dist services/${SERVICE}/dist
COPY --from=build /app/services/${SERVICE}/migrations services/${SERVICE}/migrations

USER node
WORKDIR /app/services/${SERVICE}
CMD ["node", "dist/server.js"]
