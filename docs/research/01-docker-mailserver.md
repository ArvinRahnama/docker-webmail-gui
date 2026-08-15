# docker-mailserver (DMS) Research

Research target: `docker-mailserver/docker-mailserver`. Sources are the official docs (`https://docker-mailserver.github.io/docker-mailserver/latest/`) and the official GitHub repo (`https://github.com/docker-mailserver/docker-mailserver`), read at the `master` branch via `raw.githubusercontent.com`. Every capability claim is tagged `[CONFIRMED: url]` (I read the actual file/line), `[INFERRED]` (reasonable conclusion from confirmed evidence but not a direct quote), or `[UNCERTAIN]` (needs runtime verification against a live container).

Tags default to file paths at `master`; permalink with a commit SHA where it matters is noted inline.

---

## ★1. Are domains first-class objects in DMS?

**No. Domains are implicit/derived, not a manageable entity.** There is no `setup domain add/del/list` command anywhere in the CLI — the full command surface (below) has no "domain" verb at all. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/setup]`

The official docs state this explicitly:

> "No extra configuration in DMS is required after provisioning an account with an email address." — under "Support for multiple mail domains"
> `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/docs/content/config/account-management/overview.md]`

**How the domain list is actually derived (`ACCOUNT_PROVISIONER=FILE`, the default):**

- The set of domains Postfix is "responsible for" (`/etc/postfix/vhost`) is generated at container startup / change-detection from the domain-parts of every email address in `postfix-accounts.cf` (real mailboxes) and `postfix-virtual.cf` (aliases). A domain "exists" purely because at least one account or alias uses it.
- `setup config dkim domain '<comma,list>'` accepts an explicit domain list as an argument — but this is a scoping override for DKIM key generation only (useful under LDAP, where DMS can't derive domains from local files), not domain creation. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/open-dkim]`

**Implication for the admin panel:** a "create empty domain" button would be a fake feature — there is no domain object to create or delete. The UI's domain list should be a _computed view_ (distinct domain-parts across accounts + aliases), not a CRUD resource. Deleting the last account/alias on a domain silently makes that domain "disappear" from DMS's perspective; there's nothing else to clean up.

---

## ★2. The `setup` CLI surface

**Binary location inside the container:** `/usr/local/bin/setup`. Confirmed via the Dockerfile's copy step, which places every script in `target/bin/*` (including `setup` itself, `addmailuser`, `delmailuser`, `open-dkim`, `fail2ban`, `dms-healthcheck`, etc.) directly into `/usr/local/bin/`:

```
COPY \
  target/bin/* \
  target/scripts/*.sh \
  target/scripts/startup/*.sh \
  /usr/local/bin/
```

`[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/Dockerfile lines 263-267]`

This means every subcommand below is _also_ an independently invocable executable at `/usr/local/bin/<name>` (e.g. `docker exec mailserver addmailuser user@example.com` works the same as going through `setup email add`) — the `setup` script is a thin dispatcher (`target/bin/setup`) that `source`s `/usr/local/bin/helpers/index.sh` and `case`-statements into these individual scripts.

**Invocation from the host:** the repo ships a convenience wrapper `setup.sh` at the repo root, which the docs describe as "aliasing `docker exec -ti <CONTAINER NAME> setup`" — it is meant to run on the **host**, not inside the container. `[CONFIRMED: https://docker-mailserver.github.io/docker-mailserver/latest/config/setup.sh/]` Equivalent direct form:

```
docker exec -ti <CONTAINER_NAME> setup <command> <subcommand> [args...]
```

**Full subcommand table** (verbatim from `setup`'s `_usage()` + cross-checked against each `target/bin/*` script):

| Command        | Exact argv                                                            | What it does                                                                                                                            |
| -------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| email          | `setup email add <EMAIL> [<PASSWORD>]`                                | Create a mailbox account in `postfix-accounts.cf`                                                                                       |
| email          | `setup email update <EMAIL> [<PASSWORD>]`                             | Change a mailbox's password                                                                                                             |
| email          | `setup email del [-y\|-n] <EMAIL> [<EMAIL>...]`                       | Delete account(s); see ★4                                                                                                               |
| email          | `setup email restrict <add\|del\|list> <send\|receive> [<EMAIL>]`     | Block/unblock an address from sending or receiving at the Postfix layer                                                                 |
| email          | `setup email list`                                                    | List accounts (human-readable; requires `ACCOUNT_PROVISIONER=FILE`)                                                                     |
| alias          | `setup alias add <EMAIL> <RECIPIENT>`                                 | Add a virtual alias/forward                                                                                                             |
| alias          | `setup alias del <EMAIL> <RECIPIENT>`                                 | Remove one recipient from an alias (or the whole alias if it was the last recipient)                                                    |
| alias          | `setup alias list`                                                    | List aliases                                                                                                                            |
| quota          | `setup quota set <EMAIL> [<QUOTA>]`                                   | Set/update a mailbox's Dovecot quota                                                                                                    |
| quota          | `setup quota del <EMAIL>`                                             | Remove a mailbox's quota entry (unlimited)                                                                                              |
| dovecot-master | `setup dovecot-master add\|update\|del\|list <USERNAME> [<PASSWORD>]` | Manage Dovecot [master accounts](https://doc.dovecot.org/configuration_manual/authentication/master_users/) (impersonation/admin login) |
| config         | `setup config dkim [keysize N] [selector NAME] [domain LIST] [help]`  | Generate DKIM keys; see ★7                                                                                                              |
| relay          | `setup relay add-domain <DOMAIN> <HOST> [<PORT>]`                     | Per-domain relay host override                                                                                                          |
| relay          | `setup relay add-auth <DOMAIN> <USERNAME> [<PASSWORD>]`               | SASL credentials for a relay host                                                                                                       |
| relay          | `setup relay exclude-domain <DOMAIN>`                                 | Exclude a domain from relaying                                                                                                          |
| fail2ban       | `setup fail2ban`                                                      | List currently banned IPs (all jails)                                                                                                   |
| fail2ban       | `setup fail2ban ban <IP>`                                             | Manually ban an IP                                                                                                                      |
| fail2ban       | `setup fail2ban unban <IP>`                                           | Unban an IP                                                                                                                             |
| fail2ban       | `setup fail2ban log`                                                  | `cat /var/log/mail/fail2ban.log`                                                                                                        |
| fail2ban       | `setup fail2ban status`                                               | Per-jail `fail2ban-client status` dump                                                                                                  |
| debug          | `setup debug fetchmail` \| `getmail`                                  | Run fetchmail/getmail in debug/foreground mode                                                                                          |
| debug          | `setup debug login [<COMMANDS>]`                                      | No command → drops into `/bin/bash` (interactive); with a command string → `/bin/bash -c "<COMMANDS>"` (scriptable)                     |
| debug          | `setup debug show-mail-logs`                                          | `cat /var/log/mail/mail.log`                                                                                                            |
| —              | `setup help` / any subcommand + `help`                                | Usage text                                                                                                                              |

`[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/setup]`

---

## ★3. Password via argv or stdin?

**Both — argv is optional and explicitly discouraged by the project itself.**

`setup email add <EMAIL> [<PASSWORD>]` and `setup email update <EMAIL> [<PASSWORD>]` accept the password as a positional argv argument. If omitted, the script prompts on stdin. The official help text for `addmailuser` says, verbatim:

> "To avoid a password being logged in the command history of your shell, you may omit it, you'll be prompted to input the password instead."
> `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/addmailuser]`

The prompt implementation (shared by add/update, `dovecot-master add/update`, and `relay add-auth` via `_password_request_if_missing()`):

```bash
read -r -s -p 'Enter Password: ' PASSWD      # -s = no echo
[[ -z ${PASSWD} ]] && _exit_with_error 'Password must not be empty'
read -r -s -p 'Confirm Password: ' PASSWD_CONFIRM
[[ ${PASSWD} != "${PASSWD_CONFIRM}" ]] && _exit_with_error 'Passwords do not match!'
```

`[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/scripts/helpers/database/manage/postfix-accounts.sh lines 100-111]`

**For a web admin panel:** if you shell out to `docker exec`, passing the password as an argv element means it is visible in `docker exec`'s argv (and container `ps`) for the process lifetime, and lands in host shell history if typed manually. The safe pattern is to pipe the password to stdin instead — the script's `read -r -s` will happily consume piped stdin non-interactively (no real TTY required, just an open stdin), e.g. `printf '%s\n%s\n' "$PASS" "$PASS" | docker exec -i mailserver setup email add user@example.com`. This avoids argv exposure entirely. Same logic applies to `email update`, `dovecot-master add/update`, and `relay add-auth`.

---

## ★4. Does `setup email del` delete mailbox data? Keep-data flag?

**Data-loss critical — quoting the actual script.** `target/bin/delmailuser`:

```bash
function _main() {
  ...
  _maildel_request_if_missing
  ...
  for MAIL_ACCOUNT in "${@}"; do
    _account_should_already_exist
    if [[ ${MAILDEL} -eq 1 ]]; then
      _remove_maildir "${MAIL_ACCOUNT}"
    elif [[ ${MAILDEL} -eq 2 ]]; then
      _log 'info' "Mailbox data explicitly kept (using -n)."
    else
      _log 'info' "The mailbox data will not be deleted."
    fi
    _manage_virtual_aliases_delete '_' "${MAIL_ACCOUNT}" ...   # strip aliases pointing at it
    _manage_dovecot_quota_delete "${MAIL_ACCOUNT}" ...          # remove quota entry
    _manage_accounts_delete "${MAIL_ACCOUNT}" ...               # remove from postfix-accounts.cf
  done
}

function _maildel_request_if_missing() {
  if [[ ${MAILDEL} -eq 0 ]]; then
    read -r -p "Do you want to delete the mailbox data as well (removing all mails)? [y/N] " MAILDEL_CHOSEN
    [[ ${MAILDEL_CHOSEN,,} == "y" ]] && MAILDEL=1
  fi
}

function _remove_maildir() {
  local MAIL_ACCOUNT_STORAGE_DIR="/var/mail/${DOMAIN_PART}/${LOCAL_PART}"
  rm -R "${MAIL_ACCOUNT_STORAGE_DIR}" ...
  rmdir "/var/mail/${DOMAIN_PART}" &>/dev/null   # only succeeds if now empty
}
```

`[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/delmailuser]`

Findings:

- **Flags:** `-y`/`-Y` → force-delete mail data without asking. `-n`/`-N` → force-keep mail data without asking. Neither flag → interactive `[y/N]` prompt, **default is No** (empty/EOF input on a non-TTY stdin leaves `MAILDEL=0`, which takes the "will not be deleted" branch — so a non-interactive invocation with no flag is safe-by-default, but you should never rely on that; always pass `-y` or `-n` explicitly from an admin panel).
- **Unconditional regardless of flags:** the account entry in `postfix-accounts.cf`, its quota entry in `dovecot-quotas.cf`, and any aliases pointing at it in `postfix-virtual.cf` are always removed. Only the raw Maildir under `/var/mail/<domain>/<local-part>` is gated by `-y`/`-n`/prompt.
- **Deletion is `rm -R`** on the whole per-user Maildir — irreversible, no trash/soft-delete.
- Multiple accounts can be passed in one call: `setup email del -y user1@example.com user2@example.com`.

---

## ★5. Which subcommands need a TTY vs are scriptable? Any JSON output?

**No machine-readable output exists anywhere in the CLI.** `[CONFIRMED — verified by reading every listed script's output logic]` `listmailuser` produces a hand-formatted bullet list (`* email ( 12M / 50M ) [24%]` plus an indented `[ aliases -> ... ]` line); `fail2ban status`/`log` echo raw `fail2ban-client`/log text. There is no `--json`, `--format`, or `-q` flag on any subcommand. A web admin panel must either parse this plaintext or — much more robust — **read the underlying `.cf` files directly** for listing/display, and only shell out to `setup`/the `target/bin/*` binaries for mutations.

| Subcommand                                                                                                                                                                       | Needs interactive input if arg omitted?                 | Fully scriptable with all args supplied?                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `email add` / `email update`                                                                                                                                                     | Yes — password prompt (stdin, `read -s`)                | Yes, pass password as argv or pipe to stdin              |
| `email del`                                                                                                                                                                      | Yes — mail-data keep/delete `[y/N]` prompt              | Yes, with `-y`/`-n`                                      |
| `email restrict add/del`                                                                                                                                                         | Yes — prompts for username if the 3rd arg is missing    | Yes, if email is supplied                                |
| `dovecot-master add/update`                                                                                                                                                      | Yes — same password prompt                              | Yes                                                      |
| `relay add-auth`                                                                                                                                                                 | Yes — same password prompt                              | Yes                                                      |
| `debug login` (no command arg)                                                                                                                                                   | **Requires a real TTY** — execs interactive `/bin/bash` | N/A — this mode is inherently interactive                |
| `debug login "<cmd>"`                                                                                                                                                            | No                                                      | Yes — runs `/bin/bash -c "<cmd>"`                        |
| `email list`, `alias list`, `alias add/del`, `quota set/del`, `config dkim`, `relay add-domain/exclude-domain`, `fail2ban` (all forms), `debug fetchmail/getmail/show-mail-logs` | No                                                      | Yes, fully scriptable, no prompts when args are complete |

`[CONFIRMED: individual scripts under https://github.com/docker-mailserver/docker-mailserver/tree/master/target/bin]`

---

## 6. Config file formats

All four files below live under the bind-mounted config directory: container path `/tmp/docker-mailserver/`, which the official `compose.yaml` maps to host `./docker-data/dms/config/`. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/compose.yaml]`

| File                  | Container path                               | Format                                                                                                           | Real example line                                                                                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postfix-accounts.cf` | `/tmp/docker-mailserver/postfix-accounts.cf` | `<email>\|<hash>\|<user_attributes>` (pipe-delimited, 3rd field usually empty)                                   | `user1@domainone.tld\|{SHA512-CRYPT}$6$UMGnThsSm0IFgzEw$BynVshxudpGQHDRQaF4b7wb57A7NazGZcBUakYYLflp7J4E3UHK2qo/C1qXMCkRlYFlTd.SuwCsCKb7zBaUkb/` | Comments (`#`) and blank lines ignored. This is the single source of truth — `/etc/postfix/vmailbox` and Dovecot's `userdb` file are auto-regenerated _from_ it on every change-detection cycle; never hand-edit those derived files.                                                                                                                                                                                                                               |
| `postfix-virtual.cf`  | `/tmp/docker-mailserver/postfix-virtual.cf`  | `<alias-or-@domain> <recipient1>[,<recipient2>,...]` (space-delimited; recipients comma-joined for multi-target) | `alias2@localhost.localdomain external1@otherdomain.tld`                                                                                        | This is DMS's alias/forward table (Postfix "virtual alias map"). Supports `@domain` catch-alls. Recursive: an alias can point at another alias.                                                                                                                                                                                                                                                                                                                     |
| `postfix-aliases.cf`  | **Does not exist**                           | —                                                                                                                | —                                                                                                                                               | I searched the full repo tree; no file by this name ships for the `FILE` provisioner. The only "aliases.cf"-named files in the repo are `target/postfix/ldap-aliases.cf` (an LDAP _query-filter template_, not an editable data table) and the internal helper script `helpers/aliases.sh`. **If your spec assumed this file exists, that assumption is wrong — the real alias data lives in `postfix-virtual.cf`.** `[CONFIRMED absent via full repo tree search]` |
| `dovecot-quotas.cf`   | `/tmp/docker-mailserver/dovecot-quotas.cf`   | `<email>:<quota>` (colon-delimited)                                                                              | `user@domain:50M` (from the shipped example file)                                                                                               | Only consulted when `ACCOUNT_PROVISIONER=FILE`. At change-detection, each matching line is translated into a Dovecot `userdb_quota_rule=*:bytes=N` user attribute.                                                                                                                                                                                                                                                                                                  |

Password hash format in `postfix-accounts.cf`: **`SHA512-CRYPT`** (glibc `crypt(3)` `$6$` format), generated by `doveadm pw -s SHA512-CRYPT -u "<email>" -p "<password>"`. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/scripts/helpers/database/manage/postfix-accounts.sh line 26]`

Sources: `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/test/config/relay-hosts/postfix-accounts.cf]` `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/test/config/postfix-virtual.cf]` `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/config-examples/dovecot-quotas.cf]`

---

## 7. DKIM

`setup config dkim [keysize <1024|2048|4096>] [selector <name>] [domain '<comma,separated,list>'] [help]`

| Arg        | Default                                                                                  | Notes                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `keysize`  | **2048**                                                                                 | Only 1024 / 2048 / 4096 accepted                                                                    |
| `selector` | **`mail`**                                                                               | Becomes the DNS record name `<selector>._domainkey.<domain>`                                        |
| `domain`   | DMS's FQDN; under `ACCOUNT_PROVISIONER=FILE` also auto-sourced from mail account domains | Comma-separated list; required override under LDAP since domains can't be inferred from local files |

Key generation: `opendkim-genkey --bits=<keysize> --subdomains --domain=<domain> --selector=<selector> --directory=<dir>`.

**File locations (container):** `/tmp/docker-mailserver/opendkim/keys/<domain>/<selector>.private` (PEM private key) and `<selector>.txt` (the DNS TXT record, RFC 1035 zone-file formatted, ready to paste). Also writes/updates `/tmp/docker-mailserver/opendkim/{KeyTable,SigningTable,TrustedHosts}`. Since this directory is under the bind-mounted config path, on the host it lands at `docker-data/dms/config/opendkim/keys/<domain>/mail.private` + `mail.txt` by default.
`[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/open-dkim]`

**Rspamd interaction:** if `ENABLE_RSPAMD=1` and OpenDKIM is not explicitly enabled, `open-dkim` silently delegates to a different script, `/usr/local/bin/rspamd-dkim`, instead. `[CONFIRMED: same file, lines 6-13]` I did not read `rspamd-dkim`'s source — **`[UNCERTAIN]`** whether key file locations differ under Rspamd-managed DKIM. Verify at runtime if the target deployment uses Rspamd instead of OpenDKIM (`ENABLE_RSPAMD=1`).

---

## 8. Feature support matrix

| Feature                            | Support                         | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disable a mailbox without deleting | **PARTIAL**                     | No single "disable account" toggle exists. Closest: `setup email restrict add send\|receive <EMAIL>` writes the address into `postfix-send-access.cf` / `postfix-receive-access.cf` with a Postfix `REJECT`, blocking it at the SMTP layer (`check_sender_access`/`check_recipient_access`). This does **not** block IMAP/POP3 login — the user can still read existing mail. For a full lockout you'd also need to rotate the password. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/restrict-access]`                                                                                                            |
| Quotas                             | **YES** (FILE provisioner only) | `ENABLE_QUOTAS=1` by default. Set via `setup quota set <EMAIL> [<QUOTA>]` (e.g. `50M`, `2G`) → written to `dovecot-quotas.cf`. **Explicitly not implemented for the LDAP provisioner** per the docs. Usage is read via `doveadm quota get -u <account>`, parsing the row where column 3 = `STORAGE` for current/limit/percent — this is exactly what `setup email list` displays inline. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/docs/content/config/account-management/overview.md; https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/listmailuser]`                              |
| Aliases vs forwarding              | **Same mechanism**              | DMS has no separate "forwarding" feature — a Postfix virtual alias (`postfix-virtual.cf`) _is_ the forwarding mechanism. A target can be a local mailbox, another alias (Postfix resolves recursively), or a fully external address (`user@gmail.com`), which is effectively "forwarding." `[CONFIRMED: overview.md, "Aliases" section]`                                                                                                                                                                                                                                                                                                                                   |
| Autoresponder / vacation           | **PARTIAL**                     | No `setup` subcommand manages this. Achieved by installing a Dovecot Pigeonhole Sieve script using the standard `vacation` extension as the user's active sieve file — either pre-seeded at account-creation time via `docker-data/dms/config/<user@domain>.dovecot.sieve`, or self-service later via ManageSieve. `[INFERRED from confirmed Sieve architecture — the fetched docs page didn't show a literal vacation example, so this needs a quick doc/runtime check before shipping UI copy that promises it]`                                                                                                                                                         |
| Sieve                              | **YES**                         | Global filters: `before.dovecot.sieve` / `after.dovecot.sieve` in the config dir, applied to all users. Per-user active script at container path `/var/mail/<domain>/<user>/home/.dovecot.sieve`; can be pre-provisioned by placing `docker-data/dms/config/<user@domain>.dovecot.sieve` **before** the account is created (copied in at creation time only — not retroactive). `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/scripts/helpers/accounts.sh lines 66-69; mail-sieve.md]`                                                                                                                                  |
| ManageSieve                        | **YES**                         | `ENABLE_MANAGESIEVE=1`, port 4190. User-managed scripts stored under `.../home/sieve/`, with the active one symlinked to `.dovecot.sieve`; activating a new script auto-backs-up the old one into that folder. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/docs/content/config/advanced/mail-sieve.md]`                                                                                                                                                                                                                                                                                                                      |
| POP3                               | **YES**, disabled by default    | `ENABLE_POP3=` (empty/0 by default) — must set `=1`. Ports 110/995. `[CONFIRMED: mailserver.env line 123]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| LDAP                               | **YES**, alternate provisioner  | `ACCOUNT_PROVISIONER=LDAP` plus a large block of `LDAP_*`/`DOVECOT_*` env vars (bind DN, search base, per-entity query filters for user/group/alias/domain, TLS). `[CONFIRMED: mailserver.env, ldap.md]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| LDAP invalidates local FILE CRUD?  | **YES**                         | `listmailuser`'s source refuses to run at all outside `FILE` mode: `if [[ ${ACCOUNT_PROVISIONER} != 'FILE' ]]; then _exit_with_error "This command is only compatible with 'ACCOUNT_PROVISIONER=FILE'"`. The other `setup email/alias/quota` commands write to `postfix-accounts.cf`/`postfix-virtual.cf`/`dovecot-quotas.cf`, files LDAP mode never reads — so they're inert/meaningless under LDAP, not merely discouraged. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/listmailuser lines 10-13]` A panel must detect `ACCOUNT_PROVISIONER` and hide/disable the local account CRUD entirely when it's `LDAP`. |
| OAuth2                             | **YES**, supplementary          | `ENABLE_OAUTH2=1` + `OAUTH2_INTROSPECTION_URL` add an OAUTHBEARER/XOAUTH2 SASL mechanism backed by token introspection, layered on top of (not replacing) the FILE or LDAP provisioner. `[INFERRED from env var names + doc page existing at docs/content/config/account-management/supplementary/oauth2.md — I did not fully read the page body, treat specifics as needing verification]`                                                                                                                                                                                                                                                                                |

---

## 9. Environment variables

Ground truth is the actual shipped template file, read directly (not summarized): `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/mailserver.env]`. The `=value` shown is the file's shipped default (blank means unset/uses the service's internal default, noted in parens).

### Accounts / provisioning

| Var                                                  | Purpose                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `OVERRIDE_HOSTNAME`                                  | Force FQDN when it can't be set via Docker `hostname:`                       |
| `ACCOUNT_PROVISIONER`                                | empty=FILE, `LDAP`, or `OIDC` (not yet implemented) — selects account source |
| `POSTMASTER_ADDRESS`                                 | Address for `postmaster@`; default `postmaster@example.com`                  |
| `PERMIT_DOCKER`                                      | `none` (default) — trusted networks allowed to relay/auth-bypass             |
| `DMS_VMAIL_UID` / `DMS_VMAIL_GID`                    | UID/GID for the vmail account owning `/var/mail` (default 5000/5000)         |
| `TZ`                                                 | Container timezone                                                           |
| `NETWORK_INTERFACE`                                  | Override when `eth0` isn't the right interface                               |
| `ENABLE_UPDATE_CHECK=1` / `UPDATE_CHECK_INTERVAL=1d` | Daily check for new DMS image, mails `POSTMASTER_ADDRESS` if available       |
| `LOG_LEVEL=info`                                     | See §11                                                                      |
| `SUPERVISOR_LOGLEVEL`                                | Supervisord's own log verbosity                                              |

### Quotas

| Var                          | Purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `ENABLE_QUOTAS=1`            | Dovecot quota plugin on/off (FILE provisioner only; see §8) |
| `POSTFIX_MAILBOX_SIZE_LIMIT` | Postfix-side per-mailbox size limit (bytes)                 |
| `POSTFIX_MESSAGE_SIZE_LIMIT` | Max accepted message size (bytes, default ~10MB)            |

### DKIM / DMARC / SPF

| Var                    | Purpose                  |
| ---------------------- | ------------------------ |
| `ENABLE_OPENDKIM=1`    | OpenDKIM signing service |
| `ENABLE_OPENDMARC=1`   | DMARC verification       |
| `ENABLE_POLICYD_SPF=1` | SPF policy daemon        |

### TLS / SSL_TYPE

| Var                                      | Purpose                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `SSL_TYPE`                               | empty / `letsencrypt` / `manual` / `self-signed` / `custom` — certificate strategy        |
| `SSL_CERT_PATH` / `SSL_KEY_PATH`         | Manual cert/key paths (`SSL_TYPE=manual` only)                                            |
| `SSL_ALT_CERT_PATH` / `SSL_ALT_KEY_PATH` | Secondary cert/key (e.g. RSA fallback alongside ECDSA)                                    |
| `TLS_LEVEL`                              | `modern` (secure ciphers only) or `intermediate` (broader compat); min TLS 1.2 either way |
| `SPOOF_PROTECTION`                       | Restrict envelope-sender to the authenticated account's own address                       |

### Rspamd

| Var                                       | Purpose                                     |
| ----------------------------------------- | ------------------------------------------- |
| `ENABLE_RSPAMD=0`                         | Master toggle                               |
| `ENABLE_RSPAMD_REDIS`                     | Use DMS's bundled Redis instance for Rspamd |
| `RSPAMD_CHECK_AUTHENTICATED=0`            | Also scan authenticated/outbound mail       |
| `RSPAMD_GREYLISTING=0`                    | Enable Rspamd's greylisting module          |
| `RSPAMD_LEARN=0`                          | Autolearn / Bayes training                  |
| `RSPAMD_HFILTER=1`                        | Hfilter group module                        |
| `RSPAMD_HFILTER_HOSTNAME_UNKNOWN_SCORE=6` | Score weight for unknown-hostname check     |
| `RSPAMD_NEURAL=0`                         | Neural-net anti-spam scoring                |

### ClamAV

| Var                         | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `ENABLE_CLAMAV=0`           | Antivirus scanner toggle                                 |
| `CLAMAV_MESSAGE_SIZE_LIMIT` | Messages over this size skip AV scanning (default ~25MB) |
| `VIRUSMAILS_DELETE_DELAY`   | Days to retain quarantined virus mail (default 7)        |

### Fail2ban

| Var                       | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `ENABLE_FAIL2BAN=0`       | Toggle; needs `cap_add: [NET_ADMIN]` in compose for nftables banning |
| `FAIL2BAN_BLOCKTYPE=drop` | `drop` (silent) or `reject` (ICMP unreachable)                       |

### Sieve

| Var                  | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `ENABLE_MANAGESIEVE` | empty=disabled, `1`=enable ManageSieve on port 4190 |

(Sieve filters themselves are file-based, not env-configured — see §8.)

### POP3 / IMAP / SMTP

| Var                                        | Purpose                                         |
| ------------------------------------------ | ----------------------------------------------- |
| `ENABLE_POP3`                              | empty=disabled (default), `1`=enable POP3       |
| `ENABLE_IMAP=1`                            | IMAP toggle (on by default)                     |
| `SMTP_ONLY`                                | empty=all daemons start, `1`=Postfix SMTP only  |
| `POSTSCREEN_ACTION=enforce`                | Postscreen response to failed pre-greet checks  |
| `POSTFIX_REJECT_UNKNOWN_CLIENT_HOSTNAME=0` | Reject clients with no reverse DNS              |
| `POSTFIX_INET_PROTOCOLS=all`               | IPv4/IPv6/all for Postfix                       |
| `DOVECOT_INET_PROTOCOLS=all`               | IPv4/IPv6/all for Dovecot                       |
| `DOVECOT_MAILBOX_FORMAT=maildir`           | `maildir`, `sdbox`, or `mdbox`                  |
| `POSTFIX_DAGENT`                           | Mail delivery agent (default: Dovecot via LMTP) |

### Logging

| Var                                               | Purpose                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `LOG_LEVEL=info`                                  | Verbosity of DMS's own startup/change-detection scripts — see §11 |
| `PFLOGSUMM_TRIGGER`                               | empty=no report, `daily_cron`, or `logrotate`                     |
| `PFLOGSUMM_RECIPIENT` / `PFLOGSUMM_SENDER`        | Report mail addressing                                            |
| `LOGWATCH_INTERVAL`                               | empty / `daily` / `weekly`                                        |
| `LOGWATCH_RECIPIENT` / `LOGWATCH_SENDER`          | Logwatch mail addressing                                          |
| `REPORT_RECIPIENT` / `REPORT_SENDER`              | Fallback addressing for the above reports                         |
| `LOGROTATE_INTERVAL=weekly` / `LOGROTATE_COUNT=4` | Log rotation cadence/retention                                    |

### Other groups present in the shipped `mailserver.env` (lower priority, listed for completeness)

- **Spam handling:** `SPAM_SUBJECT`, `ENABLE_AMAVIS=1`, `AMAVIS_LOGLEVEL=0`, `ENABLE_DNSBL=0`, `ENABLE_SPAMASSASSIN=0`, `ENABLE_SPAMASSASSIN_KAM=0`, `SPAMASSASSIN_SPAM_TO_INBOX=1`, `MOVE_SPAM_TO_JUNK=1`, `MARK_SPAM_AS_READ=0`, `SA_TAG=2.0`, `SA_TAG2=6.31`, `SA_KILL=10.0`, `ENABLE_POSTGREY=0`, `POSTGREY_DELAY=300`, `POSTGREY_MAX_AGE=35`, `POSTGREY_TEXT`, `POSTGREY_AUTO_WHITELIST_CLIENTS=5`, `ENABLE_MTA_STS=0`.
- **Mail retrieval:** `ENABLE_FETCHMAIL=0`, `FETCHMAIL_POLL=300`, `FETCHMAIL_PARALLEL=0`, `ENABLE_GETMAIL=0`, `GETMAIL_POLL=5`.
- **LDAP:** `LDAP_START_TLS`, `LDAP_SERVER_HOST`, `LDAP_SEARCH_BASE`, `LDAP_BIND_DN`, `LDAP_BIND_PW`, `LDAP_QUERY_FILTER_USER`, `LDAP_QUERY_FILTER_GROUP`, `LDAP_QUERY_FILTER_ALIAS`, `LDAP_QUERY_FILTER_DOMAIN`, `DOVECOT_TLS`, `DOVECOT_USER_FILTER`, `DOVECOT_PASS_FILTER`, `DOVECOT_AUTH_BIND`. (The rendered docs page also lists `LDAP_QUERY_FILTER_SENDERS`, `DOVECOT_BASE/DN/DNPASS/URIS/LDAP_VERSION/USER_ATTRS/PASS_ATTRS` as supported but they aren't in the shipped template — `[INFERRED, from a summarized fetch of https://docker-mailserver.github.io/docker-mailserver/latest/config/environment/, not raw-verified]`.)
- **SASL:** `ENABLE_SASLAUTHD=0`, `SASLAUTHD_MECHANISMS`, `SASLAUTHD_MECH_OPTIONS`, and a full `SASLAUTHD_LDAP_*` block (server, bind DN, password, search base, filter, TLS options, password attr, auth method, mech).
- **OAuth2:** `ENABLE_OAUTH2`, `OAUTH2_INTROSPECTION_URL`.
- **SRS (forwarding):** `ENABLE_SRS=0`, `SRS_SENDER_CLASSES=envelope_sender`, `SRS_EXCLUDE_DOMAINS`, `SRS_SECRET`.
- **Relay:** `DEFAULT_RELAY_HOST`, `RELAY_HOST`, `RELAY_PORT=25`, `RELAY_USER`, `RELAY_PASSWORD`.

---

## 10. Backup

**DMS ships no official backup tooling or `setup backup` command** — confirmed absent from the full CLI surface in ★2. The official guidance lives in the FAQ as plain `tar`/`docker run` recipes, not a product feature. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/docs/content/faq.md, "What about backups?" section]`

**What must be backed up**, from the official `compose.yaml` volumes: `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/compose.yaml]`

| Host path (bind mount)          | Container path            | Holds                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./docker-data/dms/mail-data/`  | `/var/mail/`              | The actual Maildir mailboxes — **this is the mail itself**                                                                                                                                                                         |
| `./docker-data/dms/mail-state/` | `/var/mail-state/`        | Service runtime/state: Dovecot indexes, fail2ban ban DB, and other persistent daemon state `[INFERRED from directory naming/purpose, not line-by-line confirmed]`                                                                  |
| `./docker-data/dms/mail-logs/`  | `/var/log/mail/`          | Mail logs (see §11)                                                                                                                                                                                                                |
| `./docker-data/dms/config/`     | `/tmp/docker-mailserver/` | **All hand-authored config**: `postfix-accounts.cf`, `postfix-virtual.cf`, `dovecot-quotas.cf`, `dovecot-masters.cf`, OpenDKIM keys, per-user Sieve seed files, TLS certs (if `SSL_TYPE=manual`), any `*-access.cf`/override files |
| `/etc/localtime:ro`             | `/etc/localtime:ro`       | Host timezone, read-only — irrelevant to backup                                                                                                                                                                                    |

Everything needed for a full restore is under `./docker-data/dms/` — the FAQ's own bind-mount example backs up exactly that directory: `tar --gzip -cf backup.tar.gz ./docker-data/dms`. The named-volume variant tars the four container paths directly: `/var/mail /var/mail-state /var/log/mail /tmp/docker-mailserver`. `[CONFIRMED: faq.md, same section]`

**Restore gotchas:**

- **Container should be stopped** before restoring into bind-mounted directories to avoid the running services writing/rotating files mid-restore. `[INFERRED — standard practice, not explicitly stated in the FAQ snippet fetched]`
- **UID/GID matter:** mail data is owned by the vmail UID/GID (`DMS_VMAIL_UID`/`DMS_VMAIL_GID`, default 5000:5000). A `tar` restore that doesn't preserve ownership (or restores onto a host where those IDs mean something else) will break Dovecot's ability to read the mailboxes until ownership is fixed. `[INFERRED from the env var's documented purpose]`
- `postfix-accounts.cf` is the authoritative account list; the derived files (`/etc/postfix/vmailbox`, Dovecot's `userdb`) are regenerated automatically on container start, so you do **not** need to back those up separately — restoring `docker-data/dms/config/` is sufficient to reconstruct them.

---

## 11. Health & logs

**HEALTHCHECK:** yes, defined directly in the Dockerfile:

```
HEALTHCHECK --start-period=30s CMD dms-healthcheck
```

`[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/Dockerfile line 301]` The Dockerfile itself notes HEALTHCHECK isn't part of the OCI image spec, so some runtimes (bare `docker run` without Compose, some Kubernetes setups) won't honor it automatically.

`dms-healthcheck`'s actual logic: reads `/etc/dms-settings` (fails/exits 1 if absent), builds the list of services that _should_ be running based on which `ENABLE_*` flags are on (always: `cron`, `rsyslog`, `postfix`, `changedetector`; conditionally: `dovecot`, `opendkim`, `opendmarc`, `amavis`, `clamav`, `fail2ban`, `postgrey`, `postsrsd`, `rspamd-redis`, `rspamd`, `mta-sts-daemon`, `saslauthd_*`, `fetchmail*`, `getmail*`), then checks via `supervisorctl status <services>` that **every** one reports exactly `RUNNING`. Exit 0 only if the reduced status set is `RUNNING`. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/dms-healthcheck]`

**Logs:** container path `/var/log/mail/` (bind-mounted to host `docker-data/dms/mail-logs/` per compose.yaml). Contains at least `mail.log` (main Postfix/Dovecot log, viewable via `setup debug show-mail-logs`) and `fail2ban.log` (via `setup fail2ban log`). Format is standard syslog-style plaintext (not structured/JSON) — `[INFERRED from rsyslog being one of the always-on services and the plain `cat` used to display these logs, not independently verified byte-for-byte]`.

**`LOG_LEVEL`** (default `info`) controls the verbosity of **DMS's own startup and change-detection scripts** (not Postfix/Dovecot's own log verbosity) — `[CONFIRMED: mailserver.env comment on line 24]`. Exact accepted values (e.g. `error`/`warn`/`info`/`debug`/`trace`) were referenced in helper script log calls (`_log 'trace' ...`, `_log 'debug' ...`, `_log 'warn' ...`, `_log 'info' ...`, `_log 'error' ...` all appear in the scripts read during this research) — `[INFERRED enum from usage, not from an explicit validation list]`.

---

## 12. Upgrade procedure

DMS does not ship an in-place "migrate" command. The documented approach is standard Docker image upgrade: pull a new tag and recreate the container; since all state lives on the bind mounts (`docker-data/dms/*`), config and mail survive the swap untouched.

The docs' own maintenance page focuses entirely on **automating** this via a third-party tool, [Watchtower](https://github.com/nicholas-fedor/watchtower) (a community fork; the original `containrrr/watchtower` is archived/unmaintained as of Dec 2025 per the same page), which polls for new image digests on the tag you're using and recreates the container. Manual alternative: `docker compose pull && docker compose up -d` (standard Compose upgrade), with `docker image prune` / `docker system prune --all` for cleanup afterward. `[CONFIRMED: https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/docs/content/config/advanced/maintenance/update-and-cleanup.md]`

The page explicitly notes semver tag semantics: pinning `:16` tracks latest minor+patch within major 16 (auto-upgrades minor versions), while `:16.0` only receives patch releases — relevant if the admin panel ever surfaces "current version" / "update available" UI.

**`[UNCERTAIN]`** — I did not locate a dedicated "breaking changes" or "migration steps between versions" document in this research pass; before shipping an "upgrade" button, check the project's GitHub Releases / changelog for the specific version jump involved, since config format changes (e.g. quota file formats, env var renames) have happened historically across major versions.

---

## 13. What DMS does NOT support

**No HTTP API. No web UI. No bundled webmail.** DMS is a CLI-and-config-files mail server image only. This was verified by (a) the complete CLI enumeration in ★2 containing no web/API server process, (b) no `ENABLE_*` env var in mailserver.env for any web service, and (c) the FAQ containing zero mentions of "API," "web UI," "webmail," or companion projects like Roundcube/SOGo/Postfixadmin when grepped. `[CONFIRMED: absence verified across https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/target/bin/setup, mailserver.env, and docs/content/faq.md]` — this is precisely the gap the requesting project's web admin panel is meant to fill.

Top things mail admins typically want that DMS does not provide out of the box:

1. **Any admin GUI/API** — every operation is `docker exec` + a CLI script, or hand-editing `.cf` files. No REST/RPC surface to build against; a panel must wrap the CLI and/or edit the flat files directly.
2. **Webmail** — no IMAP web client (Roundcube/SOGo/Rainloop-style) is bundled; DMS is IMAP/POP3/SMTP only, bring-your-own client.
3. **Domain-as-an-object management** — per ★1, no domain CRUD, quota-per-domain, or per-domain settings; everything is per-account or global via env vars.
4. **A real "disable/suspend" toggle** — per §8, only a partial send/receive block exists; no single switch that fully locks an account out while preserving login-blocked state cleanly.
5. **Machine-readable CLI output** — per ★5, zero JSON/structured output anywhere, complicating any tool (this one included) that wants to safely parse `setup` results instead of re-reading the config files.

Other notable gaps encountered during this research: quotas have no LDAP implementation (§8); DKIM key location may shift under Rspamd vs OpenDKIM (§7, flagged `[UNCERTAIN]`); no built-in backup/restore command (§10); no built-in upgrade/migration tooling beyond "pull a new image" (§12).

---

## Summary of items needing runtime verification before the admin panel relies on them

- `[UNCERTAIN]` DKIM key file path when `ENABLE_RSPAMD=1` (delegates to `rspamd-dkim`, source not read in this pass).
- `[INFERRED]` Autoresponder/vacation support via hand-authored Sieve — confirm the docs actually show a vacation example, or test it directly.
- `[INFERRED]` Exact contents of `/var/mail-state` — reasoned from directory naming/purpose, not enumerated file-by-file.
- `[INFERRED]` Full LDAP/OAuth2 env var list — the docs-page-derived portion was AI-summarized, not raw-read line by line; the mailserver.env-derived portion is raw-confirmed.
- `[UNCERTAIN]` No dedicated version-upgrade/breaking-changes doc was located; check GitHub Releases for the specific version jump before automating upgrades.
