# Implementation Plan

**Date:** 2026-08-15 · **Version target:** 0.1.0

This is the execution plan. It does not restate what the companion documents own:

| Topic | Document |
| --- | --- |
| System design, tech choices, data model, API shape, broker protocol | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Threat model, controls, verification | [`SECURITY.md`](SECURITY.md) |
| What is real, partial, constrained, unsupported | [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md) |
| Design system, IA, screens, destructive-action tiers | [`UX_ARCHITECTURE.md`](UX_ARCHITECTURE.md) |
| Licence decision and dependency inventory | [`LICENSE_AUDIT.md`](LICENSE_AUDIT.md) |
| Evidence for every capability claim | [`docs/research/`](docs/research/) |

**Licence:** Apache-2.0 (SPDX `Apache-2.0`), chosen by the project owner from a researched shortlist. Rationale in `LICENSE_AUDIT.md`.

---

## 1. Dependency budget

The brief forbids bloat, so dependencies are budgeted and justified. Anything not on this list needs a reason at review time.

**`apps/server`** — `fastify`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/static`, `@fastify/multipart`, `zod`, `better-sqlite3`, `@node-rs/argon2`, `pino`, `undici`, `tar`.

**`apps/broker`** — `fastify`, `zod`, `dockerode`, `pino`. **Deliberately four.** Every dependency here is a host-root-adjacent liability.

**`apps/web`** — `react`, `react-dom`, a router, `@tanstack/react-query`, `@tanstack/react-table`, `@tanstack/react-virtual`, `zod`, `react-hook-form`, `@hookform/resolvers`, `tailwindcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, Radix primitives (via shadcn/ui), `lucide-react`, `cmdk`, `sonner`, `recharts`, `date-fns`.

**Tooling** — `typescript`, `vite`, `vitest`, `@playwright/test`, `eslint`, `@typescript-eslint/*`, `prettier`, `@cyclonedx/cyclonedx-npm`.

Versions are pinned at Phase 8a against the licence audit; Tailwind and shadcn/ui majors are resolved then against what shadcn/ui actually supports, rather than assumed now.

---

## 2. Models not covered elsewhere

### 2.1 Backup model

**Scope** — the four volumes confirmed from the official DMS compose file: `/var/mail` (mail data), `/var/mail-state` (Dovecot indexes, Fail2ban state), `/var/log/mail`, `/tmp/docker-mailserver` (all `.cf` files, DKIM keys, TLS certs). Plus the panel's own SQLite state, stored separately so a panel restore never touches mail.

**Format** — a `tar` archive per backup with a JSON manifest recording: schema version, DMS image digest, panel version, volume list, per-entry checksums, byte size, creation time, and creating administrator. DMS ships no official backup tool, so this format is ours and must be self-describing enough to restore by hand with `tar` if the panel is unavailable. That is a hard requirement: **a backup that only our software can read is a liability.**

**Consistency** — mail data is live. The default is a warm backup with the caveat stated in the UI; an optional stop-backup-start produces a consistent archive at the cost of downtime, and the admin chooses explicitly.

**Verify** — recompute checksums and validate archive structure without extracting. Verification status is stored and shown; an unverified backup is never presented as a safety net.

**Restore** — Tier 4. Pre-flight report, container stopped, vmail UID/GID (default 5000:5000) preserved, manifest compatibility checked against the running DMS version, refuse-with-explanation on mismatch rather than proceeding hopefully.

### 2.2 Update model

1. Resolve the running image **digest** (not tag) via inspect.
2. Query the registry for the newest matching tag and its digest.
3. If different: show current vs available, link upstream release notes (linked, not scraped), and **require a verified backup** or explicit acknowledgement.
4. Pull with progress streaming.
5. Recreate via the broker's stored specification — never a client-supplied spec.
6. Verify health; on failure, offer digest rollback.

**Rollback honesty:** reverting the image digest is real. It **cannot undo data or schema migrations** performed by the newer version, because DMS state is not versioned. The UI says exactly this. Promising a clean rollback would be the most dangerous lie the product could tell.

### 2.3 Installer model

POSIX `sh`, idempotent. Detect OS and architecture → Docker and Compose presence and version → required permissions → port availability → existing installation. Generate secrets with a CSPRNG (admin bootstrap credential, broker shared secret, cookie secret). Write compose and env files. Start, wait for health, print access details and the one-time bootstrap credential. **Never ships a default password.**

Re-running upgrades in place and never destroys configuration or data.

`uninstall.sh` distinguishes **remove the GUI** from **remove the mail server**, defaults to the former, and **never removes mail data** without an explicit, separately-typed confirmation.

For remote installation we document a **checksum-verified download-then-inspect-then-run** flow as the recommended path, and explain the supply-chain risk of `curl | sh` rather than pretending it away.

### 2.4 Testing strategy

| Layer | Tool | Runs | Covers |
| --- | --- | --- | --- |
| Unit | Vitest | Everywhere, including this Docker-less workstation | Parsers, command builders, validation, auth, authz, backup manifest logic, health rules, security functions |
| Integration (fake drivers) | Vitest | Everywhere | Service→driver flows, job lifecycle, SSE, error mapping |
| Integration (real Docker + DMS) | Vitest | **CI on Linux runners** | Broker↔Docker, DMS driver against a live container, log/stat streaming, capability detection |
| E2E | Playwright | CI | The brief's critical workflows: login, create mailbox, create alias, change password, DNS check, DKIM generate, restart container, view logs, backup, restore, update, logout |
| Security | Vitest | CI | The ten checks in `SECURITY.md` Part 5 |
| Accessibility | axe-core + Playwright | CI | Zero critical/serious violations per route; keyboard-only completion of critical paths |
| Contrast | Vitest | CI | Both themes against the ratios in `UX_ARCHITECTURE.md` §3.4 |

**Fixtures carry a provenance header** naming their source. Invented fixtures are prohibited — they would reintroduce the fake-feature problem below the UI. Phase 12 captures real fixtures in CI from a live DMS container and resolves the six runtime-verification items in `FEATURE_MATRIX.md`.

---

## 3. Milestones

Each milestone ends with: tests green, lint and typecheck clean, docs updated, and a logical commit. No milestone is "done" while a feature it introduced is untested.

| # | Milestone | Key output | Exit criteria |
| --- | --- | --- | --- |
| **M1** | Repository foundation | Workspaces, TS configs, lint/format, `.env.example`, community health files, CI workflows | CI green on an empty app; `npm run check` passes |
| **M2** | Backend foundation | Config loading, logging with redaction, SQLite + migrations, error model, shared Zod package, health endpoint | Migration runner tested incl. refusing an unknown future version |
| **M3** | Auth, authz, audit | Admins, sessions, CSRF, rate limiting, lockout, audit log | Security tests 5, 6, 9 from `SECURITY.md` Part 5 pass |
| **M4** | Broker + Docker controller | Broker service, operation enum, container allowlist, stream decoding, fake driver | Broker rejects out-of-enum ops and non-allowlisted containers |
| **M5** | DMS driver | Config-file parsers, argv command builders, capability detection, fakes + fixtures | Injection tests pass; parsers tested against fixtures |
| **M6** | Frontend foundation | Design tokens, app shell, navigation, DataTable, state components, API client, auth flow | Contrast + axe tests pass; login E2E green |
| **M7** | Mail management | Domains (derived), mailboxes, aliases, quotas, passwords | Create/change-password/create-alias E2E green |
| **M8** | Security features | DKIM, DNS diagnostics, TLS, Rspamd, ClamAV, Fail2ban, Sieve, autoresponder | DNS check + DKIM generate E2E green |
| **M9** | Docker + observability | Containers, images, volumes, networks, log viewer, monitoring, health centre, restricted console | Restart + log-view E2E green |
| **M10** | Maintenance | Jobs, backups, restore, updates, config/env editor | Backup + restore E2E green |
| **M11** | Dashboard, search, notifications | Dashboard, command palette, global search, notifications | Dashboard renders with a subsystem down (degraded-state test) |
| **M12** | Testing + hardening | Full suites, security review, CSP tuned against the real app | `SECURITY.md` Part 5 fully green |
| **M13** | Packaging + installer | Multi-stage images, hardened compose, installer, uninstaller | Clean-VM install → healthy → uninstall, twice (idempotency) |
| **M14** | Documentation | README + the full `docs/` set | No unsupported claims; every feature's status matches the matrix |
| **M15** | Final audits | Functional, security, UX, licensing, production | The brief's §80 checklist with evidence per item |

M1–M6 are sequential. M7–M11 are mostly parallel once M4–M6 land. M12 runs continuously and is gated at the end.

---

## 4. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **DMS changes config-file formats on upgrade** | Medium | High — silent misreads | No API exists, so this is structural. Fixture-based parser tests fail loudly; parsers return `Unknown` rather than guessing; capability detection at startup |
| **A broker bug becomes host compromise** | Low | Critical | Four dependencies, no business logic, no DB; every change is security-reviewed |
| **Destructive operation loses mail** | Low | Critical | Volume deletion blocked outright; no bulk mailbox delete; explicit `-y`/`-n`; tiered confirmation; backup gate before restore |
| **No local Docker slows verification** | Certain | Medium | Fake drivers by default; CI on Linux is the integration authority; documented manual procedures for anything CI cannot reach |
| **Runtime-verification items resolve badly** | Medium | Low–Medium | Six items tracked in `FEATURE_MATRIX.md`, each with a documented fallback; none is load-bearing for a whole feature |
| **CSP breaks the app and gets disabled** | Medium | Medium | CSP tuned against the real app in M12 and covered by a test; self-hosted fonts remove the main CDN pressure |
| **Scope: 34 features is large** | Certain | Medium | Milestones ship vertically (schema→service→API→UI→tests per feature) so partial completion is still usable and honest |
| **Upstream DMS has no backup tooling** | Certain | High | Self-describing archive format restorable by hand with `tar`; verification is a first-class stored result |

---

## 5. Working agreements

1. **No control ships that the backend cannot perform.** A feature is real, explicitly unsupported, or absent.
2. **Reads parse state; writes use the CLI.** No parsing decorative CLI output for data.
3. **Argv arrays only.** No `sh -c`, ever.
4. **No client-supplied path or container spec** reaches a filesystem or the Docker API.
5. **Secrets never enter logs, responses, the bundle, or browser storage.**
6. **Every mutation is audited.**
7. **Destructive operations are structurally hard**, not merely warned about.
8. **Fixtures are captured, never invented.**
9. **Every claim in the docs traces to research or a test.**

---

## 6. Immediate next steps

1. M1 — repository foundation: workspaces, TypeScript, lint/format, `.gitattributes` (normalise line endings on this Windows host), `.env.example`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `NOTICE`, issue/PR templates, and CI (lint, typecheck, test, build, Docker build, `npm audit`, SBOM licence gate).
2. M2 — backend foundation.
3. Confirm with the project owner whether to push to GitHub, which is the first outward-facing action in this project and has not yet been authorised.
