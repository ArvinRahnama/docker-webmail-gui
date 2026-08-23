# Final audit — M15

`IMPLEMENTATION_PLAN.md` §3's last milestone: "Functional, security, UX,
licensing, production", with **evidence per item**. An item marked done
on recollection is not done, so every row below cites a file, a test
name, or a command and its output.

**Audited at commit:** the tip of `main` at the time this file was
written. **Re-run everything here before trusting it against a later
tree** — that is what the Command column is for.

---

## 0. Two things to read before the results

### 0.1 The checklist this milestone names does not exist in this repository

The exit criterion is "the brief's §80 checklist". The brief is the
source document the five planning documents were derived from; it is not
in the repository, and nothing here reproduces a §80. Searching for it
finds only the reference itself:

```
$ grep -rn "§80" --include="*.md" .
IMPLEMENTATION_PLAN.md:107: ... | The brief's §80 checklist with evidence per item |
```

So this audit is assembled from the checklists that **do** exist, mapped
onto the five dimensions the same table's key-output column names:

| Dimension  | Checklist used                                                            |
| ---------- | ------------------------------------------------------------------------- |
| Functional | `FEATURE_MATRIX.md` — every row's status, and its deferred-items table    |
| Security   | `SECURITY.md` Part 5's ten numbered checks                                |
| UX         | `UX_ARCHITECTURE.md` + `IMPLEMENTATION_PLAN.md` §2.4's accessibility row  |
| Licensing  | `LICENSE_AUDIT.md`, `scripts/check-licenses.mjs`, the SBOM gate, `NOTICE` |
| Production | `docs/docker.md` §6, the installer, the two images                        |

That substitution is itself a finding, recorded rather than papered over.

### 0.2 Asserted vs observed

`docs/docker.md` §6 introduced this split and this audit uses it
throughout, because most of what looks like a gap here is really one of
these two words:

- **Asserted** — a test, a type, or a gate enforces it, and it runs.
- **Observed** — it has actually been seen happening in the environment
  it is meant for.

Almost everything below is asserted. Very little is observed, and §6
says exactly where the line falls.

---

## 1. What a reader may not conclude from this audit

Stated first, not last, because it qualifies everything after it.

1. **Nothing here has touched a live `docker-mailserver`.** Every mail
   feature is proven against captured fixtures and fake drivers. No
   mailbox has been created, no Sieve script installed, no quota set, on
   a real mail server.
2. **No container image has been built.** The Dockerfiles have never been
   given to a Docker daemon. Their multi-stage structure, their pruning
   claims and their build-time assertions are reasoned and measured (§5.3)
   but not executed.
3. **No container has run.** The compose topology — the internal network,
   the dropped capabilities, the read-only root filesystems — is declared
   and statically checked, never observed.
4. **The installer has never installed anything.** It has been driven
   end-to-end against a stubbed `docker` binary (§5.2), which proves its
   logic and not its effect.
5. **No CI run has been observed.** `origin/main` is two commits behind
   this tree and no CI tooling is available in this environment
   (`gh` is not installed), so whether any workflow has ever executed is
   **unknown from here** — not "no". Nothing in the repository records a
   run.
6. **The nine deferred parser items remain open** (§2.2). They are the
   most likely place a real deployment diverges from this code.

What _is_ proven: the application's own logic, at 1,469 unit tests and 55
real-browser end-to-end tests, and that the server boots in production
configuration and answers healthy.

---

## 2. Functional audit

### 2.1 Feature status

`FEATURE_MATRIX.md`'s summary table is the checklist: 19 Full, 8 Partial,
7 Constrained, 0 unsupported whole features, 7 unsupported
sub-capabilities. Its status legend carries a scope note (added M16)
saying a status means an implemented capability, not one exercised
against a live mail server.

**Evidence.** Every feature area has module tests beside it
(`modules/<area>/*.test.ts`), and the twelve critical workflows have
Playwright coverage.

```
$ npm run check      # deps → audit → lint → format → typecheck → tests
  Tests  275 passed (275)   apps/broker
  Tests  897 passed (897)   apps/server
  Tests  224 passed (224)   apps/web
  Tests   73 passed  (73)   packages/shared
  exit 0                    # 1,469 total

$ npx playwright test
  55 passed
```

**Asserted, not observed:** that these features do what they claim
against docker-mailserver. See §1.1.

### 2.2 The nine deferred runtime-verification items — OPEN

`FEATURE_MATRIX.md`'s "Deferred to runtime verification" table lists nine
parsers written against a documented format rather than a captured
sample. **All nine remain open.** They are not closed by this audit and
must not be read as closed.

```
$ awk '/## Deferred to runtime verification/,0' FEATURE_MATRIX.md | grep -cE '^\| '
11        # 9 items + header + separator
```

| #   | Item                                           | Fallback if the real format differs     |
| --- | ---------------------------------------------- | --------------------------------------- |
| 1   | `doveadm pw` stdin behaviour                   | Primary path already avoids argv        |
| 2   | DKIM key path under `ENABLE_RSPAMD=1`          | Detected at runtime; `Unknown`          |
| 3   | Rspamd `/stat` exact field names               | Only confirmed fields render            |
| 4   | Exact `/var/mail-state` contents               | Whole volume backed up regardless       |
| 5   | `setup fail2ban status` output shape           | Raw output shown                        |
| 6   | ClamAV `VERSION` string format                 | Raw string shown                        |
| 7   | `socat` presence in the DMS image              | ClamAV reported `Unknown`               |
| 8   | `doveadm -f json quota get` key casing / units | `Unknown`, never a guessed number       |
| 9   | `postfix-{send,receive}-access.cf` line format | Standard `access(5)` parse, unconfirmed |

Each fallback is implemented and tested; what is unverified is which
branch a real deployment takes. `docs/troubleshooting.md` maps each to
the symptom an operator would actually see.

### 2.3 Refusals are real, not missing features

Seven sub-capabilities are deliberately absent, and the audit's job is to
confirm they refuse rather than silently no-op.

**Evidence.** `POST /api/v1/updates/apply` is a real route that always
refuses, names the missing Docker operation, and audits the refusal —
`apps/server/src/modules/updates/updates.routes.test.ts`. Container
create/remove and `exec.*` are absent from `BROKER_OPERATIONS`, asserted
by name in `packages/shared/src/broker.test.ts`'s vocabulary test.

---

## 3. Security audit

### 3.1 `SECURITY.md` Part 5 — ten checks

The traceability table in `SECURITY.md` Part 5 maps each check to its
test file. **Verified during this audit: every path that table cites
exists.** Two did not, and were corrected (§6.1).

| #   | Check                                    | Evidence                                                                                      | Status                      |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | Injection, every command builder         | `apps/broker/src/dms/command-injection.security.test.ts` — 52 tests, manifest vs real exports | Asserted                    |
| 2   | Path traversal, every file-touching path | `apps/server/src/security/path-traversal.security.test.ts`                                    | Asserted                    |
| 3   | Out-of-enum ops / container allowlist    | `apps/broker/src/app.test.ts`                                                                 | Asserted                    |
| 4   | No Docker socket in the web tier         | `eslint.config.js` ban + `apps/server/src/security/docker-socket-isolation.security.test.ts`  | Asserted                    |
| 5   | Cookie flags, revocation, lockout        | `apps/server/src/modules/auth/auth.routes.test.ts`, `auth.service.test.ts`                    | Asserted                    |
| 6   | Uniform login responses                  | same two files                                                                                | Asserted                    |
| 7   | Headers present; CSP not broken          | `apps/server/src/security/security-headers.security.test.ts` + `e2e/security/csp.spec.ts`     | **Observed** (real browser) |
| 8   | Log redaction                            | `apps/server/src/security/log-redaction.security.test.ts`                                     | Asserted                    |
| 9   | Authorization on every mutating route    | `apps/server/src/security/route-authorization.security.test.ts`                               | Asserted                    |
| 10  | `npm audit` + SBOM license gate          | `npm run check:audit` + `scripts/check-licenses.mjs` + `.github/workflows/security.yml`       | Partly observed — §5.1      |

Check 7 is the only one that is genuinely _observed_: a real Chromium
loads the real built bundle and the browser itself reports violations.

### 3.2 The architecture invariant

The property: full RCE in the web tier yields the broker's allowlist and
nothing more.

**Evidence, all mechanical:**

```
$ npx vitest run --root packages/shared broker
  ✓ BrokerRequestSchema — dangerous Docker fields are structurally impossible
```

- No `HostConfig`/`Binds`/`Mounts`/`Privileged`/`CapAdd`/`PidMode`/
  `NetworkMode` field parses on **any** of the 47 operations — poisoned
  input is fed through `BrokerRequestSchema.safeParse` and must be
  rejected.
- No `id`/`name`/`container` field either, with exactly one documented
  exemption (`volume.remove::name`), and the exemption set is itself
  pinned by an assertion.
- `apps/server` cannot import a Docker client: `eslint.config.js`
  `no-restricted-imports`, plus a runtime backstop suite.
- Since M16 the DMS half carries no argv, path or shell string; the
  broker builds every command line and owns every path
  (`apps/broker/src/dms/handlers.security.test.ts`).

### 3.3 Tautology sweep — the highest-value audit run here

A test that stands up its own copy of the thing under test, or asserts
against a constant it also produced, is worse than absent coverage: it
reports safety. M13 found one (the CSP spec comparing
`buildCspHeaderValue()` to a header a harness had set from
`buildCspHeaderValue()`). This audit swept for others.

**Method** — three scans over all 145 test/spec files:

1. an imported production symbol _called_ to build the expected value;
2. an imported production **constant** used as the expected value;
3. structurally identical expressions on both sides of an assertion.

**Results:** scan 3 found nothing. Scan 1 found 2 candidates, scan 2
found 10. Of those 12, **two were real** and both are fixed:

| Finding                                                                                                                                                                      | Verdict                  | Fix                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `broker.test.ts` — "one response schema per operation" compared `BROKER_RESPONSE_SCHEMAS` keys to `BROKER_OPERATIONS`, but M16 generates 26 of those keys from the same list | **Real, self-inflicted** | Test renamed to claim only the hand-written Docker half, plus a new case asserting what generation cannot: that the three DMS state reads do _not_ reuse the exec schema |
| `archive.test.ts` — `expect(f('mail')).toBe(f('mail'))`                                                                                                                      | **Real, weak**           | Replaced with an independently recomputed SHA-256 of the bytes; the old form passes for any constant-returning function                                                  |
| `csp.spec.ts` (M13's original finding)                                                                                                                                       | Already fixed            | Now compares the real server's header; re-confirmed still non-tautological                                                                                               |
| 8 constants used as expectations (`BROKER_OPS_PATH`, `PUBLIC_RESOLVERS`, …)                                                                                                  | Benign                   | The _actual_ side traverses a real execution path in every case; these prove wiring                                                                                      |
| 8 `*-test-harness.ts` files                                                                                                                                                  | Benign                   | All eight call the real `buildApp`; none reimplements production logic (`grep -c buildApp` → 8/8)                                                                        |

**A related finding, same family.** `docs/configuration.md` claimed
`.env.example` "is checked against the code's own schema, so it cannot
quietly drift". Nothing checked it. Rather than weaken the claim, the
check now exists: `apps/server/src/platform/config-env-example.test.ts`
compares `.env.example` against the union of both tiers' schema keys in
both directions. It found real drift on its first run (three broker-owned
variables) — which turned out to be correct, since one `.env` configures
both containers.

### 3.35 The intermittent "N passed, 2 did not run" — diagnosed and closed

Reported as a harness flake reproducible by chaining `npm run check` and
`npx playwright test` in one shell invocation. Reproduced here on the
first attempt, with the four E2E ports **verified free beforehand**.

**The offered hypothesis was that `reuseExistingServer` adopted a
leftover server. That is falsified for this failure**: nothing was
listening to adopt, and the error was not a lost connection.

The real cause is a strict-mode locator ambiguity in
`e2e/backup-and-restore.spec.ts`. `/maintenance/backups` renders a
"Create backup" button in the page header _and_, once the list query
resolves on an empty list, a second one in the first-run empty state
(deliberate — `domains-list-page.test.tsx` asserts the same duplication
for mailboxes). `DATA_DIR` is a fresh `mkdtemp` per run, so the list is
always empty; whether the click sees one button or two is a race with
that query, and `getByRole` is strict. Chaining after a full `check`
loads the machine enough to change which side wins.

The `2 did not run` is `test.describe.serial` semantics — the two later
tests in the block are skipped after a failure — not a truncated run.

**This one fails loudly and never passes falsely**, so unlike §3.3's
tautologies it was not producing false confidence. Fixed by asserting the
empty state first, making the DOM deterministic, then taking `.first()`
(the header button in either state). Three consecutive chained runs green
afterwards.

**A genuine latent hazard found while investigating it, and closed.**
`reuseExistingServer: !process.env.CI` did not cause the above, but it
would silently adopt a server left by a killed run — built from different
source — producing a green suite that never executed the code under test.
On ports used by nothing but this harness there is no case where adopting
is wanted, and `e2e/env.ts`'s own comment says fixed ports exist to make a
stuck process "a loud, obvious failure instead of a silent reuse of the
wrong server", which the setting quietly defeated. Now `false`
everywhere. Verified by occupying port 3900 with a decoy:

```
Error: http://127.0.0.1:3900/api/v1/health is already used, make sure that
nothing is running on the port/url or set reuseExistingServer:true …
exit 1
```

### 3.4 Dependency posture

```
$ npm run check:audit          # npm audit --omit=dev --audit-level=high
  exit 0
```

One known **moderate** advisory remains and is accepted: `dockerode` →
`uuid` (`GHSA-w5hq-g745-h8pq`, missing buffer bounds check in v3/v5/v6
when `buf` is provided). Fixing it requires a major `dockerode` bump in
the single most security-sensitive component in the project. The code
path is not reachable from this project's usage. **Open, tracked here.**

---

## 4. UX audit

### 4.1 Accessibility

```
$ npx playwright test --project=chromium-security
  ✓ accessibility — every nav-level route, authenticated (× 24 routes)
  ✓ keyboard-only completion of critical paths — login
  ✓ keyboard-only completion of critical paths — in-app navigation
```

axe-core against every nav-level route plus `/login`, zero
critical/serious violations, in a real browser against the real built
bundle. **Observed, not merely asserted.** M12 found and fixed three real
violations this way (a 4.41:1 contrast pairing, an invalid ARIA pattern,
a dialog with no viewport-height limit).

### 4.2 Honest-state rendering

The UX rule this project is built around is that a control ships only if
the backend can perform it, and an unknown renders as unknown.

**Evidence.** `Unknown` is grey and never yellow — a resolver failure
cannot render as `Invalid`
(`apps/web/src/components/status/status-badge.test.tsx`, and the DNS
state tests). The dashboard degrades per tile with a subsystem down
(`dashboard.routes.test.ts` forces the broker, a `DmsDriver` method and
ClamAV down independently; `dashboard-page.test.tsx` renders the result).
The command palette's route coverage is mechanical, not claimed
(`command-palette.route-coverage.test.ts` diffs against `App.tsx`).

### 4.3 Destructive operations

`SECURITY.md` §4.3's "a block, not a confirmation". Restore requires the
container stopped, a typed phrase, a pre-flight report, and either a
verified recent backup or an explicit acknowledgement; it is unavailable
on mobile. Mail-data deletion on account removal is a **required** field
with no default, asserted in both directions in
`apps/broker/src/dms/handlers.security.test.ts` and in the shared schema.
The uninstaller never removes a mail volume under any flag.

---

## 5. Licensing audit

### 5.1 The gate

```
$ node scripts/check-licenses.mjs
  Could not read SBOM at sbom.cdx.json: ENOENT …
  exit 2                                    # fails closed, does not pass
```

The gate **fails when it cannot run**, which is the property that
matters. It is not part of `npm run check` (no SBOM locally); it runs in
`.github/workflows/security.yml`, which generates the SBOM first:

```
.github/workflows/security.yml:101  npx @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json
.github/workflows/security.yml:108  node scripts/check-licenses.mjs sbom.cdx.json
```

`EXCEPTIONS` in the gate is **empty** — no component is excluded.

### 5.2 What actually ships

Computed during this audit over the real production tree:

```
$ npm ls --omit=dev --all           # 251 production packages
     1 0BSD              11 Apache-2.0      16 BSD-3-Clause
     4 BlueOak-1.0.0     26 ISC            189 MIT
     1 MIT AND ISC        2 OFL-1.1          1 Unlicense
```

Every one of these nine expressions is in the gate's `ALLOWED` set;
`MIT AND ISC` resolves through the gate's SPDX `AND` handling, both
operands allowed. **No shipped component is outside the allowlist.**

`OFL-1.1` is the two self-hosted typefaces, and both are credited in
`NOTICE` (Inter, JetBrains Mono) — confirmed against the two `.woff2`
files the build actually emits.

### 5.3 Both images' pruned trees

`docker/server/Dockerfile` claims no Docker client ships in the web tier;
`docker/broker/Dockerfile` claims no web-tier dependency ships in the
broker. Re-measured **after** M16 moved code between workspaces:

```
# apps/broker dropped from the workspace tree, then prune --omit=dev --dry-run
  2 packages removable: dockerode, docker-modem        → absent from the server image
# apps/server + apps/web dropped, then the same
  5 packages removable: react, @node-rs/argon2, tar, undici (×2)
                                                        → absent from the broker image
```

Both Dockerfiles additionally assert this at **build** time and fail the
build if the dependency reappears. **Asserted and measured; not observed**
— no image has been built (§1.2).

### 5.4 `LICENSE_AUDIT.md` currency

§5's inventory lists candidates evaluated _pre-adoption_, several of which
were never adopted (`better-sqlite3`, `drizzle-orm`, `kysely`, `argon2`,
`tar-fs`, `@fastify/websocket`). The document says so itself — "every row
is the _proposed_ stack, audited pre-adoption" — so it is accurate as a
decision record. **The manifest of record is the SBOM**, not that table.
No change required; recorded so a reader does not mistake one for the
other.

---

## 6. Production audit

### 6.1 Documentation accuracy

Every file path cited in every root and `docs/` markdown file was checked
for existence:

```
$ python3 …   # extract `path.ext` citations, test existence
checked 100 cited paths across 19 documents
```

Three were stale and are fixed:

| Document             | Stale citation                                                                       | Cause                                    |
| -------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `SECURITY.md`        | `apps/server/src/{drivers/dms/commands,security/command-injection.security}.test.ts` | Both moved to `apps/broker` in M16       |
| `UX_ARCHITECTURE.md` | `docker/operations.ts`                                                               | Typo for `apps/broker/src/operations.ts` |
| `docs/README.md`     | "the current blocking limitation"                                                    | M14 wording, fixed in M16                |

Re-running that scan today still reports five hits, all deliberate: two
in `CHANGELOG.md` (`e2e/security/static-proxy-server.mjs`, removed in
M13, and a shorthand `platform/sse.ts` that exists at
`apps/server/src/platform/sse.ts`) are **correct history** — a changelog
describes the state at the time — and three in this file are the stale
paths quoted in the table above, which have to appear here to be
discussed. The scan is a drift detector, not a gate; its output needs
reading rather than obeying.

### 6.2 M14 documentation re-audited against the post-M16 product

M14's operator documentation was written throughout against a product
that could not boot. M16 corrected the five places that said so; this
audit swept the rest for claims _shaped_ by that assumption.

Found and fixed: `docs/README.md`'s index entry (above), and the
unsupported `.env.example` claim (§3.3). Also corrected: both `README.md`
and `docs/docker.md` asserted the installer workflow "has not yet run" —
an unsupportable claim, since no CI tooling is available here. Both now
say **no run has been observed**, which is what is true.

### 6.3 The installer

Never executed against a real Docker daemon. Driven end-to-end against a
stubbed `docker` binary during M13, covering: fresh install; re-install
preserving hand-edited settings and unmanaged keys; `--purge` removing
volumes and `.env`; a second `--purge` with no `.env` present; and a
post-purge install coming back genuinely fresh.

```
$ npx shellcheck --shell=sh installer/install.sh installer/uninstall.sh
  (no output)   exit 0
```

`.github/workflows/installer.yml` is where the real cycle is asserted —
three install → healthy → uninstall passes, the privilege boundary
against live containers, the same-origin SPA topology, and the
hand-edited-`.env` idempotency case. **No run observed** (§1.5).

### 6.4 The server boots

The M14 blocking defect, closed in M16, re-verified during this audit:

```
$ APP_MODE=production … node apps/server/dist/index.js
  "DMS driver: RealDmsDriver (over the broker)"
$ curl -fsS http://127.0.0.1:PORT/api/v1/health
  {"status":"ok","version":"0.1.0","uptime":1.07}
```

Also asserted in the suite, with no driver override, by
`apps/server/src/production-boot.test.ts`.

---

## 7. Open items after this audit

Nothing below is fixed by this audit. This is the honest backlog.

| #   | Item                                                                          | Where it is recorded                           |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | The nine deferred parser verifications                                        | `FEATURE_MATRIX.md`, §2.2                      |
| 2   | No live `docker-mailserver` integration has ever run                          | §1.1, `docs/docker.md` §6                      |
| 3   | No image built, no container run                                              | §1.2, §1.3                                     |
| 4   | No observed CI run of any workflow                                            | §1.5, §6.3                                     |
| 5   | `dockerode` → `uuid` moderate advisory, accepted                              | §3.4                                           |
| 6   | Mail queue is read-only; `postqueue -f`/`postsuper` not wired                 | `FEATURE_MATRIX.md`, `UX_ARCHITECTURE.md` §5.2 |
| 7   | No `system.events` broker operation; `/docker/events` deliberately absent     | `UX_ARCHITECTURE.md` §5.2                      |
| 8   | Non-Linux hosts unsupported and untested                                      | `docs/docker.md` §6                            |
| 9   | No published image, no release artifacts, no checksum-verified remote install | `docs/docker.md` §2                            |

Item 4 is the cheapest to close and unblocks 3: a single push runs the
Docker and Installer workflows, and their output would move most of §1
from _asserted_ to _observed_.
