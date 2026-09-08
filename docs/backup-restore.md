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

## Scheduling

A backup can run itself on a fixed cadence instead of relying on you to
remember. Configure it on the Backups page's Schedule card:

| Setting                           | Values                                                          |
| --------------------------------- | --------------------------------------------------------------- |
| Frequency                         | Off · Every day · Every 3 days · Every 7 days · Every month     |
| Mode                              | Warm (default) or cold — the same choice a manual backup offers |
| Keep the newest N                 | 1–365, default 3                                                |
| Also delete older than (optional) | 1–3650 days                                                     |
| Upload to remote automatically    | On/off                                                          |

The schedule is a database row, not a client-side timer: a server-side
scheduler re-arms itself from that row on every startup, so a redeploy or
a restart never silently stops it. There is no free-form cron string —
five fixed choices, so there is nothing to get subtly wrong.

## Remote destinations (S3 and FTP/FTPS)

A verified backup can optionally be pushed off the VPS entirely, to Amazon
S3 (or an S3-compatible endpoint) or to an FTP/FTPS server. This is
configured entirely through the Settings UI on the Backups page — **there
is no `.env` variable for it**. The connection settings live in their own
database row, masked on every read (only a `configured: true/false` and,
for S3, the non-secret access key id are ever shown) and revealed only
through an explicit, audited action.

**S3** — Endpoint, Region, Bucket, Prefix (optional), Access key ID, Secret
access key. Signed with a hand-rolled SigV4 implementation (no AWS SDK
dependency); large archives use multipart upload.

**FTP/FTPS** — Host, Port, Username, Path (optional), Password, and an
FTPS (explicit TLS) toggle. Plaintext FTP sends the password and the
archive itself unencrypted; the UI warns visibly when FTPS is off rather
than silently accepting it. Built on `basic-ftp`. An interrupted upload
resumes by appending only the bytes not yet sent, when a smaller partial
already exists on the remote; otherwise it re-sends cleanly from the
start.

Once a destination is configured, **Test connection** performs a real
login (FTP) or signed request (S3) before anything is uploaded, each
backup row gains **Upload to remote** / **Retry upload**, and **Browse
remote** lists what the destination actually holds — not a cached guess.
**Import** pulls one of those back down (restore-from-remote step one):
the server re-verifies its manifest checksums before the backup rejoins
the local list, where the ordinary four-tier Restore above takes over
completely unchanged.

**Secrets discipline.** The S3 secret access key / FTP password are never
returned by any read endpoint, never appear in a server log line or a job
log, and never appear in the pre-change config snapshot written before
each update (that snapshot exists for provenance, not secret recovery —
see "What's deferred" below). This is proven end to end — a real app, a
real fake-backed upload, a forced-failure case — for both destination
types, not merely unit-tested.

## Retention and local staging

- **The VPS is staging, never long-term storage, once a remote is
  configured.** A backup's local archive is deleted the moment its remote
  copy is uploaded **and independently re-verified** — downloaded back and
  checksum-checked against its own manifest, never trusted on the upload's
  word alone.
- **"Keep the newest N" and the age cap prune the remote only.** A backup
  that failed to upload, or was created before any remote was configured,
  is never auto-deleted by count or age — it stays until you delete it
  yourself.
- **A failed upload is kept, not discarded**, and is retryable from the
  same row's action menu.
- **Reconcile runs automatically**, not on a button: immediately after you
  save a destination (if auto-upload is on), and on a periodic background
  sweep after that. A backup created while the remote was unreachable is
  picked up the next time either fires.

## What's deferred

Stated here rather than left to be discovered:

- **The destination config has no rollback.** Every save snapshots the
  _previous_ configuration first, but nothing currently reads that
  snapshot back — there is no "restore this destination config" control,
  unlike the general configuration editor's own snapshot/rollback. The
  snapshot's secret field is deliberately blanked before it is written, in
  part because nothing reads it back to re-authenticate with; a future
  rollback would restore the non-secret fields and ask you to re-enter the
  secret rather than recovering it from history.
- **Verifying an uploaded copy re-downloads the whole archive.** It is
  correct — a genuine re-fetch and re-hash, not a trust-the-upload
  shortcut — but it pays full download cost (and, for S3, a real request)
  every time. A stored-checksum optimization that avoided re-fetching the
  entire object was not built.
- **No manual "sync now" button.** The reconcile-everything-pending route
  exists and reconcile does run automatically (see above); there is
  currently no UI control to trigger it on demand.

## What is never touched

`installer/uninstall.sh` never removes a `docker-mailserver` volume or
any mail data, under any flag it offers. `--purge` removes _this
project's_ own volumes — admin accounts, sessions, the audit log — and
the generated `.env`. Removing mail data is not this script's to do, and
`docker rm` is called without `-v` for the same reason.

That refusal is unconditional, not a setting.
