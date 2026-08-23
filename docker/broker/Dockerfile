# syntax=docker/dockerfile:1
#
# apps/broker — the privileged tier. Small on purpose (SECURITY.md
# §4.1: "no database, no business logic, no templating, no user-facing
# surface"); this Dockerfile keeps the same discipline — nothing here
# that isn't needed to run apps/broker's own dist/index.js.
#
# Build from the repository root, not this directory:
#   docker build -f docker/broker/Dockerfile -t dwg-broker .
#
# Base image: same digest-pinned `node:24-alpine` as docker/server/
# Dockerfile — see that file's header for exactly how the digest was
# obtained and how to refresh it. One image, two Dockerfiles, so it is
# never possible for the two tiers to silently drift onto different
# underlying OS/library versions.
ARG NODE_IMAGE=node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/broker/package.json apps/broker/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/broker apps/broker
RUN npm run build --workspace packages/shared \
 && npm run build --workspace apps/broker

# `apps/server` and `apps/web` are dropped from the workspace tree before
# the prune, for the same reason (and with the same measurement behind it)
# as docker/server/Dockerfile's mirror-image step — see that file's
# comment on this stage. Both are still workspaces here only because their
# package.json files had to be copied into `deps` above for `npm ci` to
# resolve the lockfile; neither one's *source* was ever copied. Without
# this, `npm prune --omit=dev` would keep every production dependency of
# the web tier and the SPA (React, @node-rs/argon2, tar, undici and their
# transitive closure — 438 packages, measured with `npm prune --omit=dev
# --dry-run` on this repository) inside the image whose whole design
# principle is that it is small.
FROM build AS prod-deps
RUN rm -rf apps/server apps/web && npm prune --omit=dev
# See docker/server/Dockerfile's identical step: npm does not guarantee
# hoisting, and a workspace-local node_modules the runtime stage never
# copied would produce an image that starts and immediately dies.
RUN mkdir -p apps/broker/node_modules packages/shared/node_modules

# The compiled unit tests are dead weight in a runtime image: `tsc --build`
# emits one `.test.js`/`.test.d.ts`/`.test.js.map` beside every module,
# because typechecking the tests is deliberately part of the build
# (AGENT_BRIEF.md §6 — `npm test` alone is not evidence, so the test files
# stay inside tsconfig's `include`). Nothing imports them at runtime and
# vitest is not even installed after the prune above, so they are inert —
# but inert test code is still not what a production image should carry,
# least of all this one. Matched on this project's own naming convention
# (`<module>.test.ts` beside each module, §5); fixtures are *not* test
# files here — the fake drivers consume them — and are deliberately left
# alone.
RUN find apps/broker/dist packages/shared/dist \
      \( -name '*.test.js' -o -name '*.test.d.ts' -o -name '*.test.js.map' \
         -o -name '*-test-harness.js' -o -name '*-test-harness.d.ts' -o -name '*-test-harness.js.map' \) \
      -delete

# ---------------------------------------------------------------------------
# runtime — apps/broker's own dist, packages/shared's dist, pruned
# node_modules (dockerode, fastify, pino, zod, @dwg/shared — nothing
# else). Never apps/server, never apps/web.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
# A dedicated, unprivileged user — *not* root, despite holding the Docker
# socket. Read/write access to the socket is still effectively root-on-
# the-host (AGENT_BRIEF.md §2's whole reason this tier is separated out
# at all), but there is no reason to make a container-escape *also* start
# as root inside this container specifically. Reaching the host socket at
# all requires `docker/compose.yaml`'s `group_add` to add this user to
# the host's own `docker` group GID at container start (documented
# there, and by `installer/install.sh`, which detects that GID) — this
# image never bakes a guessed GID into itself, since the real one varies
# by host and a wrong guess would either fail closed (safe) or, worse,
# collide with some *other* unrelated host group of the same number.
RUN addgroup -g 10001 -S dwg && adduser -u 10001 -S dwg -G dwg -H -D

COPY --from=prod-deps --chown=dwg:dwg /app/node_modules ./node_modules
COPY --from=prod-deps --chown=dwg:dwg /app/package.json ./package.json
COPY --from=prod-deps --chown=dwg:dwg /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=prod-deps --chown=dwg:dwg /app/packages/shared/dist ./packages/shared/dist
COPY --from=prod-deps --chown=dwg:dwg /app/apps/broker/package.json ./apps/broker/package.json
COPY --from=prod-deps --chown=dwg:dwg /app/apps/broker/dist ./apps/broker/dist
COPY --from=prod-deps --chown=dwg:dwg /app/apps/broker/node_modules ./apps/broker/node_modules
COPY --from=prod-deps --chown=dwg:dwg /app/packages/shared/node_modules ./packages/shared/node_modules

# Fails the *build*, not `docker run`, if the npm-workspace symlink for
# @dwg/shared did not survive the copy across stages above — see
# docker/server/Dockerfile's identical check for the full reasoning. The
# second check is this image's half of the same discipline: the runtime
# stage above claims to carry "dockerode, fastify, pino, zod, @dwg/shared
# — nothing else", so the build asserts the web tier's own dependencies
# genuinely are not here, rather than leaving that to a comment.
# Run from inside the workspace, not /app: Node resolves a bare specifier
# from the importing module's directory upwards, and the real entrypoint
# lives in apps/broker/dist. Evaluating this at /app would only ever search
# /app/node_modules, which is both stricter than reality and — now that
# workspace-local node_modules are copied too — the wrong question.
RUN cd apps/broker && node --input-type=module -e "\
  const { readFileSync } = await import('node:fs'); \
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')); \
  const names = Object.keys(pkg.dependencies ?? {}); \
  for (const name of names) { await import(name); } \
  console.log('confirmed: all ' + names.length + ' declared runtime dependencies resolve'); \
"
# Scans every node_modules in the image, not just the root one: since the
# runtime stage now also copies workspace-local node_modules (see the
# prod-deps stage), checking only the root would leave a place for one of
# these to hide.
RUN for pkg in react @node-rs/argon2 tar undici; do \
      if find . -type d -path "*/node_modules/${pkg}" | grep -q .; then \
        echo "FAIL: ${pkg} is present in the broker image — this tier is meant to carry nothing the web tier needs." >&2; \
        exit 1; \
      fi; \
    done && echo "confirmed: no web-tier dependencies in the broker image."

USER dwg
EXPOSE 4000

# No curl/wget, and deliberately no HTTP healthcheck at all: the
# broker's one route requires the shared-secret header
# (apps/broker/src/auth.ts) and validates a real operation body before
# doing anything (apps/broker/src/app.ts's own header — the guard runs
# as an `onRequest` hook, before body parsing), so there is no
# unauthenticated request shape that proves liveness without either
# baking the shared secret into this image (it must not be) or adding a
# new, unauthenticated endpoint to the smallest, most security-sensitive
# service in this project just to satisfy a healthcheck. A bare TCP
# connect is real evidence the process is up and its listener is bound —
# not a business-logic check, but this tier has no business logic to
# check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('node:net').connect({port:process.env.BROKER_PORT||4000,host:'127.0.0.1'}).on('connect',function(){this.end();process.exit(0)}).on('error',()=>process.exit(1))"

CMD ["node", "apps/broker/dist/index.js"]
