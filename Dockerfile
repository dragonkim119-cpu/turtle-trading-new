# Turtle Trading — single container running web (Next.js) + signal engine.
FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache python3 make g++
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/engine/package.json apps/engine/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN cd apps/web && NEXT_STANDALONE=0 pnpm build

FROM build AS runner
ENV NODE_ENV=production
ENV DB_PATH=/data/turtle.db
VOLUME /data
EXPOSE 3000
# run engine + web in one container; engine crash kills container -> restart policy recovers
CMD ["sh", "-c", "pnpm --filter @turtle/engine start & pnpm --filter @turtle/web start"]
