#!/bin/sh
# docker-webmail-gui uninstaller (M13 — IMPLEMENTATION_PLAN.md §2.3;
# SECURITY.md §4.4). POSIX sh, matching install.sh.
#
# Four independent things this can remove, each beyond the default
# requiring its own explicit opt-in:
#
#   (default, no flags)  The GUI itself: the server/broker containers and
#                        this project's own two Docker networks. Leaves
#                        the named volumes (dwg-server-data,
#                        dwg-server-backups — admin accounts, sessions,
#                        audit log), the built images, and .env in place,
#                        so re-running install.sh recovers the install
#                        exactly as it was.
#   --purge              ALSO removes this project's own named volumes
#                        *and* the generated .env. Requires typing the
#                        exact confirmation phrase printed at the prompt
#                        (or DWG_CONFIRM_PURGE=yes for non-interactive
#                        use, e.g. CI) — this deletes admin accounts and
#                        the audit log, this project's own data, not mail
#                        data, but still real and still irreversible.
#                        .env goes with them deliberately: it is a
#                        generated file whose only contents are the
#                        secrets guarding data that no longer exists, and
#                        leaving it behind would both strand those secrets
#                        on disk and make the next install.sh think it was
#                        upgrading an install whose database is gone.
#   --remove-images      ALSO removes the two images this project builds
#                        (`docker compose down --rmi all`). Pure build
#                        output — no data, fully reproducible by
#                        install.sh — so this needs no confirmation, only
#                        an explicit ask, since rebuilding them is slow.
#   --remove-mail-server ALSO stops and removes the docker-mailserver
#                        *container* this panel was pointed at
#                        (DMS_CONTAINER_NAME/LABEL). Never its volumes,
#                        under any flag or confirmation this script
#                        offers — mail data is not this script's to
#                        delete, the same absolute refusal the panel
#                        itself makes (SECURITY.md §4.3: "a block, not a
#                        confirmation"). Requires its own typed
#                        confirmation (or DWG_CONFIRM_REMOVE_MAIL=yes).
#
# Idempotent: safe to run more than once, in any order relative to
# install.sh — anything already removed is reported, not treated as an
# error. That includes running with .env already gone, which is the state
# `--purge` itself leaves behind: docker/compose.yaml declares
# COOKIE_SECRET, BROKER_SHARED_SECRET and DOCKER_GID with Compose's
# `${VAR:?message}` required-variable syntax, and Compose interpolates the
# file for *every* subcommand including `down`, so a teardown with no
# .env would otherwise abort on a missing secret it does not need. Step 1
# below passes throwaway values for exactly that reason — `down` needs the
# service, network and volume *names*, never the secrets themselves.
#
# Every run ends by printing what it left behind, so what survives an
# uninstall is a stated outcome rather than something to discover later.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd)
COMPOSE_FILE="${REPO_ROOT}/docker/compose.yaml"
ENV_FILE="${REPO_ROOT}/.env"

log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

PURGE=false
REMOVE_IMAGES=false
REMOVE_MAIL_SERVER=false
for arg in "$@"; do
  case "${arg}" in
    --purge) PURGE=true ;;
    --remove-images) REMOVE_IMAGES=true ;;
    --remove-mail-server) REMOVE_MAIL_SERVER=true ;;
    --help | -h)
      log "Usage: $0 [--purge] [--remove-images] [--remove-mail-server]"
      log "See this script's own header comment for exactly what each flag does."
      exit 0
      ;;
    *) die "unknown argument: ${arg} (see: $0 --help)" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH."

# Read everything this script needs out of .env *before* anything can
# remove it — --purge deletes .env, and --remove-mail-server (which may be
# passed in the same invocation) needs the container name that was in it.
DMS_CONTAINER_NAME=mailserver
DMS_CONTAINER_LABEL=""
if [ -f "${ENV_FILE}" ]; then
  FOUND_NAME=$(sed -n 's/^DMS_CONTAINER_NAME=//p' "${ENV_FILE}" | tail -n1)
  FOUND_LABEL=$(sed -n 's/^DMS_CONTAINER_LABEL=//p' "${ENV_FILE}" | tail -n1)
  if [ -n "${FOUND_NAME}" ]; then DMS_CONTAINER_NAME="${FOUND_NAME}"; fi
  if [ -n "${FOUND_LABEL}" ]; then DMS_CONTAINER_LABEL="${FOUND_LABEL}"; fi
fi

# ---------------------------------------------------------------------------
# 1. Stop and remove the GUI's own containers and networks (and, with
#    --remove-images, the images built from this repository).
#    `docker compose down` is itself idempotent: run against an
#    already-stopped/removed stack, it reports nothing to do rather than
#    failing.
# ---------------------------------------------------------------------------
if [ -f "${COMPOSE_FILE}" ]; then
  # Builds the `docker compose` argument list in the positional
  # parameters. Safe here and only here: the flag loop above has already
  # consumed this script's own "$@", and nothing below reads it again.
  set -- -f "${COMPOSE_FILE}"
  if [ -f "${ENV_FILE}" ]; then
    set -- "$@" --env-file "${ENV_FILE}"
  fi
  set -- "$@" down --remove-orphans
  if [ "${REMOVE_IMAGES}" = "true" ]; then
    # `--rmi local` would remove nothing here: it only covers services
    # with no `image:` field, and docker/compose.yaml names both images
    # explicitly so they are addressable and taggable.
    set -- "$@" --rmi all
  fi

  if [ -f "${ENV_FILE}" ]; then
    docker compose "$@"
  else
    # The three throwaway values are what makes a teardown work with no
    # .env at all — see this file's header for why Compose demands them
    # even for `down`. Scoped to this one command, never exported, and
    # never used when a real .env exists.
    COOKIE_SECRET=uninstall \
      BROKER_SHARED_SECRET=uninstall \
      DOCKER_GID=0 \
      docker compose "$@"
  fi
  log "Removed the GUI's containers and networks."
  if [ "${REMOVE_IMAGES}" = "true" ]; then
    log "Removed the images built from this repository."
  fi
else
  warn "${COMPOSE_FILE} not found — skipping compose teardown (nothing to remove, or this is not a checkout of the repository)."
fi

# ---------------------------------------------------------------------------
# 2. --purge: this project's own named volumes, and the generated .env.
#    Own data, not mail data — but still real, still irreversible, so it
#    gets the same type-to-confirm discipline the panel's own UI uses for
#    a destructive action (UX_ARCHITECTURE.md §8), not a bare --force flag.
# ---------------------------------------------------------------------------
PURGED=false
if [ "${PURGE}" = "true" ]; then
  CONFIRM_PHRASE="delete docker-webmail-gui data"
  if [ "${DWG_CONFIRM_PURGE:-}" != "yes" ]; then
    if [ -t 0 ]; then
      printf 'This deletes admin accounts, sessions, the audit log and the generated .env\n'
      printf '(with its secrets) — not mail data, but not recoverable either.\n'
      printf 'Type "%s" to confirm: ' "${CONFIRM_PHRASE}"
      read -r REPLY
      [ "${REPLY}" = "${CONFIRM_PHRASE}" ] || die "confirmation did not match — nothing was deleted."
    else
      die "--purge requires confirmation. Run interactively, or set DWG_CONFIRM_PURGE=yes for non-interactive use (e.g. CI)."
    fi
  fi
  PURGED=true
  for volume in dwg-server-data dwg-server-backups; do
    if docker volume inspect "${volume}" >/dev/null 2>&1; then
      docker volume rm "${volume}" >/dev/null
      log "Removed volume ${volume}."
    else
      log "Volume ${volume} does not exist — already removed."
    fi
  done
  if [ -f "${ENV_FILE}" ]; then
    rm -f "${ENV_FILE}"
    log "Removed ${ENV_FILE}."
  else
    log "${ENV_FILE} does not exist — already removed."
  fi
else
  log "Own data preserved (dwg-server-data, dwg-server-backups, .env) — pass --purge to remove it too."
fi

# ---------------------------------------------------------------------------
# 3. --remove-mail-server: stop and remove the docker-mailserver
#    *container* only — never its volumes, never its mail data, under
#    any flag this script offers.
# ---------------------------------------------------------------------------
if [ "${REMOVE_MAIL_SERVER}" = "true" ]; then
  DMS_CID=$(docker ps -aq --filter "name=^${DMS_CONTAINER_NAME}\$" | head -n1)
  if [ -z "${DMS_CID}" ] && [ -n "${DMS_CONTAINER_LABEL}" ]; then
    DMS_CID=$(docker ps -aq --filter "label=${DMS_CONTAINER_LABEL}" | head -n1)
  fi

  if [ -z "${DMS_CID}" ]; then
    log "No '${DMS_CONTAINER_NAME}' container found — already removed, or never existed here."
  else
    CONFIRM_PHRASE="remove the mail server container"
    if [ "${DWG_CONFIRM_REMOVE_MAIL:-}" != "yes" ]; then
      if [ -t 0 ]; then
        printf 'This stops and removes the "%s" container. Its volumes (mail data) are never\n' "${DMS_CONTAINER_NAME}"
        printf 'touched by this script, under any flag — you would still need to remove those\n'
        printf 'yourself, deliberately, separately.\n'
        printf 'Type "%s" to confirm: ' "${CONFIRM_PHRASE}"
        read -r REPLY
        [ "${REPLY}" = "${CONFIRM_PHRASE}" ] || die "confirmation did not match — the mail server container was not touched."
      else
        die "--remove-mail-server requires confirmation. Run interactively, or set DWG_CONFIRM_REMOVE_MAIL=yes for non-interactive use (e.g. CI)."
      fi
    fi
    # No `-v`: `docker rm -v` would take the container's anonymous
    # volumes with it, and a docker-mailserver deployment's mail store is
    # exactly the kind of thing that can be one. Removing the container
    # is the whole of what this flag promises.
    docker rm -f "${DMS_CID}" >/dev/null
    log "Removed the mail server container. Its volumes were not touched."
  fi
else
  log "Mail server untouched (default) — pass --remove-mail-server to also stop and remove it (never its volumes)."
fi

# ---------------------------------------------------------------------------
# 4. Say what is still on this host. An uninstaller that quietly leaves
#    things behind is the failure mode worth engineering against; leaving
#    them behind *on purpose* and naming them is not.
# ---------------------------------------------------------------------------
log ""
log "Uninstall complete. Still on this host:"
if [ "${PURGED}" = "false" ]; then
  log "  - volumes dwg-server-data, dwg-server-backups (admins, sessions, audit log)"
  log "  - ${ENV_FILE} (generated, contains secrets)"
  log "    remove both with: $0 --purge"
fi
if [ "${REMOVE_IMAGES}" = "false" ]; then
  log "  - the images built from this repository (docker-webmail-gui-server, docker-webmail-gui-broker)"
  log "    remove with: $0 --remove-images"
fi
if [ "${REMOVE_MAIL_SERVER}" = "false" ]; then
  log "  - the '${DMS_CONTAINER_NAME}' container, if one exists — this panel never deployed it"
fi
log "  - any docker-mailserver volume or mail data: never touched by this script, under any flag"
log "  - this repository checkout itself: delete it yourself if you no longer want it"
