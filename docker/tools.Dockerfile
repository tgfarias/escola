# Local only: migrations and demo seed (needs the dev dependencies, e.g. tsx).
FROM node:22-slim
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
CMD ["sh", "-c", "pnpm db:migrate && pnpm db:seed"]
