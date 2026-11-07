# syntax=docker/dockerfile:1
# Standard container, no vendor-specific runtime (SPEC.md section 3). Three stages: install, build, run.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `npm run build` is the production build (it sets AUTH_MODE=off, since a production build refuses the dev login).
RUN npm run build
# The migration runner as one self-contained file, for the one-off "migrate" task (no dev tools needed at run time).
RUN npx esbuild scripts/migrate.ts --bundle --platform=node --format=cjs --external:pg-native --outfile=dist/migrate.cjs --log-level=warning

FROM node:24-slim AS run
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 1001 --no-create-home app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/dist/migrate.cjs ./dist/migrate.cjs
USER app
EXPOSE 3000
# The app:        node server.js
# The migrations: node dist/migrate.cjs   (run as a one-off task before each deploy)
CMD ["node", "server.js"]
