# Operating the panel

A tour of what each area does, what it deliberately does not, and where
the limits come from. [`FEATURE_MATRIX.md`](../FEATURE_MATRIX.md) is the
authoritative, feature-by-feature version with a status for every row;
this page is the operator's walkthrough.

> **On what "works" means here.** Every feature below is implemented and
> tested, and the panel boots and runs. None of it has yet been exercised
> against a live `docker-mailserver` — the test suites run against
> captured fixtures and fake drivers. See
> [`troubleshooting.md`](troubleshooting.md) for how to read `Unknown`,
> which is what you will see wherever a parser meets output it did not
> expect.

## Two rules that explain most of the design

**Reads parse state; writes use the CLI.** `docker-mailserver`'s `setup`
command has no machine-readable output mode anywhere — `setup email list`
emits a hand-formatted bullet list. Parsing that for data would break
silently on any upstream formatting change. So reads go to the config
files and real APIs, which have stable documented formats, and writes go
through `setup` itself, which owns hashing, file locking and side effects
that must not be reimplemented.

**Every mutation crosses the broker boundary.** The web tier holds no
Docker socket. See [`security-model.md`](security-model.md).

## Dashboard

Composes ten subsystems, each collected independently. One dead subsystem
degrades its own tile to `Unknown` rather than blanking the page — that
is a tested property, not an aspiration.

Three tiles you might expect are absent, on purpose. There is no "mail
flow (24h)" counter, because no real one exists: `postqueue -j` is a
snapshot and Rspamd's scanned counter is lifetime-cumulative. There is no
per-domain DKIM/SPF/DMARC rollup, because it would mean N live DNS
lookups on every dashboard load. And "Docker storage" appears instead of
"disk used/total", because nothing in this codebase has any
host-filesystem capability — only Docker's own accounting.

The service-health list contains no Postfix or Dovecot rows either.
Neither exposes an independent liveness signal in this stack, and a row
that always says "healthy" because nothing checks it is worse than no
row.

## Mail

- **Domains** — derived from address parts, not a first-class concept in
  `docker-mailserver`. There is no create, delete or enable, because
  there is no such upstream command. The page offers "Add mailbox".
- **Mailboxes** — create, delete, change password, set quota, and
  restrict sending or receiving. There is no "disable": what exists
  upstream is send/receive restriction, and it is labelled as that.
  Deleting an account always carries an explicit choice about whether its
  mail data dies with it — a required field, never defaulted. Bulk delete
  is refused; bulk restrict and bulk quota are not.
- **Aliases and forwarding** — one mechanism, one page, with a type
  column. They are the same thing upstream, so they are not two pages
  here.
- **Queue** — read-only. `postqueue -f` and `postsuper`
  (requeue/hold/release/delete) are real Postfix operations this project
  has not wired up; that is named as a gap rather than half-built.
- **Storage** — per-mailbox usage. Reports `Unknown` rather than a
  guessed number when the underlying output does not match the expected
  shape.

## Security

- **TLS** — status only. Certificate issuance is not this project's job;
  `docker-mailserver` consumes certificates from an external ACME client.
  No private key is ever read into the API layer.
- **Email auth (DNS)** — MX, SPF, DKIM, DMARC lookups with five states:
  `Detected`, `Valid`, `Invalid`, `Missing`, `Unknown`. `Unknown` renders
  grey, never yellow: a resolver failure must not look like a
  misconfigured record.
- **DKIM** — display and generation.
- **Rspamd** — live status, statistics, action thresholds and per-symbol
  scores (each individually editable), plus learn-spam and learn-ham
  behind a confirmation. General config editing is refused: Rspamd's
  config embeds Lua and its maps fetch URLs, which is code execution plus
  SSRF.
- **ClamAV** — status and version. Virus counts are log-derived and
  labelled as such, because clamd exposes no counter.
- **Fail2ban** — jail status and unban.
- **Sieve** — script management, with scripts referencing
  `vnd.dovecot.execute` or `sieve_pipe` rejected outright, since both
  invoke external programs.
- **Autoresponder** — real start and end dates, generated server-side as
  RFC 5260 `currentdate` wrapping RFC 5230 `vacation` from structured
  input, never from a script you paste.

## Docker

Containers, images, volumes, networks, logs, monitoring and health.

The limits here are the architecture showing through. Containers can be
started, stopped and restarted, but not created or removed — the broker
has no such operation, deliberately. Images can be listed and dangling
ones pruned, but not pulled, because a pull has no destination without a
recreate. Networks are read-only. Volumes can be removed _except_ any
volume backing a mail data mount, which is refused broker-side and
re-derived from the live container on every call.

The **console** is off by default. Enabled, it runs one of a fixed set of
zero-argument diagnostic commands whose argv the broker owns. It is not a
shell and cannot be made into one.

## Maintenance

- **Jobs** — one at a time, serially. Status, progress and per-job logs
  stream to the browser over Server-Sent Events.
- **Backups** — see [`backup-restore.md`](backup-restore.md).
- **Configuration editor** — a server-side allowlist of _this panel's_
  settings, with a fixed validate → diff → impact → confirm → apply →
  verify → audit flow and secret masking in which revealing a secret is
  itself an audited event. Scoped deliberately to the panel's own
  settings, not the mail container's environment variables: Docker cannot
  change a running container's environment at all, so every such setting
  would be permanently "needs recreate" — a control the backend cannot
  perform.
- **Updates** — checking is real: the running image's digest, the newest
  matching tag's digest from the registry, and a verdict comparing them.
  A registry that cannot be reached yields `Unknown`, never "up to date".
  **Applying is refused and says so**, naming the missing Docker
  operation and what to run on the host instead, and auditing the refusal
  every time. It is a real route that answers honestly, never a hidden
  control and never a silent 404.

## Auditing

Every mutation is audited, and the audit payload is structurally
incapable of holding a secret. Read and dismiss actions on notifications
are not audited — a personal view-state change is not a system mutation.
That is a judgement call, recorded as one.
