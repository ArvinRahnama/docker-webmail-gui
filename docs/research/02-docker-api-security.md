# 02 — Docker Engine API & Socket Security Boundary

**Scope:** Security research for an internet-reachable web panel that controls a `docker-mailserver` (DMS) container on a Linux host.
**Target API:** Docker Engine API **v1.55** (current stable at time of writing).
**Backend runtime:** TypeScript on Node.js 24.
**Date:** 2026-08-15.

> **Confidence legend** — every capability claim is tagged:
> `[CONFIRMED: <url>]` verified against an authoritative source · `[INFERRED]` deduced from confirmed facts/behavior · `[UNCERTAIN]` plausible but unverified.

> **Bottom line up front:** Read/write access to `/var/run/docker.sock` is root on the host, full stop. No proxy that filters by URL path (including `tecnativa/docker-socket-proxy`) can prevent escalation once container *creation* is reachable, and you cannot get container *listing/inspection* through that proxy without also opening *creation*. The only architecture that genuinely bounds blast radius is a **custom minimal privileged broker exposing a named-operation API** (not the raw Docker API), with the web backend holding **no socket access at all**. Per-container restriction does **not** exist at the Docker level and must be enforced in our application/broker layer.

---

## A. Engine API surface we need

### A.0 Version & negotiation

| Item | Value |
|---|---|
| Current stable API version | **1.55** → Docker Engine 29.7 / 29.6 `[CONFIRMED: https://docs.docker.com/reference/api/engine/version-history/]` |
| Prior | 1.54 (29.5–29.3), 1.53 (29.2), 1.52 (29.1/29.0), 1.51 (28.5–28.3), 1.50 (28.2) `[CONFIRMED: same]` |
| Swagger `info.version` | `"1.55"` `[CONFIRMED: https://raw.githubusercontent.com/moby/moby/master/api/swagger.yaml]` |
| Minimum supported | Daemon-dependent; modern daemons floor at **1.24**, practical floor 1.40 `[CONFIRMED: https://docs.docker.com/reference/api/engine/]` |

**Negotiation mechanism** `[CONFIRMED: https://docs.docker.com/reference/api/engine/ + swagger `/_ping`]`:

1. Every request path *may* be version-prefixed: `/v1.55/containers/json`. Omitting the prefix uses the daemon default (discouraged — pin it).
2. `GET`/`HEAD /_ping` returns header **`Api-Version`** = *max API version the daemon supports*, plus `Builder-Version`, `Docker-Experimental`, `Swarm`, `Cache-Control`. `[CONFIRMED: swagger.yaml `SystemPing`/`SystemPingHead`]`
3. Correct client behavior: call `/_ping` once at startup, read `Api-Version`, and negotiate `min(client_max, server_max)`; pin that in the URL prefix for all later calls. `DOCKER_API_VERSION` env var can force a version. `[CONFIRMED: https://docs.docker.com/reference/api/engine/]`
4. Requesting a version **newer** than the daemon supports → `400 Bad Request` (`client version X is too new`). `[INFERRED]` — negotiate down, never assume.

**Recommendation:** ping first, pin the negotiated version string, treat `/_ping` as the health probe. `[INFERRED]`

### A.1 Operation table

Base = `/v1.55`. **R** = read-only (GET/HEAD), **M** = mutating (state/side-effects). All params confirmed against `swagger.yaml` unless noted. `[CONFIRMED: https://raw.githubusercontent.com/moby/moby/master/api/swagger.yaml]`

| Operation | Method + Path | Key query / body params (defaults) | R/M | Notable response fields |
|---|---|---|---|---|
| List containers | `GET /containers/json` | `all=false`, `limit`, `size=false`, `filters` (JSON `map[string][]string`: `status`,`label`,`name`,`id`,`health`…) | **R** | `Id`,`Names`,`Image`,`State`,`Status`,`Ports`,`Labels`,`Mounts` |
| Inspect container | `GET /containers/{id}/json` | `size=false` (adds `SizeRw`,`SizeRootFs` — **costly**) | **R** | `State.{Status,Running,Health,ExitCode}`, `Config`, `HostConfig` (incl. `Binds`,`Privileged`,`CapAdd`,`PidMode`), `Mounts`, `NetworkSettings` |
| Container processes | `GET /containers/{id}/top` | `ps_args` | **R** | `Titles`,`Processes` |
| **Logs** | `GET /containers/{id}/logs` | `follow=false`, `stdout=false`, `stderr=false`, `since=0`, `until=0`, `timestamps=false`, `tail="all"` | **R** | *stream* — see A.2. `follow=true` keeps the connection open (streaming) |
| **Stats** | `GET /containers/{id}/stats` | `stream=true`, `one-shot=false` (only valid with `stream=false`) | **R** | see A.3 |
| Start | `POST /containers/{id}/start` | `detachKeys` | **M** | 204 no content; 304 already started |
| Stop | `POST /containers/{id}/stop` | `signal`, `t` (secs before kill) | **M** | 204; 304 already stopped |
| Restart | `POST /containers/{id}/restart` | `signal`, `t` | **M** | 204 |
| Kill | `POST /containers/{id}/kill` | `signal="SIGKILL"` | **M** | 204 |
| Pause / Unpause | `POST /containers/{id}/pause` · `/unpause` | — | **M** | 204 |
| Rename | `POST /containers/{id}/rename` | `name` (**required**) | **M** | 204; 409 name in use |
| Update (limits) | `POST /containers/{id}/update` | body: cgroup resources | **M** | live-updates CPU/mem limits |
| Remove | `DELETE /containers/{id}` | `v=false` (remove anon volumes), `force=false` (kill if running), `link=false` | **M** | 204; 409 if running & not forced |
| **Create** | `POST /containers/create` | `name`, `platform`; **body = full container config** | **M** ⚠️ | `Id`,`Warnings`. **This is the root-equivalent call** (see B) |
| Exec create | `POST /containers/{id}/exec` | body `ExecConfig` (A.4) | **M** | `Id` |
| Exec start | `POST /exec/{id}/start` | body `{Detach,Tty,ConsoleSize}` | **M** | hijacked stream (A.2/A.4) |
| Exec resize | `POST /exec/{id}/resize` | `h`,`w` | **M** | 200 |
| Exec inspect | `GET /exec/{id}/json` | — | **R** | `Running`,`ExitCode`,`Pid`,`ContainerID`,`ProcessConfig` |
| List images | `GET /images/json` | `all=false`, `filters` (`dangling`,`label`,`reference`,`until`), `shared-size=false` (**costly**), `digests=false` | **R** | `Id`,`RepoTags`,`RepoDigests`,`Size`,`Created`,`Labels` |
| Inspect image | `GET /images/{name}/json` | — | **R** | `Id`,`RepoTags`,`Config`,`Size`,`Architecture`,`Os` |
| Remove image | `DELETE /images/{name}` | `force=false`, `noprune=false` | **M** | array of `Untagged`/`Deleted` |
| Prune images | `POST /images/prune` | `filters` (`dangling`,`until`,`label`) | **M** | `ImagesDeleted`,`SpaceReclaimed` |
| **Pull image** | `POST /images/create` | `fromImage`,`tag`,`platform`; header `X-Registry-Auth` | **M** | *progress stream* (A.5) |
| List volumes | `GET /volumes` | `filters` (`dangling`,`driver`,`label`,`name`) | **R** | `Volumes[]`,`Warnings`; `UsageData.Size = -1` unless via `/system/df` |
| Inspect volume | `GET /volumes/{name}` | — | **R** | `Name`,`Mountpoint`,`Driver`,`Labels`,`Options` |
| Remove volume | `DELETE /volumes/{name}` | `force=false` | **M** | 204; 409 volume in use |
| Prune volumes | `POST /volumes/prune` | `filters` | **M** | `VolumesDeleted`,`SpaceReclaimed` |
| List networks | `GET /networks` | `filters` | **R** | `Id`,`Name`,`Driver`,`Scope`,`Containers` |
| Inspect network | `GET /networks/{id}` | `verbose`,`scope` | **R** | `Containers`,`IPAM`,`Options` |
| **Events** | `GET /events` | `since`,`until`,`filters` (`type`,`event`,`container`,`image`,`label`…) | **R** | *stream* of JSON event objects (A.6) |
| Version | `GET /version` | — | **R** | `Version`,`ApiVersion`,`MinAPIVersion`,`Os`,`Arch`,`KernelVersion` |
| Info | `GET /info` | — | **R** | `Containers`,`Images`,`ServerVersion`,`SecurityOptions`,`Driver`,`NCPU`,`MemTotal` |
| Ping | `GET`/`HEAD /_ping` | — | **R** | headers: `Api-Version`,`Builder-Version`,`Swarm` |
| **Disk usage** | `GET /system/df` | `type[]`,`verbose` | **R** (costly) | `LayersSize`, `Images`,`Containers`,`Volumes`,`BuildCache` with real sizes |

**"Recreate" is NOT an API operation.** `[CONFIRMED: swagger.yaml — no such endpoint]` To recreate a container you must: `GET /containers/{id}/json` (capture config) → `POST /containers/{id}/stop` → `DELETE /containers/{id}` → **`POST /containers/create`** (new config, same image) → `POST /containers/{newid}/start`. The load-bearing step is **create**, which is exactly the privileged operation we must never expose to untrusted input (see B). In practice, "recreate" for a compose-managed stack like DMS is done by the *host-side* tooling (`docker compose up -d --force-recreate`), not by the panel poking the raw API. `[INFERRED]`

### A.2 Multiplexed stream frame format (logs & attach, non-TTY)

Containers created **without** a TTY produce a multiplexed stream; `Content-Type: application/vnd.docker.multiplexed-stream`. We MUST decode it. Verbatim spec `[CONFIRMED: swagger.yaml ContainerAttach "Stream format"]`:

```
header := [8]byte{STREAM_TYPE, 0, 0, 0, SIZE1, SIZE2, SIZE3, SIZE4}
```
- `header[0]` **STREAM_TYPE**: `0`=stdin (written on stdout), `1`=stdout, `2`=stderr
- `header[1..3]` = three zero/padding bytes
- `header[4..7]` = **SIZE**, a `uint32` frame payload length **big-endian**

Decode loop (verbatim):
> 1. Read 8 bytes. 2. Choose `stdout`/`stderr` from the first byte. 3. Extract frame size from the last four bytes. 4. Read that many bytes → correct output. 5. Goto 1.

**TTY case:** when the container was created with `Tty:true`, the stream is **not** multiplexed — `Content-Type: application/vnd.docker.raw-stream`, raw PTY bytes, no 8-byte header. Our decoder must branch on `Config.Tty` (from inspect) or the response `Content-Type`. `[CONFIRMED: swagger.yaml "Stream format when using a TTY"]`

**Hijacking:** attach/exec-start "hijack" the HTTP connection. Client may send `Upgrade: tcp` / `Connection: Upgrade`; daemon replies `101 UPGRADED` then raw/multiplexed bytes; thereafter the socket is a bidirectional byte pipe. `[CONFIRMED: swagger.yaml ContainerAttach "Hijacking"]` A plain HTTP client that buffers the body will not work for `follow=true`/exec — the library must expose the raw socket (see E).

### A.3 Stats — correct CPU% / memory% math

Raw counters only; compute deltas across two reads (`stream=true`), or use `stream=false&one-shot=true` for a single snapshot (skips the 2-cycle wait, so `precpu_stats` is zeroed → CPU% not computable from one-shot). Formulas verbatim `[CONFIRMED: swagger.yaml ContainerStats description]`:

```
cpu_delta        = cpu_stats.cpu_usage.total_usage        - precpu_stats.cpu_usage.total_usage
system_cpu_delta = cpu_stats.system_cpu_usage             - precpu_stats.system_cpu_usage
number_cpus      = length(cpu_stats.cpu_usage.percpu_usage)  OR  cpu_stats.online_cpus
CPU usage %      = (cpu_delta / system_cpu_delta) * number_cpus * 100.0

used_memory      = memory_stats.usage - memory_stats.stats.cache          (cgroups v1)
used_memory      = memory_stats.usage - memory_stats.stats.inactive_file  (cgroups v2)
available_memory = memory_stats.limit
Memory usage %   = (used_memory / available_memory) * 100.0
```

Notes `[CONFIRMED: same]`: on **cgroup v2** hosts `cpu_usage.percpu_usage`, `memory_stats.max_usage`, `memory_stats.failcnt` are unset — use `online_cpus`, and subtract `inactive_file` (not `cache`). Failing to subtract `cache`/`inactive_file` **massively over-reports memory** (page cache counted as usage). Guard against `system_cpu_delta <= 0` (division) on the first sample. `[INFERRED]`

### A.4 Exec config (argv, never a shell string)

`POST /containers/{id}/exec` body `[CONFIRMED: swagger.yaml ExecConfig]`:

| Field | Type | Meaning |
|---|---|---|
| `Cmd` | **array of strings** | argv — pass `["postqueue","-p"]`, NOT `"sh -c ..."` |
| `User` | string | `user` / `uid` / `uid:gid` to run as |
| `WorkingDir` | string | cwd inside container |
| `Env` | array | `["VAR=value"]` |
| `Tty` | bool | allocate PTY (affects stream format, A.2) |
| `AttachStdin/Stdout/Stderr` | bool | which streams to attach |
| `Privileged` | bool (default false) | **extended privileges for the exec process** — do not set |
| `DetachKeys`, `ConsoleSize` | | detach sequence / initial size |

Then `POST /exec/{id}/start` (`{Detach,Tty,ConsoleSize}`) returns the hijacked stream. Exit code: `GET /exec/{id}/json` → `Running:false`, `ExitCode:<int>`. `[CONFIRMED: swagger.yaml ExecStart/ExecInspect]` Poll inspect after the stream closes to read `ExitCode`.

### A.5 Pull progress stream

`POST /images/create` streams newline-delimited JSON objects `{status, id, progress, progressDetail:{current,total}, error}` until complete. Parse line-by-line; a final `{error}` object signals failure even after a 200. `[CONFIRMED: swagger.yaml ImageCreate produces application/json stream]` Registry auth via base64-JSON `X-Registry-Auth` header. `[CONFIRMED: same]`

### A.6 Events — the right way to get live state

`GET /events` streams JSON event objects as they occur. Container event types include `create,start,stop,die,kill,restart,pause,unpause,oom,health_status,destroy,rename,exec_create,exec_start,exec_die` (plus image/volume/network/daemon events). Filter with `filters={"type":["container"],"container":["<id>"]}`. `[CONFIRMED: swagger.yaml /events]`

**This is the correct primitive for live container state** — subscribe once and react, rather than polling `/containers/json`. For CPU/mem you still need `/stats` (events don't carry metrics). Recommended pattern: one long-lived `/events` subscription for lifecycle/health + per-container `/stats?stream=true` only for containers the UI is actively displaying. `[INFERRED]`

---

## B. The socket security boundary — the core question

### B.1 Why socket access = root on the host

The Docker daemon runs as **root** and its socket is owned by `root:docker`. OWASP states it plainly: *"The owner of this socket is root. Giving someone access to it is equivalent to giving unrestricted root access to your host."* `[CONFIRMED: https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html RULE #1]` Docker's own docs: with the daemon socket/keys, one *"can give any instructions to your Docker daemon, giving them root access to the machine hosting the daemon."* `[CONFIRMED: https://docs.docker.com/engine/security/protect-access/]` The daemon *does not* re-check who is asking or what the container config implies — the API is the trust boundary. `[CONFIRMED: https://docs.docker.com/engine/security/]`

Concrete escalation paths — **each needs only `POST /containers/create` + `POST /containers/{id}/start`** (both plain, documented, "legitimate" calls):

1. **Bind-mount host `/` into a container and chroot.** Create with body `{"Image":"alpine","Cmd":["chroot","/host","sh"],"HostConfig":{"Binds":["/:/host"]}}`, start, attach/exec. You now read/write every file on the host as root — edit `/host/etc/shadow`, drop a SUID binary, install an SSH key. `[CONFIRMED: https://book.hacktricks.wiki/en/linux-hardening/privilege-escalation/docker-security/abusing-docker-socket-for-privilege-escalation.html]`
2. **`Privileged:true` (or `CapAdd:["SYS_ADMIN"]`).** Create `{"HostConfig":{"Privileged":true}}` → all capabilities, all devices, no seccomp/AppArmor confinement → mount host block devices, load kernel modules, escape via `release_agent` (cf. CVE-2022-0492). `[CONFIRMED: https://unit42.paloaltonetworks.com/cve-2022-0492-cgroups/]`
3. **`PidMode:"host"` + `CapAdd:["SYS_PTRACE"]`.** Share the host PID namespace and inject into / read memory of host processes (e.g. steal secrets from a root process, `nsenter` into PID 1). `[CONFIRMED: hacktricks, same]`
4. **Mount host `/etc` or `/root` read-write** (narrower Bind) and append to `/etc/sudoers`, `/etc/crontab`, `/root/.ssh/authorized_keys`, or a systemd unit → root shell on next trigger. `[CONFIRMED: hacktricks, same]`
5. **Mount the Docker socket back into the new container** (`/var/run/docker.sock:/var/run/docker.sock`) — trivially re-establishes full control if any single filter is bypassed. `[CONFIRMED: OWASP RULE #1]`

There is no "safe subset" of create — `HostConfig` fields (`Binds`, `Mounts`, `Privileged`, `CapAdd`, `PidMode`, `NetworkMode:"host"`, `Devices`, `SecurityOpt`) each independently reach the host. **Whoever can call create+start owns the host.** `[CONFIRMED: synthesis of the above]`

### B.2 Architecture options — honest comparison

| # | Architecture | Protects against | Does **NOT** protect against | Op cost |
|---|---|---|---|---|
| 1 | **Backend container, socket mounted RW** | nothing beyond network auth | *everything* — an app RCE = instant host root (B.1) | trivial |
| 2 | **`tecnativa/docker-socket-proxy`** (HAProxy path allowlist) | random API sections you never enable; enforces read-only *if* `POST=0`; blocks Swarm/secrets/build | **create-based escalation once writes are enabled** (B.3); no per-container scope; no body inspection; app RCE still reaches whatever paths are allowed | low |
| 3 | **Backend on host as systemd unit, user in `docker` group** | container-escape of the backend itself (it isn't containerized); simpler streaming | `docker` group = root (B.1); app RCE = host root; larger host attack surface; no isolation | medium |
| 4 | **Custom minimal privileged broker exposing a named-operation API**, web backend has **no** socket | app RCE in the web tier (it literally cannot create containers — no socket, no Docker verbs); enables per-container allowlist, argv allowlist, audit, rate-limit | bugs in the broker itself; a compromised broker is still root — keep it tiny & audited | **high (we build it)** |
| 5 | **Rootless Docker** | daemon/container escape → maps to an *unprivileged host UID*, not root; big reduction | control of the socket still = full control of *that user's* containers & its data (incl. the mail store); limitations: no host ports <1024 w/o setcap, cgroup-v2 + slirp4netns, some storage-driver/AppArmor caveats | medium–high |
| 6 | **Docker API over TCP + mTLS** | network sniffing; unauthenticated clients | it's the **same root-equivalent API** — mTLS only authenticates the caller; a leaked client cert = host root; adds a network attack surface Docker warns against | medium |

`[CONFIRMED: option 2 mechanics — README + haproxy.cfg, see B.3; option 5 — https://docs.docker.com/engine/security/rootless/; option 6 — https://docs.docker.com/engine/security/protect-access/; OWASP RULE #1/#11]`

**Recommendation: Option 4 (named-operation broker) as the primary boundary, hardened per Section D, with Option 5 (rootless) underneath if operationally feasible, and Option 2 only as a defense-in-depth read-only layer — never as the sole control.**

Reasoning: The web backend is the internet-reachable, highest-churn, highest-risk component; it must be **incapable** of expressing a Docker create/exec/bind-mount even if fully compromised. That is only true if it has *no socket and no raw-Docker verbs* — it calls a private API like `POST /ops/restart-mail` over an internal network, and a small, rarely-changed, heavily-audited **broker** translates that single named intent into the exact Docker call, against a **hard-coded container identity**, with the dangerous `HostConfig` fields never derived from request input. This is the only design that turns "root-equivalent" into "can restart/inspect one specific container." Be honest about the residual: **if the panel can restart the mail container it can already cause outages and, via logs/exec, read mail** — the goal is to *bound blast radius to the mail service*, not to pretend the tool is unprivileged.

### B.3 Does `docker-socket-proxy` prevent escalation if create+start are allowed? **No.** (Verified.)

I read the actual shipped `haproxy.cfg`. `[CONFIRMED: https://raw.githubusercontent.com/Tecnativa/docker-socket-proxy/master/haproxy.cfg]` Findings:

- Filtering is **URL-path regex + HTTP method only. There is zero request-body inspection.** So the proxy *cannot* distinguish a benign `create` from one with `Privileged:true`/`Binds:["/:/host"]` — it never looks at the body.
- The first rule is `http-request deny unless METH_GET || { env(POST) -m bool }`. Non-GET requests are denied unless `POST=1`.
- The generic gate `http-request allow if { path … ^(/v[\d\.]+)?/containers } { env(CONTAINERS) -m bool }` governs **all** of `/containers/*` — including both `GET /containers/json` (list) **and** `POST /containers/create`. There is **no create-specific gate.**
- Therefore: to list/inspect containers you need `CONTAINERS=1`. To start/stop them you need `POST=1` (the granular `ALLOW_START/STOP/RESTARTS` rules sit *after* the POST-deny gate, so they're unreachable unless `POST=1` anyway). **`CONTAINERS=1` + `POST=1` ⇒ `POST /containers/create` is allowed ⇒ privileged container ⇒ host root (B.1).**

So the "obvious" panel config (`CONTAINERS=1, POST=1, ALLOW_START=1, ALLOW_STOP=1, ALLOW_RESTARTS=1`) **leaves create wide open.** The proxy's README even warns to only enable what you need and never expose its port — but the granularity simply isn't there to express "read containers + start/stop, but never create." `[CONFIRMED: README + haproxy.cfg]`

The **only** way the proxy blocks create is `CONTAINERS=0` — but that also blocks list/inspect/logs/stats/top (all under `/containers`), gutting the panel. You *can* then re-enable start/stop by ID via `ALLOW_START/STOP/RESTARTS=1` (their regexes match `/containers/<id>/start` independently of `CONTAINERS`), giving a narrow "blind controller" that can start/stop/restart/kill existing containers but cannot list them or create new ones. That's a real, safer mode — but it's not a monitoring panel. **Verdict: `docker-socket-proxy` is useful only as a read-only mode (`POST=0`) or a blind start/stop mode; it does NOT make a read+control panel safe.** `[CONFIRMED: analysis of haproxy.cfg rule ordering]`

### B.4 Minimum paths for a genuinely-safe READ-ONLY mode

With `POST=0` the entire proxied API is GET/HEAD-only — no create, no exec, no start. `[CONFIRMED: README "when disabled, only GET and HEAD… read-only"]` Minimum enables:

```
POST=0  CONTAINERS=1  IMAGES=1  VOLUMES=1  NETWORKS=1  INFO=1  VERSION=1  PING=1  EVENTS=1  SYSTEM=1
AUTH=0 SECRETS=0 EXEC=0 BUILD=0 COMMIT=0 SWARM=0 CONFIGS=0 SERVICES=0 NODES=0 TASKS=0 PLUGINS=0 DISTRIBUTION=0 GRPC=0 SESSION=0
```

This yields list/inspect/logs/stats/events/df and image/volume/network read — **and is genuinely safe from *escalation*** because no state-changing verb is reachable. `[INFERRED from B.3]` Caveats that remain even read-only: (a) `GET /containers/{id}/logs` can expose mail contents/secrets — it's a **confidentiality** exposure, not an escalation; (b) `EVENTS=1` leaks activity metadata; (c) `SYSTEM=1` enables `/system/df` which is expensive. A read-only panel is the safest possible design and is the right default for any "monitoring" tier. `[INFERRED]`

### B.5 Can Docker restrict operations to a SPECIFIC container? **No — must be enforced in our layer. (Confirmed.)**

There is **no native Docker mechanism** to scope socket/API access to a particular container by name, ID, or label. `[CONFIRMED: no such control in https://docs.docker.com/engine/security/ or the Engine API]` The API is all-or-nothing per path. Options and their reality:

- **`docker-socket-proxy`:** path-regex only. You *could fork it* and hard-code a container name into the `ALLOW_START`/`STOP`/`KILL` regexes (`…/containers/mailserver/start`) — but that covers only those sub-paths, not logs/inspect/exec (which use the generic `/containers` gate), and it's a fragile custom build. Not a real per-container ACL. `[INFERRED from haproxy.cfg]`
- **Authorization plugins (AuthZ):** the *only* Docker-native way to inspect method **+ URL + body** and allow/deny per policy — so a plugin *can* enforce "only container X, never `Privileged`, never `Binds`." Implementations exist (`twistlock/authz`, `casbin/docker-casbin-plugin`). `[CONFIRMED: https://github.com/twistlock/authz , https://github.com/casbin/docker-casbin-plugin]` But: they run as a daemon-wide plugin, are **coarse by default** and require you to author/maintain policy JSON that must model create-body internals; they add a hard dependency in the daemon request path (a broken plugin can wedge Docker); and the ecosystem is semi-maintained. Operationally heavy for a single-container panel. `[INFERRED]`
- **Conclusion:** per-container restriction is **our application/broker's job** (Option 4). Enforce the container identity server-side (hard-coded name/ID/label match), never from client input. `[CONFIRMED synthesis]`

### B.6 Authorization plugins — practical here?

They exist and are the closest thing to native fine-grained control (see B.5). Practicality for us: **low-to-moderate.** They demand daemon reconfiguration (`--authorization-plugin=`), a running plugin process, and body-aware policy that we'd have to keep correct across API-version changes; a plugin fault is a daemon-wide outage. For one mail container, a small in-house broker (Option 4) is simpler, easier to audit, and doesn't put third-party code in every Docker request. Consider AuthZ only if we later need org-wide, multi-tenant Docker governance. `[INFERRED]`

---

## C. Exec safety

### C.1 Run a command with argv, no shell

Always pass `Cmd` as an **argv array** to `POST /containers/{id}/exec`, e.g. `{"Cmd":["postqueue","-p"],"User":"docker","AttachStdout":true,"AttachStderr":true,"Tty":false}`, then `POST /exec/{id}/start` with `{"Detach":false}`. Never build `["sh","-c", userString]` — that reintroduces shell injection. `[CONFIRMED: swagger.yaml ExecConfig `Cmd` is `array of strings`]`

### C.2 What you CAN and CANNOT constrain

**Can** (via ExecConfig): `User` (drop from root to an unprivileged uid), `WorkingDir`, `Env`, `Tty:false` (no PTY), which streams attach, and *not* setting `Privileged`. `[CONFIRMED: swagger.yaml]`
**Cannot** at the exec level: the target container's **existing mounts, capabilities, network, and privileged status** — exec inherits the container's world. If the container already bind-mounts host paths or holds caps, exec lands inside that pre-existing blast radius. You also cannot impose seccomp/AppArmor *per-exec* beyond what the container already runs with. `[INFERRED from B.1 + swagger]`

### C.3 If the target runs as root (DMS does)

Exec gives you **root inside that container**. Whether that reaches **host root** depends entirely on the container's config:

- A hardened, unprivileged container with only its own data volumes → root-in-container is confined to that container (still full control of mail data, but not the host). `[INFERRED]`
- A container that is `Privileged`, holds `SYS_ADMIN`/`SYS_PTRACE`, shares host PID/net, or **bind-mounts host paths** → root-in-container ⇒ host root/host-file access. `[CONFIRMED: B.1 mechanisms]`

**For a typical DMS deployment:** DMS runs as root and mounts host-side volumes for mail (`/var/mail`, e.g. `./docker-data/dms/mail-data:/var/mail`), state, logs, config, and TLS certs. Exec (or logs) therefore exposes **the entire mail store, Postfix/Dovecot config, and private TLS keys** — a critical confidentiality/integrity breach. It does **not** automatically grant host root *unless* DMS was given `Binds` to sensitive host paths, extra caps, or privileged mode. Audit the DMS `HostConfig` before assuming confinement; do **not** run DMS privileged. `[INFERRED from B.1 + DMS default compose; verify per-deployment via `GET /containers/{id}/json`]`

### C.4 Auditing/limiting an exec/terminal feature

`[INFERRED — best practice]`

1. **Prefer named actions over a shell.** Expose curated buttons ("flush queue", "reload Postfix") mapping to fixed argv; treat a raw terminal as a separate, higher-privilege feature.
2. **Server-side argv allowlist** if a command box is unavoidable; reject shell metacharacters; never `sh -c` user input.
3. **Pin the container identity** server-side; the client never names the container.
4. **Run exec as a non-root `User`** where the tooling permits.
5. **Full audit log**: who, when, exact argv, exit code (`GET /exec/{id}/json`), session duration; make logs tamper-evident.
6. **Session controls**: authn + step-up (re-auth/MFA) for terminal, per-user RBAC, idle timeout, concurrent-session cap, rate-limit exec creation.
7. **Record output** or at least command history for forensics; redact known secret patterns in the UI.
8. Gate the whole feature behind an explicit config flag, **off by default**.

---

## D. Hardening the panel's own container

Even with Option 4, the broker (and any tier that ever touches Docker) must be hardened. `privileged: true` must **never** be used — it discards seccomp/AppArmor/cap limits and is a documented escape enabler. `[CONFIRMED: OWASP RULE #3 "Do not run containers with the --privileged flag!!!"]`

**Copy-paste `compose.yaml` for the web backend (NO socket):**

```yaml
services:
  panel-web:
    image: your/panel-web:pinned-digest      # pin by @sha256:, not :latest
    read_only: true                            # RULE #8
    user: "10001:10001"                        # non-root; RULE #2
    cap_drop: [ALL]                            # RULE #3
    security_opt:
      - no-new-privileges:true                 # RULE #4
      # - apparmor=docker-default  (default)   # RULE #6
      # - seccomp=default          (default)   # RULE #6
    tmpfs:
      - /tmp:size=64m,mode=1777                # writable scratch since read_only
      - /run:size=8m
    # app-writable state -> named volume, not a host bind:
    volumes:
      - panel-data:/data
    mem_limit: 256m
    pids_limit: 200                            # RULE #7
    cpus: "0.5"
    restart: unless-stopped
    networks: [frontend, brokernet]            # reaches broker over private net
    # NO /var/run/docker.sock anywhere
volumes: { panel-data: {} }
networks:
  frontend: {}
  brokernet: { internal: true }                # broker net has no egress
```

Notes `[CONFIRMED: OWASP rules cited; INFERRED for exact tmpfs list]`:
- **`read_only: true`** requires writable tmpfs for anything the process writes: typically `/tmp` and `/run`; Node also needs a writable dir if it writes logs/caches — send those to a named volume or tmpfs. Node 24 itself runs fine read-only.
- **`cap_drop: ALL`** — a Node HTTP service needs **no** Linux capabilities (it binds a high port). If you must bind <1024, prefer a high port + reverse proxy rather than adding `NET_BIND_SERVICE`.
- **`no-new-privileges:true`** blocks SUID/`setcap` escalation inside the container. `[CONFIRMED: OWASP RULE #4]`
- **seccomp/AppArmor**: keep Docker's **defaults** (`seccomp=default`, `apparmor=docker-default`) — do **not** pass `seccomp=unconfined`/`apparmor=unconfined`. Defaults block the syscalls used in cgroup/mount escapes (mitigates CVE-2022-0492). `[CONFIRMED: https://docs.docker.com/engine/security/seccomp/ , /apparmor/ ; https://unit42.paloaltonetworks.com/cve-2022-0492-cgroups/]`
- **Resource limits** (`mem_limit`,`cpus`,`pids_limit`) bound DoS. `[CONFIRMED: OWASP RULE #7]`

**The broker** (the only thing with the socket) gets the same hardening **plus**: its own network is `internal: true` (no internet path to it); mount the socket **read-write only if it must issue writes** — a monitoring-only broker should use a `docker-socket-proxy` with `POST=0` (B.4) instead of the raw socket; keep the broker image minimal (distroless/scratch) and its code tiny and audited.

**userns-remap caveat when mounting the socket:** enabling `--userns-remap` remaps container root to an unprivileged host UID, but a container that **mounts the docker socket is unaffected** — it talks to the (still-root) daemon and can create containers with `--userns=host`, so userns-remap does **not** contain a socket-bearing container. Also, userns-remap is **incompatible** with `--privileged` (without `--userns=host`), with sharing host PID/NET namespaces, and with volume-drivers unaware of the mapping; external/named-volume file ownership must be pre-arranged. `[CONFIRMED: https://docs.docker.com/engine/security/userns-remap/]` Net: userns-remap helps the *containers Docker runs*, not a container that *holds the socket* — another reason the web tier must have no socket at all.

---

## E. Node.js client: `dockerode` vs raw HTTP-over-unix-socket

| Criterion | `dockerode` (+`@types/dockerode`) | Raw `http`/`undici` over unix socket |
|---|---|---|
| Version / maintenance | v5.0.1, actively maintained, ~5M downloads/wk `[CONFIRMED: https://snyk.io/advisor/npm-package/dockerode]` | N/A (stdlib / `undici` is Node core-adjacent, very active) |
| License | **Apache-2.0** `[CONFIRMED: package.json]` | MIT (Node) / MIT (`undici`) |
| Runtime deps | `docker-modem`, `@balena/dockerignore`, `@grpc/grpc-js`, `@grpc/proto-loader`, `protobufjs`, `tar-fs` `[CONFIRMED: package.json]` — grpc+protobufjs+tar-fs are heavyweight and only needed for BuildKit/Swarm/build-context, which we don't use | Zero extra deps (or just `undici`) |
| Streaming / hijack | Yes — `docker-modem` handles the 101/hijack, `follow` logs, and demux (`modem.demuxStream`) `[CONFIRMED: docker-modem is the transport]` | You implement 101-upgrade handling + the A.2 8-byte demux yourself `[INFERRED]` |
| TypeScript types | External `@types/dockerode` (DefinitelyTyped), decent but can lag the API `[CONFIRMED: https://snyk.io/advisor/npm-package/@types/dockerode]` | You write exact types for only the ~20 ops you use — smaller, precise |
| Known CVEs | none critical open on dockerode core; watch transitive `tar-fs` (past path-traversal advisories — pin ≥2.1.4, present) `[CONFIRMED: package.json pins ^2.1.4; https://security.snyk.io/package/npm/dockerode]` | Attack surface = your code + `undici` (well-audited) |
| Unix socket support | `new Docker({socketPath:'/var/run/docker.sock'})` | `http.request({socketPath})` or `undici` with a `Client('unix://…')`/socketPath dispatcher |

**Recommendation:** For a broker that speaks the raw Docker API, **`dockerode` is the pragmatic default** on Node 24 — Apache-2.0 is fine for OSS, it correctly implements the tricky hijack/demux for exec and `follow` logs (the part most likely to have subtle bugs if hand-rolled), and it's widely battle-tested. Mitigate its downsides: pin by lockfile, run `npm audit`/Snyk on the `tar-fs`/grpc transitives, and add `@types/dockerode`. **However**, since our surface is tiny (~20 read ops + a handful of writes) and we want minimal dependencies in a privileged broker, a **thin `undici`-based client is a defensible, lighter alternative** — the only non-trivial code is the A.2 demux and 101-upgrade handling, both fully specified above. **Decision rule:** if the broker needs interactive **exec/attach** streaming, use `dockerode` (don't hand-roll hijack); if the broker is **read-only/monitoring** (logs `follow`, stats, events, inspect), a small `undici` client keeps the privileged component minimal and dependency-light. `[INFERRED synthesis]`

---

## Relevant CVEs (socket/exec escape context)

| CVE | What | Mitigation relevant to us |
|---|---|---|
| **CVE-2019-5736** | runc `/proc/self/exe` overwrite → host runc replaced → host root, triggered by `exec`/run into a malicious/attacker-controlled container | Patched runc; **read-only host runc**; non-root user / userns; SELinux. Relevance: our exec-into-container feature is exactly the trigger class. `[CONFIRMED: https://unit42.paloaltonetworks.com/breaking-docker-via-runc-explaining-cve-2019-5736/]` |
| **CVE-2024-21626** ("Leaky Vessels") | runc leaks host-cwd fd (fd/7); `WORKDIR`/`cwd=/proc/self/fd/7` lands process in host FS → escape | runc ≥1.1.12; don't run untrusted images; SELinux/AppArmor. `[CONFIRMED: https://access.redhat.com/security/vulnerabilities/RHSB-2024-001]` |
| **CVE-2022-0492** | cgroup-v1 `release_agent` missing `CAP_SYS_ADMIN` check → escape from a container that can mount cgroupfs (e.g. via user-namespaces/`unshare`) | Kernel patch (≥5.17-rc3); **keep AppArmor/SELinux + seccomp defaults** (they block the mount) — hence never `--privileged`/`seccomp=unconfined`. `[CONFIRMED: https://unit42.paloaltonetworks.com/cve-2022-0492-cgroups/]` |
| **CVE-2026-6406** | Docker Desktop ECI bypass — `--use-api-socket` mounts docker.sock via `HostConfig.Mounts`, ECI only checked `HostConfig.Binds` → socket smuggled in | Update Docker Desktop; reinforces that path/field-level allowlists (Binds vs Mounts) are bypass-prone — **another argument against relying on body/path filters** rather than a no-socket design. `[CONFIRMED: https://www.sentinelone.com/vulnerability-database/cve-2026-6406/]` |

---

## Sources

- Docker Engine API reference & version history — https://docs.docker.com/reference/api/engine/ · https://docs.docker.com/reference/api/engine/version-history/ · https://docs.docker.com/reference/api/engine/version/v1.55/
- Moby swagger (v1.55) — https://raw.githubusercontent.com/moby/moby/master/api/swagger.yaml
- Docker security — https://docs.docker.com/engine/security/ · /protect-access/ · /rootless/ · /userns-remap/ · /seccomp/ · /apparmor/
- `tecnativa/docker-socket-proxy` — https://github.com/Tecnativa/docker-socket-proxy · haproxy.cfg: https://raw.githubusercontent.com/Tecnativa/docker-socket-proxy/master/haproxy.cfg
- OWASP Docker Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html
- HackTricks — Abusing Docker Socket — https://book.hacktricks.wiki/en/linux-hardening/privilege-escalation/docker-security/abusing-docker-socket-for-privilege-escalation.html
- AuthZ plugins — https://github.com/twistlock/authz · https://github.com/casbin/docker-casbin-plugin
- dockerode — https://github.com/apocas/dockerode · https://snyk.io/advisor/npm-package/dockerode · https://security.snyk.io/package/npm/dockerode
- CVEs — https://access.redhat.com/security/vulnerabilities/RHSB-2024-001 · https://unit42.paloaltonetworks.com/cve-2022-0492-cgroups/ · https://unit42.paloaltonetworks.com/breaking-docker-via-runc-explaining-cve-2019-5736/ · https://www.sentinelone.com/vulnerability-database/cve-2026-6406/
