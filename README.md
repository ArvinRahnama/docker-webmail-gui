# Docker Webmail GUI

A self-hosted web management panel for [`docker-mailserver`](https://github.com/docker-mailserver/docker-mailserver), built so that a compromise of the web tier cannot become a compromise of the host.

> ### ⚠️ Project status: under active development — not yet production-ready
>
> Version 0.1.0 is in development. Every feature milestone is built and the panel installs, but it has not been through the production audit (`IMPLEMENTATION_PLAN.md` M15). Do not point this at a mail server you care about.
>
> **What is proven.** Over 1,400 unit tests and 55 Playwright end-to-end tests, including a real-browser CSP and accessibility sweep against the built SPA. The server boots in `APP_MODE=production` and reports healthy — asserted by a test that builds the real application with no driver override, and confirmed by running the built server directly. The packaging exists — multi-stage images, a hardened compose topology, an idempotent installer and uninstaller — and CI is wired to run the full install → healthy → uninstall cycle three times on a real Linux runner, asserting the privilege boundary against live containers.
>
> **What is not.** That CI workflow has not yet run against a real Docker daemon. No tagged release and no published image. The clean-VM cycle has never been run on real hardware, and nothing has ever run against a live `docker-mailserver` — CI stands up a minimal placeholder container so that container resolution and the network-join step exercise something real, which is not the same as exercising mail operations. Nine parsers were written against documented formats rather than captured samples and still await runtime confirmation — see [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md)'s "Deferred to runtime verification" table, and [`docs/troubleshooting.md`](docs/troubleshooting.md) for what you would actually see if one of them is wrong.
>
> Progress is tracked in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) §3.

---

## Why this exists

`docker-mailserver` is an excellent mail stack, but it ships **no HTTP API, no web UI, and no webmail** — it is managed through a CLI (`setup`) and flat configuration files inside the container. Administering it means SSH, `docker exec`, and remembering command syntax.

This project provides a web panel for that job. It is aimed at an administrator who owns a production mail server and is not a mail expert: someone who needs to know quickly whether mail is flowing, whether DNS and TLS are correct, and where the problem is when it is not.

## What it does — and honestly does not

Every capability below was verified against upstream documentation and source before being planned. The project's hard rule is that **no control ships unless the backend can actually perform it** — anything upstream cannot do is shown as an explained, disabled state rather than hidden or faked.

**Working as full features:** mailboxes, aliases and forwarding, quotas and usage, password management, DNS diagnostics (MX/SPF/DKIM/DMARC/PTR) with real validation, DKIM generation, Sieve filters, autoresponders with start/end dates, log viewing with live tailing, container/image/volume/network views, backups and restore, health checks, monitoring, and the dashboard.

**Deliberately limited, with the reason shown in the UI:**

| Area                 | Limit                                                           | Why                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Domains**          | No create, delete, or disable                                   | `docker-mailserver` has no `setup domain` command and no domain object. A domain exists only as long as a mailbox or alias references it, so the panel derives the list and explains that adding the first mailbox creates the domain |
| **Mailbox disable**  | Only _restrict sending / receiving_                             | Upstream has no true account-disable; it has `setup email restrict`. The UI is labelled for what it actually does                                                                                                                     |
| **Let's Encrypt**    | Status and diagnostics only, no issuance                        | `docker-mailserver` consumes certificates from an external ACME client. Embedding one would duplicate the tool you already run and create a second source of truth for certificates                                                   |
| **Rspamd config**    | Thresholds, symbol scores, and learn spam/ham only              | Rspamd configuration embeds **Lua**, and maps can reference URLs. A general editor would hand code execution and SSRF to anyone holding an admin session                                                                              |
| **Terminal**         | Restricted allowlisted command console, **disabled by default** | Exec into the mail container is root inside a container holding your mail, DKIM private keys and TLS certificates. There is no unrestricted shell and never a host shell                                                              |
| **Networks**         | Read-only                                                       | Network mutation offers a mail panel nothing and `NetworkMode: host` is an escalation path                                                                                                                                            |
| **Virus statistics** | Derived from log parsing, labelled as such                      | `clamd` exposes no detection counter — this is a genuine upstream gap, not an oversight                                                                                                                                               |
| **Spam trends**      | Sampled by this panel into its own database                     | Rspamd's history is a 200-entry in-memory ring buffer that does not survive a restart. Until enough samples exist the UI says _"Collecting"_ rather than drawing a line it cannot back                                                |

Full detail, per capability, in [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md).

## Architecture

The panel needs Docker access, and **read/write access to the Docker socket is root on the host** — one `POST /containers/create` with a bind mount or `Privileged: true` ends the discussion. An internet-reachable web application is the worst possible holder of that capability.

So it doesn't hold it:

```
                    Browser (admin)
                          │  HTTPS · session cookie · CSRF
                          ▼
┌─────────────────────────────────────────────────────┐
│  apps/server — WEB TIER                             │
│  API · auth · sessions · SQLite · audit · jobs      │
│  Serves the SPA. Owns all business logic.           │
│  NO Docker socket. NO Docker verbs.                 │
└─────────────────────────────────────────────────────┘
                          │  named operations only, over an
                          │  internal-only network + shared secret
                          ▼
┌─────────────────────────────────────────────────────┐
│  apps/broker — PRIVILEGED TIER                      │
│  Tiny, rarely changed. Holds the Docker socket.     │
│  Allowlists operations AND target containers.       │
│  Never accepts a container spec from the web tier.  │
└─────────────────────────────────────────────────────┘
                          │  Docker Engine API (unix socket)
                          ▼
              Docker daemon → docker-mailserver
```

The web tier speaks a fixed vocabulary of 47 named intents — `container.restart`, `container.logs`, `dms.email.add` and so on. **There is no field in that protocol that can carry a bind mount, a capability, or a container specification.** Full remote code execution in the web tier yields the broker's allowlist and nothing more.

This is privilege separation, as used by OpenSSH — not a microservice split.

**A note on `docker-socket-proxy`:** the common recommendation does not solve this. It filters on URL path and HTTP method only, never the request body, and a single `CONTAINERS` gate governs both container listing _and_ container creation. The configuration a panel needs leaves creation open. Verified against its shipped `haproxy.cfg`; details in [`docs/research/02-docker-api-security.md`](docs/research/02-docker-api-security.md).

Full design in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Security

Treat this as tier-0 infrastructure: it authenticates to your mail server and can read DKIM private keys from configuration.

Highlights — the complete threat model, controls, and how each is verified are in [`SECURITY.md`](SECURITY.md):

- Argon2id password hashing; server-side sessions with immediate revocation (not JWTs, because revocation must take effect _now_).
- Rate limiting, lockout, and login responses that reveal nothing about whether an account exists.
- Argv arrays only — **never `sh -c`**, never shell interpolation.
- No client-supplied path or container specification ever reaches a filesystem or the Docker API.
- Secrets never appear in logs, API responses, the frontend bundle, or browser storage. Revealing a masked secret is itself an audited event.
- Every mutation is audited; the audit log never records secrets.
- Strict CSP with no `unsafe-inline` and no CDN — which is why fonts are self-hosted.

**Data safety is structural, not advisory.** The four `docker-mailserver` volumes are identified from container mounts and **cannot be deleted through the panel at all**. There is no bulk mailbox delete. Destructive operations are tiered, and restore requires a verified backup or an explicit acknowledgement that none exists.

Found a vulnerability? See [`SECURITY.md`](SECURITY.md) Part 1 — please use the private advisory flow, not a public issue.

## Requirements

- Linux host with Docker Engine and Compose
- A running `docker-mailserver` container
- Node.js 24+ _(only to build from source; the released image will not require it)_

## Installation

```sh
git clone <this repository>
cd docker-webmail-gui
./installer/install.sh
```

Idempotent — re-running it upgrades an existing install in place without
touching data or regenerating secrets. Prints a one-time bootstrap admin
credential on a fresh install only. Requires a Linux host with Docker
Engine and the Compose v2 plugin; a running `docker-mailserver` container
is not required to install (mail-dependent features report `Unknown` until
one is found), but is what makes the panel useful. Full detail, including
hardening, uninstall, and — honestly — what is and isn't verified where,
lives in [`docs/docker.md`](docs/docker.md). No pre-built images are
published yet, so this is a source build (Docker builds it; Node.js on the
host is not required for this path). A published-image install and a
checksum-verified remote-script path both remain future work — see that
file's own §2 and §6.

## Configuration

Copy [`.env.example`](.env.example) to `.env`. Every variable is documented inline with its purpose, whether it is required, and its default. Secrets must be generated with a CSPRNG — **no default password ships with this project**.

## Backups

`docker-mailserver` ships no official backup tooling, so this project implements it. Backups cover the four volumes needed for a full restore: mail data, mail state, logs, and configuration (which includes DKIM keys and TLS certificates).

Archives are plain `tar` with a JSON manifest, deliberately: **a backup only our software can read is a liability**, so you can restore by hand if the panel is unavailable. Restore is the most guarded operation in the product.

## Development

No Docker required — mock drivers are the default in development mode, so the panel is fully developable on a machine with no Docker daemon, and cannot touch a real one by accident.

```sh
npm install
npm run dev
```

Useful scripts: `npm run check` (lint + typecheck + test), `npm run build`, `npm test`.

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Testing

Unit and fake-driver integration tests run anywhere. Playwright end-to-end tests (fake-driver-backed, including a real-browser CSP and accessibility sweep — M12) run in CI on Linux, as does a real install → verify → uninstall cycle against a real Docker daemon (M13, `docs/docker.md` §6). Integration tests against a live `docker-mailserver` container are not yet part of CI — `docs/docker.md` §6 says exactly what is and isn't verified where, rather than leaving it implied. Test fixtures are **captured from real output, never invented** — a fabricated fixture would reintroduce the fake-feature problem one layer below the UI.

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Please read the working agreements in [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) §5 first; they are the project's non-negotiables.

## License

[Apache-2.0](LICENSE). Chosen from a researched shortlist — the reasoning, the full third-party dependency inventory, and the analysis of the mail stack's own licences are in [`LICENSE_AUDIT.md`](LICENSE_AUDIT.md).

This project is not affiliated with the `docker-mailserver` project.
