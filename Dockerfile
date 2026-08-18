# syntax=docker/dockerfile:1

##############################################################################
# drone-missionsv2 — production image
#
# Replaces the Spring Boot backend's executable jar with a long-running Node
# process serving the Next.js "standalone" output (`output: "standalone"` in
# next.config.ts). Three stages keep the final runtime image small:
#   1. deps    — installs the full dependency tree (build + runtime deps)
#   2. builder — runs `next build`, producing `.next/standalone`
#   3. runner  — copies ONLY the standalone bundle + static assets into a
#                fresh, minimal image; no source, no devDependencies, no
#                package manager, no build cache.
#
# Schema is NOT part of this image. Flyway migrations (`db/migration/`) are
# applied separately by the `flyway` service in docker-compose.yml — see
# README.md "Database migrations (Flyway)". This image only runs the app.
##############################################################################

FROM node:22-alpine AS base
# Alpine's musl libc needs libc6-compat for a few native Next.js/Node
# addons (notably `sharp`, pulled in transitively by next/image).
RUN apk add --no-cache libc6-compat
WORKDIR /app
# Pin pnpm to the major version pnpm-lock.yaml's `lockfileVersion: '9.0'`
# was generated with, via Corepack (bundled with Node 22).
RUN corepack enable && corepack prepare pnpm@9 --activate

# -----------------------------------------------------------------------------
# deps — install once, reused by the builder stage via COPY --from
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# builder — compiles the app
# -----------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# `next build` evaluates every route module during "Collecting page data"
# (see src/app/api/health/route.ts), which imports the fail-fast Zod env
# loader in src/lib/env.ts. JWT_SECRET has no default (see that file's doc
# comment on why: a working default would mean every clone of this repo
# signs tokens with the same publicly-known key), so the build needs *some*
# 32-byte-plus value present just to get past module evaluation.
#
# This placeholder is NEVER baked into the served bundle or used to sign a
# real token: the app is a Node server, not a static site, so src/lib/env.ts
# reads live `process.env` again the moment the standalone server actually
# starts (see the runner stage below and the `app` service in
# docker-compose.yml) — the real JWT_SECRET always comes from the
# container's *runtime* environment, which overrides this build-time value.
# (`docker build` prints a generic SecretsUsedInArgOrEnv linter warning on
# the next two lines because the var name contains "SECRET" — expected and
# safe here; see the paragraph above for why.)
ARG JWT_SECRET_BUILD_PLACEHOLDER="docker-build-time-placeholder-not-a-real-secret-32bytes"
ENV JWT_SECRET=$JWT_SECRET_BUILD_PLACEHOLDER
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

# -----------------------------------------------------------------------------
# runner — minimal runtime image
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone server.js binds to this host/port pair. PORT is the same
# variable src/lib/env.ts validates (default 8085, mirroring the Spring
# backend's server.port) — one env var, read by both the app's own config
# and the HTTP listener, so they can never disagree.
ENV HOSTNAME=0.0.0.0
ENV PORT=8085

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# `next build` with `output: "standalone"` does NOT include `public/` or
# `.next/static` in the standalone bundle (only the traced server + the
# node_modules it actually needs) — both are copied in explicitly, exactly
# as Next.js's own standalone Docker recipe does.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 8085

# Mirrors the app/route.ts db field: this only asserts the process is alive
# and serving, not that a database is reachable — a "not_configured"/"down"
# `db` value in the JSON body still returns HTTP 200 (see that route's doc
# comment on why `db` is informational data, never part of the HTTP status).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then((r)=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
