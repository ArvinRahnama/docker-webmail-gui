# Deployment

The full detail ARCHITECTURE.md §10 promises and defers to this file — read
that section first for the two-sentence version and the reasoning; this is
the how-to.

## 1. What gets deployed, and what doesn't

Two containers, two networks — `docker/compose.yaml`:

- **`server`** — the web tier. API, auth, business logic, serves the built
  SPA (`STATIC_DIR`, wired in M13). Holds no Docker socket and no Docker
  vocabulary. Publishes `PORT` (default `3000`) to the host, or put a real
  reverse proxy in front of it on the `frontend` network instead — both
  work; the compose file does not force either.
- **`broker`** — the privileged tier. Tiny, holds `/var/run/docker.sock`,
  publishes nothing. On the `broker` network only, which is
  `internal: true` — no route to or from the internet in either direction,
  and no route to `frontend` either.

**`docker-mailserver` is not a service in this compose file.** This project
does not deploy DMS — it manages an already-running one, resolved by name
or label (`DMS_CONTAINER_NAME` / `DMS_CONTAINER_LABEL`, `.env.example`).
Bring your own DMS (the [official
compose.yaml](https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/compose.yaml)
is the reference), on the same Docker host, before or after installing this
panel — either order works, per §3 below.

## 2. Install

```sh
git clone <this repository>
cd docker-webmail-gui
./installer/install.sh
```

Requires Linux, Docker Engine, and the Compose v2 plugin — `install.sh`
checks all three and fails with a specific message if any is missing,
rather than partway through. It is idempotent: re-running it upgrades the
running stack in place (rebuilds images from the current source, restarts
containers with the new image if it changed) without regenerating any
secret or touching `./data`/`./backups` — see the script's own header
comment for the exact ordering.

Every setting resolves in one documented order: **this script's own
environment** (`PORT=8080 ./installer/install.sh`), then **the existing
`.env`**, then **the documented default**. The middle rule is the one that
makes a re-install safe on a host you have since tuned: hand-edit `.env`,
re-run the installer, and the edit survives — including keys `install.sh`
does not manage at all, which are copied across verbatim. CI asserts this
directly (§6), because a `.env` that merely came back unchanged would look
identical whether the installer preserved your settings or quietly reset
every one of them to its default.

> **Plain HTTP and the session cookie.** `COOKIE_SECURE` defaults to
> `true`, which is right behind TLS and fatal without it: browsers refuse
> to store a `Secure` cookie over `http://`, except on `localhost` /
> `127.0.0.1`. So the URL `install.sh` prints works, and the same panel
> reached over a LAN address or a hostname on plain HTTP will appear to
> accept your login and then do nothing at all. Either terminate TLS in
> front of it (see `BIND_ADDRESS` in §4), or set `COOKIE_SECURE=false` in
> `.env` and re-run. `install.sh` prints this warning itself on any install
> where `COOKIE_SECURE` is left on.

On a **fresh** install it prints a one-time bootstrap admin email and
password — the account's `forcePasswordChange` flag means you're required
to change it on first login (`apps/server/src/modules/auth/bootstrap.ts`).
Nothing prints it a second time; it's also in `.env`
(`BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`) until you clear those
two lines yourself, which `.env.example` and the installer's own final
message both recommend doing once you've logged in.

**Remote installation.** For `curl | sh`-style remote installs, the
recommended path is checksum-verified download-then-inspect-then-run, not
piping an unverified stream straight into a shell:

```sh
curl -fsSLO https://<release-url>/install.sh
curl -fsSLO https://<release-url>/install.sh.sha256
sha256sum -c install.sh.sha256   # verify before you read or run it
less install.sh                  # actually read it — it's short
sh install.sh
```

This project does not yet publish signed release artifacts at a stable URL
(no image registry push, no release process — `docker.yml`'s own header:
"It never pushes an image... this is a build-only smoke test, not a release
pipeline"), so today the only real install path is a git checkout, as
above. The two-step pattern above is documented now so the eventual release
process has a settled answer rather than reaching for `curl | sh` by
default later — see SECURITY.md §4.4.

## 3. Connecting to docker-mailserver

Every _Docker-level_ operation (start/stop/restart, logs, stats, exec) goes
through `broker`'s socket access — it never needs network reachability to
DMS at all. The one exception is `apps/server`'s direct HTTP calls to
Rspamd's controller API (`RSPAMD_URL`), which do need the `server`
container to actually be able to route to DMS's IP.

`install.sh` handles this automatically, best-effort: after starting the
stack, it looks for a running container matching `DMS_CONTAINER_NAME`
(default `mailserver`) or `DMS_CONTAINER_LABEL`, and if found, joins
`server` to whichever Docker network(s) that container is on
(`docker network connect`). This is safe to re-run — install.sh again once
DMS exists, if it didn't when you first installed this panel.

If auto-detection doesn't find it (a non-default container name with no
label set, or DMS on a host Compose can't see), connect it by hand:

```sh
docker network connect <dms-network-name> $(docker compose -f docker/compose.yaml ps -q server)
```

Until `server` is on a network that can reach it, Rspamd-dependent features
report `Unknown`/`Unavailable` — never a fabricated result (AGENT_BRIEF.md
§4, §9).

## 4. Hardening actually applied

Every item below is a real, running-container property, not aspirational —
`.github/workflows/installer.yml` asserts most of these directly against
live containers on every push that touches `docker/`, `installer/`,
`apps/`, or `packages/` (see §6).

| Control                           | `server`                                                                   | `broker`                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Non-root user                     | yes (`dwg`, uid 10001)                                                     | yes (`dwg`, uid 10001)                                                                                                                                                                                                                                                                                       |
| `read_only` root filesystem       | yes (`/tmp` tmpfs; `/app/data`, `/app/backups` named volumes)              | yes (`/tmp` tmpfs)                                                                                                                                                                                                                                                                                           |
| `cap_drop: ALL`                   | yes                                                                        | yes                                                                                                                                                                                                                                                                                                          |
| `no-new-privileges`               | yes                                                                        | yes                                                                                                                                                                                                                                                                                                          |
| `privileged: true`                | never                                                                      | never                                                                                                                                                                                                                                                                                                        |
| Docker socket                     | absent — not mounted, not on disk anywhere in the image                    | mounted read-write (the one thing this tier exists for)                                                                                                                                                                                                                                                      |
| Published ports                   | `${BIND_ADDRESS:-0.0.0.0}:${PORT:-3000}` — see below                       | none                                                                                                                                                                                                                                                                                                         |
| `pids_limit`                      | 512                                                                        | 128                                                                                                                                                                                                                                                                                                          |
| Log rotation                      | json-file, 10 MB × 5                                                       | json-file, 10 MB × 5                                                                                                                                                                                                                                                                                         |
| Docker client library in image    | absent — the build itself fails if `dockerode` reappears                   | present (this tier is the one that talks to the socket)                                                                                                                                                                                                                                                      |
| Networks                          | `frontend`, `broker`                                                       | `broker` only                                                                                                                                                                                                                                                                                                |
| `broker` network `internal: true` | —                                                                          | yes — no internet route in either direction                                                                                                                                                                                                                                                                  |
| Base image                        | `node:24-alpine`, pinned by digest                                         | same digest                                                                                                                                                                                                                                                                                                  |
| Resource limits                   | 1 CPU / 512 MB                                                             | 0.5 CPU / 256 MB                                                                                                                                                                                                                                                                                             |
| Healthcheck                       | `GET /api/v1/health` (no curl/wget in the image — a one-line Node `fetch`) | a bare TCP connect (the broker's only route requires an authenticated, schema-valid body — there is no unauthenticated HTTP shape that would prove liveness without either baking the shared secret into the image or adding a new endpoint to the smallest, most security-sensitive service in the project) |

### `BIND_ADDRESS` — publishing to the LAN, or only to a proxy

`BIND_ADDRESS` defaults to `0.0.0.0`, which publishes `PORT` on every
interface: the right default for a plain LAN install with no proxy in
front. Set it to `127.0.0.1` in `.env` when a reverse proxy on this same
host terminates TLS — the published port then exists only for that proxy,
the panel is not reachable from the LAN on plain HTTP at all, and
`COOKIE_SECURE=true` becomes correct rather than a lockout (§2). Either
way `install.sh` carries the value forward on every re-run.

### What the images themselves are checked for

Two of the rows above are properties of the _image_, not of how it is run,
and both are enforced at build time rather than described:
`docker/server/Dockerfile` fails the build if `dockerode` or `docker-modem`
is present in the web tier's runtime `node_modules`, and
`docker/broker/Dockerfile` fails if any web-tier dependency (React,
`@node-rs/argon2`, `tar`, `undici`) is present in the broker's. Neither is
automatic: `npm ci` installs every workspace's dependencies into one
hoisted tree, and `npm prune --omit=dev` keeps all of them, because every
workspace is still a workspace. Each Dockerfile drops the other tier's
workspace directory before pruning, and then asserts the result — measured
with `npm prune --omit=dev --dry-run`, which lists `dockerode`,
`docker-modem` and both `@types` packages as removable only once
`apps/broker` is gone.

## 5. Uninstall

```sh
./installer/uninstall.sh                       # GUI only — default
./installer/uninstall.sh --purge               # + own data (admins, sessions, audit log) and .env
./installer/uninstall.sh --remove-images       # + the two images this repository builds
./installer/uninstall.sh --remove-mail-server  # + stops/removes the DMS *container* (never its volumes)
```

`--purge` and `--remove-mail-server` each require their own typed
confirmation (interactively, or `DWG_CONFIRM_PURGE=yes` /
`DWG_CONFIRM_REMOVE_MAIL=yes` for non-interactive use). `--remove-images`
does not: it removes build output that `install.sh` reproduces exactly, so
the only cost of getting it wrong is a slower next install.

**`--purge` removes the generated `.env` along with the volumes**, on
purpose. `.env` holds nothing but the secrets guarding data that no longer
exists; leaving it would strand those secrets on disk _and_ make the next
`install.sh` believe it was upgrading an install whose database is gone.
After a purge, the next install is a genuinely fresh one, with a new
bootstrap credential — which is what CI's third cycle asserts (§6).

**No flag this script offers ever removes a DMS volume or any mail data.**
That refusal is unconditional — the same one the panel's own UI makes
(SECURITY.md §4.3: "a block, not a confirmation"), not a setting anything
can turn off. `docker rm` is called without `-v` for exactly this reason.

Safe to run more than once, in any order relative to `install.sh` —
anything already removed is reported, not treated as an error. That
includes running with `.env` already gone, which is the state `--purge`
itself leaves: Compose interpolates `docker/compose.yaml` for every
subcommand including `down`, and the file declares three required
variables, so the teardown supplies throwaway values for them rather than
failing on secrets a teardown never needed.

Every run ends by listing what it left on the host, so what survives an
uninstall is a stated outcome rather than something to discover later.

## 6. What is verified where

Working agreement #9 (AGENT_BRIEF.md §7, §9) applies to this file's own
claims as much as to the app's: this section says plainly what is actually
tested versus what remains a documented manual step, rather than letting
"there's a workflow for it" imply more than it does.

**Asserted in CI, on every relevant push (`.github/workflows/installer.yml`),
against a real Docker daemon on a real Linux runner** — this machine, at
the time these files were written, had no Docker daemon reachable at all
(confirmed directly: the socket exists, the session's user has no
permission to use it), so this workflow is where this class of check runs
against anything real rather than simulated:

- `docker/compose.yaml` parses and resolves (`docker compose config`).
- `installer/install.sh` and `installer/uninstall.sh` pass `shellcheck`.
- Three full install → verify-healthy → uninstall cycles: a fresh install,
  an upgrade of what the first cycle deliberately left behind, and a fresh
  install onto the fully purged host the second cycle produced.
- Idempotency, in the three senses that can actually fail independently:
  installing twice in a row leaves `.env` (and therefore every secret)
  byte-identical; installing again after **hand-editing** `.env` preserves
  every edit, including a key the installer does not manage at all;
  uninstalling twice in a row is a no-op the second time, not an error —
  including the second run of `--purge`, where there is no longer a `.env`
  for Compose to read.
- The privilege boundary in the _running containers_: the server has no
  Docker socket on any mount path or at `/var/run/docker.sock` inside its
  own filesystem, and no `dockerode`/`docker-modem` in its runtime
  `node_modules`; the broker has the socket and publishes no ports; the
  broker is not on the `frontend` network and its own network is
  `internal: true`; both containers run non-root with a read-only rootfs,
  `cap_drop: ALL`, `no-new-privileges` and a bounded `pids_limit`.
- The same-origin topology M13 introduced, in the shipped image: `GET /`
  returns the built SPA shell, its hashed asset actually loads, a
  client-side route (`/mail/domains`) falls back to that shell rather than
  404ing, and an unmatched `/api/v1/*` path still returns the JSON error
  envelope — never the shell. The last of those is the specific regression
  a catch-all SPA fallback introduces, so it is asserted rather than
  assumed.
- `--purge` actually removes this project's own named volumes and `.env`,
  and not before that flag is passed; `--remove-images` actually removes
  both built images; and neither touches the placeholder mail server's own
  network.
- `--remove-mail-server` actually stops and removes the placeholder DMS
  container CI stands up for this purpose, and never touches its volumes.
- The best-effort DMS-network auto-join in `install.sh` runs against a
  real (if minimal) named container on every cycle, not as dead code.
- Both image builds also self-check (`.github/workflows/docker.yml` builds
  them on every push touching `docker/`): each Dockerfile fails the build
  if the other tier's dependencies leaked into it — see §4.

**Not verified here, and not claimed to be — remaining manual/future
verification:**

- **The install cycle actually completing against a real Docker daemon.**
  The workflow asserts the right things and the server now does boot in
  production configuration (proven by a test and by running the built
  server directly), but **no run of this workflow has been observed**, and
  nothing in this repository records one. Treat everything below as
  asserted, not observed, until a run says otherwise.
- **A real `docker-mailserver` container**, not the minimal named
  placeholder CI uses to exercise container-resolution and the
  network-join step. Mailbox operations, DKIM, TLS status, Rspamd/ClamAV
  reachability and every other DMS-dependent feature against a real DMS
  deployment is not exercised by this workflow. The fake-driver-backed
  Vitest/Playwright suites (M1-M12) cover this project's own logic
  thoroughly; a live DMS integration pass is separate, real-daemon-only
  work this machine cannot do and CI does not yet attempt.
- **Non-Linux hosts.** `install.sh` refuses to run anywhere but Linux, on
  purpose (its own comment: Docker Desktop's socket-permission model on
  macOS/Windows has not been verified against the `DOCKER_GID`
  `group_add` approach this installer relies on). Untested, not merely
  undocumented.
- **The remote `curl | sh` install path** described in §2 — no release
  artifacts are published yet for it to fetch, so the checksum-verify step
  itself has nothing to run against today.
- **A browser session end to end.** CI asserts the SPA is _served_ and
  that API 404s are still API 404s; it does not drive a login through it.
  The real-browser coverage of the app itself is Playwright's (M12) —
  whose security project does now run against a real `apps/server` serving
  the built SPA from one origin, the same topology this image ships, but
  as a local process rather than as the container. Logging in through the
  packaged container is a manual step.
- **`COOKIE_SECURE=true` over plain HTTP.** The lockout described in §2 is
  browser behaviour, not something this project's code can assert; the
  installer warns about it rather than testing it.
- **Long-running stability** (memory growth, restart behaviour under
  `restart: unless-stopped` after a genuine crash) — the CI cycle above
  runs for minutes, not days. Log growth specifically is now bounded by
  configuration (§4's rotation row) rather than left to the default, but
  that bound has not been observed being hit.
- **Multi-node / clustered hosts.** Out of scope by design
  (ARCHITECTURE.md §11: "single-node by design").
