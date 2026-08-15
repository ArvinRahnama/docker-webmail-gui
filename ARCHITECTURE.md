# Architecture

**Date:** 2026-08-15 · **Status:** Authoritative for implementation.
**Companions:** [`SECURITY.md`](SECURITY.md) · [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md) · [`UX_ARCHITECTURE.md`](UX_ARCHITECTURE.md) · [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)

---

## 1. The problem this architecture solves

A web panel that manages Docker needs the Docker socket. **Read/write access to `/var/run/docker.sock` is root on the host** — a single `POST /containers/create` with `Binds: ["/:/host"]` or `Privileged: true` ends the discussion (research §B.1). An internet-reachable HTTP application is the highest-churn, highest-risk component in any system. Putting those two facts in the same process is the central design failure this architecture exists to avoid.

Two further research findings closed off the easy escapes:

- **`tecnativa/docker-socket-proxy` cannot save us.** It filters on URL path and HTTP method only — **no request-body inspection** — and one `CONTAINERS` gate governs both `GET /containers/json` and `POST /containers/create`. The configuration a panel needs (`CONTAINERS=1, POST=1`) leaves container creation open. It is genuinely safe only in read-only mode (`POST=0`). Verified by reading the shipped `haproxy.cfg`, not the README.
- **Docker has no per-container access control.** Not by name, ID or label. That boundary can only exist in our own code.

## 2. Shape: three tiers, one privilege boundary

```
                    Browser (admin)
                          │  HTTPS · session cookie · CSRF
                          ▼
┌─────────────────────────────────────────────────────┐
│  apps/server — WEB TIER                             │
│  Fastify · auth · sessions · SQLite · audit · jobs  │
│  Serves the SPA. Owns all business logic.           │
│  ❗ NO Docker socket. NO Docker verbs. ❗            │
└─────────────────────────────────────────────────────┘
                          │  named operations only, over an
                          │  internal-only network + shared secret
                          │  e.g. POST /ops/mail.account.create
                          ▼
┌─────────────────────────────────────────────────────┐
│  apps/broker — PRIVILEGED TIER                      │
│  Tiny. Rarely changes. Holds the Docker socket.     │
│  Allowlists operations AND target containers.       │
│  Never accepts a container spec from the web tier.  │
└─────────────────────────────────────────────────────┘
                          │  Docker Engine API v1.55 (unix socket)
                          ▼
              Docker daemon → docker-mailserver
```

**The invariant:** the web tier cannot *express* a dangerous Docker call. Not "is prevented from" — **cannot express**. It has no socket and speaks a vocabulary of named intents (`mail.account.create`, `container.restart`, `logs.tail`). There is no field in that protocol that can carry a bind mount, a capability, or a container specification. Full RCE in the web tier yields the broker's allowlist and nothing more.

This is privilege separation as used by OpenSSH, not microservices. It is also what the brief's own §50 sketch describes: *Frontend / Backend / Secure Docker Controller*.

### 2.1 What this does and does not buy

Stated plainly, because overclaiming here would be its own security failure:

**Contained:** host takeover via container create, arbitrary bind mounts, privileged containers, socket re-exposure, operations against containers outside the allowlist, arbitrary argv into the mail container.

**Not contained:** a compromised web tier can still do anything the allowlist permits — restart the mail container (outage), read mail logs (metadata), read config files (which include DKIM private keys). **A panel that can manage mail can compromise mail.** The goal is to bound the blast radius to the mail service and keep it off the host.

**Residual:** a bug in the broker is a host compromise. This is why the broker is deliberately tiny, has no business logic, no database, no template engine, and changes rarely.

---

## 3. Technology choices

| Layer | Choice | Why this, not the alternative |
| --- | --- | --- |
| Language | **TypeScript**, strict, everywhere | One language across three apps; Zod schemas in `shared/` are the *same artifact* for backend validation and frontend types, so a contract drift becomes a compile error |
| Runtime | **Node.js 24 LTS** | Available; native fetch/undici, stable test runner, good SQLite story |
| Backend | **Fastify** | MIT, fast, schema-first validation, mature plugin set (`@fastify/cookie`, `helmet`, `rate-limit`, `static`). Express is slower and less schema-native; Hono is excellent but its Node adapter is less battle-tested for long-lived SSE streams |
| Validation | **Zod** | One schema → runtime validation + static type + OpenAPI-ish docs. Non-negotiable given the shared-contract goal |
| State | **`node:sqlite`** (Node built-in) | Single file, synchronous API (simpler correctness in a low-concurrency admin tool), no server, and **zero native compilation**. See §3.1 — this reverses an earlier decision |
| Data access | **Hand-written SQL + typed repositories + a small migration runner** | ~11 tables. An ORM (Drizzle/Kysely) adds a dependency and a codegen step to save little. Keeps the dependency count honest per the brief's anti-bloat rule |
| Password hashing | **`@node-rs/argon2`** (Argon2id) | Prebuilt binaries — no node-gyp toolchain at install time, which matters for a self-hosted product. We implement no cryptography ourselves |
| Docker client | **`dockerode`** — in the broker only | Apache-2.0. Exec requires HTTP connection hijacking plus the 8-byte multiplexed-stream demux; that is exactly where hand-rolled bugs hide. Accepted cost: heavier transitive tree, so it is pinned and audited |
| Frontend | **React + Vite + Tailwind + shadcn/ui** | Per brief. Tailwind/shadcn major versions pinned in Phase 10 against what shadcn/ui currently supports — verified at implementation time, not assumed here |
| Data/UI libs | TanStack **Query**, **Table**, **Virtual**; `cmdk`; `sonner`; `react-hook-form` | Headless where possible so the design system owns presentation |
| Tests | **Vitest** (unit/integration), **Playwright** (E2E) | |
| Logging | **Pino** | Structured JSON, fast, with a mandatory redaction list |

### 3.1 SQLite driver: why this reversed

The plan originally specified `better-sqlite3` and explicitly rejected `node:sqlite` as a Release Candidate. Attempting the first install reversed it, and the reason matters beyond convenience.

`better-sqlite3` is a native addon. On this Node 24 host no prebuilt binary was available, so `npm install` fell back to `node-gyp` and failed for want of a C++ toolchain. The dev-environment breakage is the small part. The significant part is what it implies: **if prebuilds lag for Node 24 on one common platform, they lag on others** — most importantly **ARM64 Linux**, which is an entirely ordinary place to self-host a small mail server (a Pi, an ARM VPS). A self-hosted product whose install can fail on a compiler error has a real adoption problem, and "install build-essential first" is not an acceptable answer for an appliance-shaped tool.

Removing the native addon also removes a C++ dependency from a security-sensitive service, which is a genuine, if secondary, benefit.

`node:sqlite` is verified working on Node 24.19.0 with no flag, and its `DatabaseSync`/`prepare`/`run`/`all` surface is close enough to `better-sqlite3` that the repository layer hides the difference either way.

**The RC concern was real and is not dismissed** — it is downgraded to a managed risk (`IMPLEMENTATION_PLAN.md` §4). Stability 1.2 in an LTS runtime means the API is unlikely to move, and because all database access already goes through hand-written typed repositories (§7.3), swapping the driver later touches one module rather than the codebase.

### 3.2 Deliberate omissions

No Redis (SQLite covers sessions, jobs and rate limits at this scale). No message queue (the in-process job runner is sufficient for one-at-a-time maintenance operations). No ORM. No Kubernetes. No microservices — the broker is a privilege boundary, not a service decomposition. **No WebSocket**: every real-time need here is server→client only, so SSE covers it (§8).

---

## 4. Repository layout

```
docker-webmail-gui/
├── apps/
│   ├── web/                 React SPA (Vite)
│   ├── server/              Fastify — API, auth, business logic, serves SPA
│   │   ├── src/modules/     mail/ docker/ dns/ tls/ spam/ backup/ health/ …
│   │   ├── src/platform/    db, migrations, audit, jobs, config, logging, errors
│   │   └── src/drivers/     brokerClient, dmsDriver  (+ fakes)
│   └── broker/              Privileged Docker broker — small, audited
├── packages/
│   └── shared/              Zod schemas, DTO types, constants, error codes
├── docker/                  Dockerfiles, compose files
├── installer/               install.sh, uninstall.sh
├── docs/                    User + developer docs, research/
├── tests/                   E2E + integration fixtures
└── scripts/                 Dev/CI utilities
```

`apps/` + `packages/` (npm workspaces) rather than the brief's flat `frontend/ backend/`, because the broker makes a third deployable and `shared/` is a library rather than an app. The brief explicitly permits a better-justified structure.

---

## 5. Talking to docker-mailserver

DMS ships **no HTTP API and no machine-readable CLI output** — `setup email list` is a hand-formatted bullet list. That single fact dictates a split:

| Path | Mechanism | Why |
| --- | --- | --- |
| **Read** | Parse config files (`postfix-accounts.cf`, `postfix-virtual.cf`, `dovecot-quotas.cf`) and query real APIs (Rspamd HTTP, clamd socket, `doveadm`, `postqueue -j`, Docker API) | These have stable documented formats. Parsing decorative CLI text would break silently on any upstream cosmetic change |
| **Write** | `setup` CLI via `docker exec` with an **argv array** | `setup` owns hashing, file locking and side effects. Reimplementing those would fork the write semantics and eventually corrupt state |

**Command construction rules** (enforced by the broker, not by convention):
- Argv arrays only. Never `sh -c`. Never string interpolation.
- Subcommand and flags come from a **server-side allowlist**; only leaf values (an address, a quota) come from validated input.
- **Passwords go to stdin, never argv** — DMS accepts an argv password but warns it lands in shell history, and argv is visible in `ps`.
- **`setup email del` always gets an explicit `-y` or `-n`.** Without a flag it prompts interactively and would hang a non-interactive exec. The flag encodes the admin's explicit choice about mail data.

### 5.1 Capability detection

At startup and on a schedule, the server probes what this deployment actually supports — `ENABLE_QUOTAS`, `ENABLE_RSPAMD`, `ENABLE_CLAMAV`, `ENABLE_FAIL2BAN`, LDAP mode — and publishes a **capability document** to the frontend. The UI renders `Unsupported` states from this document rather than from hardcoded assumptions. If LDAP provides accounts, local account CRUD is disabled with an explanation, because writing `postfix-accounts.cf` would be meaningless there.

---

## 6. Broker protocol

Small, boring, and closed by construction.

- **Transport:** HTTP over a Docker network declared `internal: true` (no route to or from the internet). The broker binds only that interface.
- **Authentication:** a 32-byte shared secret generated by the installer, sent as a header, compared in constant time. Rotatable.
- **Vocabulary:** a fixed enum of operations. Requests are Zod-validated against a per-operation schema. **Unknown operation → reject.** There is no passthrough, no raw path, no `args` escape hatch.
- **Target resolution:** the broker resolves container identity **itself**, from configured name/label, at request time. The web tier never sends a container ID. An operation naming a non-allowlisted container is rejected before reaching Docker.
- **Container specs:** for `recreate`, the specification is stored broker-side. The web tier can request a recreate; it cannot describe one.
- **Streaming:** logs and stats stream back over chunked HTTP; the broker owns the TTY/non-TTY demux so the web tier never touches raw Docker framing.

Operation families: `container.{list,inspect,start,stop,restart,recreate,stats,logs}` · `exec.run` (allowlisted argv only) · `image.{list,inspect,pull,prune}` · `volume.{list,inspect,df}` · `network.{list,inspect}` · `events.subscribe` · `system.{ping,version,info,df}` · `file.{read,write}` (allowlisted DMS config paths only).

---

## 7. Application design

### 7.1 API

`/api/v1/*`, JSON, cookie-authenticated. Every request and response is Zod-validated from `packages/shared`.

Uniform error envelope — never a stack trace:

```json
{ "error": { "code": "MAILBOX_NOT_FOUND", "message": "That mailbox does not exist.",
             "errorId": "e_01J9X…", "details": null } }
```

`errorId` correlates to the server log so an admin can quote it in a bug report without us leaking internals. Technical detail is available to authenticated admins via the log, not via the response body.

### 7.2 Layering

`route (HTTP, validation, authz) → service (business logic, audit) → driver (broker / DMS / DNS / filesystem)`

Drivers are **interfaces with two implementations** — real and fake. This is what makes the product developable on a machine with no Docker (Phase 0 finding) and testable in CI, and it is why mock mode is architecture rather than a convenience.

### 7.3 Data model (SQLite)

| Table | Purpose |
| --- | --- |
| `admins` | Accounts, Argon2id hashes, disabled flag, force-password-change |
| `sessions` | Server-side sessions: token **hash**, expiry, last-seen, IP, user agent |
| `login_attempts` | Brute-force detection and lockout |
| `audit_log` | Append-only security record (§7.6) |
| `jobs`, `job_logs` | Long-running operations |
| `backups` | Backup metadata, checksum, verification result |
| `metric_samples` | Our own time series — the only source of spam trends |
| `notifications` | Deduplicated alerts |
| `settings` | Runtime configuration |
| `schema_migrations` | Applied migration versions |

Migrations are numbered, forward-only, and run at startup inside a transaction. The brief requires surviving upgrades without data loss, so the runner refuses to start on an unknown future schema version rather than guessing.

### 7.4 Sessions, not JWTs

Opaque random tokens in an `HttpOnly; Secure; SameSite=Strict` cookie; only the **hash** is stored. Chosen over JWTs because **revocation must be immediate** in an admin panel — disabling an administrator or logging out a stolen session has to take effect now, which stateless tokens cannot guarantee before expiry.

### 7.5 Jobs

Backup, restore, update, recreate and DKIM generation exceed a request's lifetime. A single in-process runner executes them **one at a time** (deliberate: two concurrent restores, or a backup during a restore, is a data-corruption scenario), persisting state so progress survives a page reload. Progress streams over SSE into the UI's job tray.

### 7.6 Audit log

Append-only. Every security-relevant action records timestamp, actor, action, target, result, IP and user agent. **Never records** passwords, private keys, session tokens or secret values — enforced by a redaction layer, not by developer discipline. Revealing a masked secret in the UI is itself an audited event.

### 7.7 Health engine

Each check is an independent unit returning `Healthy | Warning | Critical | Unknown` with its own timestamp. Checks never infer from one another — an unreachable Rspamd yields `Unknown` for Rspamd only, and the rest of the report still renders. Results are cached with per-check TTLs so the dashboard does not stampede the mail server.

### 7.8 Metrics sampling

Because Rspamd's `/history` is a 200-entry in-memory ring buffer lost on restart, **trend data does not exist upstream**. A scheduled sampler writes `/stat` counters, queue depth and resource usage into `metric_samples`, downsampling old data on a retention policy. Until enough samples exist the UI says *"Collecting"* — it never draws a line it cannot back.

---

## 8. Real-time: SSE only

Server-Sent Events for container state, log tailing, job progress, health changes and notifications. Chosen over WebSocket because **every stream here is server→client**; the restricted command console is request/response, not an interactive PTY, so bidirectional transport buys nothing. SSE also survives reverse proxies more predictably and reconnects natively.

Polling is used where it is genuinely sufficient (slow-moving lists). Live container state is driven by the Docker `/events` stream rather than by polling `/containers/json`, with per-container stats streams opened only for what the UI is actively showing.

---

## 9. Development and mock mode

`APP_MODE=development` binds the **fake** drivers by default. Connecting to a real Docker daemon requires an explicit, loud opt-in. A developer cannot accidentally restart their own containers, and the product is fully developable on the Windows workstation this project is being built on, which has no Docker at all.

Fakes are seeded from **captured fixtures with a provenance header** naming their source — real command output or documented format. Inventing fixture data would reintroduce the fake-feature problem one layer below the UI, so it is prohibited.

---

## 10. Deployment

Two containers plus two networks:

- `frontend` network: reverse proxy → **server**.
- `broker` network: `internal: true`, carries **server → broker** only. No internet route.
- **server**: non-root, `read_only`, `cap_drop: ALL`, `no-new-privileges`, tmpfs for `/tmp`, named volume for SQLite. No socket.
- **broker**: same hardening, plus the Docker socket. Minimal base image.
- `privileged: true` is never used anywhere.

Images are multi-stage, pinned by digest, with healthchecks and resource limits. Full deployment detail lives in `SECURITY.md` and `docs/docker.md`.

---

## 11. Consequences worth stating

1. **The broker is a real cost.** A third deployable, a protocol, an extra hop. It is justified only by the privilege boundary — and that boundary is the difference between "app RCE" and "host root".
2. **We are coupled to DMS's file formats.** Since there is no API, parser changes are an upgrade risk. Mitigated by fixture-based parser tests that fail loudly, and by parsers that report `Unknown` rather than guessing on unexpected input.
3. **Single-node by design.** SQLite and the in-process job runner assume one instance. Multi-node would need a shared store and distributed locking; the brief scopes this to single-server, and the interfaces do not preclude a later swap.
4. **The panel is a high-value target.** It authenticates to a mail server and can read DKIM private keys from config. It must be treated as tier-0 infrastructure, and the documentation must say so rather than implying it is a casual tool.
