FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @app-lanche/api build
RUN pnpm --filter @app-lanche/api deploy --prod --legacy /out

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
# Diretório do armazenamento local (só com STORAGE_DRIVER=local); o volume herda o dono.
RUN mkdir -p /data/documents && chown node:node /data/documents
USER node
CMD ["node", "dist/server.js"]
