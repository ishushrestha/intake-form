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
COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN pnpm --filter @intake/contracts build \
  && pnpm --filter @intake/web build \
  && pnpm --filter @intake/api build \
  && pnpm --filter @intake/api deploy --prod --legacy /runtime

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /runtime/ ./
COPY --from=build /app/apps/web/dist /web
ENV WEB_DIST=/web
EXPOSE 3001
CMD ["node", "dist/main.js"]
