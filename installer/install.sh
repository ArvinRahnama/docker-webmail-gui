#!/bin/sh
# docker-webmail-gui installer (M13 — IMPLEMENTATION_PLAN.md §2.3, §3;
# SECURITY.md §4.4). POSIX sh, not bash — this must run on whatever
# `/bin/sh` a minimal server actually has, without assuming bash-isms
# (arrays, `[[`, `local` are all bash-only and deliberately avoided
# below).
#
# What this does, in order: detect OS/architecture and Docker/Compose,
# detect an existing install (idempotent — a second run upgrades in
# place, never regenerates a secret that already exists, never touches
# ./data or ./backups), generate any missing secret with a CSPRNG, write
# .env, build and start the stack, wait for real health, assert the
# privilege boundary is real in the containers that just started, attempt
# to attach the server to an already-running docker-mailserver's network
# (best-effort, never fatal), and print access details plus the one-time
# bootstrap credential — only on a fresh install, since re-printing it on
# an upgrade would print a password the admin has (per the mandatory
# first-login flow) already rotated away.
#
# The MCP integration (docs/mcp-integration.md) runs inside the server
# container and is on unless MCP_ENABLED=false. When on, this script adds
# the docker/compose.mcp.yaml overlay, generates the vault key file (once —
# never regenerated) and waits for the MCP listener to answer inside the
# server container. With it off, the install needs nothing MCP-related.
#
# Where each setting comes from, in precedence order — this is the part
# that makes a re-run safe to do on a system an operator has since tuned
# by hand:
#
#   1. This script's own environment  (`PORT=8080 ./installer/install.sh`)
#   2. The existing `.env`, if there is one   <- edits survive a re-run
#   3. The documented default (or, for a secret, a freshly generated one)
#
# Rule 2 is the one worth stating explicitly: every key this script
# writes is read back out of `.env` first, so hand-editing `.env` and
# re-running the installer keeps the edit. Keys this script does not
# manage are carried across verbatim as well (see step 8). A value that
# has been deliberately *emptied* is indistinguishable from an unset one
# in POSIX sh, so an emptied key falls back to its default — which for
# every optional key here is itself empty, so clearing one works.
#
# Run from a checked-out copy of this repository, from any directory —
# it locates the repo root itself (below) rather than assuming the
# caller's cwd. For remote installation, SECURITY.md §4.4 and
# docs/docker.md document the checksum-verified download-then-inspect-
# then-run flow this script is meant to be fetched through; this file
# does not implement that transport itself.
set -eu

# ---------------------------------------------------------------------------
# Locate the repository root (this script's own directory, one level up)
# regardless of the caller's cwd or how this script was invoked.
# ---------------------------------------------------------------------------
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd)
COMPOSE_FILE="${REPO_ROOT}/docker/compose.yaml"
MCP_COMPOSE_FILE="${REPO_ROOT}/docker/compose.mcp.yaml"
ENV_FILE="${REPO_ROOT}/.env"

log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# Every `docker compose` call goes through this, so the MCP overlay is either
# on all of them or on none (MCP_ENABLED is resolved in step 6, before the
# first call).
dc() {
  if [ "${MCP_ENABLED}" = "true" ]; then
    docker compose -f "${COMPOSE_FILE}" -f "${MCP_COMPOSE_FILE}" --env-file "${ENV_FILE}" "$@"
  else
    docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" "$@"
  fi
}

# ---------------------------------------------------------------------------
# 1. Detect OS and architecture. Linux only, for now — the DOCKER_GID
#    detection below (matching the *host's* docker.sock group so the
#    broker container can reach it without running as root) assumes
#    Linux's socket-permission model; Docker Desktop (macOS/Windows)
#    proxies the socket through a VM with different semantics this
#    script has not been verified against. Failing closed here with a
#    clear message beats silently producing a broker that can never
#    reach the socket.
# ---------------------------------------------------------------------------
OS_NAME=$(uname -s)
if [ "${OS_NAME}" != "Linux" ]; then
  die "unsupported OS: ${OS_NAME}. This installer supports Linux hosts only (see this script's own comment on why). Docker Desktop users: use docker/compose.yaml directly and set DOCKER_GID by hand."
fi

ARCH_NAME=$(uname -m)
case "${ARCH_NAME}" in
  x86_64 | amd64) ARCH_NAME=amd64 ;;
  aarch64 | arm64) ARCH_NAME=arm64 ;;
  *) die "unsupported architecture: ${ARCH_NAME}. docker/server/Dockerfile and docker/broker/Dockerfile's base image publishes amd64 and arm64 only." ;;
esac
log "Detected: Linux/${ARCH_NAME}"

# ---------------------------------------------------------------------------
# 2. Detect Docker and Compose.
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH. Install Docker Engine first: https://docs.docker.com/engine/install/"

if ! docker info >/dev/null 2>&1; then
  die "docker is installed but the daemon is not reachable. Is it running, and is $(id -un) allowed to use it (in the 'docker' group, or running via sudo)?"
fi

if ! docker compose version >/dev/null 2>&1; then
  die "docker compose (the v2 plugin) is not available. Install it: https://docs.docker.com/compose/install/"
fi
log "Docker and Compose: present and reachable."

# ---------------------------------------------------------------------------
# 3. Detect the host's docker.sock group GID — what lets the broker
#    container reach the socket via `group_add` without running as root
#    (docker/broker/Dockerfile's own comment on why; docker/compose.yaml
#    reads this from DOCKER_GID). The *socket's own* group ownership is
#    authoritative, not a group literally named "docker" — some distros
#    name it differently, and what actually matters is which GID the
#    socket file itself is group-owned by.
# ---------------------------------------------------------------------------
DOCKER_SOCK_PATH=/var/run/docker.sock
DETECTED_DOCKER_GID=''
if [ -S "${DOCKER_SOCK_PATH}" ]; then
  DETECTED_DOCKER_GID=$(stat -c '%g' "${DOCKER_SOCK_PATH}" 2>/dev/null || stat -f '%g' "${DOCKER_SOCK_PATH}" 2>/dev/null || true)
fi

# ---------------------------------------------------------------------------
# 4. Detect an existing installation. Idempotent: a second run must
#    never regenerate a secret an admin (or an already-running session)
#    depends on, and must never touch the named volumes ./data/./backups
#    live in.
# ---------------------------------------------------------------------------
FRESH_INSTALL=true
if [ -f "${ENV_FILE}" ]; then
  FRESH_INSTALL=false
  log "Existing installation found (${ENV_FILE}) — upgrading in place. Secrets, settings and data are preserved."
fi

# ---------------------------------------------------------------------------
# 5. A CSPRNG secret generator. Prefers `openssl rand`, the same tool
#    .env.example itself tells a developer to run by hand; falls back to
#    reading /dev/urandom directly (present on every Linux kernel this
#    installer targets) so a minimal image without openssl installed
#    still gets a real CSPRNG value, never a weaker one.
# ---------------------------------------------------------------------------
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

# ---------------------------------------------------------------------------
# 6. Setting resolution — the precedence rules stated in this file's
#    header, in two small functions.
#
#    `read_env_value` reads one key out of the existing `.env`, or prints
#    nothing if there is no such key (or no file). `resolve` layers the
#    caller's own environment on top of that, with a documented default
#    underneath.
#
#    The `eval` in `resolve` reads a variable *by name*; every name it is
#    ever called with is a literal constant written in this file a few
#    lines below, never anything derived from `.env`, an argument, or any
#    other input, so there is no expansion here an outside value can
#    reach.
# ---------------------------------------------------------------------------
read_env_value() {
  # $1 = key
  if [ -f "${ENV_FILE}" ]; then
    sed -n "s/^$1=//p" "${ENV_FILE}" | tail -n1
  fi
}

resolve() {
  # $1 = key, $2 = default
  eval "_resolve_from_env=\${$1:-}"
  if [ -n "${_resolve_from_env}" ]; then
    printf '%s' "${_resolve_from_env}"
    return 0
  fi
  _resolve_from_file=$(read_env_value "$1")
  if [ -n "${_resolve_from_file}" ]; then
    printf '%s' "${_resolve_from_file}"
    return 0
  fi
  printf '%s' "$2"
}

# Secrets: generated once, then carried forward for the lifetime of the
# install. Regenerating COOKIE_SECRET would invalidate every live session;
# regenerating BROKER_SHARED_SECRET would break the web tier's only route
# to the broker until both containers had restarted with the new value.
COOKIE_SECRET=$(resolve COOKIE_SECRET "$(gen_secret)")
BROKER_SHARED_SECRET=$(resolve BROKER_SHARED_SECRET "$(gen_secret)")

# The host's docker group GID: whatever was detected wins over a stale
# value in .env (the socket's group can genuinely change if Docker is
# reinstalled), and .env is the fallback for the case where detection
# failed but a previous run — or the operator — already recorded one.
DOCKER_GID=${DETECTED_DOCKER_GID:-$(read_env_value DOCKER_GID)}
if [ -z "${DOCKER_GID}" ]; then
  die "could not determine the group GID of ${DOCKER_SOCK_PATH}. Set DOCKER_GID yourself in ${ENV_FILE} (see docker/compose.yaml's comment on why the broker needs it) and re-run."
fi
log "Docker socket group GID: ${DOCKER_GID}"

# `pull` fetches the released images from GHCR; `build` compiles them from
# this checkout. Default `build`, because reaching this script at all means
# having the source — but an operator installing a release wants `pull`,
# which is what README.md's quick start uses. Either way the images end up
# under the same name (docker/compose.yaml's header explains why).
DWG_IMAGE_MODE=$(resolve DWG_IMAGE_MODE 'build')
case "${DWG_IMAGE_MODE}" in
  pull | build) ;;
  *) die "DWG_IMAGE_MODE must be 'pull' or 'build', not '${DWG_IMAGE_MODE}'." ;;
esac
# Defaults to this checkout's own release (the root package.json's
# "version"), so a fresh install from a `vX.Y.Z` checkout installs that
# release — pulled or built. An existing install keeps the DWG_VERSION in
# its .env (rule 2 above); pass DWG_VERSION to move it.
CHECKOUT_VERSION=$(sed -n 's/^  "version": "\([^"]*\)",*$/\1/p' "${REPO_ROOT}/package.json" | head -n 1)
[ -n "${CHECKOUT_VERSION}" ] || die "could not read the version from ${REPO_ROOT}/package.json."
DWG_VERSION=$(resolve DWG_VERSION "${CHECKOUT_VERSION}")
BIND_ADDRESS=$(resolve BIND_ADDRESS '0.0.0.0')
PORT=$(resolve PORT '3000')
LOG_LEVEL=$(resolve LOG_LEVEL 'info')
COOKIE_SECURE=$(resolve COOKIE_SECURE 'true')
SESSION_ABSOLUTE_TTL_HOURS=$(resolve SESSION_ABSOLUTE_TTL_HOURS '12')
SESSION_IDLE_TTL_HOURS=$(resolve SESSION_IDLE_TTL_HOURS '2')
DMS_CONTAINER_NAME=$(resolve DMS_CONTAINER_NAME 'mailserver')
DMS_CONTAINER_LABEL=$(resolve DMS_CONTAINER_LABEL '')
RSPAMD_URL=$(resolve RSPAMD_URL 'http://mailserver:11334')
RSPAMD_PASSWORD=$(resolve RSPAMD_PASSWORD '')
ENABLE_EXEC_CONSOLE=$(resolve ENABLE_EXEC_CONSOLE 'false')
ENABLE_HSTS=$(resolve ENABLE_HSTS 'true')

# MCP integration (docs/mcp-integration.md) — on by default. It runs inside
# the server container; MCP_ENABLED selects the docker/compose.mcp.yaml
# overlay (see dc() above), the rest configure it. An existing .env keeps
# whatever it already says, so an install that had it off stays off.
MCP_ENABLED=$(resolve MCP_ENABLED 'true')
case "${MCP_ENABLED}" in
  true | false) ;;
  *) die "MCP_ENABLED must be 'true' or 'false', not '${MCP_ENABLED}'." ;;
esac
MCP_PUBLIC_URL=$(resolve MCP_PUBLIC_URL '')
MCP_BIND_ADDRESS=$(resolve MCP_BIND_ADDRESS '127.0.0.1')
MCP_PORT=$(resolve MCP_PORT '3100')
MCP_MAIL_HOST=$(resolve MCP_MAIL_HOST "${DMS_CONTAINER_NAME}")
MCP_TRUST_PROXY=$(resolve MCP_TRUST_PROXY 'loopback,linklocal,uniquelocal')
MCP_REQUIRE_HTTPS=$(resolve MCP_REQUIRE_HTTPS 'true')
case "${MCP_PUBLIC_URL}" in
  '' | https://*) ;;
  *) die "MCP_PUBLIC_URL must be an https:// URL (ChatGPT and the MCP authorization spec require HTTPS), not '${MCP_PUBLIC_URL}'." ;;
esac

# BOOTSTRAP_ADMIN_EMAIL/PASSWORD: only generated on a genuinely fresh
# install (no admin can exist yet — bootstrapFirstAdmin, apps/server/src
# /modules/auth/bootstrap.ts, only ever creates the *first* one). An
# upgrade run carries whatever is already in .env forward unchanged —
# usually empty, per .env.example's own recommendation to unset these
# again after the first successful login; never fabricated fresh on an
# upgrade, which would silently do nothing (an admin already exists) but
# would be a confusing thing to find in .env regardless.
if [ "${FRESH_INSTALL}" = "true" ]; then
  # Not admin@localhost: config.ts validates this with a strict email
  # rule that rejects an address with no TLD (AGENT_BRIEF.md §7 — read
  # paths accept `user@domain`, write paths stay strict), so the old
  # default made the server refuse to start on a default install.
  # example.com is RFC 2606's reserved documentation domain: valid,
  # unmistakably a placeholder, and it never needs to receive mail —
  # this is a login identifier for the panel, not a mailbox.
  BOOTSTRAP_ADMIN_EMAIL=$(resolve BOOTSTRAP_ADMIN_EMAIL 'admin@example.com')
  BOOTSTRAP_ADMIN_PASSWORD=$(resolve BOOTSTRAP_ADMIN_PASSWORD "$(gen_secret)")
else
  BOOTSTRAP_ADMIN_EMAIL=$(resolve BOOTSTRAP_ADMIN_EMAIL '')
  BOOTSTRAP_ADMIN_PASSWORD=$(resolve BOOTSTRAP_ADMIN_PASSWORD '')
fi

# ---------------------------------------------------------------------------
# 7. Port availability — only meaningful to check on a fresh install;
#    on an upgrade, whatever already holds PORT is almost always this
#    project's own previous `server` container, which `docker compose up
#    -d` below will recreate in place, not a real conflict.
# ---------------------------------------------------------------------------
if [ "${FRESH_INSTALL}" = "true" ]; then
  if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :${PORT}" 2>/dev/null | grep -q ":${PORT}"; then
    die "port ${PORT} is already in use. Set PORT in the environment before running this script, e.g.: PORT=8080 $0"
  fi
fi

# ---------------------------------------------------------------------------
# 8. Write .env — never partially: build the whole file in a temp path
#    and rename it into place, so a script interrupted mid-write never
#    leaves a truncated, half-written .env behind for the next run (or
#    `docker compose`) to read.
#
#    Every key `docker/compose.yaml` and `docker/compose.mcp.yaml`
#    interpolate appears below, so a re-run round-trips the whole of what
#    Compose actually reads rather than silently resetting the subset this
#    script happened to list.
#    Anything *else* an operator has added to .env is appended verbatim
#    at the end, under its own heading — a setting this script does not
#    know about is still theirs, and losing it on an upgrade would be
#    exactly the kind of quiet destruction the uninstaller is careful to
#    avoid.
# ---------------------------------------------------------------------------
MANAGED_KEYS='APP_MODE BIND_ADDRESS PORT DWG_IMAGE_MODE DWG_VERSION LOG_LEVEL COOKIE_SECRET COOKIE_SECURE SESSION_ABSOLUTE_TTL_HOURS SESSION_IDLE_TTL_HOURS BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD BROKER_SHARED_SECRET DOCKER_GID DMS_CONTAINER_NAME DMS_CONTAINER_LABEL RSPAMD_URL RSPAMD_PASSWORD ENABLE_EXEC_CONSOLE ENABLE_HSTS MCP_ENABLED MCP_PUBLIC_URL MCP_BIND_ADDRESS MCP_PORT MCP_MAIL_HOST MCP_TRUST_PROXY MCP_REQUIRE_HTTPS'

TMP_ENV=$(mktemp "${REPO_ROOT}/.env.XXXXXX")
TMP_EXTRA=$(mktemp "${REPO_ROOT}/.env.extra.XXXXXX")
trap 'rm -f "${TMP_ENV}" "${TMP_EXTRA}"' EXIT

cat > "${TMP_ENV}" <<EOF
# Generated by installer/install.sh — see .env.example for what every
# value here means. Re-running install.sh preserves this file: every
# value below is read back out before being rewritten, so hand edits
# survive an upgrade, and no existing secret is ever regenerated.
APP_MODE=production
DWG_IMAGE_MODE=${DWG_IMAGE_MODE}
DWG_VERSION=${DWG_VERSION}
BIND_ADDRESS=${BIND_ADDRESS}
PORT=${PORT}
LOG_LEVEL=${LOG_LEVEL}
COOKIE_SECRET=${COOKIE_SECRET}
COOKIE_SECURE=${COOKIE_SECURE}
SESSION_ABSOLUTE_TTL_HOURS=${SESSION_ABSOLUTE_TTL_HOURS}
SESSION_IDLE_TTL_HOURS=${SESSION_IDLE_TTL_HOURS}
BOOTSTRAP_ADMIN_EMAIL=${BOOTSTRAP_ADMIN_EMAIL}
BOOTSTRAP_ADMIN_PASSWORD=${BOOTSTRAP_ADMIN_PASSWORD}
BROKER_SHARED_SECRET=${BROKER_SHARED_SECRET}
DOCKER_GID=${DOCKER_GID}
DMS_CONTAINER_NAME=${DMS_CONTAINER_NAME}
DMS_CONTAINER_LABEL=${DMS_CONTAINER_LABEL}
RSPAMD_URL=${RSPAMD_URL}
RSPAMD_PASSWORD=${RSPAMD_PASSWORD}
ENABLE_EXEC_CONSOLE=${ENABLE_EXEC_CONSOLE}
ENABLE_HSTS=${ENABLE_HSTS}
# Optional MCP integration — docs/mcp-integration.md.
MCP_ENABLED=${MCP_ENABLED}
MCP_PUBLIC_URL=${MCP_PUBLIC_URL}
MCP_BIND_ADDRESS=${MCP_BIND_ADDRESS}
MCP_PORT=${MCP_PORT}
MCP_MAIL_HOST=${MCP_MAIL_HOST}
MCP_TRUST_PROXY=${MCP_TRUST_PROXY}
MCP_REQUIRE_HTTPS=${MCP_REQUIRE_HTTPS}
EOF

if [ -f "${ENV_FILE}" ]; then
  # Read straight from the old file rather than through a pipe: `while
  # read` on the right of a pipe runs in a subshell in POSIX sh, and
  # redirecting instead keeps this loop in the current shell where its
  # `>>` appends are the only thing that has to survive it.
  : > "${TMP_EXTRA}"
  while IFS= read -r line; do
    case "${line}" in
      [A-Za-z_]*=*) ;;
      *) continue ;;
    esac
    key=${line%%=*}
    case " ${MANAGED_KEYS} " in
      *" ${key} "*) ;;
      *) printf '%s\n' "${line}" >> "${TMP_EXTRA}" ;;
    esac
  done < "${ENV_FILE}"
  if [ -s "${TMP_EXTRA}" ]; then
    {
      printf '\n'
      printf '# Carried over from the previous .env — keys install.sh does not\n'
      printf '# manage itself. Left exactly as they were found.\n'
    } >> "${TMP_ENV}"
    cat "${TMP_EXTRA}" >> "${TMP_ENV}"
  fi
fi

chmod 600 "${TMP_ENV}"
mv "${TMP_ENV}" "${ENV_FILE}"
rm -f "${TMP_EXTRA}"
trap - EXIT
log "Wrote ${ENV_FILE}."

# ---------------------------------------------------------------------------
# 8b. MCP vault key — the key that seals every stored mailbox credential.
#     Only when MCP_ENABLED=true: docker/compose.mcp.yaml is what mounts it,
#     and without that overlay nothing reads it. Generated once into
#     secrets/ (git-ignored), never regenerated: replacing it would make
#     every sealed credential unreadable. An existing key is kept whatever
#     MCP_ENABLED says, so turning the integration off and on again keeps
#     every stored credential. It lives outside the dwg-server-data volume
#     on purpose, so a copy of that volume alone cannot unseal anything.
#     The directory is 0700 (only this user can traverse it on the host);
#     the file is 0444 because the container runs as an unprivileged UID
#     (10001) that must be able to read the bind-mounted file.
# ---------------------------------------------------------------------------
MCP_SECRETS_DIR="${REPO_ROOT}/secrets"
MCP_VAULT_KEY_PATH="${MCP_SECRETS_DIR}/mcp_vault_key"
if [ "${MCP_ENABLED}" = "true" ]; then
  mkdir -p "${MCP_SECRETS_DIR}"
  chmod 700 "${MCP_SECRETS_DIR}"
  if [ -f "${MCP_VAULT_KEY_PATH}" ]; then
    [ -s "${MCP_VAULT_KEY_PATH}" ] || die "${MCP_VAULT_KEY_PATH} exists but is empty. Restore it from your backup (stored MCP mailbox credentials cannot be read without it), or delete it to start over and re-provision every MCP connection's mailbox credential."
    log "MCP vault key present (${MCP_VAULT_KEY_PATH}) — kept as is."
  else
    TMP_KEY=$(mktemp "${MCP_SECRETS_DIR}/.mcp_vault_key.XXXXXX")
    # A server that ran without this overlay sealed its credentials with
    # the key it generated in its data volume; adopt that key rather than
    # mint a new one that could not open them.
    if docker exec dwg-server cat /app/data/mcp/vault.key > "${TMP_KEY}" 2>/dev/null && [ -s "${TMP_KEY}" ]; then
      log "Adopted the MCP vault key the server generated in its data volume."
    else
      gen_secret > "${TMP_KEY}"
      log "Generated the MCP vault key."
    fi
    chmod 444 "${TMP_KEY}"
    mv "${TMP_KEY}" "${MCP_VAULT_KEY_PATH}"
    log "MCP vault key written to ${MCP_VAULT_KEY_PATH}."
  fi
fi

# ---------------------------------------------------------------------------
# 9. Build and start.
# ---------------------------------------------------------------------------
if [ "${DWG_IMAGE_MODE}" = "pull" ]; then
  log "Pulling published images (DWG_IMAGE_MODE=pull, version ${DWG_VERSION})..."
  dc pull
else
  log "Building images from source (DWG_IMAGE_MODE=build)..."
  dc build
fi

log "Starting the stack..."
dc up -d --remove-orphans

# ---------------------------------------------------------------------------
# 10. Wait for real health — the same endpoint playwright.config.ts's
#     webServer.url polls, not a fixed sleep. Prefers curl, falls back to
#     wget: neither is guaranteed on every minimal Linux install (this
#     script's own container images deliberately have neither — see
#     docker/server/Dockerfile's healthcheck comment — but the *host*
#     running this installer is a different, less controlled thing).
# ---------------------------------------------------------------------------
check_url() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 2 "$1" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 2 -O /dev/null "$1" >/dev/null 2>&1
  else
    die "neither curl nor wget is available to check ${1}. Install one and re-run."
  fi
}

log "Waiting for the server to report healthy..."
HEALTH_URL="http://127.0.0.1:${PORT}/api/v1/health"
ATTEMPT=0
MAX_ATTEMPTS=60
until check_url "${HEALTH_URL}"; do
  ATTEMPT=$((ATTEMPT + 1))
  if [ "${ATTEMPT}" -ge "${MAX_ATTEMPTS}" ]; then
    die "the server did not become healthy after ${MAX_ATTEMPTS} attempts. Check the logs: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs server broker"
  fi
  sleep 2
done
log "Healthy."

# ---------------------------------------------------------------------------
# 11. Assert the privilege boundary is real in the containers that just
#     started, on this host — not merely described by docker/compose.yaml.
#
#     Read/write access to /var/run/docker.sock is root on the host
#     (AGENT_BRIEF.md §2), and the entire architecture exists to keep that
#     access on one small tier. `.github/workflows/installer.yml` asserts
#     the same properties in CI; this repeats the two load-bearing ones
#     where they actually matter to an operator — on their machine, on
#     their Docker version, against the compose file as it was actually
#     interpolated for them. It costs two `docker inspect` calls and it
#     fails the install rather than reporting success over a boundary that
#     silently did not materialise.
#
#     Fatal, not a warning: an install that came up "healthy" with the
#     socket on the wrong side of the boundary is worse than one that
#     refused, because it looks finished.
# ---------------------------------------------------------------------------
SERVER_CID=$(dc ps -q server)
BROKER_CID=$(dc ps -q broker)
[ -n "${SERVER_CID}" ] || die "could not find the running 'server' container after starting the stack."
[ -n "${BROKER_CID}" ] || die "could not find the running 'broker' container after starting the stack."

# Every mount destination, not just /var/run/docker.sock: the claim is
# that the web tier has no Docker socket anywhere in its filesystem, so
# checking one path would leave the claim broader than the check.
SERVER_MOUNTS=$(docker inspect --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' "${SERVER_CID}")
case "${SERVER_MOUNTS}" in
  *docker.sock*) die "the 'server' container has a Docker socket mounted (${SERVER_MOUNTS}). This must never happen — see AGENT_BRIEF.md §2 and docker/compose.yaml. Refusing to report a successful install." ;;
esac

BROKER_MOUNTS=$(docker inspect --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' "${BROKER_CID}")
case "${BROKER_MOUNTS}" in
  *"${DOCKER_SOCK_PATH}"*) ;;
  *) die "the 'broker' container does not have ${DOCKER_SOCK_PATH} mounted, so no Docker operation can work. Check docker/compose.yaml and the logs." ;;
esac

BROKER_PORTS=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${BROKER_CID}")
case "${BROKER_PORTS}" in
  *HostPort*) die "the 'broker' container publishes a port to the host (${BROKER_PORTS}). The privileged tier must be reachable only from the internal network." ;;
esac

log "Privilege boundary verified: the socket is on the broker only, and the broker publishes nothing."

# The optional MCP listener runs inside the server container. When it is
# enabled, wait until it answers there — a misconfiguration (for example a
# missing vault key) stops the server from starting at all, which the
# health wait above already catches.
if [ "${MCP_ENABLED}" = "true" ]; then
  log "Waiting for the MCP listener to answer..."
  ATTEMPT=0
  until docker exec "${SERVER_CID}" node -e "fetch('http://127.0.0.1:3100/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
    ATTEMPT=$((ATTEMPT + 1))
    if [ "${ATTEMPT}" -ge "${MAX_ATTEMPTS}" ]; then
      die "the MCP listener did not answer. Check the logs: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs server"
    fi
    sleep 2
  done
  log "MCP listener answering on port 3100 inside the server container."
fi

# ---------------------------------------------------------------------------
# 12. Best-effort: attach the server to an already-running
#     docker-mailserver's network, for apps/server's direct Rspamd HTTP
#     calls (docker/compose.yaml's own header explains why this is the
#     one thing that needs real network reachability to DMS, rather than
#     going through the broker). Never fatal — DMS may not exist yet, or
#     may be added later; this script is safe to re-run once it does.
# ---------------------------------------------------------------------------
DMS_CID=$(docker ps -q --filter "name=^${DMS_CONTAINER_NAME}\$" | head -n1)
if [ -z "${DMS_CID}" ] && [ -n "${DMS_CONTAINER_LABEL}" ]; then
  DMS_CID=$(docker ps -q --filter "label=${DMS_CONTAINER_LABEL}" | head -n1)
fi

attach_to_dms_network() {
  # $1 = container id, $2 = human name, $3 = why it needs the network
  _attach_networks=$(docker inspect -f '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}} {{end}}' "$1")
  _attach_connected=false
  for net in ${DMS_NETWORKS}; do
    # Never use this loop to bridge onto this project's own internal
    # networks, whatever network DMS happens to share.
    # Docker's default `bridge` network has no embedded DNS, so the mail
    # server's container name would not resolve there; `host` and `none`
    # cannot be joined at all.
    case "${net}" in
      dwg-broker | bridge | host | none) continue ;;
    esac
    # Already attached (a re-run against an unchanged stack) is success,
    # not a failure to report — this loop is idempotent by construction.
    case " ${_attach_networks} " in
      *" ${net} "*)
        log "The $2 is already attached to docker-mailserver's network '${net}'."
        _attach_connected=true
        break
        ;;
    esac
    if docker network connect "${net}" "$1" 2>/dev/null; then
      log "Attached the $2 to docker-mailserver's network '${net}' ($3)."
      _attach_connected=true
      break
    fi
  done
  if [ "${_attach_connected}" = "false" ]; then
    warn "found a running '${DMS_CONTAINER_NAME}' container but could not attach the $2 to any of its networks ($3) — see docs/docker.md §3."
  fi
}

if [ -n "${DMS_CID}" ]; then
  DMS_NETWORKS=$(docker inspect -f '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}} {{end}}' "${DMS_CID}")
  if [ "${MCP_ENABLED}" = "true" ]; then
    attach_to_dms_network "${SERVER_CID}" "server" "for Rspamd, and IMAP/SMTP for MCP"
  else
    attach_to_dms_network "${SERVER_CID}" "server" "for Rspamd reachability"
  fi
else
  warn "no running '${DMS_CONTAINER_NAME}' container found — mail-server-dependent features will report Unknown/Unavailable until one exists and this script is re-run."
fi

# ---------------------------------------------------------------------------
# 13. Report.
# ---------------------------------------------------------------------------
log ""
log "docker-webmail-gui is running: http://127.0.0.1:${PORT}"

# COOKIE_SECURE defaults on (config.ts, .env.example), which is right
# behind TLS and wrong on plain HTTP: a `Secure` session cookie is simply
# not stored by the browser over an insecure origin, so login appears to
# do nothing at all. Browsers make an exception for `localhost`/127.0.0.1,
# which is why the URL printed above still works — but the moment the
# panel is reached over a LAN address or a hostname on plain HTTP, it does
# not. Say so here rather than let an operator debug an invisible cookie.
if [ "${COOKIE_SECURE}" = "true" ]; then
  log ""
  log "Note: COOKIE_SECURE=true (the default, and correct behind TLS). Browsers refuse to"
  log "store a Secure cookie over plain http:// on anything but localhost, so if you reach"
  log "this panel over a LAN address or hostname you must either terminate TLS in front of"
  log "it, or set COOKIE_SECURE=false in ${ENV_FILE} and re-run this script."
fi

if [ "${MCP_ENABLED}" = "true" ]; then
  log ""
  log "MCP integration: listening on ${MCP_BIND_ADDRESS}:${MCP_PORT} (public MCP + OAuth endpoints)."
  if [ -z "${MCP_PUBLIC_URL}" ]; then
    log "  Next: put an HTTPS reverse proxy for a public hostname in front of it, set its"
    log "  public URL in Mail > MCP Connections > Settings (or MCP_PUBLIC_URL here), then"
    log "  enable the integration there. It stays disabled until you do."
  else
    log "  Public URL: ${MCP_PUBLIC_URL} — enable the integration in Mail > MCP Connections."
  fi
  log "  Back up ${MCP_VAULT_KEY_PATH} together with the dwg-server-data volume (stored apart)."
fi

if [ "${FRESH_INSTALL}" = "true" ]; then
  log ""
  log "First-time login (change this password immediately — you will be required to):"
  log "  Email:    ${BOOTSTRAP_ADMIN_EMAIL}"
  log "  Password: ${BOOTSTRAP_ADMIN_PASSWORD}"
  log ""
  log "This credential is shown once. It is stored in ${ENV_FILE} — consider clearing"
  log "BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD there after your first successful login."
else
  log "Upgrade complete."
fi
