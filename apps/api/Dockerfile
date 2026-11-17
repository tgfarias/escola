FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@12.21.0 --activate
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
USER node
CMD ["node", "dist/server.js"]
