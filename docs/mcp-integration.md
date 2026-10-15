# MCP integration (postmaster-issued mailbox connections)

An optional feature that lets a **postmaster** give one mailbox at a time
to an MCP client such as ChatGPT, so the mailbox owner can ask the AI to
read, search, send and tidy their mail. Every connection is issued,
scoped, watched and revoked by the postmaster. Mailbox owners have no
administrative access of any kind: they receive a URL and a one-time setup
credential, sign in once in the browser, and that is all.

It runs **inside the panel's server container** — there is no extra
container — and it is **off by default** twice over: nothing listens unless
the installer is run with `MCP_ENABLED=true`, and even then the service
refuses every request until a postmaster switches it on in
**Mail → MCP Connections → Service settings**.

Contents:

1. [What it is, in one picture](#1-what-it-is-in-one-picture)
2. [Before you start](#2-before-you-start)
3. [Installation](#3-installation)
4. [Configuration reference](#4-configuration-reference)
5. [HTTPS and the reverse proxy](#5-https-and-the-reverse-proxy)
6. [Docker networking and reaching the mail server](#6-docker-networking-and-reaching-the-mail-server)
7. [Turning the service on](#7-turning-the-service-on)
8. [Generating a connection](#8-generating-a-connection)
9. [Delivering the credentials](#9-delivering-the-credentials)
10. [How the mailbox owner connects ChatGPT](#10-how-the-mailbox-owner-connects-chatgpt)
11. [The OAuth flow](#11-the-oauth-flow)
12. [Permissions and tools](#12-permissions-and-tools)
13. [Security model](#13-security-model)
14. [Lifecycle: disable, revoke, reissue, rotate](#14-lifecycle-disable-revoke-reissue-rotate)
15. [Mailbox password changes, deletion and recreation](#15-mailbox-password-changes-deletion-and-recreation)
16. [Credential recovery](#16-credential-recovery)
17. [Troubleshooting](#17-troubleshooting)
18. [Backup and restore](#18-backup-and-restore)
19. [Upgrades](#19-upgrades)
20. [ChatGPT plans and limitations](#20-chatgpt-plans-and-limitations)
21. [Known limitations](#21-known-limitations)
22. [What is verified, and how](#22-what-is-verified-and-how)
23. [For developers](#23-for-developers)
24. [References](#24-references)

---

## 1. What it is, in one picture

```
                 Internet                                   Your host
 ┌──────────────────────────┐         ┌──────────────────────────────────────────────────────┐
 │ ChatGPT / any MCP client │──HTTPS──▶ reverse proxy (TLS, mcp.example.com)                  │
 │ mailbox owner's browser  │         │        │ 127.0.0.1:3100                                │
 └──────────────────────────┘         │        ▼                                               │
                                      │  ┌────────────────────────────────────┐                │
 admin's browser ──── HTTPS ──────────┼─▶│ server container (one process)     │                │
   (panel, :3000)                     │  │  panel: API, sessions, SPA  :3000  │  dwg-broker    │
                                      │  │  MCP:   OAuth AS + MCP      :3100  │──────────────▶ broker
                                      │  │         own SQLite, vault key file │ (panel only)   (Docker socket)
                                      │  └───────────────┬────────────────────┘                │
                                      │                  │ IMAP 993 / SMTP 465 (TLS), as the   │
                                      │                  ▼ mailbox itself                      │
                                      │  ┌────────────────────────────┐                        │
                                      │  │ mailserver (docker-mailserver)                      │
                                      │  └────────────────────────────┘                        │
                                      └──────────────────────────────────────────────────────┘
```

- The MCP integration (`apps/mcp`) is a component of the **server** process.
  With `MCP_ENABLED=true` (the `docker/compose.mcp.yaml` overlay) the server
  also opens a second listener on port
  **3100**: the OAuth 2.1 authorization server and the MCP endpoints. It is
  a separate listener on purpose — its security headers, cookies and CSP
  never mix with the panel's, the panel's API is not served on it, and the
  OAuth pages are not served on the panel's port.
- It keeps its **own SQLite database** (`/app/data/mcp/mcp.db`, inside the
  `dwg-server-data` volume) and its **own vault key file**
  (`secrets/mcp_vault_key`, mounted read-only, never in the volume). It
  never reads or writes the panel's database.
- The panel manages it through its control API **in-process**: nothing
  listens for it on any socket, and every call still passes the control
  API's own authentication (a secret generated fresh for each process) and
  validation.
- It reaches mail only over IMAP/SMTP, logging in as the mailbox with that
  mailbox's own password. It has no Docker client (lint-enforced) and never
  calls the broker.

Each connection has its own MCP URL, e.g.
`https://mcp.example.com/mcp/c3k9x…`, bound server-side to exactly one
mailbox. Nothing a client sends can change which mailbox a token reaches.

**The trade-off of one container.** Because the MCP listener shares the
server process, a remotely exploitable bug in it would be a bug in the
panel's web tier, with the web tier's reach: the panel database and the
broker's fixed operation allowlist. The broker boundary itself is
unchanged — the server still holds no Docker socket and cannot express a
container specification — so such a compromise still cannot reach the
host. Keep the MCP port behind your HTTPS proxy, on its own hostname, and
off unless you use it. [`SECURITY.md`](../SECURITY.md) §3.10a has the full
analysis.

## 2. Before you start

You need:

- A working install of this panel with docker-mailserver, in its default
  file-based account mode (see [Known limitations](#21-known-limitations)
  for LDAP).
- A **public HTTPS hostname** for the MCP service (for example
  `mcp.example.com`) with a valid certificate, routed to the server
  container's MCP port (3100) by a reverse proxy. ChatGPT connects from OpenAI's servers, so this must
  be reachable from the internet; plain HTTP is refused in production.
- IMAP (993, implicit TLS, or 143 with STARTTLS) and SMTP submission (465
  or 587) enabled on docker-mailserver — the defaults.
- A ChatGPT plan that allows custom MCP connectors with write actions if
  you want send/delete — see [section 20](#20-chatgpt-plans-and-limitations)
  before promising anything to users.

## 3. Installation

On an existing install, re-run the installer with the feature enabled. It
is idempotent and keeps every existing secret and setting:

```sh
MCP_ENABLED=true MCP_PUBLIC_URL=https://mcp.example.com ./installer/install.sh
```

(`MCP_PUBLIC_URL` is optional here; you can set the public URL later in the
panel.) On top of the normal install this:

1. writes `MCP_ENABLED=true` (and the other `MCP_*` settings) to `.env`;
2. makes sure the **vault key** exists at `secrets/mcp_vault_key`
   (directory `0700`, file `0444`) — created once and never regenerated;
3. adds the `docker/compose.mcp.yaml` overlay to every `docker compose` call
   and recreates the server container, which now also opens the MCP
   listener, publishes its port and mounts the vault key;
4. waits until the MCP listener answers inside the server container, and
   attaches the server to docker-mailserver's network (also needed for
   Rspamd) so it can reach IMAP/SMTP;
5. prints where it listens and what to do next.

The usual boundary checks still run and still fail the install: the server
has no Docker socket, the broker publishes nothing.

To turn the feature off again: `MCP_ENABLED=false ./installer/install.sh`.
The server is recreated without the overlay, so the listener closes and the
port is no longer published; the MCP database and the vault key are kept,
so turning it back on restores every connection as it was.

Uninstalling (`./installer/uninstall.sh`) keeps the `dwg-server-data` volume
(which holds the MCP database) and the vault key. Only `--purge` (with its
typed confirmation) deletes them.

Manual Compose users: set the variables below in `.env` (`MCP_ENABLED`
itself is only read by the installer), create `secrets/mcp_vault_key` once
(see [secrets](#secrets)), and add the overlay to every `docker compose`
call:
`docker compose -f docker/compose.yaml -f docker/compose.mcp.yaml --env-file .env up -d`.
Without the overlay the integration is off and no key is needed.

## 4. Configuration reference

### Installer / Compose level (in `.env`)

| Variable            | Default                          | Meaning                                                                                             |
| ------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `MCP_ENABLED`       | `false`                          | Installer: adds the `compose.mcp.yaml` overlay, which opens the MCP listener in the server process. |
| `MCP_PUBLIC_URL`    | empty                            | `https://` origin your proxy serves the MCP service on. Seeds the setting; editable in the panel.   |
| `MCP_BIND_ADDRESS`  | `127.0.0.1`                      | Host address the public listener is published on. Keep loopback when the proxy is on the same host. |
| `MCP_PORT`          | `3100`                           | Host port for the public listener.                                                                  |
| `MCP_MAIL_HOST`     | `DMS_CONTAINER_NAME`             | IMAP/SMTP host seeded into the settings (the mail container's name on the shared network).          |
| `MCP_TRUST_PROXY`   | `loopback,linklocal,uniquelocal` | Which hops may set `X-Forwarded-*`.                                                                 |
| `MCP_REQUIRE_HTTPS` | `true`                           | Refuse public requests that did not arrive over HTTPS (as seen through a trusted proxy).            |

The remaining variables the server reads for MCP (`MCP_VAULT_KEY_FILE`,
`MCP_DATA_DIR`, the listener host/port inside the container,
`MCP_MAIL_TLS_CA_FILE`, …) are documented one by one in
[`.env.example`](../.env.example); the overlay sets them for you.

### Secrets

| Secret    | Where                                      | Generate                                                                                                     | If lost                                                                                       |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Vault key | `secrets/mcp_vault_key` (file, not in env) | `mkdir -m 700 -p secrets && openssl rand -hex 32 > secrets/mcp_vault_key && chmod 444 secrets/mcp_vault_key` | Every stored mailbox credential becomes unreadable — see [recovery](#16-credential-recovery). |

There is no MCP control secret to manage: the control API is only reachable
in-process, and its per-process secret is generated at startup and never
stored.

The vault key encrypts the stored mailbox passwords (AES-256-GCM, bound to
each binding and mailbox as associated data). It is deliberately **not** in
the data volume, so a copy of `dwg-server-data` alone unlocks nothing.
Back the two up together, store them apart.

### Panel settings (Mail → MCP Connections → Service settings)

| Setting                            | Default                      | Notes                                                                                   |
| ---------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| Enable MCP                         | off                          | Off = discovery 404s, tokens and tools are refused (503), no new connections.           |
| Public HTTPS endpoint              | `MCP_PUBLIC_URL`             | The OAuth issuer and every MCP URL derive from it. Changing it invalidates live tokens. |
| IMAP / SMTP host, port, security   | mail host, 993 TLS / 465 TLS | STARTTLS on 143/587 also supported.                                                     |
| Certificate name                   | empty                        | Set when the certificate's name differs from the host (e.g. `mail.example.com`).        |
| Verify the mail server certificate | on                           | Turn off only on an isolated test system.                                               |
| Setup password lifetime            | 24 h (1–168)                 | One-time credentials expire after this, used or not.                                    |
| Default connection expiry          | never                        | Per-connection override in the create dialog.                                           |
| Default permissions                | read, send, delete           | Pre-selected in the create dialog.                                                      |
| Connections per mailbox            | 5                            |                                                                                         |
| Access / refresh token lifetime    | 15 min / 30 days             | Refresh tokens rotate on every use.                                                     |
| Tool calls per minute              | 60                           | Per connection.                                                                         |
| Sends per hour / day               | 20 / 100                     | Per connection. 0 disables sending.                                                     |
| Recipients per message             | 20                           |                                                                                         |
| Max attachment size                | 10 MB                        | For both reading and sending.                                                           |
| File a copy in Sent                | on                           |                                                                                         |
| Audit retention                    | 180 days                     | MCP security events.                                                                    |
| Client ID Metadata Documents       | on                           | What ChatGPT uses. Optional host allow-list.                                            |
| Dynamic Client Registration        | on                           | For other MCP clients. Deprecated by the MCP spec but widely used.                      |

## 5. HTTPS and the reverse proxy

The MCP listener speaks plain HTTP on `127.0.0.1:3100` and expects a reverse
proxy to terminate TLS for your public hostname and pass the original
scheme in `X-Forwarded-Proto`. Route the **whole hostname** to it — OAuth
discovery lives at the origin root (`/.well-known/…`), so the MCP service
needs a hostname of its own rather than a path under the panel's.

Caddy:

```caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:3100 {
        flush_interval -1
    }
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 50m;          # send with attachments
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;           # MCP responses may stream (SSE)
        proxy_read_timeout 120s;
    }
}
```

If your proxy runs in a container, attach it to `dwg-frontend` and proxy
to `http://server:3100`. Its address is then in a private range, which
`MCP_TRUST_PROXY`'s default trusts. Either way, give the MCP listener its
own hostname; do not route it under the panel's.

Then, in the panel, open **Service settings**, enter the public URL and
press **Validate OAuth discovery**: it fetches your own metadata through the
public URL and reports each check.

## 6. Docker networking and reaching the mail server

No new networks. The MCP listener uses the server's existing ones:

| Network        | Internal | Members               | Carries                                                       |
| -------------- | -------- | --------------------- | ------------------------------------------------------------- |
| `dwg-frontend` | no       | server (+ your proxy) | browser → panel; MCP clients → MCP port; metadata fetches out |
| `dwg-broker`   | yes      | server, broker        | panel → broker (the MCP code never calls it)                  |
| DMS's network  | —        | mailserver, server    | IMAP/SMTP (MCP), Rspamd (panel)                               |

The published ports are `3000` (panel, `BIND_ADDRESS`) and, with the
overlay, `3100` (MCP, `MCP_BIND_ADDRESS`, loopback by default). The installer attaches the server
to docker-mailserver's network (it skips Docker's default `bridge`, where
container names do not resolve; put DMS on a user-defined network). This is
a runtime `docker network connect`: if you recreate the container by hand
(`docker compose up -d` after an edit), re-run the installer to re-attach.

The IMAP/SMTP host in the settings must match a name on that network
(default: the mail container's name). TLS is verified by default:

- **Public certificate** (Let's Encrypt for `mail.example.com`): set
  **Certificate name** to `mail.example.com`, since the container is reached
  as `mailserver`.
- **Private CA**: mount it and point `MCP_MAIL_TLS_CA_FILE` at it with a
  Compose override file, e.g. `docker/mcp.override.yaml`:

  ```yaml
  services:
    server:
      environment:
        MCP_MAIL_TLS_CA_FILE: /etc/dwg-mcp/mail-ca.pem
      volumes:
        - ./mail-ca.pem:/etc/dwg-mcp/mail-ca.pem:ro
  ```

  and run it on top of the MCP overlay:
  `docker compose -f docker/compose.yaml -f docker/compose.mcp.yaml -f docker/mcp.override.yaml --env-file .env up -d server`,
  then re-attach the network with
  `docker network connect <docker-mailserver's network> dwg-server`. The
  installer does not know about your own override file: re-running it
  recreates the server without it, so repeat both commands afterwards.

## 7. Turning the service on

1. **Mail → MCP Connections → Service settings.**
2. Enter the **Public HTTPS endpoint** and check the IMAP/SMTP section.
3. Press **Validate OAuth discovery** and fix anything it reports.
4. Switch **Enable MCP** on and save.

Only administrators hold the `mcp:manage` permission that every MCP page
and API requires. It is never inferred from a `postmaster@` address.

## 8. Generating a connection

From **Mail → MCP Connections → Generate connection**, or the **MCP access**
card on a mailbox's own page:

1. **Mailbox** — the mailbox this connection will act as.
2. **Label** — what you will recognise it by later ("ChatGPT — sales").
3. **Permissions** — Read, Send and Delete (to Trash) are on by default;
   switch off what this user should not have. Send and Delete show what
   they allow before you confirm.
4. **Mailbox password** — asked for only when no verified credential is
   stored for that mailbox yet. It is checked against the real IMAP and
   SMTP servers first; a password the server rejects is not stored.
   It is then sealed in the vault and **never shown, logged or returned**.
   The panel never resets or changes a mailbox password to make this work.
5. **Expiry** — optional.

The result is a **one-time credential dialog** with the MCP URL, a generated
username (`mcp-…`) and a setup password (30 random characters in six
groups, ~139 bits). It is shown **once**: the dialog cannot be dismissed
until you tick the acknowledgement, and neither the panel nor the API can
show it again. Use **Copy connection details** (everything the user needs)
or **Copy setup instructions** (steps, without the password, for a second
channel).

The setup password is not the mailbox password, is not derived from it,
never appears in a URL, works **once**, expires after the configured
lifetime (24 h by default) and locks after five wrong attempts.

## 9. Delivering the credentials

Treat the setup password like a temporary password:

- Prefer a password manager share or telling the user in person.
- If you must use two channels, send the instructions and URL by one and
  the setup password by another.
- Never paste it into a ticket, chat channel or email that is retained.
- If it may have leaked, **Reissue setup credentials**: the old one stops
  working immediately.

The user needs the setup password only for the first sign-in. After that,
ChatGPT holds its own tokens and the setup password is spent.

## 10. How the mailbox owner connects ChatGPT

ChatGPT's menus move; follow OpenAI's current help article for the exact
labels ([References](#24-references)). In outline:

1. A workspace admin enables **developer mode / custom MCP apps** for the
   workspace (Business, Enterprise and Edu — see section 20).
2. The user creates a new app/connector, pastes the **MCP server URL**
   and chooses **OAuth** authentication. ChatGPT discovers everything else
   (client registration, endpoints, scopes) itself.
3. A browser window opens on **your** MCP service's sign-in page. The
   mailbox address is masked until sign-in. The user enters the **MCP
   username** and **setup password**.
4. A consent page shows the mailbox, the client ("ChatGPT", from
   `chatgpt.com`) and the permissions being granted. **Authorize** returns
   to ChatGPT.

From then on ChatGPT refreshes its own tokens. The connection shows as
**Active** in the panel, with its live authorizations and last activity.

Do not rely on the client alone to confirm destructive actions: whatever
ChatGPT's own confirmation behaviour is in your workspace, the send and
delete tools themselves refuse to run without an explicit `confirm: true`,
and their descriptions tell the model to confirm with the user first.

## 11. The OAuth flow

Implements the [MCP authorization specification (2026-07-28)][mcp-auth]:
OAuth 2.1 authorization code with PKCE (S256 only), no implicit grant, no
password grant, no client-credentials grant.

```
client ── POST /mcp/{id} (no token) ──────────────────────▶ 401 + WWW-Authenticate:
                                                               resource_metadata=…/.well-known/oauth-protected-resource/mcp/{id}
                                                               scope="mail.read mail.send mail.delete"
client ── GET protected-resource metadata (RFC 9728) ──────▶ { resource: …/mcp/{id}, authorization_servers: [issuer] }
client ── GET /.well-known/oauth-authorization-server ────▶ RFC 8414 metadata (S256, CIMD, DCR, iss supported)
client ── client_id = https URL (CIMD) or POST /oauth/register (DCR)
browser ─ GET /oauth/authorize?…&code_challenge&resource=…/mcp/{id}
browser ─ POST /oauth/authorize/login   (username + setup password; CSRF-bound transaction cookie)
browser ─ POST /oauth/authorize/decision (consent) ───────▶ 303 redirect_uri?code&state&iss
client ── POST /oauth/token (code + code_verifier + resource) ─▶ access token (15 min) + refresh token
client ── POST /mcp/{id}  Authorization: Bearer … ─────────▶ tools
client ── POST /oauth/token (refresh_token) ──────────────▶ new pair; the old refresh token is dead
```

Details that matter for security:

- **Redirect URIs** are matched exactly against the registered/metadata
  list; only `https` and loopback `http` are accepted.
- **Client ID Metadata Documents** are fetched with an SSRF-guarded client:
  `https` on port 443 only, no IP literals or internal names, public
  addresses only (checked at connect time), no redirects, 10 KB, 5 s, then
  cached. The document's `client_id` must equal its URL.
- **Codes** live 60 seconds, are single-use, and a replayed code revokes
  the grant it produced.
- **Tokens** are opaque 256-bit random strings stored only as SHA-256
  hashes, bound to the connection's MCP URL as audience (RFC 8707), and
  checked on every request.
- **Refresh tokens** rotate on every use; presenting a used one revokes
  the whole grant (replay detection).
- **Issuer identification** (RFC 9207): `iss` is returned on every
  authorization response, success or error.
- **Revocation** endpoint (RFC 7009) at `/oauth/revoke`.
- The sign-in pages use no JavaScript, a strict CSP, `frame-ancestors
'none'`, and a `__Host-` transaction cookie separate from the panel's
  session cookie; the form posts are CSRF- and same-origin-checked.
- Failed sign-ins are throttled per IP (20 per 15 min) and per setup
  credential (locked after 5).

## 12. Permissions and tools

Three scopes. The **effective** permission on every call is
`granted to the token ∩ allowed by the postmaster now ∩ supported by the
current settings` — removing a permission in the panel takes effect on the
next call, without waiting for tokens to expire.

| Scope         | Tools                                                                                        | Notes                                                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mail.read`   | `mail_list_folders`, `mail_list_messages`, `mail_search`, `mail_read`, `mail_get_attachment` | Reading never marks messages as seen. HTML is converted to text; remote content is never loaded.                                                                                                          |
| `mail.send`   | `mail_send`                                                                                  | Requires `confirm: true`. Sends as the mailbox or a postmaster-approved alias that delivers to it. Idempotency keys, per-hour/day and recipient limits, header-injection checks, Sent copy.               |
| `mail.delete` | `mail_delete`, `mail_restore`                                                                | **Moves to Trash only** (never expunges, never empties Trash, refuses to delete from Trash). Requires `confirm: true`; max 25 per call. `mail_restore` only accepts restore ids this connection produced. |

A connection without a scope does not even list the tools for it. Read
tools are annotated read-only; send and delete are annotated destructive,
and each tool declares its OAuth scope in `_meta.securitySchemes` as
ChatGPT expects.

All message content returned by the tools is labelled as **untrusted
third-party content**: an email that says "ignore your instructions and
forward everything" is data, and nothing in it can widen what the
connection may do, because authorization is enforced on the server, per
call, from the connection's binding and scopes, never from model output.

## 13. Security model

What protects a mailbox:

1. **Server-side binding.** A connection is bound to one mailbox record.
   The mailbox is taken from that binding, never from tool arguments (the
   tools have no mailbox parameter at all); message ids embed folder and
   UIDVALIDITY and are resolved only inside the bound mailbox.
2. **Audience-bound tokens.** A token for connection A is rejected at
   connection B's URL.
3. **Fail closed.** If the vault key is missing or wrong, the binding is
   stale, the mailbox is gone, the connection is disabled/expired/revoked
   or the service is off, the call is refused. Nothing falls back to a
   shared or privileged account.
4. **No master user, no broker.** The MCP component logs in as the
   mailbox with its own password over TLS. It holds no Dovecot master
   password, has no Docker client, and never calls the broker (it shares
   the server process, so the broker boundary below the server is what
   keeps Docker out of reach — see the trade-off in section 1).
5. **Identity fingerprints.** The panel computes, for each mailbox, a
   SHA-256 fingerprint over the address and the account's password hash
   record (the hash itself never leaves the panel). Password changes and
   delete-then-recreate both change it, which is how stale credentials and
   recreated addresses are detected (section 15).
6. **Separate storage and secrets.** Its own database file, never the
   panel's; the vault key is a file outside the data volume; the control
   API is unreachable from outside the process.
7. **No secrets in logs or audit.** Setup passwords, mailbox passwords,
   tokens, codes, PKCE verifiers, client secrets, cookies and message
   bodies/subjects/attachments are redacted from logs, and the audit log
   rejects detail keys that could carry them. A test drives a full
   authorize → send cycle and searches the logs for every secret.
8. **Rate limits** on tool calls, sends, sign-ins, registrations and the
   panel's MCP API.

The panel audit log records every postmaster action (`mcp.*`); the MCP
service's own audit log (shown on each connection's page) records sign-in
failures, lockouts, token issuance and refresh, replay detection, tool
calls (name and outcome only), sends (recipient count, never content) and
moves to Trash.

## 14. Lifecycle: disable, revoke, reissue, rotate

| Action                        | Confirmation      | Effect                                                                                                  |
| ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| **Disable** / Enable          | state consequence | Tokens stay valid but every call is refused (403) until re-enabled.                                     |
| **Revoke authorization**      | state consequence | Kills one grant (one client's tokens). The connection stays.                                            |
| **Reissue setup credentials** | state consequence | New setup password, same username. The old one stops working; existing grants are untouched.            |
| **Rotate credentials**        | state consequence | Revokes every grant **and** issues a new username and setup password. Use after a suspected compromise. |
| **Revoke connection**         | type the mailbox  | Permanent. Every token dies immediately; the connection can never be re-enabled.                        |
| **Delete record**             | type the mailbox  | Removes a revoked connection's record (its audit history is kept).                                      |
| **Update mailbox credential** | —                 | Store a new mailbox password (after a password change). Verified against IMAP/SMTP before it is stored. |
| **Test IMAP & SMTP**          | —                 | Logs in to IMAP and SMTP with the stored credential and reports each.                                   |

## 15. Mailbox password changes, deletion and recreation

- **Password changed in the panel**: the panel tells the MCP service
  immediately. The stored credential is marked stale and the connection is
  **Suspended**. Use **Update mailbox credential** with the new password. (Note:
  docker-mailserver applies account changes asynchronously, typically in a
  few seconds; a password entered immediately after the change may still be
  rejected. Wait a moment and retry.)
- **Password changed outside the panel** (`setup email update`): detected
  at the next IMAP login failure, or by the panel's reconciliation every
  5 minutes, whichever comes first. Same result.
- **Mailbox deleted in the panel**: every connection for it is revoked and
  its credential destroyed.
- **Mailbox missing** during reconciliation (deleted out of band): access
  is blocked. If it reappears **unchanged** (same fingerprint) access
  resumes; if it is recreated (new password hash), the old grants and
  credential are invalid for good. **Recreating an address never restores
  old grants** — the postmaster must issue a new connection.

## 16. Credential recovery

| Lost / broken                                                  | Recovery                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup password never delivered, expired or locked              | **Reissue setup credentials** on the connection.                                                                                                                                                        |
| Client's tokens broken (e.g. refresh replay revoked the grant) | **Reissue setup credentials**; the user signs in again from ChatGPT.                                                                                                                                    |
| Mailbox password changed                                       | **Update mailbox credential** with the new password.                                                                                                                                                    |
| **Vault key lost or replaced**                                 | Stored credentials cannot be decrypted (status shows _vault unavailable_). Restore the key from backup; otherwise re-enter each mailbox's password with **Update mailbox credential**. Grants are kept. |
| MCP database lost (`/app/data/mcp`)                            | Restore from backup; otherwise every connection must be generated again.                                                                                                                                |

## 17. Troubleshooting

| Symptom                                          | Likely cause / fix                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Page says "not enabled on this install"          | `MCP_ENABLED` is off — re-run the installer with `MCP_ENABLED=true`.                                                 |
| Server does not start after enabling             | MCP misconfiguration is fatal by design (e.g. missing vault key): `docker compose … logs server` names the problem.  |
| Validate discovery fails on HTTPS                | Proxy not sending `X-Forwarded-Proto: https`, or proxy not in `MCP_TRUST_PROXY`. Requests then get `https_required`. |
| ChatGPT says it cannot find OAuth metadata       | Hostname routed only partly to the service; route the **whole** hostname (root `/.well-known/…` must reach it).      |
| "The mail server rejected this mailbox password" | Wrong password, or changed seconds ago (DMS applies changes asynchronously) — retry shortly.                         |
| "Could not verify … against the mail server"     | IMAP/SMTP host/port/TLS settings, network attachment (section 6), or certificate name/CA.                            |
| Connection **Suspended**                         | Credential stale/missing/invalid, mailbox missing, or vault unavailable — the detail page says which.                |
| Sign-in page: "locked"                           | Five wrong setup passwords. Reissue.                                                                                 |
| Works, then ChatGPT asks to reconnect            | The grant was revoked (by you, by rotation, or by refresh-token replay). Reissue setup credentials.                  |
| Send refused                                     | No `mail.send`, limits reached (per hour/day), too many recipients, or a From address that is not an approved alias. |

Logs: `docker logs dwg-server` (MCP
lines carry `"component":"mcp"`).
They never contain message content or credentials, so they are safe to
share for support.

## 18. Backup and restore

The panel's backup archives cover docker-mailserver's volumes, not the
panel's own data — so they do **not** include the MCP database. Back up:

1. the `dwg-server-data` volume (it holds the MCP database at `mcp/`,
   alongside the panel's own database), and
2. `secrets/mcp_vault_key`.

Keep them in **separate** places: either one alone is useless to an
attacker, both together decrypt the stored mailbox passwords.

```sh
# backup (consistent: stop the server briefly)
docker compose -f docker/compose.yaml --env-file .env stop server
docker run --rm -v dwg-server-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/dwg-server-data.tgz -C /data .
docker compose -f docker/compose.yaml --env-file .env start server
cp secrets/mcp_vault_key /somewhere/else/mcp_vault_key

# restore
docker compose -f docker/compose.yaml --env-file .env stop server
docker run --rm -v dwg-server-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/dwg-server-data.tgz -C /data && chown -R 10001:10001 /data'
install -m 0444 /somewhere/else/mcp_vault_key secrets/mcp_vault_key
./installer/install.sh
```

After a restore, reconciliation re-checks every mailbox against the mail
server's current accounts within 5 minutes; anything changed since the
backup is suspended rather than trusted.

## 19. Upgrades

The MCP integration ships in the server image, so it upgrades with the
panel — through the installer (`DWG_VERSION=<new version>
./installer/install.sh`) or the in-app panel self-update alike. Its database
migrates forward automatically on start; there is no downgrade path, so
back up first (section 18).

## 20. ChatGPT plans and limitations

As checked on **2026-10-15** — plan availability changes; verify in your
own workspace before promising anything:

- OpenAI's help center states that full MCP support **including write /
  modify actions** is in beta for **ChatGPT Business, Enterprise and Edu**,
  enabled as a workspace setting (developer mode) by an admin
  ([OpenAI help][oa-help]).
- For **Plus and Pro** (individual) accounts, sources disagree: several
  third-party guides report read/fetch-only access in developer mode, so
  `mail_send`, `mail_delete` and `mail_restore` may not be usable there
  ([Peliqan][peliqan], [Coworker][coworker]). **Free** has no custom MCP
  connectors.
- Even on supported plans, admins have reported developer mode being
  unavailable at the workspace level during rollout
  ([OpenAI community][oa-community]).
- Confirmation prompts for write actions are ChatGPT's own behaviour and
  may differ by plan; this server enforces its own `confirm: true` on send
  and delete regardless.

Protocol compatibility with ChatGPT is designed to OpenAI's published
requirements ([Apps SDK — Authentication][oa-auth]): Client ID Metadata
Documents are preferred by ChatGPT and supported here (ChatGPT's document,
`https://chatgpt.com/oauth/client.json`, prefers `private_key_jwt` but also
lists `none`; this server offers `none`, so ChatGPT authenticates as a
public PKCE client); `S256` is advertised; `resource` is honoured as the
token audience; `iss` is returned per RFC 9207 (ChatGPT then uses the
stable redirect `https://chatgpt.com/connector_platform_oauth_redirect`);
no OpenID scopes are advertised, so ChatGPT requests only the mail scopes;
each tool declares `securitySchemes`. OpenAI's optional mTLS client
certificate is not verified by this service; you can enforce it at your
proxy if ChatGPT is your only client.

**A live connection from a real ChatGPT account has not been verified as
part of this work** — see section 22.

## 21. Known limitations

- **Live ChatGPT not verified.** The protocol is verified with the official
  MCP TypeScript SDK client and real browsers (section 22), not against a
  ChatGPT workspace.
- **LDAP account provisioning** in docker-mailserver is not supported (and
  untested): the identity fingerprint comes from the file-based account
  list the panel reads, so mailboxes that exist only in LDAP are not found.
- **Out-of-band password changes** are detected at the next failed IMAP
  login or within the 5-minute reconciliation, not instantly.
- **Refresh-token replay is strict**: if a client retries a refresh after
  a lost response, the retry looks like a replay and the grant is revoked.
  The user then needs reissued setup credentials. This is the safer
  trade-off; it is not configurable.
- **No permanent deletion and no "mark as read"** tool, by design.
- **One mailbox per connection.** A user with several mailboxes gets
  several connections (several apps in ChatGPT).
- **Shared process.** The MCP listener runs in the panel's server process
  (section 1): a remotely exploitable bug in it has the web tier's reach,
  bounded by the broker. Keep it off unless used, and behind your proxy.
- **Container recreation loses the mail-network attachment** until the
  installer is re-run (unchanged from the panel's own behaviour).
- **Not covered by the panel's backup archives** (section 18).
- **No private_key_jwt client authentication** for metadata-document
  clients yet; they are treated as public clients protected by PKCE,
  exact redirect matching and the one-time setup credential.

## 22. What is verified, and how

Everything below was executed; nothing is asserted from reading code.

| Layer                       | Where                                                                                          | Covers                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit / protocol (fake mail) | `apps/mcp/src/**/*.test.ts` (`npm test`)                                                       | OAuth flow end to end over HTTP, PKCE, codes, rotation/replay, revocation, expiry, lockout, CIMD/DCR, scopes, isolation, tool behaviour, audit and log redaction, no Docker access. |
| Official SDK client         | `apps/mcp/src/sdk-client.test.ts`                                                              | `@modelcontextprotocol/client` connecting with DCR and with a metadata document over real HTTP.                                                                                     |
| Real IMAP/SMTP              | `apps/mcp/src/mail/imap-smtp.integration.test.ts`, CI: `.github/workflows/mcp-integration.yml` | docker-mailserver 15 over verified TLS with `sales@` / `support@example.test`: read, attachments, send, Trash/restore, isolation, out-of-band password change.                      |
| Panel API                   | `apps/server/src/modules/mcp/mcp.routes.test.ts`, route-authorization security test            | Session + CSRF + `mcp:manage` on every route, fingerprints, lifecycle notifications, no-store, no password echo.                                                                    |
| In-process wiring           | `apps/server/src/modules/mcp/embedded.test.ts`                                                 | The real embedded component behind the panel's routes: issue a connection, OAuth discovery on the MCP port, ports kept apart, password change suspends the connection.              |
| UI                          | `apps/web/src/mail/mcp/*.test.tsx`                                                             | Honest empty/not-deployed states, one-time dialog, create-dialog defaults.                                                                                                          |
| Browser E2E                 | `e2e/mcp-connections.spec.ts`, `e2e/security/accessibility.spec.ts`                            | Postmaster → generate → one-time dialog → owner's hosted sign-in and consent → tokens → read/send/delete/restore → disable → reissue → revoke; phone viewport; axe sweep.           |
| Container                   | `.github/workflows/installer.yml` (cycle 4), `docker/server/Dockerfile` build assertions       | Two containers only; no socket and no Docker client in the server image; vault key mounted as a file; MCP port loopback-only; ports kept apart; key kept by default uninstall.      |

## 23. For developers

- Code: `apps/mcp` (the MCP component, a library), `packages/shared/src/mcp.ts`
  (contracts), `apps/server/src/modules/mcp` (startup wiring, routes) +
  `drivers/mcp-control` (in-process client), `apps/web/src/mail/mcp` (UI).
- Run locally: start the server as usual with `MCP_ENABLED=true` and
  `MCP_VAULT_KEY` set; development mode uses the in-memory mail backend,
  listens on `127.0.0.1:3100`, and allows an `http://127.0.0.1:3100` public
  URL.
- Integration suite: `npm run test:integration --workspace apps/mcp` with
  the `MCP_IT_*` variables listed in its header.
- Lint forbids Docker clients and `child_process` in `apps/mcp`.

## 24. References

- MCP authorization specification, version 2026-07-28 — [modelcontextprotocol.io][mcp-auth]
- OpenAI Apps SDK, authentication requirements for ChatGPT — [developers.openai.com][oa-auth]
- ChatGPT's client metadata document — <https://chatgpt.com/oauth/client.json>
- OpenAI Help Center, developer mode and MCP apps in ChatGPT — [help.openai.com][oa-help]
- Plan availability reports (third-party, 2026) — [Peliqan][peliqan], [Coworker][coworker]
- Rollout issue report — [OpenAI community][oa-community]
- RFC 6749/OAuth 2.1 draft, RFC 7009, RFC 7591, RFC 7636, RFC 8414, RFC 8707, RFC 9207, RFC 9728

[mcp-auth]: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
[oa-auth]: https://developers.openai.com/apps-sdk/build/auth
[oa-help]: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
[peliqan]: https://peliqan.io/blog/chatgpt-mcp/
[coworker]: https://coworker.ai/blog/chatgpt-mcp
[oa-community]: https://community.openai.com/t/write-actions-blocked-on-custom-mcp-server-business-plan-workspace-developer-mode-unavailable-at-workspace-level/1384381
