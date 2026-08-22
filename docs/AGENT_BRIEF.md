# Agent Brief — read this instead of the planning documents

**Purpose.** This is the condensed working context for anyone (human or agent) implementing a milestone. It replaces reading `ARCHITECTURE.md`, `SECURITY.md`, `FEATURE_MATRIX.md`, `UX_ARCHITECTURE.md` and `IMPLEMENTATION_PLAN.md` end to end — roughly 2,000 lines — with about 200.

**Read the full documents only when** you need detail this brief explicitly defers to them, or you are changing a decision recorded there. If you contradict this brief, the full documents win and this file is wrong — say so.

---

## 1. What this is

A self-hosted web panel for `docker-mailserver` (DMS). Node 24, TypeScript strict, npm workspaces monorepo. Apache-2.0.

```
apps/server   web tier — API, auth, business logic, serves the SPA.  NO Docker socket.
apps/broker   privileged tier — holds the Docker socket. Tiny. Rarely changes.
apps/web      React SPA (Vite, Tailwind v4, shadcn/ui)
packages/shared  Zod schemas shared by server, broker and web
```

## 2. The architecture invariant — the thing this project exists to protect

Read/write access to `/var/run/docker.sock` **is root on the host**. One `POST /containers/create` with a bind mount or `Privileged: true` ends the discussion.

So the web tier holds **no socket and no Docker vocabulary**. It sends _named intents_ (`container.restart`, `container.logs` — 18 in total, the full list is `BROKER_OPERATIONS` in `packages/shared/src/broker.ts`) to the broker over an internal-only network. **There is no protocol field anywhere that can carry a bind mount, a capability, a `HostConfig`, or a container specification.** Full RCE in the web tier yields the broker's allowlist and nothing more.

Consequences you must preserve:

- Never add a passthrough parameter, an `args` array, or a raw path to the broker protocol.
- `HostConfig`, `Binds`, `Mounts`, `Privileged`, `CapAdd`, `PidMode`, `NetworkMode` appear in **no schema**. A test enforces this.
- Container identity is resolved **broker-side** from config. The web tier never sends a container id.
- `container.create`, `container.remove` and `exec.*` are deliberately absent from the operation enum.

**Rejected and why:** `tecnativa/docker-socket-proxy` filters on path and method only, never the request body, and one `CONTAINERS` gate covers both container _listing_ and _creation_. Verified by reading its shipped `haproxy.cfg`. It is safe only in read-only mode.

## 3. Nine working agreements — non-negotiable

1. **No control ships that the backend cannot perform.** A feature is real, explicitly unsupported, or absent.
2. **Reads parse state; writes use the CLI.** DMS has no machine-readable output, so never parse its decorative CLI text for data.
3. **Argv arrays only.** Never `sh -c`, never interpolation, never a shell. ESLint fails the build on a shell in an argv array — do not work around it.
4. **No client-supplied path or container spec** reaches a filesystem or the Docker API. Log sources and editable files are server-side enums.
5. **Secrets never enter logs, responses, the bundle, or browser storage.**
6. **Every mutation is audited**, and the audit payload is structurally incapable of holding a secret.
7. **Destructive operations are structurally hard**, not merely warned about.
8. **Fixtures are captured, never invented.** If you construct one from a documented format, the header must say exactly that.
9. **Every claim in the docs traces to research or a test.**

## 4. What is real, and what is deliberately not

Full detail in `FEATURE_MATRIX.md`; this is the part that trips people up.

| Thing                      | Reality                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Domains**                | **Not first-class in DMS.** No `setup domain` command exists. The list is _derived_ from address parts. **No create, delete or enable — do not add them.** The page offers "Add mailbox" instead.                                                                                                                                                      |
| **Mailbox disable**        | Does not exist. DMS has `setup email restrict` (send/receive blocking). Label it as restriction, never "Disable".                                                                                                                                                                                                                                      |
| **Aliases vs forwarding**  | One mechanism, one page with a type column. Not two pages.                                                                                                                                                                                                                                                                                             |
| **Bulk mailbox delete**    | Refused. Bulk restrict and bulk quota are fine.                                                                                                                                                                                                                                                                                                        |
| **`setup email del`**      | Always carries an explicit `-y`/`-n`. Without a flag it prompts and hangs a non-interactive exec. Whether mail data dies with the account is a **required field, never defaulted**.                                                                                                                                                                    |
| **Let's Encrypt issuance** | Not ours. DMS consumes certs from an external ACME client. Show status; never read a private key into the API layer.                                                                                                                                                                                                                                   |
| **Rspamd config editor**   | Refused — its config embeds Lua and its maps fetch URLs (code execution + SSRF). Only thresholds, symbol scores, learn spam/ham.                                                                                                                                                                                                                       |
| **Terminal / exec**        | Restricted allowlisted command console, **off by default**. Never an unrestricted or host shell.                                                                                                                                                                                                                                                       |
| **Networks**               | Read-only.                                                                                                                                                                                                                                                                                                                                             |
| **Virus counts**           | Log parsing only — clamd exposes no counter. Label as log-derived.                                                                                                                                                                                                                                                                                     |
| **Spam trends**            | Rspamd `/history` is a 200-entry in-memory ring lost on restart. We sample `/stat` into `metric_samples`. Show "Collecting" until real data exists — never a fabricated line.                                                                                                                                                                          |
| **Autoresponder dates**    | **Real.** RFC 5260 `currentdate` wrapping RFC 5230 `vacation`. Generate Sieve server-side from structured input.                                                                                                                                                                                                                                       |
| **Sieve / autoresponders** | Reject scripts referencing `vnd.dovecot.execute` or `sieve_pipe` — they invoke external programs. **Not capability-gated, unlike the other features:** there is no `ENABLE_*` toggle for them. `ENABLE_MANAGESIEVE` gates only the ManageSieve protocol, which we do not use, so gating on it would disable a working feature for an unrelated reason. |
| **DNS states**             | `Detected \| Valid \| Invalid \| Missing \| Unknown`. **`Unknown` is grey, not yellow** — a resolver failure must never render as `Invalid`.                                                                                                                                                                                                           |
| **`postfix-aliases.cf`**   | **Does not exist.** The alias file is `postfix-virtual.cf`. The original brief was wrong.                                                                                                                                                                                                                                                              |

## 5. Code patterns — copy these, don't invent

- **Module shape:** `modules/<area>/{<area>.service.ts, <area>.routes.ts, <area>.repository.ts}` + a `.test.ts` beside each. Copy `modules/auth/` or `modules/mail/`.
- **Driver shape:** interface + real implementation + fixture-seeded fake, with the fake as the development default. Copy `drivers/broker/` or `drivers/dms/`.
- **SQL:** fully static parameterised strings. **Never compose SQL from a prefix** — a constant that looks obviously safe today is how the habit starts.
- **Schemas:** Zod in `packages/shared`, consumed by server _and_ web. A contract change becomes a compile error.
- **Errors:** `AppError` with a stable code; the handler maps everything to `{ error: { code, message, errorId, details } }` and never leaks a stack trace. `details` is a JSON value, not `unknown` — `z.unknown()` accepts a _missing key_, which silently makes a required field optional.
- **Optional props:** the project sets `exactOptionalPropertyTypes`. An optional property may be _absent_ but may not be _passed as `undefined`_ — type it `?: T | undefined` when a caller forwards one through.

## 6. Verification — the part that is not optional

**`npm run check` must pass end to end** (dependency consistency → lint → format → typecheck → tests).

**`npm test` alone is not evidence.** Vitest strips types with esbuild without checking them, so a suite can be fully green while the code does not compile. This has already hidden a real failure on this project.

Run `npm run format` periodically as you work. Several milestones have been killed mid-task by session limits; the recoverable ones were those that left formatted, type-clean files behind.

Do **not** test against a real Docker daemon or a live docker-mailserver — neither exists on this machine. Real-daemon integration is M12 in CI.

## 7. Gotchas already discovered — do not rediscover these

- **`npm ls` disagreeing with the lockfile is real.** A workspace once declared zod 3 while others declared 4; npm hoisted one copy and 55 tests passed against the wrong version. `npm run check:deps` now gates both declarations _and_ installed versions.
- **Pino redaction is case-sensitive.** `Authorization` leaks where `authorization` is censored. Keys stay lowercase because Node, Fastify and undici all lowercase header names; two tests pin this, including one that deliberately asserts the leak.
- **SQLite implements FK `ON DELETE SET NULL` as an UPDATE.** An unconditional append-only trigger will block it and break deletes.
- **A bare `ROLLBACK` throws** when no transaction is active, so rollback cleanup must be guarded or it replaces the original error.
- **Strict `.email()` rejects `user@domain`** (no TLD), which is legitimate inside a mail system and appears in DMS's own files. Read paths accept it; write paths stay strict.
- **Docker's container-list `name` filter does substring matching** — list broadly and match exactly client-side.

## 8. Querying the codebase instead of reading it

A knowledge graph of the code lives at `graphify-out/graph.json` — 1,883 nodes and 4,223 edges extracted from every TypeScript file by AST analysis (no LLM, so it is exact rather than inferred). It is gitignored and regenerable.

**Use it before opening files.** To find what calls what, what a symbol connects to, or how two parts of the system relate:

```
graphify query "how does the broker client reach the Docker API"
graphify path "AuthService" "Database"
graphify explain "DmsDriver"
```

The most connected nodes are `cn()`, `Database`, `DmsDriver`, `buildApp()`, `FakeDmsDriver`, `AdminsRepository`, `RealDmsDriver`, `runMigrations()`, `request()` and `DockerApi` — those are the real hubs, and a change to one of them has wide reach.

**Caveat:** the graph covers code only. Documentation was deliberately excluded from extraction, because this brief already carries the operative parts and re-extracting the planning documents would duplicate it at real cost. So the graph answers "how is this wired", not "why was it decided" — for the latter, this brief and then the full documents.

**Regenerating it:** the project directory has Windows per-directory case sensitivity enabled, which graphify's cache layer cannot handle (it lowercases paths, and lowercased paths do not resolve here). Build from a copy in a case-insensitive location and copy `graphify-out/` back. Do not "fix" this by disabling case sensitivity on the project directory — that attribute is likely set deliberately for WSL or Docker builds.

## 9. When you disagree

Push back with a reason. Delegated engineers have corrected this project's specification six times — an over-engineered redaction scheme, a forced-password-change deadlock, a schema-level delete bug, and more. A specification is not evidence; the repository is.
