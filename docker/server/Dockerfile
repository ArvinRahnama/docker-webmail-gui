# syntax=docker/dockerfile:1
#
# apps/server — the web tier (API, auth, business logic; serves the
# built SPA — ARCHITECTURE.md §4, §10). Holds no Docker socket and no
# Docker vocabulary (AGENT_BRIEF.md §2): nothing in this file's runtime
# dependency list, environment, or entrypoint ever references
# /var/run/docker.sock — that stays exclusive to docker/broker/Dockerfile.
# `apps/server/src/security/docker-socket-isolation.security.test.ts`
# (M12) pins the same invariant on the source tree; this file is the
# other half, for the image actually shipped.
#
# Build from the repository root, not this directory — the build needs
# packages/shared and apps/web too:
#   docker build -f docker/server/Dockerfile -t dwg-server .
#
# Base image pinned by digest, not just a tag (ARCHITECTURE.md §10):
# `node:24-alpine` moves forward with every Node/Alpine patch release;
# this digest never does. Alpine (musl libc), not slim/bookworm (glibc):
# @node-rs/argon2 — this image's one native dependency — ships prebuilt
# binaries for both linux-x64-musl and linux-arm64-musl (verified against
# its own package.json's optionalDependencies list), so musl costs
# nothing here and buys a smaller image.
#
# Digest obtained from AWS ECR Public's mirror of Docker Official Images
# (`registry-1.docker.io`/`auth.docker.io` were not reachable from the
# network this file was authored on; ECR Public mirrors Docker Official
# Images verbatim, and the digest is self-verifying regardless of which
# registry ultimately serves the pull — Docker refuses anything that
# doesn't hash to this exact value):
#   curl -s "https://public.ecr.aws/token/?service=public.ecr.aws&scope=repository:docker/library/node:pull"
#   curl -s -H "Authorization: Bearer <token>" \
#     -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
#     -D - -o /dev/null \
#     https://public.ecr.aws/v2/docker/library/node/manifests/24-alpine
#   # -> docker-content-digest: sha256:...
# Re-run the same two commands to refresh, or use
# `docker buildx imagetools inspect node:24-alpine` on a machine with
# ordinary registry access.
ARG NODE_IMAGE=node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

FROM ${NODE_IMAGE} AS base
WORKDIR /app

# ---------------------------------------------------------------------------
# deps — the full workspace tree, including devDependencies (tsc/vite are
# needed to build, not to run). Manifests only, before any source, so
# this layer caches across source-only changes.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/broker/package.json apps/broker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# ---------------------------------------------------------------------------
# build — packages/shared first (apps/web and apps/server both depend on
# its built dist/, the same order M12's `pretest:e2e` npm script uses),
# then the SPA this image serves, then the server itself.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/server apps/server
RUN npm run build --workspace packages/shared \
 && npm run build --workspace apps/web \
 && npm run build --workspace apps/server

# ---------------------------------------------------------------------------
# prod-deps — devDependencies pruned from the *already-resolved* tree.
# Not a fresh `npm ci --omit=dev --workspace apps/server`: workspace
# hoisting means a targeted install can silently miss a dependency
# another workspace's devDependencies had pulled to the shared top level;
# pruning the tree `build` already proved correct has no such risk.
#
# `apps/broker` is dropped from the workspace tree *before* the prune, and
# that ordering is the whole point. `npm prune --omit=dev` removes only
# what the ideal tree does not need, and apps/broker is still a workspace
# at this stage (its package.json was copied into `deps` above so `npm ci`
# could resolve the lockfile), so npm keeps its *production* dependencies
# — dockerode and docker-modem among them — in the shared hoisted
# node_modules this stage's output is copied from. Measured on this
# repository with `npm prune --omit=dev --dry-run`: dockerode does not
# appear in the removal list with apps/broker present, and does appear
# (with docker-modem and both @types packages) once it is gone. Removing
# the directory takes the workspace out of the tree npm computes; nothing
# in this image ever needed it, since `build` above never copied its
# source either.
# ---------------------------------------------------------------------------
FROM build AS prod-deps
RUN rm -rf apps/broker && npm prune --omit=dev

# The compiled unit tests are dead weight in a runtime image: `tsc --build`
# emits one `.test.js`/`.test.d.ts`/`.test.js.map` beside every module,
# because typechecking the tests is deliberately part of the build
# (AGENT_BRIEF.md §6 — `npm test` alone is not evidence, so the test files
# stay inside tsconfig's `include`). Nothing imports them at runtime and
# vitest is not even installed after the prune above, so they are inert —
# but 376 inert files in apps/server/dist alone is not what a production
# image should carry. Matched on this project's own naming convention
# (`<module>.test.ts` beside each module, §5); fixtures are *not* test
# files here — the fake drivers consume them — and are deliberately left
# alone.
RUN find apps/server/dist packages/shared/dist \
      \( -name '*.test.js' -o -name '*.test.d.ts' -o -name '*.test.js.map' \
         -o -name '*-test-harness.js' -o -name '*-test-harness.d.ts' -o -name '*-test-harness.js.map' \) \
      -delete

# ---------------------------------------------------------------------------
# runtime — only what apps/server needs to run: its own dist, packages/
# shared's dist (its one workspace dependency), the built SPA, and the
# pruned node_modules. Never apps/broker's source, never dockerode —
# check-dep-consistency-style isolation starts with never having it on
# disk to begin with.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
# A dedicated, unprivileged, home-less system user — never the base
# image's own `node` user, which docker-library's own guidance notes can
# collide with a *different* UID an operator's host or orchestrator
# already assumes for "the node user". Fixed UID/GID (not left to
# `adduser` defaults) so a bind-mounted volume's ownership is predictable
# across image rebuilds.
RUN addgroup -g 10001 -S dwg && adduser -u 10001 -S dwg -G dwg -H -D

# Absolute, not the config schema's own `./data`/`./backups` defaults —
# those are relative to whatever the process's cwd happens to be, which
# this Dockerfile would rather pin explicitly than leave implicit. Both
# pre-created and pre-owned by `dwg` here, before `USER dwg` below: a
# compose-mounted named volume at these paths inherits this directory's
# existing ownership on first mount (standard Docker behaviour), which is
# what lets `cap_drop: ALL` + a non-root user + a read-only root
# filesystem (docker/compose.yaml) still leave these two paths writable.
ENV DATA_DIR=/app/data
ENV BACKUP_DIR=/app/backups
RUN mkdir -p /app/data /app/backups && chown -R dwg:dwg /app/data /app/backups
VOLUME ["/app/data", "/app/backups"]

COPY --from=prod-deps --chown=dwg:dwg /app/node_modules ./node_modules
COPY --from=prod-deps --chown=dwg:dwg /app/package.json ./package.json
COPY --from=prod-deps --chown=dwg:dwg /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=prod-deps --chown=dwg:dwg /app/packages/shared/dist ./packages/shared/dist
COPY --from=prod-deps --chown=dwg:dwg /app/apps/server/package.json ./apps/server/package.json
COPY --from=prod-deps --chown=dwg:dwg /app/apps/server/dist ./apps/server/dist
COPY --from=prod-deps --chown=dwg:dwg /app/apps/web/dist ./apps/web/dist

# Two build-time assertions, both of which fail the *build* rather than
# shipping an image that would be wrong at `docker run`:
#
#  1. The npm-workspace symlink for `@dwg/shared`
#     (node_modules/@dwg/shared -> ../../packages/shared) still resolves
#     after being copied across stages above — Node's runtime module
#     resolution for that bare specifier depends on it, and nothing else
#     in this Dockerfile would otherwise notice if it didn't.
#  2. No Docker client library is present in this image at all. This is
#     what makes this file's header claim a *checked* property of the
#     shipped artifact rather than a comment: the web tier holding no
#     Docker vocabulary (AGENT_BRIEF.md §2) is enforced in the source tree
#     by `docker-socket-isolation.security.test.ts` and in the running
#     container by `.github/workflows/installer.yml`, and here, in the
#     image itself, at the only moment it can still be cheaply fixed.
#     Deliberately checked *after* the COPY above rather than trusted from
#     the prune, so a future change to either step cannot quietly
#     reintroduce it.
RUN node --input-type=module -e "await import('@dwg/shared'); await import('fastify'); await import('@node-rs/argon2');"
RUN for pkg in dockerode docker-modem; do \
      if [ -e "node_modules/${pkg}" ]; then \
        echo "FAIL: ${pkg} is present in the web tier's runtime dependencies — see this file's header." >&2; \
        exit 1; \
      fi; \
    done && echo "confirmed: no Docker client library in the web tier image."

USER dwg
ENV STATIC_DIR=/app/apps/web/dist
EXPOSE 3000

# No curl/wget in this image on purpose (smaller image, smaller attack
# surface) — Node itself, already required to run the server, can make
# the one GET this needs.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
