#!/bin/bash
# Docker Webmail GUI — docker-mailserver integration (docker/dms/README.md).
#
# Run by docker-mailserver's user-patches.sh on every container start, as
# root, after DMS has written its own configuration and before the mail
# daemons start. It makes three changes, all inside the container (nothing
# here touches the mail data volume):
#
#   1. Rspamd never rejects mail for its spam score. Spam is delivered with
#      the X-Spam header and filed in Junk instead. Viruses (ClamAV) are
#      still rejected — that is a forced action, not a score.
#   2. Spam-to-Junk honours each mailbox's own sender allow/block lists,
#      which the panel maintains as the personal Sieve script
#      "dwg-sender-lists".
#   3. A user moving mail out of Junk ("not spam") or into Junk ("spam")
#      is recorded in the mail log, where the panel picks it up and updates
#      that mailbox's lists.
#
# It never fails the container start: every step warns and carries on, so
# a problem here degrades to "spam handling as docker-mailserver ships it",
# never to a mail server that will not boot.

DWG_INTEGRATION_VERSION=1
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MARKER=/etc/dovecot/dwg-integration-version

log() { echo "[dwg-integration] $*"; }
warn() { echo "[dwg-integration] WARNING: $*" >&2; }

install_rspamd_never_reject() {
  local actions=/etc/rspamd/local.d/actions.conf
  if [[ ! -d /etc/rspamd/local.d ]]; then
    warn 'Rspamd is not installed in this container; spam will not be scored at all.'
    return 0
  fi
  if [[ -f ${actions} ]] && grep -qE '^[[:space:]]*reject[[:space:]]*=' "${actions}"; then
    sed -i -E 's|^([[:space:]]*reject[[:space:]]*=).*|\1 null;|' "${actions}" ||
      warn "could not edit ${actions}"
  else
    echo 'reject = null;' >>"${actions}" || warn "could not write ${actions}"
  fi
  # An operator's own override wins over local.d, by Rspamd's design. Say
  # so loudly rather than pretend the policy is in force.
  local override=/etc/rspamd/override.d/actions.conf
  if [[ -f ${override} ]] && grep -qE '^[[:space:]]*reject[[:space:]]*=[[:space:]]*[0-9]' "${override}"; then
    warn "${override} sets a reject threshold, which overrides this integration: spam scoring above it will still be rejected."
  fi
  log 'Rspamd: spam is no longer rejected (reject = null); it is filed in Junk.'
}

install_sieve() {
  local after_dir=/usr/lib/dovecot/sieve-global/after
  local pipe_dir=/usr/lib/dovecot/sieve-pipe
  mkdir -p "${after_dir}" "${pipe_dir}" || { warn 'could not create Sieve directories'; return 1; }

  install -m 0644 "${SRC_DIR}/spam-to-junk.sieve" "${after_dir}/70-dwg-spam-to-junk.sieve" &&
    install -m 0644 "${SRC_DIR}/report-ham.sieve" "${pipe_dir}/dwg-report-ham.sieve" &&
    install -m 0644 "${SRC_DIR}/report-spam.sieve" "${pipe_dir}/dwg-report-spam.sieve" &&
    install -m 0755 "${SRC_DIR}/sender-report" "${pipe_dir}/dwg-sender-report" ||
    { warn 'could not install the Sieve scripts'; return 1; }

  # Global scripts must be precompiled: the mail user cannot write a
  # .svbin next to them at delivery time.
  local script
  for script in "${after_dir}/70-dwg-spam-to-junk.sieve" \
    "${pipe_dir}/dwg-report-ham.sieve" "${pipe_dir}/dwg-report-spam.sieve"; do
    if ! sievec "${script}"; then
      warn "sievec failed for ${script}; leaving docker-mailserver's own spam handling in place."
      return 1
    fi
    chown dovecot:root "${script}" "${script%.sieve}.svbin" 2>/dev/null || true
  done

  install -m 0644 "${SRC_DIR}/dovecot.conf" /etc/dovecot/conf.d/95-dwg.conf ||
    { warn 'could not install the Dovecot configuration'; return 1; }

  if ! doveconf -n >/dev/null 2>&1; then
    warn 'Dovecot rejected the integration configuration; removing it again.'
    rm -f /etc/dovecot/conf.d/95-dwg.conf
    return 1
  fi
  log 'Dovecot: spam-to-Junk with per-mailbox sender lists, and Junk move reports, installed.'
}

if install_sieve; then
  install_rspamd_never_reject
  echo "${DWG_INTEGRATION_VERSION}" >"${MARKER}"
else
  # Without the Sieve half, a reject-free Rspamd would deliver spam to the
  # Inbox whenever MOVE_SPAM_TO_JUNK=0. Leave Rspamd as it was.
  rm -f "${MARKER}"
  warn 'integration not active; Rspamd left unchanged.'
fi
exit 0
