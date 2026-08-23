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

- Dashboard, command palette, global search and notifications (M11): the
  last unbuilt feature milestone, and the point `/` became a real landing
  route rather than a redirect.
  - **The dashboard degrades per tile, not per page.** `GET
    /api/v1/dashboard` composes ten already-shipped subsystems — broker
    health, TLS, Rspamd/ClamAV/Fail2ban reachability, mail counts, the
    mail queue, backups, updates and the audit log — each collected in
    its own `try`/`catch`, so one dead subsystem degrades its own tile to
    `Unknown` instead of blanking the page or returning a 500. That is
    the milestone's exit criterion, proven at both levels: forcing the
    broker, a `DmsDriver` method and a reachable-but-down ClamAV to fail
    independently in `dashboard.routes.test.ts`, and the rendered
    degraded state in `dashboard-page.test.tsx`.
  - **Three tiles were cut rather than faked**, each with the reasoning
    recorded where the decision lives. No "mail flow (24h)" tile: no real
    counter exists, since `postqueue -j` is a snapshot and Rspamd's
    scanned counter is lifetime-cumulative. No per-domain
    DKIM/SPF/DMARC rollup: the email-auth page had already declined N
    live DNS lookups on every load for the same domain list. "Docker
    storage" rather than "disk used/total", because no host-filesystem
    capability exists anywhere in this codebase — only Docker's own
    `GET /system/df`. The service-health list carries no fabricated
    Postfix or Dovecot rows either; neither exposes an independent
    liveness signal in this stack.
  - **Notifications are derived from the dashboard's own snapshot**, not
    from a second, independently-drifting reading of "is TLS okay". The
    evaluator upserts a notification for every current verdict problem
    and resolves every condition that stopped appearing. "Dismiss" is a
    read marker, never a resolve — an admin acknowledging a warning
    cannot make a certificate stop expiring.
  - **One command palette serves both `⌘K` and `/` global search.** Its
    static entries are exhaustive over the app's route table and nothing
    more: no domain-create, mailbox-disable, container-recreate or
    update-apply entry exists, because none of those controls exist
    anywhere else in the app either. A later test makes that
    exhaustiveness mechanical rather than a comment (M12).
  - **A follow-up pass closed the four gaps this milestone surfaced.**
    Rspamd shipped a complete backend in M8 that no UI ever reached — a
    working feature nobody could use, which is the same failure as a fake
    control, inverted — and now has a page scoped to exactly the write
    allowlist `SECURITY.md` §3.13 permits. The mail queue became a real
    read-only page, with `postqueue -f`/`postsuper` named as a reachable
    gap rather than half-built. Alias quick-open landed. And
    `/docker/events` was **removed from the documents rather than built
    around**: `UX_ARCHITECTURE.md` §5.2 named the page and
    `FEATURE_MATRIX.md` §1 cited it as a dashboard source, but no
    `system.events` operation ever existed in the broker's vocabulary.
    Adding an outbound Docker Engine call to this project's smallest,
    highest-scrutiny component deserves its own pass; the recent-activity
    row stays audit-log only, honestly, until then.

- Testing and hardening (M12): the full Playwright suite, `SECURITY.md`
  Part 5's ten checks made enumerable, and the first time this project
  ever ran a real browser against its own output.
  - **Every exhaustive suite is exhaustive by construction, not by
    diligence.** The command-injection suite maintains a manifest of
    every command builder and diffs it against the module's real exports,
    so a builder added later with no coverage fails the suite instead of
    shipping silently — which immediately surfaced two genuinely
    uncovered builders. The authorization suite asks the running app for
    its own route table (parsed from Fastify's `printRoutes`, since there
    is no structured route-listing API) and fires every mutating route
    with no session and with no CSRF header. The palette's
    route-exhaustiveness claim, which had already drifted false once,
    now reads `App.tsx`'s source and diffs both directions.
  - **Each new gate was verified to fail before it was trusted to pass.**
    The authorization suite was checked by stripping both auth hooks from
    one route and confirming it caught them; the log-redaction suite by
    interpolating a real password into a log message — the one shape
    object-path redaction cannot reach — and confirming the leak was
    quoted back; the palette test by deleting an entry by hand.
  - **The built SPA had been shipping zero CSS.** `main.tsx` never
    imported the stylesheet, and nothing else in the module graph reached
    it, so every build — development and production alike — rendered
    unstyled HTML. Nothing existing could have caught it: the contrast
    tests parse the token file as text, and every component and E2E test
    asserts structure and content, never applied styling. It was found by
    the first thing in this project that actually renders a page and
    looks at what loaded. One import; `vite build` now emits a real CSS
    asset and the two self-hosted fonts.
  - **Real-browser CSP verification found two live violations.** Zod v4
    probes `new Function('')` once to select a faster validation path,
    which trips `script-src` the moment any shared schema is constructed
    — fixed with a jitless configuration in a dedicated, first-imported
    module, since import order is load-bearing here. And `sonner` injects
    its base stylesheet through a runtime `<style>` element with no nonce
    hook in either its current or previous major version; `style-src-elem`
    gains `'unsafe-inline'` as the single documented exception in this
    policy, while `style-src` itself stays at `'self'` precisely so the
    exception cannot silently widen. Loosening `script-src` to accommodate
    a toast library would have been the wrong trade in the other
    direction.
  - **A real axe-core sweep found three real accessibility violations**
    that jsdom and static token math could not: the active nav link's
    text-on-background pairing sat at 4.41:1, just under the AA floor,
    on a pairing the contrast matrix had never covered despite the app
    shipping it; a stat tile carried `aria-label` on a bare `div`, which
    has no role that accepts a name; and a dialog's confirm button was
    genuinely unreachable in a small viewport.
  - **The audit also found dead scaffolding and a real advisory.** The
    web tier declared a Docker socket-path config field that no code in
    it ever read — removed, with a new suite pinning its absence three
    independent ways, and an ESLint rule now bans importing a Docker
    client from anywhere under `apps/server`. `@fastify/static` carried
    four path-traversal and auth-bypass advisories, one high, at a
    version that was declared but not yet wired up. And `npm audit` was
    red entirely from devDependencies that never survive the multi-stage
    build, so the real gate became a production-only audit wired into
    `npm run check`, with an informational full-tree check alongside it.

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
  - **M12's security E2E project now runs against the real same-origin
    server**, retiring `e2e/security/static-proxy-server.mjs` (139 lines of
    test-only static file server + `/api` proxy) in favour of a plain
    `apps/server` with `STATIC_DIR` set — the topology the image ships.
    That harness had to re-implement this project's security-header set in
    order to attach a real CSP to a document it served itself, which meant
    the CSP spec's "carries exactly this project's documented policy"
    assertion was comparing `buildCspHeaderValue()` against a header set
    from `buildCspHeaderValue()`, and could not have failed. Against the
    real server it did fail, on Helmet's `;`-without-a-space
    serialisation; the spec now normalises separator whitespace and
    compares the policy, matching the call
    `security-headers.security.test.ts` had already made and documented.
  - **Verified against a real Docker daemon in CI, not on the machine that
    wrote it** (`.github/workflows/installer.yml`): three install →
    healthy → uninstall cycles, the privilege boundary asserted against
    live containers, the same-origin SPA topology asserted against the
    shipped image (including that an unmatched `/api/*` path still returns
    the JSON envelope and not the app shell), and idempotency asserted
    including the hand-edited-`.env` case. `docs/docker.md` §6 states
    plainly what remains unverified and why.

- Documentation (M14): an operator-facing `docs/` set — an index, the
  security model, configuration, operations, backups and restore, and
  troubleshooting — alongside the deployment guide M13 already added.
  Deliberately separated from the contributor documents at the repository
  root, which serve a different reader; `docs/README.md` says which is
  which.
  - **`docs/security-model.md` states the deal plainly.** Anyone running
    this is giving a container access to their Docker socket, which is
    root on the host. It says what the privilege boundary buys (full RCE
    in the web tier yields the broker's allowlist and nothing more, and
    *why* — there is no protocol field that can express anything else),
    what it explicitly does not buy (an admin account here is roughly
    shell access on the mail container; a broker compromise is a host
    compromise; backups are unencrypted mail), and which properties are
    enforced by a failing build or a CI assertion rather than by
    intention.
  - **Writing it surfaced a blocking product defect.** `apps/server`
    reaches docker-mailserver through a `DmsExecPort` that has no
    concrete implementation — it needs `exec.run` and `file.read`, two
    broker operations deferred when the vocabulary was defined and never
    added. In `APP_MODE=production` the driver factory refuses to
    construct rather than silently serve fake data, so the process exits
    at startup. That is the compose file's and the installer's own mode,
    so no production install can currently come up. Reproduced directly
    by booting the built server. Documented in
    `docs/troubleshooting.md`, in the README's status banner, in
    `docs/docker.md` §6, and as a scope note on `FEATURE_MATRIX.md`'s
    status legend — every mail-dependent row is proven against fixtures
    and fakes only.
  - **Three documents named broker operations that do not exist.**
    `logs.tail` and `mail.account.create` were cited in `README.md`,
    `ARCHITECTURE.md` and `docs/AGENT_BRIEF.md` as the canonical examples
    of the web tier's vocabulary, and the architecture diagram showed
    `POST /ops/mail.account.create`. The real vocabulary is 18 operations
    and the real route is `POST /v1/ops`. Corrected against
    `packages/shared/src/broker.ts` rather than against memory.
  - **The `[Unreleased]` section stopped at M10.** M11, M12 and M13 are
    now written, in the same voice as the entries around them.
  - The README's status banner now separates what is proven from what is
    not, and no longer claims an installation path that works.


- docker-mailserver behind the broker (M16): the milestone that made the
  panel able to start. `apps/server` reached DMS through a `DmsExecPort`
  that had **no implementation** — implementing it meant giving the broker
  `exec.run(argv)` and `file.read(path)` — so `createDmsDriver` refused to
  construct and the process exited at startup. `APP_MODE=production` is
  what the compose file sets and the installer writes, so every production
  install crash-looped the web tier while the broker sat healthy beside it.
  - **The vocabulary moved instead of the argv.** An allowlist that
    validates a caller-supplied argv is still a passthrough, and full RCE
    in the web tier would have become arbitrary command execution inside
    the mail container. So each DMS operation became a named intent with
    typed leaf parameters — 29 of them, taking the broker's vocabulary
    from 18 to 47 — and the broker constructs the command line from its
    own builders. `commands.ts` physically moved from `apps/server` to
    `apps/broker`: the web tier has no copy to reach for.
  - **File reads take a symbolic key, never a path**, and the broker owns
    the five-key mapping. **Environment reads return six allowlisted
    variables**, not the container's environment — the port this replaced
    returned all of it, which would have handed a compromised web tier
    every credential in the mail container for the sake of four capability
    flags. Passwords and Sieve bodies still travel on stdin, never argv.
  - **The cost, stated plainly:** the broker now owns the DMS command
    vocabulary, which is real business logic in the component whose whole
    virtue is having none. That was a deliberate trade — a structural
    guarantee in place of a validation routine — and it is why the two
    tables that encode it (`DMS_COMMAND_BUILDERS`, `DMS_CONFIG_FILE_PATHS`)
    are `satisfies`-checked, so an operation cannot exist without a
    builder or a key without a path.
  - **Proven, not asserted.** `production-boot.test.ts` builds the real
    application in production configuration with no driver override — the
    override would skip the line that used to throw — and reaches a
    healthy `/api/v1/health`. The built server, run directly, now logs
    "DMS driver: RealDmsDriver (over the broker)" and answers healthy
    where it previously exited 1. M12's command-injection manifest
    followed the builders to the broker and still fails the suite when a
    builder appears without coverage; new `handlers.security.test.ts`
    asserts the file-key mapping, the environment filtering, stdin for
    passwords, and that no code path names a DKIM `.private` key.
  - **A second boot-blocking bug, found while proving the first:**
    `install.sh` defaulted `BOOTSTRAP_ADMIN_EMAIL` to `admin@localhost`,
    which the config schema's strict email rule rejects for having no TLD.
    A default install would have failed configuration validation before it
    ever reached the DMS driver. Now `admin@example.com`.
  - The `name` field on three Sieve operations became `script`, because
    `broker.test.ts`'s container-reference guard rejects a `name` field on
    every operation but one documented exemption — and a vocabulary where
    "name" sometimes means a container is the ambiguity that guard exists
    to prevent. The guard stayed blunt; the field got renamed.


- Final audit (M15): `AUDIT.md` — functional, security, UX, licensing and
  production, with a file, a test name or a command and its output behind
  every row, and §1 stating up front what a reader may **not** conclude:
  nothing has touched a live docker-mailserver, no image has been built,
  no container has run, and no CI run has been observed.
  - **The checklist the milestone names does not exist here.** The exit
    criterion cites "the brief's §80 checklist"; the brief is not in the
    repository. The audit is assembled instead from the checklists that
    are — `FEATURE_MATRIX.md`, `SECURITY.md` Part 5, `UX_ARCHITECTURE.md`,
    `LICENSE_AUDIT.md` — and records the substitution rather than papering
    over it.
  - **Two more tautologies found and fixed.** `broker.test.ts`'s
    "one response schema per operation" check became partly
    self-referential in M16, when 26 of the 47 keys started being
    generated from the same list the assertion compares against — a
    regression this project's own author introduced. It now claims only
    the hand-written half and adds the case generation cannot cover: that
    the three DMS state reads do not silently reuse the exec schema. And
    `archive.test.ts` asserted `f(x) === f(x)`, true for any function
    including one returning a constant; it now recomputes the digest by
    an independent path.
  - **An unsupported documentation claim, made true rather than
    softened.** `docs/configuration.md` said `.env.example` "is checked
    against the code's own schema, so it cannot quietly drift". Nothing
    checked it. `config-env-example.test.ts` now does, in both
    directions, against the union of both tiers' schemas — and found
    real drift on its first run.
  - **Three stale file citations** in `SECURITY.md`, `UX_ARCHITECTURE.md`
    and `docs/README.md`, found by a scan of every path cited in every
    document. Two were M16 fallout; one was a long-standing typo.
  - **Licensing verified against what actually ships**, not against the
    pre-adoption inventory: 251 production packages, nine license
    expressions, every one inside the gate's allowlist, exceptions list
    empty, and both images' pruned trees re-measured after M16 moved code
    between workspaces.
  - **A claim of this project's own corrected:** the README and
    `docs/docker.md` said the installer workflow "has not yet run". No CI
    tooling is available in the development environment, so that was
    unsupportable in either direction. Both now say no run has been
    *observed*.


### Notes

- No release has been published yet and no image is published to any
  registry. The panel starts and runs; nothing has yet been exercised
  against a live `docker-mailserver`. The production audit is M15. See the
  project status banner in `README.md`.

[Unreleased]: https://github.com/ArvinRahnama/docker-webmail-gui/commits/main
