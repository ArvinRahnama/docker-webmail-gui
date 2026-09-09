# Design: panel self-update

**Status:** Built (SU-A through SU-G, 2026-09-09). Every section below is written in the original proposal's voice, as approved; each numbered decision in §9 now carries a **Resolved** note recording what was actually chosen and built, and §10 consolidates the full deferred backlog. See `FEATURE_MATRIX.md` §31b for the user-facing capability summary.
**Scope:** The panel (`dwg-server` + `dwg-broker`) recreating _itself_ onto a newer published version. **Not** `docker-mailserver` updates — see [§0](#0-scope-correction-two-different-things-currently-share-one-page) below, which is the first thing this doc needs to fix in the brief it was given.

---

## 0. Scope correction: two different things currently share one page

The task that produced this doc described the goal as "replace the always-refuse Updates behavior with real in-panel self-update (the panel upgrades its own containers)." Before proposing a mechanism, one fact has to be stated plainly because it changes the shape of everything below:

**`/maintenance/updates` today is entirely about `docker-mailserver`, not the panel.** `UpdatesService.getStatus()` (`apps/server/src/modules/updates/updates.service.ts`) calls `this.broker.containerInspect()` — which resolves the _managed mail container_ (`DMS_CONTAINER_NAME`/`_LABEL`) — reads its image digest, and compares it against the registry. `RELEASE_NOTES_URL` points at `github.com/docker-mailserver/docker-mailserver/releases`. `applyRefused()` refuses to recreate that same mail container. Nothing on the page today ever looks at `dwg-server`'s or `dwg-broker`'s own version.

"The panel upgrades its own containers" is a **different pair of containers, a different version source, and a different risk profile** from what this page currently shows. Recreating `dwg-server`/`dwg-broker` (stateless application containers, config in named volumes, easy to roll back) is a fundamentally different operation from recreating the mail container (live mail data, the actual product this panel manages). This design is scoped **only** to the panel's own two containers. It leaves the mail-server comparison and its refusal completely untouched — that refusal has independent, still-valid reasoning (§22/§31 of `FEATURE_MATRIX.md`) that nothing here revisits.

Proposal: keep `/maintenance/updates` as the page, but it grows a **second, separate card**: "docker-mailserver" (unchanged, still a real comparison, still refuses to apply) and "Panel" (new, this design). They share nothing but the page — different service, different service class, different version source, different mutation. This is an open decision for the owner (§9.3).

---

## 1. Self-recreation mechanism

### The core problem

A container cannot cleanly recreate itself. `docker stop <self>` from inside the container being stopped kills the process issuing the next commands (`rm`, `create`, `start`) before they run. This applies to `dwg-broker` specifically, since `dwg-broker` is the only container holding the Docker socket and therefore the only thing that can _issue_ a recreate at all.

It does **not** apply to `dwg-server`: `dwg-broker` recreating `dwg-server` is an ordinary operation from `dwg-broker`'s point of view — `dwg-broker`'s own process is untouched by tearing down a _different_ container. The HTTP request `dwg-server` made to trigger this is expected to be dropped (exactly the existing `panel.restart` contract — see `server-controls.tsx`'s `doRestartPanel` — the caller doesn't wait on that response, it polls `/api/v1/health` afterward). So `dwg-broker` can perform "stop → remove → create → start → poll health" for `dwg-server` **synchronously, in its own HTTP handler**, no different in shape from `handlePanelRestart` today, just with create/remove added to the sequence.

Only the _last_ step — `dwg-broker` recreating `dwg-broker` — needs a hand-off to something outside `dwg-broker`'s own process.

### Proposed mechanism: a detached one-shot updater, launched by the broker

`dwg-broker` launches a **second, short-lived container** — the _updater_ — that:

1. Has the Docker socket bind-mounted (the same one bind `dwg-broker` itself has — nothing wider).
2. Runs the **broker's own image**, at whatever version is _currently_ running (not the new one — there's nothing to pull yet when it's launched), with an alternate command (`node apps/broker/dist/updater.js` instead of `apps/broker/dist/index.js`). This publishes **zero new images**: the updater logic ships inside the broker image as an alternate entrypoint, built and versioned together, never out of sync with the broker code that launches it.
3. Is handed everything it needs as **environment variables set by `dwg-broker` at launch, from its own config** — never from the web tier (see §2): the two target image references, the two container names, and a bounded timeout.
4. Runs detached (`docker run -d`, i.e. created and started, not attached) — its lifetime is independent of the container that launched it, so it survives `dwg-broker` tearing itself down partway through its own run.

Sequence the updater executes, entirely through the Docker socket:

```
1. Pull dwg-server's target image.
2. Pull dwg-broker's target image.
   (Nothing is touched yet. Either pull failing aborts here — clean no-op.)
3. Inspect the CURRENT dwg-server container; capture its full spec
   (HostConfig, Env, Mounts, Networks, Labels) verbatim. This is
   dwg-server's rollback plan.
4. Inspect the CURRENT dwg-broker container; capture its spec the same
   way. This is dwg-broker's rollback plan.
   (Both captured up front, before any teardown — see §4 on why.)
5. Stop + remove dwg-server (old). Create + start dwg-server using the
   captured spec with only Image swapped to the new digest. Poll
   `docker inspect` for `.State.Health.Status === "healthy"`, bounded.
     - Fails/times out -> recreate dwg-server from its rollback plan
       (old image, old spec), write FAILED status, exit non-zero.
6. Stop + remove dwg-broker (old — this is the updater's own launcher;
   the updater itself is a separate container, so it is unaffected).
   Create + start dwg-broker the same way. Poll health (the container's
   own TCP healthcheck), bounded.
     - Fails/times out -> roll BOTH containers back to their captured
       specs/images (not just broker — see §4), write FAILED status,
       exit non-zero.
7. Both healthy -> write SUCCESS status, exit 0.
```

`dwg-broker`'s own role in this is small: validate the request, resolve the two image references and container names from its own config, launch the updater, write an audit event, and return. It does not wait for the updater — it can't, since it is about to be one of the things replaced.

### Why a detached container and not, say, a host script

`dwg-broker` has no way to run anything on the _host_ — its whole world is the Docker socket. A container is the only unit of "process that outlives me" the socket can create. This is the same reasoning `panel.restart` already established for restarting `dwg-server`, extended one step further because this time the _broker itself_ is a target too.

### Why not `docker compose` CLI against the original `compose.yaml`

Rejected. It would need (a) the `docker compose` binary in the image, and (b) a bind-mount of the host's `compose.yaml` **and `.env`** into the broker/updater so it can resolve the project. `.env` holds `RSPAMD_PASSWORD`, `COOKIE_SECRET`, `BOOTSTRAP_ADMIN_PASSWORD`, etc. — secrets `dwg-broker` does not read today (`compose.yaml`'s `broker:` service lists only the handful of vars it actually needs, explicitly, not the whole file). Mounting the full `.env` to run a CLI would be a real, avoidable expansion of what the privileged tier can read. "Clone the currently-running container's own already-deployed spec via `docker inspect`" gets the identical result (every env var, mount, network, resource limit the operator already has running) with **no new mount and no new binary** — the spec source is Docker's own state, not a second copy of the config on disk that could drift from what is actually running.

### Registry access from an `internal: true` network

`dwg-broker`'s network is `internal: true` — no route to or from the internet (`docker/compose.yaml`). This does **not** block image pulls: a pull issued over the Docker socket is performed by the **daemon**, using the _host's_ networking, not the calling container's network namespace. This is true of every Docker API call today (`container.restart` doesn't need `dwg-broker` to have network reachability to anything either) and pulling is no different in kind — it's the first operation that happens to need the _daemon_ to reach the internet, which it already can (the host does). `dwg-broker`'s own isolation is unaffected and unweakened by this feature.

---

## 2. Broker named operations

Two new operations, following the exact shape `panel.restart` already established (`packages/shared/src/broker.ts`, `apps/broker/src/operations.ts`, `apps/broker/src/container-resolver.ts`):

```ts
'panel.selfUpdateCheck'; // read-only: is a self-update currently possible + what would it target
'panel.selfUpdateApply'; // the mutation: launches the updater
```

**Request shapes — deliberately minimal, no passthrough:**

```ts
PanelSelfUpdateCheckRequestSchema = z
  .object({ operation: z.literal('panel.selfUpdateCheck') })
  .strict();
// zero parameters — mirrors image.prune / panel.restart's "means exactly one thing"

PanelSelfUpdateApplyRequestSchema = z
  .object({
    operation: z.literal('panel.selfUpdateApply'),
    targetVersion: z.string().regex(/^\d+\.\d+\.\d+$/), // strict semver, nothing else
  })
  .strict();
```

`targetVersion` is the **only** thing the web tier ever supplies, and it is a bare version string — not an image reference, not a registry host, not a repo name. `dwg-broker` composes the two full image references itself:

```ts
const serverImage = `ghcr.io/arvinrahnama/docker-webmail-gui-server:${targetVersion}`;
const brokerImage = `ghcr.io/arvinrahnama/docker-webmail-gui-broker:${targetVersion}`;
```

The repo prefixes are **constants in broker source**, never configuration and never client input — the same way `panel.restart` never accepts a container id, only ever resolving `PANEL_SERVER_CONTAINER_NAME`/`_LABEL` from its own environment. There is no field anywhere in either schema that could carry a tag with a `@sha256:` override, a different registry host, a different repo, a `Binds` array, or any `HostConfig` key — the same guarantee `packages/shared/src/broker.test.ts` already proves by construction for every other operation, and the same test gets these two added to its poison-every-field sweep.

**The container-recreation capability this needs, scoped as narrowly as `panel.restart` scoped `container.restart`:**

- `dwg-broker` gains internal (not web-tier-facing) `createContainer`/`removeContainer`/`pullImage` methods on `DockerApi` (`apps/broker/src/docker-types.ts`) — these do not exist today at all; there is currently no create/remove/pull anywhere in the driver, by design (`updates.service.ts`'s own header: _"neither `container.create` nor `container.remove` exists in `BROKER_OPERATIONS`... withholding `POST /containers/create`... is the reason the broker exists"_).
- These new driver methods are used **exclusively** by the two handlers above and the updater script — never exposed as a general operation, never reachable with a caller-supplied spec. `container.create`/`container.remove` remain **permanently absent** from `BROKER_OPERATIONS` (§22/§24/§31 of `FEATURE_MATRIX.md` do not change: there is still no way for the web tier, or any client of the broker HTTP API, to submit a `HostConfig`, a bind mount, `Privileged`, or an arbitrary image reference).
- The container spec used for every create call is never invented — it is always `docker inspect`'s own output for the container being replaced, with only `Image` swapped. The updater does not construct a spec from scratch at any point.

**Response shapes:**

```ts
PanelSelfUpdateCheckResponseSchema = z.object({
  currentVersion: z.string(), // resolved from dwg-server's own running image tag
  updatePossible: z.boolean(), // false if e.g. this install is DWG_IMAGE_MODE=build (see §9.6)
  reason: z.string().nullable(), // present when updatePossible is false
});

PanelSelfUpdateApplyResponseSchema = z.object({ started: z.literal(true) });
// the updater's real outcome is never known synchronously — see §6
```

**`handlePanelSelfUpdateApply`'s guard, generalizing `handlePanelRestart`'s existing broker-self guard:** resolve `panelServer`/`panelBroker` identities exactly as `panel.restart` does, and additionally refuse if either resolves to the _mail_ container's identity (`deps.dms`) — defense in depth against a configuration error that pointed `PANEL_SERVER_CONTAINER_NAME`/`PANEL_BROKER_CONTAINER_NAME` at the wrong container, even though no legitimate configuration could produce that today. Same fail-closed shape as the existing check, one more identity compared.

---

## 3. Version source

**How `updateAvailable` is computed today (for docker-mailserver, unchanged by this design):** `UpdatesService.getStatus()` inspects the _running_ mail container's image digest, takes its first repo tag (e.g. `ghcr.io/docker-mailserver/docker-mailserver:latest`), and asks `RegistryClientPort.resolveTagDigest(reference)` — "what digest does the registry currently serve for _this exact tag_" — comparing that digest against what's running. This only detects drift on a **floating** tag (`:latest`); it has no concept of "list available versions," because docker-mailserver is tracked by a floating tag, not pinned releases.

**Panel self-update needs a different question: "what is the newest published _version_," not "did this floating tag move."** `docker-webmail-gui` is versioned with pinned semver tags (`git tag v0.1.0`/`v0.2.0`/`v0.3.0`, `DWG_VERSION` in `.env`, matching `docker-webmail-gui-server:0.1.0` etc. — `docker/compose.yaml`'s own convention). The natural source of truth is the project's own GitHub Releases, the same record `CHANGELOG.md` already keeps in lockstep with:

```
GET https://api.github.com/repos/ArvinRahnama/docker-webmail-gui/releases/latest
-> { tag_name: "v0.4.0", ... }
```

Proposed: a new port, `SelfUpdateReleaseSourcePort` (mirrors `RegistryClientPort`'s interface+real+fake shape, `apps/server/src/drivers/registry/`), with one method:

```ts
resolveLatestRelease(): Promise<{ version: string; publishedAt: string } | null>
// null (never throws) on any network failure, 404, or unparseable
// response — the same "Unknown, not Invalid" discipline every other
// driver in this codebase already follows.
```

`currentVersion` comes from the running `dwg-server` image's own tag (already visible to the server process — either read from its own container inspect via `dwg-broker`, or simplest: baked into the image at build time as a file/env var `DWG_VERSION`, which `docker/server/Dockerfile` already has available as a build arg pattern to extend). Comparing `currentVersion` against `resolveLatestRelease()`'s version is the entire "is an update available" check — no registry digest comparison needed at all for this half, since versions are pinned tags, not a moving `:latest`.

**Target tag: latest vs. owner-selected — open decision, see §9.1.** The schema in §2 already supports either: `targetVersion` is a free (regex-validated) string the _server_ decides what to populate with — either always the resolved-latest version (auto-latest, admin only confirms), or a version the admin typed after seeing a list of releases (pick-a-version). Nothing broker-side changes between those two policies; only what the web tier sends as `targetVersion` differs.

---

## 4. Health check + rollback

**"Healthy" criterion, precisely:** after `docker create`+`start`, poll `docker inspect <new container id>` and read `.State.Health.Status`. Both images already ship a Docker-native `HEALTHCHECK` (`docker/server/Dockerfile`'s `fetch('.../api/v1/health')`, `docker/broker/Dockerfile`'s TCP connect) — reusing Docker's own healthcheck state means the updater does not need its own HTTP client or network attachment to either container; it only ever talks to the socket. Poll interval matches the images' own `interval: 30s`; bounded by a timeout constant — proposed **90 seconds**, reusing the exact value `server-controls.tsx`'s `RECONNECT_TIMEOUT_MS` already uses for `panel.restart`, so the two "how long do we wait for the panel to come back" numbers in this codebase stay one number, not two that could drift. `healthy` = success; `unhealthy` or timeout = trigger rollback for that step.

**What must be captured to roll back, and when:** both containers' full specs and image references, captured by `docker inspect` **before either is touched** (step 3–4 in §1's sequence, not lazily as each is about to be replaced). This ordering matters: if capture happened lazily, a failure while recreating `dwg-broker` (after `dwg-server` already succeeded) would have no captured `dwg-server` rollback plan left to use, because the _running_ container by then is already the new one — inspecting at that point would capture the new spec, not the old one. Capturing both up front means the rollback plan is always "what was running when this update started," regardless of which step fails.

**Rollback scope: whole-update, not per-container.** If `dwg-broker`'s recreate fails after `dwg-server`'s already succeeded, the design rolls back **both** to their pre-update state — never leaves a new-server/old-broker (or the reverse) pair running. The two are versioned and released together (`docker/compose.yaml`'s "digest-pinned... one image, two Dockerfiles, so it is never possible for the two tiers to silently drift" already states this as a project-wide invariant for build parity); leaving them mismatched after a failed update would violate that same invariant at runtime.

**Where the outcome is recorded, given nothing survives to report it synchronously (see §6):** the updater writes a small status file to the `server-data` named volume (`docker/compose.yaml`'s existing `server-data:/app/data` mount on `dwg-server` — the updater gets the **same** volume added to its own container spec, nothing new to provision) — e.g. `/app/data/self-update-result.json`: `{ outcome: 'success' | 'rolled-back' | 'failed', fromVersion, toVersion, failedAt, reason }`. The new (or rolled-back) `dwg-server` process reads this on the next request to a small new endpoint and clears it after the admin has seen it once.

**Crash-of-the-updater-itself is a real gap, not hand-waved:** if the updater process dies mid-sequence (host reboot, OOM-kill), nothing rolls anything back and no status file is written. This is an explicit open question for the owner (§9.7), not solved by this design as written — the honest options are (a) accept it as a rare, manually-recoverable case (the captured rollback-plan JSON, if also written to the status file _before_ step 5 begins, is enough for a human with `docker` CLI access to finish the job by hand), or (b) build a "was an update left in progress" check into `dwg-broker`'s own startup that can resume or force-rollback from that same file. Proposing (a) for a first version — write the rollback plan to the status file immediately after capture, before any teardown, so worst case is a documented manual recovery path, not silence.

---

## 5. The mailserver must be untouched

Guaranteed the same way `panel.restart` already guarantees it, extended with one more check:

1. **Only `panelServer`/`panelBroker` identities are ever resolved** by the new handlers — the same two config values (`PANEL_SERVER_CONTAINER_NAME`/`_LABEL`, `PANEL_BROKER_CONTAINER_NAME`/`_LABEL`) `panel.restart` already resolves, via the same `resolveContainerByIdentity`/`selectSingleMatch` (`container-resolver.ts`) that fails closed on zero or multiple matches. `dms` (the mail container identity) is never in the resolution path for these operations at all — not filtered out, structurally absent from the code path.
2. **New guard (§2):** additionally refuse if either resolved identity also matches `deps.dms` — the same shape as the existing broker-self guard in `handlePanelRestart`, one more comparison.
3. **The updater is handed exactly two container names and two image references at launch** (env vars set by `dwg-broker`, §1) — it has no code path that reads `DMS_CONTAINER_NAME` at all, so there is no field it could misuse even if the guard above were somehow bypassed. This mirrors `console.exec`'s "the broker owns the argv, the client sends a symbolic key" discipline: the updater is handed a closed, two-item worklist, not a general "which containers" capability.
4. **Test:** a broker-level test (mirroring `apps/broker/src/app.test.ts`'s existing container-allowlist suite) asserts `panel.selfUpdateApply` refuses when `PANEL_SERVER_CONTAINER_NAME`/`PANEL_BROKER_CONTAINER_NAME` is misconfigured to resolve to the fake DMS container, and a fake-`DockerApi`-level test asserts the updater's pull/create/remove calls only ever reference the two panel image repos and the two panel container names, never anything DMS-shaped, across every branch (success, server-health-fail, broker-health-fail).

---

## 6. Progress / feedback

Two phases, reusing two different **existing** mechanisms rather than inventing a third:

**Phase A — "prepare" (survivable; `dwg-server` is still running and can track it).** A new `JOB_TYPES` entry, `'panel.selfUpdate'`, run through the existing `JobRunner` exactly like `backup.upload` (`apps/server/src/platform/jobs/job-runner.ts`), streamed to the browser over the existing `/api/v1/jobs/:id/stream` SSE endpoint the Updates page already has access to (`use-maintenance-queries.ts`'s job hooks). The job's `execute()`:

1. Calls `panel.selfUpdateCheck` (validates the target is real, resolves current version).
2. Calls a synchronous "pull" step per image (two `ctx.log()`-tracked steps: "Pulling dwg-server image", "Pulling dwg-broker image" — ordinary job progress, not byte-level streaming; nothing this codebase's broker protocol does today streams a response, and inventing that shape for one feature is more machinery than the UI needs).
3. Calls `panel.selfUpdateApply` — this **launches the updater and returns almost immediately**. This is the point of no return: `ctx.log('Recreating panel containers — this connection will drop shortly.')`, then the call returns, and moments later `dwg-server` itself is torn down.

**The job's own terminal DB state is not trustworthy for phase B, and that has to be stated plainly rather than glossed over.** The database lives on the same `server-data` volume the new `dwg-server` reopens, so the job row `panel.selfUpdate` was writing to survives — but nothing ever gets to mark it `succeeded`, because the process that would do so is deliberately killed first. The **existing** `recoverInterruptedJobs()` (`job-runner.ts`) will find it `running` at the new process's next startup and mark it `failed: interrupted by a server restart` — technically correct (it _was_ interrupted), but misleading as a **verdict** on a self-update that may have completely succeeded. Proposed handling: the Updates page never reads this job's terminal status as the verdict. It's shown only during phase A for progress; once the connection drops, the page switches to phase B and the verdict comes from the status file (§4), not the job row.

**Phase B — "recreate" (not survivable; reuse `panel.restart`'s existing reconnect pattern, extended).** `server-controls.tsx`'s `doRestartPanel` already implements exactly this shape for a plain restart: show a blocking "reconnecting" overlay, poll `/api/v1/health` on a bounded timeout (`RECONNECT_TIMEOUT_MS`), and surface a structured refusal directly if one arrives instead of polling on it. Reused here almost unchanged, with two extensions: (a) the health poll must succeed _and_ the reported version must equal the target version — a health-only check can't distinguish "the new version came up" from "a rollback silently restored the old one and it's healthy too" — and (b) once reconnected, fetch the new small endpoint (§4) for the real outcome (`success` / `rolled-back` / `failed`) and show it as the terminal toast, not a generic "The panel is back online."

---

## 7. Security

- **Admin-only, same gate every maintenance route already has:** `requirePermission('maintenance:manage')` on both new server routes (`updates.routes.ts`), matching backups/config/updates today. There is only one admin role in this codebase (`ADMIN_ROLES = ['administrator']`) so this is the same bar every other mutating maintenance action clears.
- **Tier, deliberately reconsidered rather than reused from the current page:** the _current_ "Apply update" confirm dialog was just downgraded from tier 3 to tier 2 (task #15 part 1) specifically because that action was guaranteed to be refused server-side and had nothing destructive to gate. **That reasoning does not carry over here.** A real self-update can genuinely fail and (worst case, §4's crash gap) leave the panel unreachable. This should be **Tier 4** — type-to-confirm plus the same backup-gate pattern restore already uses (`ConfirmDialogBackupStatus`), since an admin about to risk the panel's own availability should see the same "is there a recent verified backup" fact restore shows, even though this operation doesn't touch mail data itself — the honest reason is "if this goes wrong and you need to intervene by hand, you'll want everything else in a known-good state," not "this touches mail data."
- **Every step audited**, extending the existing `update.apply_refused` audit action (`updates.routes.ts`) with real outcomes: `update.self_update_started`, `update.self_update_succeeded`, `update.self_update_rolled_back`, `update.self_update_failed` — recorded by `dwg-server` when it discovers the outcome (§4/§6), since the updater itself has no access to the audit DB (it only holds the Docker socket, on purpose — giving it DB write access would be new, avoidable privilege).
- **Only `dwg-broker` (and the updater it launches, which only exists as `dwg-broker`'s own delegate) ever touches Docker.** `dwg-server` still holds no socket, no Docker vocabulary, and still cannot express a container spec — it sends a version string and receives a job id / status back, the same shape every other mutation in this codebase already has.
- **No secrets newly exposed:** the updater's env is limited to the two image references, two container names, and a timeout (§1) — no admin session data, no cookie/broker secrets beyond what `dwg-broker`'s own recreated env already legitimately carries forward (unchanged from what it has today, since the captured spec is cloned, not reconstructed).

---

## 8. Test strategy against fakes

- **`DockerApi`'s fake** (the same fake-driver pattern every other broker capability uses) gains `pullImage`/`createContainer`/`removeContainer` as pure in-memory state transitions — a fake image registry (name+tag -> a synthetic digest) and a fake container table healthchecks can be scripted against (`setHealthy(id, boolean)` for a test to control). No real daemon, no real network.
- **The updater's state machine is a plain, dependency-injected module** (`DockerApi`, an injectable clock exactly like `BackupUploaderDeps.now`, and the target config) — not "a script tested by literally spawning it as a container." This makes every branch unit-testable the same way `handlePanelRestart` is tested today: success path; pull-fails-abort; server-health-fails-rollback-server-only; broker-health-fails-rollback-both; asserting the exact sequence of Docker calls (stop/remove/create/start order, and that rollback recreates with the _captured_ old spec, not a re-derived one).
- **Broker-level tests** (mirroring `apps/broker/src/app.test.ts`) cover the two new operations' request-schema rejection (poisoned fields — `HostConfig`, `Binds`, `Privileged`, an arbitrary `image` field — all rejected the same way `broker.test.ts` already proves for every other operation) and the DMS-identity guard from §5.
- **Server-level tests** cover the job (`panel.selfUpdate`)'s phase-A behavior against a fake `BrokerClient`, the version-source port's fake (`SelfUpdateReleaseSourcePort`, mirroring `fake-registry-client.ts`), and — importantly — a test that a stale `running` `panel.selfUpdate` job row (simulating "the process died mid-update," seeded directly into a fresh in-memory DB) does **not** get shown as a failure verdict once `recoverInterruptedJobs()` marks it interrupted; the page must fall back to the status-file check.
- **What fakes genuinely cannot prove, stated rather than skipped:** that a real `docker create` with a spec cloned from a real `docker inspect` actually reproduces a working container (volumes mount correctly, networks attach correctly, the healthcheck genuinely reflects the new process). That needs a real daemon. Proposed: a new CI job, in the same spirit as the installer's existing "install → healthy → uninstall, twice" cycle (`IMPLEMENTATION_PLAN.md` M13 exit criterion) — bring up the real stack in a CI runner, build a second image tagged as a "newer" version, trigger self-update against it for real, and assert the containers actually swap and come back healthy. This is CI's job, never local/fake, and never the production VPS — consistent with every other "needs a real daemon" gap this codebase already defers to CI (`AGENT_BRIEF.md` §6).

---

## 9. Open decisions for the owner

1. **Auto-latest vs. pick-a-version.** Does "Apply update" always target the newest GitHub release with just a confirm, or can the admin choose an older/specific version (e.g. to intentionally hold back, or catch up gradually across intermediate versions)? Affects the UI (one button vs. a version list) and whether "skip a version" is ever valid.

   **Resolved:** auto-latest. The server resolves the newest published release (`SelfUpdateReleaseSourcePort.resolveLatestRelease()`) and that is the only version `POST /api/v1/updates/panel/apply` can ever target (`PanelSelfUpdateService.apply()`, SU-C) — the admin confirms, never chooses (SU-D's `panel-update-card.tsx`, Tier 4 confirm dialog). No version list, no "skip a version" concept; the owner settled this before build started.

2. **Confirm the release-tracking convention.** This design assumes every tagged release (`v0.1.0`, `v0.2.0`, ...) has a matching pinned GHCR tag for both images, and that GitHub Releases is the right source for "latest." Needs the owner to confirm that's the actual publish process (is there also a floating `:latest` GHCR tag today? Should there be?).

   **Confirmed, unchanged from what this section assumed.** `RealSelfUpdateReleaseSource` reads the project's own GitHub Releases; `.github/workflows/release.yml` publishes the exact version tag, its minor-only alias, and `latest` for both images, matching every release. SU-E additionally baked the same version into each image at build time (`DWG_VERSION`), so `panel.selfUpdateCheck`'s reported `currentVersion` no longer even depends on this release-to-tag convention holding at compare-time — only at publish-time, which `release.yml`'s own build-args now enforce mechanically rather than by convention alone.

3. **Does the docker-mailserver comparison stay on this page, unchanged, as a second card (§0)?** Or should it move elsewhere, or be removed now that "Updates" gains a real meaning for the panel? This is a product-scope call, not an engineering one.

   **Resolved:** stays, unchanged, as a second card. `/maintenance/updates` now shows two fully independent cards — "docker-mailserver" (§0, exactly as before, still a real comparison, still refuses to apply) and "Panel" (SU-D, `panel-update-card.tsx`) — sharing nothing but the route.

4. **Rollback policy scope.** This design only proposes _automatic_ rollback on a failed health check during apply. Is a _manual_ "roll back to the previous version" button (independent of a failed apply, e.g. "I updated successfully but want to revert anyway") in scope for this effort, or later?

   **Resolved:** automatic-only in v1. A failed health check during apply is the only trigger for rollback, exactly as originally proposed; a manual "roll back to a previous version" button independent of a failed apply was explicitly chosen for **later** by the owner — recorded as a deferred item, §10.

5. **Concurrency / maintenance window.** Should self-update refuse to start while a backup/restore job is in flight (a restore needs the container running throughout; an update-triggered outage mid-restore would compound two risky operations)? Should it require an explicit "no other jobs running" precondition, enforced where?

   **Resolved:** yes, refuses outright, enforced server-side. `PanelSelfUpdateService.apply()` (`apps/server/src/modules/updates/panel-self-update.service.ts`) checks `JobsRepository.listActive()` for any job whose type starts with `backup.` before ever enqueuing the self-update job, and refuses with `CONFLICT` if one is in flight — before anything is enqueued, not a UI-level check alone (SU-C).

6. **One published image (broker, reused) vs. a dedicated updater image.** §1 proposes reusing `dwg-broker`'s own image with an alternate command — no new image to publish, always version-locked to the broker code that launches it. The alternative (a separate `docker-webmail-gui-updater` image) is more narrowly auditable in isolation but adds a third image to build, sign, and keep in lockstep. Needs a call.

   **Resolved:** the reused-broker-image approach, exactly as proposed. The updater is `apps/broker/dist/self-update/updater-entrypoint.js`, an alternate command inside the broker's own already-running image, launched via `launch-updater.ts` (SU-B). No third image was ever built or published.

7. **The updater-crash gap (§4).** Accept "rollback plan written to the status file before any teardown, worst case is documented manual recovery" as sufficient for a first version, or require `dwg-broker` to detect and resume/force-rollback an incomplete update on its own next startup?

   **Resolved:** option (a), accepted for v1. The rollback plan (both containers' captured recreate specs) is written to the status file immediately after capture, before any teardown begins (`updater.ts`'s `'in-progress'`-phase write, SU-B/SU-C) — a crash from that point on leaves a documented, by-hand-recoverable record behind, never silence. `dwg-broker` does not detect or resume an interrupted update on its own next startup; that automatic-resume path remains a deferred item, §10.

8. **`DWG_IMAGE_MODE=build` installs.** An install built from source rather than pulled (`docker/compose.yaml`'s own dual `build:`/`image:` support) has no registry image matching what's running, so "pull the target version" doesn't apply the same way. Should self-update simply refuse for these installs (`panel.selfUpdateCheck`'s `updatePossible: false`), and if so, how does the panel know at runtime which mode it was installed under — that signal doesn't exist today and would need to be added (e.g. baked into the image at build time vs. pulled from a registry).

   **Resolved (SU-E):** yes, refuse, and the signal is now baked at build time. `docker/server/Dockerfile` and `docker/broker/Dockerfile` each take a `DWG_VERSION`/`DWG_IMAGE_ORIGIN` build ARG, turned into an image `ENV` — never a compose-level override, so an operator cannot casually flip a local build's reported origin via `.env`. `DWG_IMAGE_ORIGIN` defaults to `source`; only `.github/workflows/release.yml`'s publish step overrides it to `registry` (alongside the real release version) for the one build whose output it actually pushes to GHCR. `docker/compose.yaml`'s own `build.args` feeds the checkout's `DWG_VERSION` through for a local `docker compose build` too (including the installer's `DWG_IMAGE_MODE=build` path), so a source-built install still reports a real version — just never `registry` origin. `panel.selfUpdateCheck` (`apps/broker/src/operations.ts`) now reads both containers' baked facts via `extractBakedImageFacts` (`apps/broker/src/self-update/image-refs.ts`), inspecting each container's own env the same uniform way (`inspectContainerForRecreate`, already broker-internal) rather than the old digest-to-repo-tag join — which could not tell a published image from a locally built one sharing the identical tag (this section's own opening sentence). `updatePossible` is `false` whenever either container's baked marker is missing (an image built before this existed) or is not `origin: registry`, each with its own distinct, honest reason.

9. **Retry cool-down.** After an automatic rollback, should the panel throttle immediate re-attempts (protects against a flapping loop if the target version is itself broken), or is "the admin decides when to try again" sufficient?

   **Resolved:** none in v1. There is no throttle on re-attempting a self-update after an automatic rollback — "the admin decides when to try again," this question's own second option. Recorded as a deferred item, §10, in case a flapping-target-version scenario later makes this worth revisiting.

---

## 10. Deferred backlog (recorded at completion — SU-G, working agreement 9)

Nothing below is silently dropped; each is a real, considered decision to defer, not an oversight. Also recorded in `FEATURE_MATRIX.md` §31c and `CHANGELOG.md`.

- **A manual "roll back to a previous version" control**, independent of a failed apply (§9.4) — the owner chose **later**, not this effort. Automatic rollback-on-failed-health-check is the only rollback path v1 ships.
- **A real-Docker-daemon CI test of the rollback path specifically** (a forced health failure driving an automatic rollback, verified against a real daemon rather than a fake). The rollback _logic itself_ is unit-proven exhaustively (`apps/broker/src/self-update/updater.test.ts`: server-health-fails-rollback-server-only, broker-health-fails-rollback-both, asserting the exact Docker call sequence and that rollback recreates from the _captured_ old spec, never a re-derived one). What a real daemon adds on top of that — that a container recreated from a cloned spec genuinely boots — is already covered by the real-daemon job's success path (`.github/workflows/self-update.yml`), which recreates two containers from cloned specs and asserts they come back healthy. Forcing a genuine rollback for real needs a deliberately broken target image; a bigger, separately-reviewed follow-up (SU-F's own report to the owner named this explicitly).
- **Updater-crash resume-on-startup** (§9.7/§4) — v1 accepts documented manual recovery instead: the rollback plan is written to the status file before any teardown, and a crash mid-update is treated as a rare, by-hand-recoverable case, not an automatic one.
- **Retry cool-down after a rollback** (§9.9) — none in v1; no throttle on re-attempting.
- **`DANGEROUSLY_OVERRIDE_SELF_UPDATE_REGISTRY`** (`apps/broker/src/config.ts`, SU-F) is not a product feature. It exists solely so the real-daemon CI job above can point a real broker at a disposable local registry instead of the real GHCR, since nothing "newer" is ever actually published there for that job to pull. Read once, at broker process startup, from an env var — never a `BrokerRequest` field, never reachable from `/v1/ops` — and it can only ever replace the registry _host_ half of the two fixed repository constants, never the repository names themselves (`resolvePanelRepository`, `apps/broker/src/self-update/image-refs.ts`). It is never set by `docker/compose.yaml`, `installer/install.sh`, or any real deployment path; the only place it is ever set is `.github/workflows/self-update.yml`'s own generated, uncommitted compose override. Recorded here so its existence is never a surprise to a future reader of the broker's config surface.
