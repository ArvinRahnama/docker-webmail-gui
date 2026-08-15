# Security

**Date:** 2026-08-15 · **Status:** Authoritative. A change that weakens a control here requires an explicit, documented decision.

This document is both the project's **vulnerability disclosure policy** and its **threat model**.

---

## Part 1 — Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report privately via GitHub Security Advisories on the repository (_Security → Report a vulnerability_), which creates a private channel with the maintainers.

Include: affected version/commit, environment, reproduction steps, impact, and any proof of concept. We aim to acknowledge within 5 days, provide an initial assessment within 10 days, and coordinate disclosure once a fix is available. Reporters are credited unless they prefer otherwise.

**Supported versions:** during 0.x, only the latest release receives security fixes.

### Report these as vulnerabilities

Authentication or authorization bypass · session fixation or hijacking · injection of any kind · path traversal · SSRF · secret exposure in responses, logs or the frontend bundle · any escape from the broker's operation allowlist · any route by which the web tier reaches the Docker socket · privilege escalation between administrators.

### Known and documented, not vulnerabilities

These are properties of the design, stated openly rather than hidden:

- **An administrator can read mail metadata and configuration.** The panel exists to manage a mail server; log viewing and config reading are its purpose.
- **DKIM private keys live in the DMS config volume.** Anything that can read that volume can read them. We never expose them through the API, but an admin with backup-download rights obtains them inside the archive.
- **A compromised broker is a host compromise.** This is why the broker is minimal (§4.1).
- **The panel can cause a mail outage.** Restart and recreate are features.

---

## Part 2 — Threat model

### 2.1 Assets, ranked

1. **Mail data** — irreplaceable. Loss is unrecoverable and unacceptable.
2. **The host** — compromise means everything else is moot.
3. **Secrets** — DKIM private keys, TLS private keys, mail account credentials, the broker secret, admin password hashes.
4. **Mail integrity** — the ability to send as a domain (spoofing, reputation damage, blocklisting).
5. **Availability** — an outage is serious but recoverable.

### 2.2 Trust boundaries

| Boundary | Between                | Control                                                                                               |
| -------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| **B1**   | Internet → web tier    | Authentication, session management, rate limiting, CSRF, security headers                             |
| **B2**   | Web tier → broker      | Internal-only network, shared secret, fixed operation vocabulary, Zod-validated per-operation schemas |
| **B3**   | Broker → Docker daemon | Operation allowlist, server-side container allowlist, no client-supplied container specs              |
| **B4**   | Broker → DMS container | Argv arrays only, allowlisted subcommands, allowlisted file paths                                     |

**B2 is the load-bearing boundary.** Everything above it is assumed breachable.

### 2.3 Adversaries

| Adversary                                    | Capability                          | Primary defence                                                                                     |
| -------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Unauthenticated internet attacker            | Reach the login endpoint            | Auth, rate limiting, lockout, no information disclosure                                             |
| Credentialed attacker (stolen admin session) | Full panel authority                | Audit logging, re-auth for destructive actions, immediate session revocation, blast-radius bounding |
| Attacker with RCE in the web tier            | Arbitrary code in the web container | **B2** — no socket, no Docker vocabulary, no way to express a container spec                        |
| Malicious or compromised dependency          | Code execution at build or run time | Lockfiles, pinned digests, CI audit, SBOM, minimal dependency count                                 |
| Curious/careless administrator               | Legitimate but dangerous actions    | Tiered confirmations, impact summaries, deletion blocks on mail volumes                             |

---

## Part 3 — Threats and mitigations

Every threat named in the project brief, with our actual exposure and control. **Verification** names how we prove it, since an unverified control is an assumption.

### 3.1 Docker socket abuse · Docker/container escape · host filesystem access

**Exposure:** Highest-severity class. `POST /containers/create` with `Binds: ["/:/host"]`, `Privileged: true`, `PidMode: "host"`, or re-mounting the socket each independently yields host root.

**Mitigations:**

- The web tier has **no Docker socket and no Docker vocabulary**. It cannot express a container specification — there is no protocol field that carries one.
- The broker exposes a **fixed enum of named operations**, Zod-validated per operation. Unknown operation → reject. No passthrough, no raw path, no `args` escape hatch.
- Container identity is resolved **broker-side** from configured name/label. The web tier never sends a container ID.
- `recreate` uses a **broker-stored specification**. The web tier can request one; it cannot describe one.
- `Privileged` is never set on exec or on any container. `privileged: true` appears nowhere in our compose files.
- Both containers run non-root, `read_only`, `cap_drop: ALL`, `no-new-privileges:true`, with Docker's default seccomp and AppArmor profiles retained (these block the cgroup `release_agent` path of CVE-2022-0492).
- Broker network is `internal: true` — no route to or from the internet.

**Explicitly rejected:** `tecnativa/docker-socket-proxy` as the primary control. Verified against its shipped `haproxy.cfg`: it inspects only path and method, never the body, and a single `CONTAINERS` gate covers both container listing and container creation — so a read+control panel configured through it leaves creation open. It is usable only in read-only mode.

**Verification:** a test asserts no socket is mounted into the web container; a test asserts the broker rejects every operation outside its enum; a CI grep fails the build on `privileged` or a `docker.sock` bind in the web service.

**Residual:** a broker bug is a host compromise. Mitigated by keeping it small, logic-free and rarely changed.

### 3.2 Command injection

**Exposure:** We invoke `setup`, `doveadm`, `postqueue` and `postsuper` inside a container with admin-supplied values (addresses, quotas, domains).

**Mitigations:** argv arrays exclusively — **never `sh -c`**, never string interpolation, never a shell. Subcommands and flags come from a server-side allowlist; only leaf values come from input, and each is schema-validated (address, hostname, integer range) before use. The restricted console has no free-form argv at all.

**Verification:** unit tests attempt injection payloads (`; rm -rf /`, `$(…)`, backticks, newlines) against every command builder and assert they are either rejected or passed through inertly as a single argv element.

### 3.3 Path traversal · arbitrary file read/write

**Exposure:** Log viewing, config editing, backup download.

**Mitigations:** **no client-supplied path ever reaches the filesystem.** Log sources are a server-side enum. Editable config files are a server-side allowlist of DMS paths. Backups are addressed by opaque ID and resolved server-side; the resolved path is verified to sit within the backup directory after normalisation. No endpoint accepts a path parameter.

**Verification:** tests assert `../`, absolute paths, URL-encoded traversal, and symlink escapes are rejected on every file-touching endpoint.

### 3.4 SSRF

**Exposure:** DNS diagnostics take an admin-supplied domain — the brief's most obvious SSRF surface.

**Mitigations:** we perform **DNS resolution only** — never an HTTP fetch to a user-supplied host. Domains are validated against a strict hostname pattern before reaching a resolver. Queries are timeout-bounded and rate-limited. Resolvers used for propagation checks are a **fixed list of public resolvers**, not user-supplied. The Rspamd controller address is configuration, not input.

**Note:** Rspamd maps can reference URLs, which is one reason we ship no general Rspamd config editor (§3.13).

### 3.5 Authentication bypass · session hijacking · brute force

**Mitigations:**

- Argon2id via `@node-rs/argon2`. We implement no cryptography.
- Opaque random session tokens; only the **hash** is stored. `HttpOnly; Secure; SameSite=Strict; Path=/`.
- Session rotation on login and on privilege change; immediate server-side revocation on logout or account disable.
- Absolute and idle expiry.
- Per-IP and per-account rate limiting with progressive lockout on `login_attempts`.
- **Constant-time comparison** and a uniform failure message — login never reveals whether an account exists, and timing does not either.
- No password reset by email (there is no trusted mail path at install time — a mail panel cannot depend on the mail server it manages). Recovery is a documented CLI procedure on the host.

**Verification:** tests for cookie flags, revocation immediacy, lockout thresholds, and identical responses/timings for unknown vs wrong-password.

### 3.6 CSRF

**Mitigations:** `SameSite=Strict` cookies, `Origin`/`Sec-Fetch-Site` validation on every state-changing request, and a synchroniser token for mutations. Safe methods are strictly side-effect free. CORS is **not** enabled — the SPA is same-origin, served by the same server.

### 3.7 XSS

**Mitigations:** React escapes by default; `dangerouslySetInnerHTML` is banned by lint rule. **Log output is treated as fully untrusted** and rendered as text, never HTML — mail logs contain attacker-influenced content (sender names, subjects), making the log viewer the highest-risk XSS sink in the product. A strict CSP without `unsafe-inline`/`unsafe-eval` is a defence in depth.

### 3.8 SQL injection

**Mitigations:** every query uses parameterised statements via `node:sqlite` (`ARCHITECTURE.md` §3.1 — the driver was changed from `better-sqlite3` after it proved uninstallable without a C++ toolchain). String-concatenated SQL is banned by lint rule, and the rule targets `.prepare()`, which is the API of both drivers, so the control survived the swap unchanged. Untrusted input never reaches an identifier position.

### 3.9 Privilege escalation between administrators

**Mitigations:** authorization is enforced server-side per route — never inferred from the UI. The permission model is explicit and extensible beyond the single `Administrator` role. An administrator cannot disable or delete their own account (lockout prevention), and the last remaining administrator cannot be removed.

### 3.10 Secret exposure

**Mitigations:** no secrets in the repository, in the frontend bundle, or in browser storage. `.env.example` carries no real values. Secrets are masked in the UI, and **revealing one is an audited event**. API responses never contain passwords, private keys or tokens. Pino has a **mandatory redaction list** so secrets cannot reach logs through an accidental object dump. **DKIM private keys are never read into the API layer** — only public records are parsed. TLS parsing touches the certificate, never the key.

**Two redaction properties learned empirically (2026-08-16), not assumed.** Both were found by testing the logger against Pino rather than reading its docs, and both are requirements, not implementation trivia:

1. **`set-cookie` must be redacted, not just `cookie`.** `cookie` covers the inbound request header; the _response_ `set-cookie` header is what carries a live session token. Anything logging response headers — or an error object holding them — would otherwise leak an active session.
2. **Pino's redaction is case-sensitive.** Verified: with paths `['authorization', '*.authorization']`, a key spelled `Authorization` passes through **unredacted** while `authorization` is censored. Node, Fastify and undici all lowercase header names — for inbound request headers, for `reply.getHeaders()`, and for responses per the fetch specification — so every header-shaped object this application actually handles arrives lowercase.

   **Decision: keep the key list lowercase and rely on that, rather than expanding every key into case variants.** Expanding them multiplies the redaction path count to defend against a case the platform already prevents. The residual exposure is a _hand-built_ log payload using a capitalised key, so the rule is simply that log fields are spelled in lowercase.

   This was originally specified the other way round. The reversal came from the implementing engineer pushing back on the expansion as disproportionate, and the objection was correct — the valuable part of the finding was never the mechanism, it was that we had been relying on an _unstated_ assumption about header casing. Two tests now pin both halves: that lowercase keys redact, and that the capitalised form does not. The second deliberately asserts the leak, so that a future change in Pino's behaviour, or a later decision to add variants, fails the test and forces this note to be updated rather than left stale.

A test asserts both, and states why, so that neither is "simplified" away later.

**Honest exception:** backup archives contain DKIM and TLS private keys by necessity. Download is audited and gated.

### 3.11 Log injection

**Mitigations:** structured JSON logging (Pino) — user input is a field value, never part of a format string, so newline/CRLF forgery cannot fabricate log entries. On render, log content is escaped and control characters are stripped.

### 3.12 Malicious configuration

**Mitigations:** config changes are validated, diffed, and their restart/recreate impact shown **before** apply, with a pre-change snapshot for rollback. Only allowlisted files are editable. Values are schema-validated, not free-form.

### 3.13 Deliberate refusals

Three capabilities are refused because their risk exceeds their value. Each is shown in the UI as an explained, disabled state:

| Refused                                                  | Reason                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General Rspamd configuration editor                      | Rspamd config embeds **Lua** and maps can reference URLs — arbitrary code execution and SSRF inside the mail stack, handed to whoever holds an admin session                                                                                      |
| Unrestricted shell / host terminal                       | Exec into DMS is root in a container holding the mail store, DKIM keys and TLS certs. Exec is also the trigger class for runc escapes (CVE-2019-5736, CVE-2024-21626). We ship a **restricted, allowlisted command console**, disabled by default |
| Sieve scripts using `vnd.dovecot.execute` / `sieve_pipe` | These invoke external programs — the arbitrary-execution path the brief warns about. Scripts referencing them are rejected server-side                                                                                                            |

### 3.14 Supply-chain attacks

**Mitigations:** committed lockfiles; base images pinned by **digest**, not tag; multi-stage builds so build tooling never ships; CI runs `npm audit` and dependency review on every PR; a **CycloneDX SBOM** is generated in CI and fails on a newly introduced non-permissive license; the dependency count is kept deliberately low. The installer does not pipe remote content to a shell without a documented verification step (§5).

---

## Part 4 — Applied controls

### 4.1 Why the broker is small

Its threat contribution is proportional to its code. It therefore has **no database, no business logic, no templating, no user-facing surface** — it validates a named operation, resolves a container identity from its own configuration, and makes one Docker call. It should change rarely; every change is a security-relevant change.

### 4.2 Security headers

Set on the app's own responses and tuned against the real application rather than copied:

- **CSP:** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`. No `unsafe-inline`, no `unsafe-eval`, no CDN — which is also why fonts are self-hosted.
- `Strict-Transport-Security` (opt-out for plain-HTTP LAN installs, where forcing HSTS would lock an admin out).
- `X-Content-Type-Options: nosniff` · `Referrer-Policy: no-referrer` · `X-Frame-Options: DENY` (with `frame-ancestors`) · `Permissions-Policy` denying unused features.

**These are verified by tests, not assumed.** A CSP that breaks the app is worse than none, because it gets disabled in a hurry.

### 4.3 Data-safety controls

Mail data loss is the worst outcome this product can cause, so safety is enforced structurally rather than by warning text:

- **The four DMS volumes are identified from container mounts and cannot be deleted through the panel at all** — a block, not a confirmation.
- No bulk mailbox delete.
- `setup email del` always carries an explicit `-y`/`-n`; the admin's choice about mail data is never implicit.
- Tiered confirmations (`UX_ARCHITECTURE.md` §8): destructive operations require type-to-confirm plus an impact summary; restore additionally requires a verified recent backup or explicit acknowledgement.
- Restore requires the container stopped and preserves vmail UID/GID (default 5000:5000) — a documented gotcha that silently breaks delivery when missed.
- Update rollback reverts an image digest but **cannot undo data migrations**, and says so rather than implying safety.
- Restore is unavailable on mobile.

### 4.4 Installer

Detects OS, architecture, Docker, Compose, permissions, ports and existing installs; is **idempotent**; generates secrets with a CSPRNG; never ships a default password; verifies health before reporting success. Uninstall distinguishes **remove the GUI** from **remove the mail server**, and **never touches mail data by default**. For `curl | sh`, we document the checksum-verified two-step method as the recommended path and explain the supply-chain risk rather than pretending it away.

---

## Part 5 — Verification

Controls are only real if tested. The security test suite is part of CI:

1. Injection payloads against every command builder.
2. Path traversal against every file-touching endpoint.
3. Broker rejects operations outside its enum, and containers outside its allowlist.
4. No Docker socket reachable from the web tier.
5. Cookie flags, session revocation, lockout behaviour.
6. Uniform login responses for unknown vs wrong password.
7. Security headers present and the CSP not broken by the real app.
8. Log redaction — secrets never appear in output.
9. Authorization enforced server-side on every mutating route.
10. `npm audit` + dependency review + SBOM license gate.

Phase 13 adds a full manual review against the brief's §79 checklist; Phase 17 records the result.
