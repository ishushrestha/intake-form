FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/llm-worker/package.json apps/llm-worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY apps/llm-worker apps/llm-worker
COPY packages/contracts packages/contracts
RUN pnpm --filter @intake/contracts build \
  && pnpm --filter @intake/llm-worker build \
  && pnpm --filter @intake/llm-worker deploy --prod --legacy /runtime

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV RUNNING_IN_DOCKER=1
COPY --from=build /runtime/ ./
RUN ./node_modules/.bin/playwright install --with-deps chromium \
  && chown -R node:node /app /ms-playwright
USER node
CMD ["node", "dist/main.js"]
