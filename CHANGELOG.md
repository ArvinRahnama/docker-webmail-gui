# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is at `0.x`, the public API, configuration format, and
database schema may change between minor versions. Breaking changes will be
called out explicitly here.

## [Unreleased]

### Added

- Repository foundation: npm workspaces monorepo (`apps/server`, `apps/broker`,
  `apps/web`, `packages/shared`), strict TypeScript configuration, ESLint rules
  that enforce specific controls from `SECURITY.md`, Prettier, and CI.
- Planning documentation: `ARCHITECTURE.md`, `SECURITY.md`, `FEATURE_MATRIX.md`,
  `UX_ARCHITECTURE.md`, `LICENSE_AUDIT.md`, `IMPLEMENTATION_PLAN.md`.
- Technical research under `docs/research/`, covering docker-mailserver
  capabilities, the Docker Engine API and socket security boundary, mail-stack
  component data sources, and dependency licensing.
- Apache-2.0 licence, `NOTICE`, and community health files.
- Docker broker and the privilege boundary (M4): a closed operation
  vocabulary (`packages/shared/src/broker.ts`) covering container
  list/inspect/start/stop/restart/stats/logs plus Docker
  system/image/volume/network reads, deliberately omitting
  `container.create`, `container.remove` and `exec.*`. `apps/broker`
  enforces shared-secret authentication (compared in constant time,
  rejected before any request parsing), resolves the managed mail
  container's identity itself from configuration (the web tier can never
  supply a container id), decodes Docker's multiplexed log stream
  (TTY and non-TTY, including frames split across chunk boundaries), and
  computes CPU%/memory% with the documented formulas including the
  cgroup v1 vs v2 branch. `apps/server/src/drivers/broker` adds the web
  tier's `BrokerClient` interface with `RealBrokerClient` (HTTP via
  `undici`) and a fixture-seeded `FakeBrokerClient`, which is the
  development-mode default so the panel remains developable with no
  Docker daemon.
- docker-mailserver integration driver (M5): parsers for
  `postfix-accounts.cf`, `postfix-virtual.cf` and `dovecot-quotas.cf`
  that tolerate comments, blanks and malformed lines without throwing
  and report what they could not parse rather than dropping it silently
  — a parser that skips a line quietly is how an administrator comes to
  believe a mailbox was deleted when it was not. Command builders return
  typed argv arrays only, never a shell string; passwords go to stdin
  because argv is visible in `ps`; and deleting a mailbox takes a
  required discriminated field for whether the mail data dies with the
  account, so `setup email del` always carries an explicit `-y`/`-n`
  (without one it prompts and hangs a non-interactive exec). Domains are
  **derived** from the address parts of accounts and aliases, with no
  create, delete or enable operation exported, because docker-mailserver
  has no domain object to call. The driver mirrors the broker's shape —
  interface, real implementation behind an exec port, fixture-seeded
  fake as the development default — and `createDmsDriver` throws loudly
  rather than silently falling back to the fake.
- Frontend foundation and design system (M6): design tokens for both
  themes, the application shell and navigation, the `DataTable` and the
  loading/empty/error state components, a typed API client built on the
  shared Zod schemas, and the authentication flow, following
  `UX_ARCHITECTURE.md`.
- Mail management (M7): domains (derived), mailboxes, aliases and
  forwarding, quotas and password management end to end — shared
  schemas, server modules and the first real UI pages. The feature
  matrix's constraints are enforced structurally rather than by
  convention: the domains routes file defines no `POST`, `DELETE`, `PUT`
  or `PATCH` at all; there is no bulk mailbox delete and a test asserts
  the route does not exist; and mailbox restriction is labelled for what
  it does (send/receive blocking) rather than as a "disable"
  docker-mailserver cannot perform. Read paths accept the TLD-less
  `user@domain` form that is legitimate inside a mail system and appears
  in `dovecot-quotas.cf`, while write paths stay strict.
- Security features (M8): DNS diagnostics for MX, SPF, DKIM, DMARC and
  PTR, with `Detected | Valid | Invalid | Missing | Unknown` states in
  which a resolver failure renders as `Unknown` and never as `Invalid`;
  DKIM key generation and record display; TLS certificate status, with
  no private key ever read into the API layer; Rspamd statistics; ClamAV
  status and detection counts; Fail2ban jail status, ban and unban;
  Sieve filters; and autoresponders with real start and end dates.
  Autoresponder Sieve is generated server-side from structured input,
  wrapping RFC 5230 `vacation` in RFC 5260 `currentdate` bounds, so the
  administrator never hand-writes Sieve. Sieve validation rejects
  `vnd.dovecot.execute` and `sieve_pipe` before a script is ever stored,
  because those invoke external programs. Spam trends come from our own
  periodic samples into `metric_samples`, not from Rspamd's `/history`
  (a 200-entry in-memory ring lost on restart), and the UI reports
  "Collecting" until real data exists rather than drawing a line it
  cannot back. ClamAV detection counts are log-derived and labelled as
  such, because clamd exposes no counter; ClamAV's `STATS` output and
  `setup fail2ban status` are both parsed defensively and shown raw when
  parsing fails.
- Docker and observability (M9): containers, images, volumes, networks,
  the log viewer, monitoring, the health centre and the restricted
  command console, plus the four broker operations they needed. Each new
  operation carries a symbolic selector and nothing more — a volume
  name, a log-source enum value, or a command key — and none accepts
  argv, a path or a container reference, so the privilege boundary is
  unchanged. `volume.remove` refuses any volume backing a protected
  mail-data mount, before touching Docker, with the protected set
  re-derived from the managed container's own mounts on every call
  rather than from a hardcoded list. `image.prune` takes no parameters
  at all, so it can only ever mean dangling images. `logs.file` reads a
  two-value enum through a broker-side path. `console.exec` runs one of
  four zero-argument diagnostic commands with broker-owned argv, and is
  disabled by default. Container recreate remains unimplemented on
  purpose: it needs `container.create`, the root-equivalent call the
  broker deliberately lacks, and appears in this codebase only in
  comments explaining why it is absent.
- Maintenance (M10): the job system, backups and restore, the
  configuration and environment editor, and the update checker.
  - **Jobs.** A closed set of job types (`backup.create`,
    `backup.verify`, `backup.restore`) and one in-process runner that
    executes a single job at a time — serial by construction rather than
    by convention, because two concurrent restores, or a backup during a
    restore, is a data-corruption scenario. Status, progress and per-job
    logs are persisted and broadcast to the browser over Server-Sent
    Events (`platform/sse.ts`, the product's first stream). Jobs left
    `queued` or `running` by a previous process are failed at startup
    with a clear reason rather than presented as resumable: only the
    database rows survive a restart, not the closures.
  - **Backups and restore.** `tar` archives of the four
    docker-mailserver volumes, moved through two new broker routes
    (`GET`/`PUT /v1/archive/:volumeKey`) that pass Docker's own archive
    bodies through byte for byte — which is what makes vmail UID/GID
    preservation automatic — and that sit deliberately outside the JSON
    operation contract, whose 64KB body limit a multi-gigabyte volume
    would never fit. `:volumeKey` is one of four symbolic keys, never a
    path. Every archive carries a `manifest.json` with per-entry and
    per-volume SHA-256 checksums, in a documented on-disk layout, so a
    backup stays restorable by hand with plain `tar` if the panel itself
    is unavailable — docker-mailserver ships no official backup tool, so
    this format is ours to keep honest. Verify recomputes checksums
    against the archive's own manifest without extracting it and reports
    every mismatch as a result rather than throwing. Restore is the
    four-tier flow — pre-flight report, type-to-confirm, and either a
    verified recent backup or an explicit acknowledgement — requires the
    container stopped, and is unavailable on mobile.
  - **Configuration and environment editor.** A server-side allowlist of
    settings with the fixed flow validate → diff → impact → confirm →
    apply → verify → audit, secret masking in which revealing a secret
    is itself an audited event, and a complete pre-change snapshot
    (`config_snapshots`, migration `004_maintenance.ts`) that is never
    exposed back over the API. Scoped deliberately to this panel's own
    settings rather than docker-mailserver container environment
    variables: Docker cannot change a running container's environment at
    all, so every such setting would be "needs recreate" and silently
    unappliable — a control the backend cannot perform.
  - **Updates.** The running image's digest from Docker inspect, the
    newest matching tag's digest resolved against any v2-compliant
    registry over the OCI Distribution API (taken from the
    `Docker-Content-Digest` header, never recomputed locally), the
    verdict comparing them, and the backup facts that would gate an
    update. A registry that cannot be reached yields `Unknown`, never
    "up to date".
  - **Applying an update is deliberately not implemented, and refuses in
    the open.** Applying means pull → stop → remove → create → start,
    and `container.create` is the root-equivalent Docker call the broker
    exists to withhold. `POST /api/v1/updates/apply` is therefore a real
    route that always refuses with `CAPABILITY_UNSUPPORTED`, names the
    missing operation, says what to run on the host instead, and audits
    the refusal every time — never a hidden control and never a silent
    404. Image pull and rollback are absent for the same reason, and
    there is no `update.apply` job type, because a step that can never
    complete should not be modelled as a job. The rollback caveat is
    still shown unconditionally next to the version comparison: anyone
    updating through their own tooling needs to know that reverting an
    image cannot undo data or configuration-file migrations the newer
    version performed, since docker-mailserver does not version its
    on-disk state.

- Packaging and installer (M13): two digest-pinned, multi-stage `node:24-alpine`
  images (`docker/server/Dockerfile`, `docker/broker/Dockerfile`), a hardened
  `docker/compose.yaml`, and `installer/install.sh` / `installer/uninstall.sh`.
  - **The compose file is where the privilege boundary stops being
    TypeScript and becomes topology.** `broker` holds `/var/run/docker.sock`,
    publishes nothing, and sits alone on an `internal: true` network with no
    route to or from the internet; `server` publishes the panel and has no
    socket on any path. Both run as a non-root fixed-uid user with a
    read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, a
    bounded `pids_limit`, resource limits and bounded log rotation. The
    broker reaches the socket through the host's own docker-group GID,
    detected by the installer, never baked into an image.
  - **Each image asserts the other tier is absent, at build time.** `npm ci`
    resolves every workspace into one hoisted tree and `npm prune
    --omit=dev` keeps all of it, so the web-tier image would otherwise ship
    `dockerode` and the broker image would ship React and `@node-rs/argon2`.
    Each Dockerfile drops the other tier's workspace before pruning and then
    fails the build if the dependency reappears — as does a step that strips
    the compiled unit tests `tsc --build` emits beside every module.
  - **The installer is idempotent in the sense that actually fails.** Every
    setting resolves as environment → existing `.env` → default, so a
    re-install preserves hand-edited settings (and keys the installer does
    not manage) rather than silently resetting them to defaults; no existing
    secret is ever regenerated. It also verifies the privilege boundary on
    the operator's own host after starting the stack, and refuses to report
    success if the socket landed on the wrong side of it.
  - **The uninstaller leaves nothing behind by accident.** The default
    removes containers and networks only; `--purge` (typed confirmation)
    also removes this project's own volumes and the generated `.env`;
    `--remove-images` removes the built images; `--remove-mail-server`
    (its own typed confirmation) stops and removes the mail container and
    **never a volume**, under any flag. Every run ends by listing what it
    left on the host, and a second run of anything is a reported no-op.
  - **Verified against a real Docker daemon in CI, not on the machine that
    wrote it** (`.github/workflows/installer.yml`): three install →
    healthy → uninstall cycles, the privilege boundary asserted against
    live containers, the same-origin SPA topology asserted against the
    shipped image (including that an unmatched `/api/*` path still returns
    the JSON envelope and not the app shell), and idempotency asserted
    including the hand-edited-`.env` case. `docs/docker.md` §6 states
    plainly what remains unverified and why.

### Notes

- No release has been published yet and no image is published to any
  registry. Installing today means building from a source checkout with
  `installer/install.sh` (`docs/docker.md`); the production audit is M15.
  See the project status banner in `README.md`.

[Unreleased]: https://github.com/ArvinRahnama/docker-webmail-gui/commits/main
