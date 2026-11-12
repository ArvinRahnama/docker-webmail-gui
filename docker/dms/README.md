# docker-mailserver spam-filter integration

The panel manages docker-mailserver; it does not deploy it. This directory
holds the small piece that has to run **inside** the mail container for the
panel's spam features to take effect:

| Behaviour                        | What happens                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Spam is never rejected**       | Rspamd's `reject` threshold is switched off (`reject = null`). Spam is delivered with `X-Spam: Yes` and filed in the mailbox's **Junk** folder instead.                                       |
| **Viruses are still rejected**   | ClamAV's verdict is a forced action, not a score, so infected mail is still refused at SMTP time. Turn the antivirus on with `ENABLE_CLAMAV=1` in docker-mailserver's environment.            |
| **"Not spam" allows the sender** | A user moving a message **out of** Junk (to any folder but Trash) adds its sender to that mailbox's allow list. Allowed senders are never filed in Junk.                                      |
| **"Spam" blocks the sender**     | A user moving a message **into** Junk takes the sender off the allow list and adds it to the block list. Blocked senders are always filed in Junk — never rejected.                           |
| **Lists are per mailbox**        | One user's report never changes another mailbox. Administrators can edit any mailbox's lists under **Security → Sender Lists**.                                                               |
| **Rejected mail is visible**     | **Security → Rejected Mail** lists everything the server refused (unknown recipients, bad sender domains, blocklisted servers, viruses), with the reason; ClamAV's page lists recent viruses. |

Works with any mail client — webmail (Roundcube, SnappyMail), Thunderbird,
phones — because it hooks the IMAP move itself, not a client plugin.

## Install

From the panel's checkout, on the Docker host:

```sh
./installer/install-dms-integration.sh                 # container named "mailserver"
./installer/install-dms-integration.sh --container mail # or name it
```

It copies `dwg/` into docker-mailserver's config directory
(`/tmp/docker-mailserver/dwg/` inside the container — the volume DMS keeps
across recreates), adds one line to `user-patches.sh` there (creating it if
needed, keeping anything already in it), and applies the integration
immediately. Re-running it updates the files. `--uninstall` removes it;
recreate the container afterwards.

Security → Sender Lists shows whether it is active. Requires
docker-mailserver 16 (Dovecot 2.4) with `ENABLE_RSPAMD=1`.

## What is installed, exactly

`dwg/install.sh` runs on every container start, as root, after DMS has
written its own configuration. It never fails the start — a problem
degrades to docker-mailserver's own spam handling, with a warning in the
container log.

- `/etc/rspamd/local.d/actions.conf`: `reject = null;`. An operator's own
  `rspamd/override.d/actions.conf` still wins (Rspamd's precedence); the
  script warns if that sets a reject threshold.
- `70-dwg-spam-to-junk.sieve` replaces DMS's own spam-to-Junk script (same
  name in Dovecot's config, `95-dwg.conf`). It includes each mailbox's
  personal script `dwg-sender-lists`, which the panel writes and never
  activates, so the user's own filters and autoresponder are untouched.
- `dwg-report-ham.sieve` / `dwg-report-spam.sieve`: IMAPSieve scripts on
  moves out of / into Junk. They call `dwg-sender-report`, which writes one
  line to the mail log; the panel reads the log every minute. Nothing in
  the mail container talks to the panel, and the panel needs no new
  privilege: it reads the log and writes Sieve scripts with the broker
  operations it already had.

## What gets listed

- Ordinary senders: the **domain** (and its subdomains).
- Shared providers (Gmail, Outlook, Yahoo, iCloud, …) and this server's own
  domains: the **full address** only — one person's report never allows or
  blocks everyone at Gmail.
- No usable From address: the **client IP**.
- Administrators can add any of the three by hand.

An allowed sender is ignored for a message that fails DMARC for a domain
publishing `p=reject` or `p=quarantine`: that is someone forging the
address. Rspamd strips any `X-Spamd-Result` header a sender supplies, so
this check cannot be faked.

Each mailbox holds up to 200 entries; when full, the oldest entry added by
a report makes room. Entries an administrator added are never removed
automatically.

## Verified

Against `ghcr.io/docker-mailserver/docker-mailserver:16` (Rspamd 4.1.5,
Dovecot 2.4.1, ClamAV 1.4.3) on 2026-11-12: spam scoring 25 delivered to
Junk instead of rejected; EICAR still rejected; allow by address, exact and
parent domain and IP; block by domain and IP; moves out of/into Junk
reported with the right sender and client IP; moves to Trash ignored; no
mailbox without a list affected.
