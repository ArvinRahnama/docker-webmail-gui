# Feature Matrix

**Date:** 2026-08-15 · **Status:** Authoritative. Implementation may not add a UI control that contradicts this document.

This matrix is the project's defence against fake features. Every one of the 34 required capabilities is assessed against what `docker-mailserver` (DMS), the Docker Engine API, and the underlying mail stack can _actually_ do — verified in Phase 1 research, not assumed.

**Evidence base:** [`docs/research/01-docker-mailserver.md`](docs/research/01-docker-mailserver.md) · [`02-docker-api-security.md`](docs/research/02-docker-api-security.md) · [`03-mail-stack-components.md`](docs/research/03-mail-stack-components.md)

## Status legend

| Status          | Meaning                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Full**        | Backed end-to-end by a real data source or operation. Ships complete.                                                                              |
| **Partial**     | Core capability is real; a named sub-capability is absent upstream and is shown as an explicit `Unsupported` control, never hidden or faked.       |
| **Constrained** | Real and complete, but deliberately narrowed for safety (allowlisted, opt-in, or read-only). The limit is a design decision, documented in the UI. |
| **Unsupported** | The stack genuinely cannot do this. No control ships except an explanatory disabled state.                                                         |

---

## 0. Two architectural rules that shape every row

**Rule 1 — Reads parse state; writes use the CLI.**
DMS's `setup` CLI has **no JSON or machine-readable output mode anywhere** — `setup email list` emits a hand-formatted bullet list. Parsing that for reads would be fragile and would break silently on upstream formatting changes. Therefore:

- **Read path:** parse the config files directly (`postfix-accounts.cf`, `postfix-virtual.cf`, `dovecot-quotas.cf`) and query real APIs (Rspamd HTTP, clamd socket, `doveadm`, `postqueue -j`, Docker Engine API). These have stable, documented formats.
- **Write path:** invoke `setup` via `docker exec` with an **argv array**, never `sh -c`. `setup` owns the write semantics (hashing, file locking, side effects) and we must not reimplement them.

**Rule 2 — Every mutation crosses the broker boundary.**
The web tier holds no Docker socket. Mutations are named operations sent to the privileged broker, which pins the target container identity server-side. See `ARCHITECTURE.md`.

---

## 1. Dashboard — **Partial**

Composite view; each tile is only as real as its source. Tiles whose source is unreachable render `Unknown`, never zero.

| Tile                      | Source                                                              | Real?                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server / container status | Docker `GET /containers/{id}/json` → `State.Status`, `State.Health` | Full                                                                                                                                                                                            |
| CPU / RAM                 | Docker `GET /containers/{id}/stats` with documented delta formulas  | Full                                                                                                                                                                                            |
| Disk                      | `GET /system/df` + host filesystem stats for the data path          | Full                                                                                                                                                                                            |
| Network                   | Docker stats `networks.*.rx_bytes/tx_bytes`                         | Full                                                                                                                                                                                            |
| Mail queue                | `postqueue -j` (JSON Lines) grouped by `queue_name`                 | Full                                                                                                                                                                                            |
| Mailbox / alias count     | Parse `postfix-accounts.cf` / `postfix-virtual.cf`                  | Full                                                                                                                                                                                            |
| Domain count              | **Derived** from address parts (see §2)                             | Full                                                                                                                                                                                            |
| Spam statistics           | Rspamd `GET /stat`                                                  | Full (point-in-time)                                                                                                                                                                            |
| **Spam trend over time**  | **Our own periodic `/stat` samples in SQLite**                      | Constrained — Rspamd `/history` is a 200-entry in-memory ring buffer lost on restart, so trends require our own sampling. Shows _"Collecting — trend available after 24h"_ until samples exist. |
| Virus statistics          | **Log parsing only** — clamd exposes no detection counter           | Partial, labelled as log-derived                                                                                                                                                                |
| TLS status                | Parse the certificate PEM                                           | Full                                                                                                                                                                                            |
| DNS status                | Live resolver queries                                               | Full                                                                                                                                                                                            |
| Backup status             | Our own SQLite backup records                                       | Full                                                                                                                                                                                            |
| Update status             | Compare running image digest vs registry                            | Full                                                                                                                                                                                            |
| Health / recent events    | Our health engine + Docker `/events` + audit log                    | Full                                                                                                                                                                                            |

**UI** `/` · **API** `GET /api/v1/dashboard` · **Security** aggregate endpoint returns no secrets; per-tile failures isolated so one dead subsystem cannot blank the page · **Tests** unit tests per collector incl. the cgroup-v1/v2 memory branch; integration test asserting a failed collector degrades to `Unknown` rather than throwing.

---

## 2. Domains — **Partial** (create/delete unsupported upstream)

**Finding:** domains are **not first-class in DMS**. No `setup domain` command exists. The domain list is derived from the address parts in `postfix-accounts.cf` and `postfix-virtual.cf`. A domain exists exactly as long as something references it.

| Capability                         | Status          | Notes                                                                                                          |
| ---------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| List domains, mailbox/alias counts | Full            | Derived from parsed config                                                                                     |
| Domain detail, membership          | Full            |                                                                                                                |
| DNS diagnostics per domain         | Full            | §10                                                                                                            |
| DKIM per domain                    | Full            | §11                                                                                                            |
| TLS status                         | Full            |                                                                                                                |
| **Create domain**                  | **Unsupported** | No upstream operation. UI explains that adding the first mailbox creates the domain, and links to that action. |
| **Delete domain**                  | **Unsupported** | Domains vanish when the last reference is removed. UI lists remaining references.                              |
| **Enable/disable domain**          | **Unsupported** | No upstream concept.                                                                                           |
| Quota information                  | Full            | Aggregated from mailbox quotas                                                                                 |

**UI** `/mail/domains` · **API** `GET /api/v1/domains`, `GET /api/v1/domains/:domain` · **Docker ops** exec (read files) · **Security** domain names validated against a strict hostname pattern before ever reaching a DNS resolver (SSRF surface) · **Tests** unit tests for domain derivation incl. aliases-only domains and IDN; assertion that no create/delete endpoint exists.

---

## 3. Mailboxes / Users — **Partial**

| Capability                           | Status      | Mechanism                                                                                               |
| ------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------- |
| List, search, sort, filter, paginate | Full        | Parse `postfix-accounts.cf`; server-side paging                                                         |
| Create                               | Full        | `setup email add <addr>` — password via **stdin**, not argv                                             |
| Delete                               | Full        | `setup email del` — see the flag rule below                                                             |
| Change password                      | Full        | `setup email update` via stdin                                                                          |
| Quota set/clear                      | Full        | `setup quota set                                                                                        | del`                                                                                                                                                       |
| Usage                                | Full        | `doveadm quota get`                                                                                     |
| **Enable/disable**                   | **Partial** | DMS has no true disable. `setup email restrict add send                                                 | receive` blocks sending and/or receiving — real, but not a full account disable. UI labels it exactly that: _Restrict sending / receiving_, not "Disable". |
| Bulk operations                      | Constrained | Bulk restrict and bulk quota only. **No bulk delete** — the blast radius is unacceptable for mail data. |

**The `email del` data-loss rule.** `setup email del` always removes account metadata; deleting the Maildir is gated by `-y` (force delete) / `-n` (force keep), and with **no flag it prompts interactively, defaulting to No**. We must **always pass an explicit flag** — never rely on the prompt, which would hang a non-interactive exec. The UI makes the choice explicit: _Delete account and its mail_ (`-y`) vs _Delete account, keep mail on disk_ (`-n`). Deletion is irreversible; there is no trash.

**UI** `/mail/mailboxes` · **API** `GET/POST /api/v1/mailboxes`, `PATCH|DELETE /api/v1/mailboxes/:address` · **Security** passwords piped to stdin so they never appear in `argv`/`ps`; never logged, never returned; delete is destructive **Tier 3** (type-to-confirm + impact summary showing message count and data size) · **Tests** unit tests for `.cf` parsing incl. malformed lines; a test asserting the delete flag is always explicit; audit-log assertion on every mutation.

---

## 4. Aliases — **Full**

`setup alias {add,del,list}` writing `postfix-virtual.cf`. Create, delete, list, search, domain filter, destination management, validation all real.

> **Correction to the brief:** `postfix-aliases.cf` **does not exist** in DMS. The alias file is `postfix-virtual.cf`. Any doc or copy referring to the former is wrong.

Editing = delete + re-add (no upstream in-place edit); performed atomically server-side and presented as a single edit.

**UI** `/mail/aliases` · **API** `GET/POST /api/v1/aliases`, `DELETE /api/v1/aliases/:id` · **Security** address validation before shelling; loop and self-reference detection · **Tests** parser tests, catch-all (`@domain`) handling, alias-to-alias chain detection.

---

## 5. Forwarding — **Full** (same mechanism as aliases)

DMS has **no separate forwarding subsystem**. Forwarding is an alias whose destination is external. Presenting two pages for one mechanism would confuse users about which to use, so this ships as **one Aliases page with a type column** distinguishing _internal alias_ from _external forward_. Multiple destinations, validation, editing and safe deletion all real. Enable/disable is achieved by removing/re-adding, and is labelled accordingly rather than implying a persistent disabled state.

---

## 6. Password management — **Full**

Generation (CSPRNG), confirmation, strength meter, and rotation. Hashing is delegated to DMS/Dovecot — **we never implement or store mail password hashes**.

**One unresolved item flagged for runtime verification:** whether `doveadm pw` can consume a password from piped stdin over `docker exec -i`, or whether `-p` (which exposes it in `argv`, visible in `ps`) is the only route. Our primary path — `setup email add/update` via stdin — avoids this entirely. If a direct `doveadm pw` call is ever needed, the documented fallback is passing via `docker exec -e` so the value lands in `/proc/pid/environ` rather than `ps`. **Verified in Phase 12 integration tests before any such path ships.**

**Security** never logged (logger redaction list), never returned by any endpoint, never persisted by us, never placed in browser storage; rate-limited; TLS required.

---

## 7. Quotas — **Full**

Set/clear via `setup quota set|del`; usage via `doveadm quota get`. Displays quota, usage, remaining, percentage, warnings, sorting. Domain-level figures are aggregated by us from mailbox data. Requires `ENABLE_QUOTAS=1` — when disabled, the page shows a real `Unsupported` state explaining the env var to change, rather than empty tables.

**UI** `/mail/storage` · **API** `GET /api/v1/quotas`

---

## 8. SMTP settings · 9. IMAP settings — **Constrained**

Effective configuration is readable (`postconf -n`/`-d`/`-M`, `doveconf`). Editable configuration is the DMS **environment variables**, and env changes require a **container recreate**, not a restart — a Docker fact, not a DMS one.

Every setting is therefore classified in the UI as **Read-only** · **Editable (live)** · **Editable (needs restart)** · **Editable (needs recreate)**, and no change is applied without showing which it is. This directly satisfies the brief's requirement never to silently modify configuration.

**UI** `/config/smtp`, `/config/imap` · **Security** recreate is a **Tier 4** operation routed through the broker · **Tests** classification correctness per setting; a test that applying an env change surfaces the recreate warning.

---

## 10. DNS / MX / SPF / DKIM / DMARC — **Full**

Live resolution via Node's `dns.promises.Resolver` for MX, SPF (TXT `v=spf1`), DKIM (TXT at `<selector>._domainkey.<domain>`), DMARC (TXT at `_dmarc.<domain>`), PTR and A/AAAA. Validation goes beyond presence: multiple SPF records, >10 SPF lookups, `~all` vs `-all`, DMARC `p=none`, missing `rua`.

Each record reports exactly one of **Detected · Valid · Invalid · Missing · Unknown**. `Unknown` (resolver failure) is grey, never yellow — conflating "we could not check" with "there is a problem" trains admins to ignore warnings.

_Propagation checking_ is offered honestly: we query several public resolvers and report per-resolver answers. We do **not** claim global propagation, which is not observable.

**Security** this is the project's main **SSRF surface**. Domains are validated against a strict hostname pattern; only DNS is performed (never HTTP fetches to user-supplied hosts); queries are rate-limited and timeout-bounded. **Tests** parser unit tests against fixture records; malformed-record handling; an assertion that resolver failure yields `Unknown` and not `Invalid`.

---

## 11. DKIM generation — **Full**

`setup config dkim` generates keys; the public key and DNS TXT record are displayed with copy. Selector, key size and status shown. Rotation is supported as generate → publish → verify, with clear warning that mail signed with the old key may fail validation until DNS propagates.

**Private keys are never returned by any API and never rendered.** The UI shows only the public record.

**Runtime verification flagged:** the DKIM key path differs when `ENABLE_RSPAMD=1` (DMS delegates to an `rspamd-dkim` script). Confirmed in Phase 12 before the feature is declared done.

---

## 12. SSL / Let's Encrypt — **Partial**

| Capability                                                          | Status                     |
| ------------------------------------------------------------------- | -------------------------- |
| Certificate status, issuer, subject, SANs, validity, days remaining | Full — parsed from the PEM |
| Expiry warnings (≤30d warn, ≤7d critical)                           | Full                       |
| `SSL_TYPE` mode display and manual cert configuration               | Full                       |
| Certificate diagnostics                                             | Full                       |
| **Issuing / renewing Let's Encrypt certificates**                   | **Unsupported**            | DMS does not issue certificates; it consumes them from an external ACME client (certbot, Traefik, acme-companion). We will not embed an ACME client — it would duplicate the tool the admin already runs and create a second source of truth for certificates. The UI shows status plus documentation on wiring an ACME client. |

Private key material is never read into the API layer — only certificate (public) data is parsed.

---

## 13. Rspamd · 14. Spam statistics · 15. Spam rules

**13 Rspamd — Full (read) / Constrained (write).** Controller HTTP API on port 11334, `Password` header. `GET /stat`, `/errors`, `/symbols`, `/actions`, `/graph` read-only. Health and version real.

**14 Spam statistics — Full, with an honest time-series caveat.** Point-in-time counters from `/stat` are real. History from `/history` is capped at **200 entries and does not survive a restart**, which the UI states on the page. Trends come from our own sampling (§1).

**15 Spam rules — Constrained.** Rules and symbol scores are **readable**. Writes are limited to a safe allowlist — thresholds and per-symbol scores — plus `/learnspam` and `/learnham` (mutating; require confirmation and are audited).

**We deliberately do not ship a general Rspamd configuration editor.** Rspamd config can embed **Lua**, and maps can reference URLs — arbitrary code execution and SSRF respectively. Exposing that through a web panel would hand an authenticated attacker code execution inside the mail stack. This is an intentional refusal, stated in the UI, not an oversight.

**UI** `/security/rspamd`, `/monitoring/spam` · **Security** controller password held server-side only, never proxied to the browser; read-only credential used wherever possible.

---

## 16. ClamAV — **Partial**

| Capability                                                | Status                                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Running status, engine version, signature DB version/date | Full — `PING`, `VERSION` via the clamd socket                                                                                          |
| Health, resource usage                                    | Full                                                                                                                                   |
| **Detection counts / scan statistics**                    | **Partial — log parsing only.** clamd exposes no detection counter. Clearly labelled as log-derived, with its retention window stated. |
| `STATS` command output                                    | Constrained — documented upstream as unstable free text, so parsed defensively and shown raw if parsing fails                          |
| Trigger signature update                                  | Constrained — `freshclam` is a real operation, offered with confirmation and rate limiting                                             |

Requires `ENABLE_CLAMAV=1`; otherwise a real `Unsupported` state.

---

## 17. Sieve filters — **Full**

`doveadm sieve list|get|put|activate|deactivate` gives genuine per-user script management: inspect, edit, validate, activate/deactivate, error reporting.

**Security:** Sieve is a restricted, non-Turing-complete filtering language, but the `vnd.dovecot.execute`/`sieve_pipe` extensions can invoke external programs. Scripts are **validated server-side and rejected if they reference execute/pipe extensions**, which closes the arbitrary-execution path the brief warns about. Scripts are size-capped and syntax-checked before being stored.

---

## 18. Autoresponder — **Full, including start/end dates**

Implemented as Sieve `vacation` (RFC 5230). A **date window is genuinely expressible** by wrapping it in RFC 5260 `currentdate` tests — verified in research, so this ships as a real feature rather than a degraded one:

```sieve
require ["vacation", "date", "relational"];
if allof (currentdate :value "ge" "date" "2026-08-20",
          currentdate :value "le" "date" "2026-08-30") {
  vacation :days 7 :subject "Out of office" "I am away until 30 August.";
}
```

Enable, disable, message, subject, start/end dates, validation and status are all real. Generated server-side from structured input — **the admin never hand-writes Sieve here**, which keeps injection out of the flow.

---

## 19. Logs · 20. Mail logs · 21. Container logs — **Full**

One viewer, multiple sources: container stdout via Docker `GET /containers/{id}/logs?follow=true`, and mail logs from `/var/log/mail`. The multiplexed 8-byte stream header is decoded (TTY vs non-TTY branch); Postfix lines are parsed into queue id, sender, recipients, status, DSN, relay and delay.

Live streaming (SSE), search, severity/time filtering, download, pause/resume, buffer clear and source selection all real. Virtualized rendering for large volumes.

**Security — the brief's "no arbitrary filesystem access" requirement:** log sources are a **fixed server-side enum**. No client-supplied path ever reaches the filesystem, closing the path-traversal vector. Log content is treated as untrusted and escaped on render (log-injection defence). Access is authenticated and audited — mail logs contain sender/recipient metadata.

---

## 22. Container status · 23. Start / Stop / Restart — **Constrained**

Status, health, uptime, image, ports and resource usage via Docker inspect/stats. Start, stop and restart are real, routed through the broker as **named operations against an allowlist of managed containers**.

**Recreate is separated deliberately.** "Recreate" is not a Docker API operation — it decomposes into stop → remove → **create** → start, and `POST /containers/create` is the exact call that grants host root (arbitrary bind mounts, `Privileged`, `PidMode: host`). The broker therefore **never accepts a container specification from the web tier**. Recreate is only available as a fixed, parameterless operation against an allowlisted container using a server-side-stored specification. Non-allowlisted containers are visible but read-only, with the reason shown.

Lifecycle actions are **Tier 2** confirmations stating the operational consequence (mail delivery stops during restart).

---

## 24. Docker images — **Full**

List with tag, ID, size, created date, and which containers use them. Cleanup is offered for **dangling images only**, and an image in use by any container — running or stopped — can never be selected. Pull with progress streaming is supported as part of updates.

---

## 25. Volumes — **Constrained**

List, inspect, mountpoint, container relationships, and size via `GET /system/df` (flagged as an expensive call and cached).

**Deletion of a volume holding mail data is blocked outright, not merely confirmed.** The four DMS volumes — `mail-data` (`/var/mail`), `mail-state`, `mail-logs`, `config` (`/tmp/docker-mailserver`) — are identified from the container's mounts and marked protected. For any other volume, deletion is **Tier 3** and refuses while a container references it. This is the single most dangerous operation in the product and is treated accordingly.

---

## 26. Networks — **Full (read-only)**

List and inspect: driver, scope, connected containers, IPAM. **No create, delete, connect or disconnect** — network mutation offers no value to a mail admin panel and expands the attack surface (`NetworkMode: host` is an escalation vector). Read-only by design, stated in the UI.

---

## 27. Backups / Restore — **Full** (the highest-risk feature)

Backs up the four volumes confirmed from the official compose file: `/var/mail` (mail), `/var/mail-state` (Dovecot indexes, Fail2ban state), `/var/log/mail`, `/tmp/docker-mailserver` (all `.cf` files, DKIM keys, TLS certs). DMS ships **no official backup tool**; its FAQ recommends `tar` over the data directory — so we own this logic and must be careful.

Create, list with metadata, verify (checksum + archive integrity), download, delete and restore-preview are all real. Restore is **Tier 4**: pre-flight report, type-to-confirm, and either a verified recent backup or explicit acknowledgement. Restore requires the container stopped, and preserves the vmail UID/GID (default 5000:5000) — a documented restore gotcha that silently breaks mail delivery if missed.

Long-running, so it runs as a job with progress, never blocking a request. **Restore is unavailable on mobile** — a four-tier destructive flow on a phone is a data-loss hazard.

---

## 28. Configuration editor · 29. Environment variables — **Constrained**

Shows current values, effective configuration, pending changes, a **diff**, validation, and the restart/recreate impact (§8) before anything is applied. Flow is fixed: validate → diff → explain consequences → confirm → apply → verify → audit.

Secrets are masked with show/hide/copy; **revealing a secret is itself an audited event**. Editable files are a **server-side allowlist** of DMS config files — no arbitrary path, no arbitrary file write. A pre-change snapshot enables rollback.

---

## 30. Health checks — **Full**

Real checks against real sources: Docker daemon (`/_ping`), container state and Docker healthcheck, Postfix (`postconf`/queue reachable), Dovecot (`doveadm`), Rspamd (`/stat`), ClamAV (`PING`), DKIM/TLS/DNS (§10–12), disk, memory, CPU, queue depth, port reachability. Each returns **Healthy · Warning · Critical · Unknown** with the timestamp of the check. Nothing is inferred from another check's result.

---

## 31. Updates — **Partial**

Current version (running image digest), available version (registry), update preview, backup recommendation, progress and failure handling are real. Release notes are linked to the upstream release page rather than scraped and reformatted.

The brief's requirement that we never blindly `docker compose pull && up -d` is met: updating requires the **recreate** path (§22), which uses a server-side-stored container specification, never a client-supplied one.

**Rollback is honest about its limits.** Reverting to the previous image digest is real and supported. But a rollback **cannot undo data or schema migrations** performed by the new version — mail data and DMS state are not versioned. The UI states this plainly and requires a verified backup before an update proceeds. Promising a clean rollback would be the most dangerous lie this product could tell.

---

## 32. Terminal / Exec — **Constrained, opt-in, disabled by default**

Ships **off** behind an explicit configuration flag. When enabled:

- **Restricted command console, not a shell.** A server-side allowlist of named diagnostic commands with fixed argv (`postqueue -p`, `doveadm quota get`, `postconf -n`, …). No free-form shell, no `sh -c`, no user-supplied argv.
- Target container is pinned server-side; the client never names it.
- Runs as a non-root user where the tooling permits, with `Privileged` never set.
- Every invocation is audited with actor, exact argv, exit code and duration; sessions time out.
- The UI names the target container and warns before opening.

**Rationale for refusing a real shell:** exec into DMS grants root _inside_ a container that mounts the mail store, DKIM private keys and TLS certificates — full compromise of mail confidentiality even without host escape. Additionally, `exec` is the trigger class for runc escapes such as CVE-2019-5736 and CVE-2024-21626. A general shell in a web panel is not a defensible risk for the convenience it buys. An unrestricted host shell is **never** provided.

---

## 33. Monitoring · 34. System resources — **Full**

Container CPU/RAM/network from Docker stats using the documented delta formulas, with the **cgroup v1 vs v2 branch handled correctly** (`cache` vs `inactive_file` subtraction — getting this wrong massively over-reports memory). Host CPU, RAM, swap, disk, load average from the host; Docker resource usage from `/system/df`.

Mail volume, spam volume and error counts come from log parsing and our own sampled series (§1). Live updates use Docker `/events` for lifecycle plus targeted stats streams only for what the UI is actively displaying — not blanket polling.

---

## Summary

| Status          | Count                                    | Items                                                                                                                                                                                           |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Full**        | 19                                       | Aliases, Forwarding, Passwords, Quotas, DNS, DKIM, Sieve, Autoresponder, Logs ×3, Images, Networks, Backups/Restore, Health, Monitoring, System resources, Rspamd (read), Spam statistics       |
| **Partial**     | 8                                        | Dashboard, Domains, Mailboxes, TLS, ClamAV, Updates, SMTP/IMAP settings                                                                                                                         |
| **Constrained** | 7                                        | Spam rules, Containers/lifecycle, Volumes, Config editor, Environment, Terminal/Exec, Rspamd (write)                                                                                            |
| **Unsupported** | 0 whole features; **5 sub-capabilities** | Create/delete/disable domain · true mailbox disable (only send/receive restrict) · Let's Encrypt issuance · bulk mailbox delete (refused by us) · general Rspamd config editing (refused by us) |

Every unsupported sub-capability ships as a visible, disabled control with an explanation — never hidden, never faked.

## Deferred to runtime verification (Phase 12)

| Item                                  | Why it matters                    | Fallback if it fails                                       |
| ------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| `doveadm pw` stdin behaviour          | Password exposure in `argv`       | Primary path (`setup` via stdin) already avoids it         |
| DKIM key path under `ENABLE_RSPAMD=1` | DKIM display/rotation correctness | Detect path at runtime; report `Unknown` rather than guess |
| Rspamd `/stat` exact field names      | Dashboard spam tile bindings      | Bind defensively; render only confirmed fields             |
| Exact `/var/mail-state` contents      | Backup completeness               | Back up the whole volume regardless                        |
| `setup fail2ban status` output shape  | Fail2ban page parsing             | Show raw output if parsing fails                           |
| ClamAV `VERSION` string format        | Version/signature-age display     | Show raw string                                            |
