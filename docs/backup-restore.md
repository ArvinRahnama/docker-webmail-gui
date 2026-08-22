# Backups and restore

The highest-risk feature in this panel, and the one whose format is
documented most carefully — because `docker-mailserver` ships no official
backup tool, which makes this format ours to keep honest.

## What is backed up

Four `docker-mailserver` volumes, by symbolic key. The web tier never
sends a path; it sends one of these four keys.

| Key         | Container path           | What it holds                            |
| ----------- | ------------------------ | ---------------------------------------- |
| `mail`      | `/var/mail`              | Mail data                                |
| `mailState` | `/var/mail-state`        | Dovecot indexes, Fail2ban state          |
| `mailLog`   | `/var/log/mail`          | Mail logs                                |
| `dmsConfig` | `/tmp/docker-mailserver` | `.cf` files, DKIM keys, TLS certificates |

Archives are written to `BACKUP_DIR` (`/app/backups` in the container, a
named volume). **They are plain `tar` and are not encrypted** — they
contain your mail, so treat them accordingly.

## The archive format

One outer `tar` containing a `manifest.json` and one `<key>.tar` per
volume. The manifest carries per-entry and per-volume SHA-256 checksums
plus the mail container's image digest at backup time.

The important property: **a backup stays restorable by hand with plain
`tar` if this panel is unavailable.** Every archive embeds its own
restore instructions, which amount to:

```sh
tar -xf <archive> manifest.json
tar -xf <archive> mail.tar && tar -xf mail.tar -C <restored /var/mail>
# ... and the same for mailState, mailLog, dmsConfig
```

Every extracted entry keeps its original owner, group and mode. **Do not
`chown` afterwards** — the `vmail` account (uid/gid 5000 by default)
depends on that exact preservation for mail delivery to keep working.
This is not something the panel does specially: the broker's two archive
routes pass Docker's own archive bodies through byte for byte, which is
what makes ownership preservation automatic rather than reconstructed.

Those two routes sit deliberately outside the broker's JSON operation
contract, whose 64 KB body limit a multi-gigabyte mail volume would never
fit.

## Verify

Verification recomputes checksums against the archive's _own_ manifest
without extracting it, and reports every mismatch as a result rather than
throwing. A backup that fails verification still tells you exactly which
entries differ.

Verify your backups. An unverified backup is a hypothesis.

## Restore — and why it is deliberately awkward

Restore overwrites live mail data. It is gated by four things, and none
of them is a nag dialog you can click through by reflex:

1. **A pre-flight report** of what will be replaced.
2. **Type-to-confirm** — the phrase, not an OK button.
3. **Either a recently verified backup, or an explicit acknowledgement**
   that you are restoring one that has not been verified.
4. **The mail container must be stopped.** Not "should be" — the restore
   refuses while it is running.

Restore is also unavailable on mobile. That is intentional: it is not a
thing to do from a phone.

Jobs run strictly one at a time, serially by construction rather than by
convention, because two concurrent restores — or a backup taken during a
restore — is a data-corruption scenario rather than a slow one.

Jobs left `queued` or `running` by a process that died are failed at
startup with a clear reason rather than presented as resumable. Only the
database rows survive a restart; the work itself does not.

## What is never touched

`installer/uninstall.sh` never removes a `docker-mailserver` volume or
any mail data, under any flag it offers. `--purge` removes _this
project's_ own volumes — admin accounts, sessions, the audit log — and
the generated `.env`. Removing mail data is not this script's to do, and
`docker rm` is called without `-v` for the same reason.

That refusal is unconditional, not a setting.
