#!/bin/sh
# Docker Webmail GUI — install the docker-mailserver spam-filter integration
# (docker/dms/README.md) into a running docker-mailserver container.
#
#   ./installer/install-dms-integration.sh [--container NAME] [--no-apply]
#   ./installer/install-dms-integration.sh --uninstall [--container NAME]
#
# What it does, all through the Docker CLI (no host paths needed, so it
# works whether DMS's config directory is a bind mount or a named volume):
#
#   1. Copies docker/dms/dwg/ into the container's config directory,
#      /tmp/docker-mailserver/dwg/ — the volume DMS keeps across recreates.
#   2. Adds one line to /tmp/docker-mailserver/user-patches.sh (creating
#      it if absent, never replacing what is there) so DMS runs the
#      integration's install.sh on every container start.
#   3. Unless --no-apply, runs it now and reloads Dovecot and Rspamd, so it
#      takes effect without recreating the container. No mail is lost:
#      Postfix keeps accepting while Rspamd restarts.
#
# Re-running it is safe; it updates the files and never adds the hook twice.
set -eu

CONTAINER=''
APPLY=true
UNINSTALL=false
HOOK_MARKER='# docker-webmail-gui spam-filter integration'
HOOK_LINE='[ -f /tmp/docker-mailserver/dwg/install.sh ] && /bin/bash /tmp/docker-mailserver/dwg/install.sh'

log() { printf '[install-dms-integration] %s\n' "$*"; }
die() { printf '[install-dms-integration] ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER=${2:?--container needs a name}; shift 2 ;;
    --no-apply) APPLY=false; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC_DIR="${REPO_ROOT}/docker/dms/dwg"
[ -f "${SRC_DIR}/install.sh" ] || die "missing ${SRC_DIR}/install.sh — run this from a full checkout."

if [ -z "${CONTAINER}" ]; then
  # Same default and .env key the panel itself uses (DMS_CONTAINER_NAME).
  if [ -f "${REPO_ROOT}/.env" ] && [ -r "${REPO_ROOT}/.env" ]; then
    CONTAINER=$(sed -n 's/^DMS_CONTAINER_NAME=//p' "${REPO_ROOT}/.env" | tail -n1)
  fi
  CONTAINER=${CONTAINER:-mailserver}
fi

command -v docker >/dev/null 2>&1 || die 'docker is not installed.'
[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || true)" = 'true' ] ||
  die "no running container named '${CONTAINER}'. Pass --container NAME."
docker exec "${CONTAINER}" test -d /tmp/docker-mailserver ||
  die "'${CONTAINER}' has no /tmp/docker-mailserver — is it docker-mailserver?"

TMP=$(mktemp)
trap 'rm -f "${TMP}"' EXIT

# Current user-patches.sh (empty if there is none).
docker exec "${CONTAINER}" sh -c 'cat /tmp/docker-mailserver/user-patches.sh 2>/dev/null || true' >"${TMP}"

if [ "${UNINSTALL}" = true ]; then
  if grep -qF "${HOOK_MARKER}" "${TMP}"; then
    grep -vF -e "${HOOK_MARKER}" -e "${HOOK_LINE}" "${TMP}" >"${TMP}.new" || true
    mv "${TMP}.new" "${TMP}"
    docker cp "${TMP}" "${CONTAINER}:/tmp/docker-mailserver/user-patches.sh"
    log 'Removed the hook from user-patches.sh.'
  fi
  docker exec "${CONTAINER}" rm -rf /tmp/docker-mailserver/dwg
  log "Removed /tmp/docker-mailserver/dwg. Recreate the container to return to docker-mailserver's own spam handling, e.g.: docker compose up -d --force-recreate ${CONTAINER}"
  exit 0
fi

log "Installing into '${CONTAINER}'…"
docker exec "${CONTAINER}" mkdir -p /tmp/docker-mailserver/dwg
docker cp "${SRC_DIR}/." "${CONTAINER}:/tmp/docker-mailserver/dwg/"

if grep -qF "${HOOK_LINE}" "${TMP}"; then
  log 'user-patches.sh already runs the integration.'
else
  if [ ! -s "${TMP}" ]; then
    printf '#!/bin/bash\n' >"${TMP}"
  fi
  # Make sure the existing last line ends before ours starts.
  [ -z "$(tail -c1 "${TMP}")" ] || printf '\n' >>"${TMP}"
  printf '\n%s\n%s\n' "${HOOK_MARKER}" "${HOOK_LINE}" >>"${TMP}"
  docker cp "${TMP}" "${CONTAINER}:/tmp/docker-mailserver/user-patches.sh"
  log 'Added the hook to user-patches.sh (it runs on every container start).'
fi

if [ "${APPLY}" = true ]; then
  log 'Applying now…'
  docker exec "${CONTAINER}" /bin/bash /tmp/docker-mailserver/dwg/install.sh
  if docker exec "${CONTAINER}" test -f /etc/dovecot/dwg-integration-version; then
    docker exec "${CONTAINER}" doveadm reload
    docker exec "${CONTAINER}" supervisorctl restart rspamd >/dev/null
    log 'Done. Spam is now filed in Junk instead of being rejected, and Junk moves update sender lists.'
  else
    die 'the integration did not activate inside the container; see the warnings above.'
  fi
else
  log "Installed. It takes effect when the container is next recreated, e.g.: docker compose up -d --force-recreate ${CONTAINER}"
fi

if [ "$(docker exec "${CONTAINER}" printenv ENABLE_CLAMAV 2>/dev/null || true)" != '1' ]; then
  log "Note: ENABLE_CLAMAV is not 1 in '${CONTAINER}', so mail is not scanned for viruses. Set ENABLE_CLAMAV=1 in docker-mailserver's environment and recreate the container to turn the antivirus on."
fi
