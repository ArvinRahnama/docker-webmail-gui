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

DWG_INTEGRATION_VERSION=2
SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MARKER=/etc/dovecot/dwg-integration-version
DOVECOT_CONF=/etc/dovecot/conf.d/95-dwg.conf
DMS_SPAM_TO_JUNK_BACKUP=/usr/lib/dovecot/sieve-global/after/.spam_to_junk.sieve.dms

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

# Global scripts must be precompiled: the mail user cannot write a .svbin
# next to them at delivery time.
compile_global() {
  local script
  for script in "$@"; do
    if ! sievec "${script}"; then
      warn "sievec failed for ${script}; leaving docker-mailserver's own spam handling in place."
      return 1
    fi
    chown dovecot:root "${script}" "${script%.sieve}.svbin" 2>/dev/null || true
  done
}

install_common_scripts() {
  local pipe_dir=$1
  mkdir -p "${pipe_dir}" || { warn 'could not create the Sieve pipe directory'; return 1; }
  if ! { install -m 0644 "${SRC_DIR}/report-ham.sieve" "${pipe_dir}/dwg-report-ham.sieve" &&
    install -m 0644 "${SRC_DIR}/report-spam.sieve" "${pipe_dir}/dwg-report-spam.sieve" &&
    install -m 0755 "${SRC_DIR}/sender-report" "${pipe_dir}/dwg-sender-report"; }; then
    warn 'could not install the Sieve report scripts'
    return 1
  fi
  compile_global "${pipe_dir}/dwg-report-ham.sieve" "${pipe_dir}/dwg-report-spam.sieve"
}

# Dovecot 2.4 (docker-mailserver 16+): named sieve_script blocks.
install_sieve_24() {
  local after_dir=/usr/lib/dovecot/sieve-global/after
  local pipe_dir=/usr/lib/dovecot/sieve-pipe
  mkdir -p "${after_dir}" || { warn 'could not create the Sieve directory'; return 1; }
  install -m 0644 "${SRC_DIR}/spam-to-junk.sieve" "${after_dir}/70-dwg-spam-to-junk.sieve" ||
    { warn 'could not install the spam-to-Junk script'; return 1; }
  compile_global "${after_dir}/70-dwg-spam-to-junk.sieve" || return 1
  install_common_scripts "${pipe_dir}" || return 1
  install -m 0644 "${SRC_DIR}/dovecot-2.4.conf" "${DOVECOT_CONF}" ||
    { warn 'could not install the Dovecot configuration'; return 1; }
}

# Dovecot 2.3 (docker-mailserver 15 and older). docker-mailserver's own
# spam_to_junk.sieve is left exactly as it is. Each mailbox's list script
# (written by the panel into its personal Sieve folder) becomes the first
# after-script, and the after-scripts docker-mailserver already had move
# one place down. A mailbox with no list has no file, which Dovecot skips.
# (An include from a global script, as on 2.4, cannot be used here: 2.3
# fails to compile it for any mailbox without personal Sieve storage.)
# IMAPSieve rules are numbered `imapsieve_mailboxN_*` (docker-mailserver
# uses 1 and 2 when RSPAMD_LEARN=1), so this configuration is generated.
install_sieve_23() {
  local after_dir=/usr/lib/dovecot/sieve-global/after
  local pipe_dir=/usr/lib/dovecot/sieve-pipe
  install_common_scripts "${pipe_dir}" || return 1

  # With MOVE_SPAM_TO_JUNK=0 docker-mailserver writes no spam-to-Junk
  # script; a reject-free Rspamd would then put spam in the Inbox.
  if ! ls "${after_dir}"/*.sieve >/dev/null 2>&1; then
    mkdir -p "${after_dir}" || { warn 'could not create the Sieve directory'; return 1; }
    grep -v 'include :personal' "${SRC_DIR}/spam-to-junk.sieve" >"${after_dir}/spam_to_junk.sieve" &&
      compile_global "${after_dir}/spam_to_junk.sieve" || return 1
  fi

  # Our own previous copy must not count when reading what is configured.
  rm -f "${DOVECOT_CONF}"

  local sieve_dir
  sieve_dir=$(doveconf -h plugin/sieve_dir 2>/dev/null || true)
  # Dovecot's own `~` (the mailbox's home), not the shell's: keep it literal.
  # shellcheck disable=SC2088 # Dovecot expands this ~, per mailbox.
  [[ -n ${sieve_dir} ]] || sieve_dir='~/sieve'
  local -a after=()
  local i=1 key value
  while :; do
    key=sieve_after
    [[ ${i} -gt 1 ]] && key="sieve_after${i}"
    value=$(doveconf -h "plugin/${key}" 2>/dev/null || true)
    [[ -n ${value} ]] || break
    after+=("${value}")
    i=$((i + 1))
  done

  # IMAPSieve on 2.3 allows one rule per destination mailbox and source
  # (a second "into Junk" rule is skipped as a duplicate), and reads rules
  # 1, 2, 3, ... until the first missing number. So where docker-mailserver
  # already has the rule (RSPAMD_LEARN=1: rule 1 "into Junk" runs its
  # learn-spam script as `_before`), our report is attached to it as
  # `_after`; otherwise a rule of our own is added at the next number.
  local next=1 name from
  local spam_rule='' ham_rule=''
  while :; do
    name=$(doveconf -h "plugin/imapsieve_mailbox${next}_name" 2>/dev/null || true)
    [[ -n ${name} ]] || break
    from=$(doveconf -h "plugin/imapsieve_mailbox${next}_from" 2>/dev/null || true)
    [[ ${name} == Junk && -z ${from} ]] && spam_rule=${next}
    [[ ${name} == '*' && ${from} == Junk ]] && ham_rule=${next}
    next=$((next + 1))
  done

  # Prints the settings that run `script` for rule `existing` (as its
  # `_after`), or for a new rule at `next` with `name`/`from`/`causes`.
  rule_lines() {
    local existing=$1 script=$2 name=$3 from=$4 causes=$5 comment=$6
    echo
    echo "  # ${comment}"
    if [[ -n ${existing} ]]; then
      if [[ -n $(doveconf -h "plugin/imapsieve_mailbox${existing}_after" 2>/dev/null) ]]; then
        warn "IMAPSieve rule ${existing} already has an after-script; that report is not installed."
        return 0
      fi
      echo "  imapsieve_mailbox${existing}_after = file:${pipe_dir}/${script}"
      return 0
    fi
    echo "  imapsieve_mailbox${next}_name = ${name}"
    [[ -z ${from} ]] || echo "  imapsieve_mailbox${next}_from = ${from}"
    echo "  imapsieve_mailbox${next}_causes = ${causes}"
    echo "  imapsieve_mailbox${next}_before = file:${pipe_dir}/${script}"
    next=$((next + 1))
  }

  local plugins extensions imap_plugins
  plugins=$(doveconf -h plugin/sieve_plugins 2>/dev/null || true)
  extensions="$(doveconf -h plugin/sieve_extensions 2>/dev/null || true) $(doveconf -h plugin/sieve_global_extensions 2>/dev/null || true)"
  imap_plugins=$(doveconf -h -f protocol=imap mail_plugins 2>/dev/null || true)

  {
    echo '# Docker Webmail GUI — docker-mailserver integration (docker/dms/README.md).'
    echo '# Generated by install.sh on every container start; edits are lost.'
    echo 'plugin {'
    echo '  # Each mailbox'"'"'s sender lists first (compiled per mailbox, since the'
    echo '  # global directory is not writable at delivery time), then the'
    echo '  # after-scripts docker-mailserver already had, in their original order.'
    echo "  sieve_after = file:${sieve_dir}/dwg-sender-lists.sieve;bindir=~/.dwg-sieve-bin"
    local k=2 previous
    for previous in "${after[@]}"; do
      echo "  sieve_after${k} = ${previous}"
      k=$((k + 1))
    done
    [[ ${plugins} == *sieve_imapsieve* && ${plugins} == *sieve_extprograms* ]] ||
      echo "  sieve_plugins = $(printf '%s sieve_imapsieve sieve_extprograms' "${plugins}" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' ')"
    [[ -n $(doveconf -h plugin/sieve_pipe_bin_dir 2>/dev/null) ]] ||
      echo "  sieve_pipe_bin_dir = ${pipe_dir}"
    [[ ${extensions} == *vnd.dovecot.pipe* ]] ||
      echo '  sieve_global_extensions = +vnd.dovecot.pipe'
    echo
    rule_lines "${spam_rule}" dwg-report-spam.sieve Junk '' 'COPY APPEND' \
      'Moved into Junk: "this is spam" (block the sender).'
    rule_lines "${ham_rule}" dwg-report-ham.sieve '*' Junk COPY \
      'Moved out of Junk: "not spam" (allow the sender). The script skips Trash.'
    echo '}'
    if [[ ${imap_plugins} != *imap_sieve* ]]; then
      echo 'protocol imap {'
      # shellcheck disable=SC2016 # Dovecot's own $mail_plugins, written literally.
      echo '  mail_plugins = $mail_plugins imap_sieve'
      echo '}'
    fi
  } >"${DOVECOT_CONF}" || { warn 'could not write the Dovecot configuration'; return 1; }
}

# Undoes a partial install: our Dovecot config goes. (An earlier version
# replaced docker-mailserver's 2.3 spam_to_junk.sieve and kept the original
# beside it; put that back if it is there.)
rollback() {
  rm -f "${DOVECOT_CONF}"
  restore_dms_spam_to_junk
}

restore_dms_spam_to_junk() {
  local target=/usr/lib/dovecot/sieve-global/after/spam_to_junk.sieve
  if [[ -f ${DMS_SPAM_TO_JUNK_BACKUP} ]]; then
    mv -f "${DMS_SPAM_TO_JUNK_BACKUP}" "${target}" && sievec "${target}" >/dev/null 2>&1 &&
      chown dovecot:root "${target}" "${target%.sieve}.svbin" 2>/dev/null
    log "restored docker-mailserver's own spam_to_junk.sieve."
  fi
}

install_sieve() {
  local version
  version=$(dovecot --version 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+' || true)
  case "${version}" in
    2.3)
      restore_dms_spam_to_junk
      install_sieve_23 || { rollback; return 1; }
      ;;
    2.4) install_sieve_24 || { rollback; return 1; } ;;
    *)
      warn "unsupported Dovecot version '${version:-unknown}' (2.3 or 2.4 needed)."
      return 1
      ;;
  esac

  if ! doveconf -n >/dev/null 2>&1; then
    warn 'Dovecot rejected the integration configuration; removing it again.'
    rollback
    return 1
  fi
  log "Dovecot ${version}: spam-to-Junk with per-mailbox sender lists, and Junk move reports, installed."
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
