# Mail Stack Components — Real Data Sources for the Web Admin Panel

Scope: what `docker exec`-reachable commands and internal HTTP services in a `docker-mailserver` container can
actually produce, so the admin panel only surfaces UI for data that is real, machine-readable, and won't break on
day one. Tags: `[CONFIRMED: url]` = pulled from an official doc source this session, `[INFERRED]` = consistent
with docs/well-established behavior but not verified verbatim against an authoritative page this session,
`[UNCERTAIN]` = genuinely unresolved, needs a runtime test against the real container before you build UI on it.

---

## Executive summary — the five starred questions

**★1. Rspamd controller API.** Real HTTP JSON API on port **11334** `[CONFIRMED: docs.rspamd.com/workers/controller]`.
`/stat` (GET, read-only) is real and returns scan/learn counters and an `actions` breakdown, but this session could
not pull the verbatim field list from an official page — treat the exact key names as `[INFERRED]` and confirm with
one `curl` against the running container before wiring a dashboard to specific keys. `/history` (GET) is real but is
an **in-memory ring buffer, NOT persisted across restarts by default**, capped at `history_rows = 200` entries
`[INFERRED, converging searches]`; a Redis-backed history module exists but is opt-in, not default
`[CONFIRMED: docs.rspamd.com/modules/history_redis/]`. `/errors`, `/symbols`, `/actions`, `/graph` are GET/read-only.
`/checkv2` is POST (scans a message, does not mutate state) and its response schema (`action`, `score`,
`required_score`, `symbols[]`) IS confirmed `[CONFIRMED: docs.rspamd.com/developers/protocol]`.
`/learnspam` and `/learnham` are POST and **are mutating** (train the Bayes classifier). Auth is a `Password` HTTP
header (or query string); there are two privilege tiers — `password` for read-only commands, `enable_password` for
mutating ones (map edits, learning, config changes) `[CONFIRMED: docs.rspamd.com/workers/controller + GitHub issue #4186]`.

**★2. ClamAV.** Running status, `VERSION`, and `STATS` are all real clamd protocol commands you can hit directly
over its control socket (no shell parsing needed) `[CONFIRMED: docs.clamav.net/manual/Usage/ClamdProtocol.html]`.
`STATS` is explicitly documented as unstable free-text, not a fixed schema — parse defensively.
**Virus-detection counting: there is no counter endpoint or persistent stats store in ClamAV/clamd for "N viruses
found."** `STATS` reports queue/thread/memory state, not detection totals. The only way to get a virus-count metric
is parsing clamd/freshclam/maillog log lines (or your own MDA's "REJECT"/"virus found" log lines) — confirmed
honestly negative `[INFERRED from protocol docs — no counter command exists]`.

**★3. `postqueue -j`.** Real, and it IS JSON — specifically **JSON Lines: one JSON object per line, one line per
queue file** `[CONFIRMED: postfix.org/postqueue.1.html]`. Confirmed field names: `queue_name`, `queue_id`,
`arrival_time`, `message_size`, `forced_expire`, `sender`, `recipients[]` (each with `address`, `orig_address`,
`delay_reason`, `bounce_reason`). Per-queue counts (incoming/active/deferred/hold) are obtained by counting/filtering
these JSON lines by `queue_name` yourself — there's no separate "counts" endpoint. `postqueue -f` (flush) and
`postsuper -d/-h/-H/-r` are **all mutating**; `-d` (delete) and `-h` (hold) and `-H` (release from hold) and `-r`
(requeue) are destructive/state-changing and should require confirmation in the UI.

**★4. `doveadm pw`.** Schemes SHA512-CRYPT, ARGON2ID, BLF-CRYPT are all real via `-s SCHEME`
`[CONFIRMED: doc.dovecot.org/main/core/man/doveadm-pw.1.html]`. **Argv-safety is `[UNCERTAIN]` and security-critical
enough that you must test it, not assume it.** What's confirmed: `-p password` puts the plaintext in argv (visible
via `ps`/`docker top`) — avoid it. Without `-p`, doveadm prompts interactively ("Enter new password:" /
"Retype new password:"). Docker-mailserver's own documented recipe still uses `-p "$MAIL_PASS"` from a shell
`[INFERRED from search of docker-mailserver docs]`, i.e. even upstream doesn't demonstrate an argv-free path. This
session could not confirm whether the interactive prompt reads a piped/non-tty stdin (common for C `getpass()`-style
prompts to require `/dev/tty` and reject plain stdin) — **verify empirically**: `printf 'pw\npw\n' | docker exec -i
<container> doveadm pw -s SHA512-CRYPT`. If that fails, the pragmatic argv-avoidance fallback is `docker exec -e
DOVEADM_PW=... <container> sh -c 'doveadm pw -s SHA512-CRYPT -p "$DOVEADM_PW"'` — exec-scoped env vars aren't in
`ps` output (they live in `/proc/<pid>/environ`, root/owner-readable only), which is a real reduction in exposure
even though it isn't zero.

**★5. Sieve vacation with start/end dates — this is REAL, confirmed, definitive syntax exists.** Pigeonhole
implements RFC 5260's `date`/`currentdate` extension (v0.1.12+) `[INFERRED from search of doc.dovecot.org, RFC
5260 confirmed CONFIRMED: rfc-editor.org/rfc/rfc5260.html]`, and combining it with `vacation` (RFC 5230) via
`if allof(...)` is the documented, standard pattern for windowed autoresponders:

```sieve
require ["date", "relational", "vacation"];
if allof(
    currentdate :value "ge" "date" "2026-08-01",
    currentdate :value "le" "date" "2026-08-15"
) {
    vacation :days 7 :subject "Out of office"
        "I am away and will respond when I return.";
}
```

This is a real, buildable feature: generate this exact `if allof(currentdate :value "ge" ... currentdate :value "le"
...) { vacation ... }` pattern server-side, push it with `doveadm sieve put` / ManageSieve, and activate it. Do NOT
build UI implying base `vacation` alone supports start/end dates — it doesn't; the date window comes entirely from
wrapping it in a `currentdate` condition.

---

## 1. Rspamd controller HTTP API

Default controller port: **11334** `[CONFIRMED: docs.rspamd.com/workers/controller]`. Base URL from inside the
container: `http://127.0.0.1:11334`.

### Auth model

`[CONFIRMED: docs.rspamd.com/workers/controller]` `[CONFIRMED: github.com/rspamd/rspamd issues #2112, #4186]`

- Every privileged (state-changing) request needs a `Password` HTTP header (or `?password=` query string) matching
  the `enable_password` config value.
- Read-only requests need a `Password` matching the (lower-privilege) `password` config value — if only one password
  is configured, it's used for both tiers.
- `secure_ip` in the controller config whitelists IPs (e.g. `127.0.0.1`) to skip auth entirely — this is the
  realistic path for a container-internal admin panel talking to `127.0.0.1:11334`, avoiding password management.
- Example: `curl -H "Password: xxx" http://localhost:11334/symbols`.

### Endpoint surface

`[CONFIRMED: docs.rspamd.com/workers/controller — endpoint names]`, methods/response-field detail mostly `[INFERRED]`
unless noted — **verify field names with a live `curl` before binding UI to specific keys.**

| Endpoint                                     | Method | Mutating?            | Notes                                                                                                                                       |
| -------------------------------------------- | ------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/stat`                                      | GET    | No                   | Scan/learn counters + actions breakdown. Exact field list `[INFERRED]` — see below.                                                         |
| `/statreset`                                 | GET    | **Yes** (privileged) | Resets the counters `/stat` reports. Useful "since last reset" semantics, but resets shared global state — don't expose this to non-admins. |
| `/history`                                   | GET    | No                   | Recent message verdicts (see below).                                                                                                        |
| `/historyreset`                              | GET    | **Yes** (privileged) | Clears the in-memory history ring buffer.                                                                                                   |
| `/errors`                                    | GET    | No                   | Recent internal error log entries (privileged read) `[INFERRED]`.                                                                           |
| `/symbols`                                   | GET    | No                   | Lists all loaded rule symbols, weights, descriptions, groups.                                                                               |
| `/actions`                                   | GET    | No                   | Current score thresholds per action (greylist/add-header/reject/etc).                                                                       |
| `/graph`                                     | GET    | No                   | Time-series data backing the WebUI throughput graph.                                                                                        |
| `/pie`                                       | GET    | No                   | Action-distribution data backing the WebUI pie chart.                                                                                       |
| `/checkv2`                                   | POST   | No (scans only)      | Full scan of a submitted message. Response is documented JSON — see below.                                                                  |
| `/scan`, `/check`                            | POST   | No                   | Older/alternate scan endpoints; `/checkv2` is the current one to use.                                                                       |
| `/learnspam`                                 | POST   | **Yes**              | Trains Bayes as spam. Body = raw message. Optional `Classifier` header.                                                                     |
| `/learnham`                                  | POST   | **Yes**              | Trains Bayes as ham. Same shape as `/learnspam`.                                                                                            |
| `/fuzzyadd` / `/fuzzydel` / `/fuzzydelhash`  | POST   | **Yes**              | Fuzzy-hash storage management — mutating, privileged.                                                                                       |
| `/saveactions` / `/savesymbols` / `/savemap` | POST   | **Yes**              | Persist config changes (thresholds, symbol weights, maps) to disk.                                                                          |
| `/maps` / `/getmap`                          | GET    | No                   | List/read configured maps (e.g. whitelists).                                                                                                |
| `/counters`                                  | GET    | No                   | Per-symbol hit counters (how often each rule fired).                                                                                        |
| `/metrics`                                   | GET    | No                   | Prometheus-format metrics exposition (if enabled) — likely your best bet for a stable, versioned schema instead of scraping `/stat`.        |

### `/checkv2` response — the one fully confirmed schema

`[CONFIRMED: docs.rspamd.com/developers/protocol]`

```json
{
  "score": 5.2,
  "required_score": 15.0,
  "action": "add header",
  "symbols": {
    "BAYES_SPAM": { "name": "BAYES_SPAM", "score": 3.0, "options": ["..."] }
  },
  "subject": "...",
  "urls": ["..."],
  "emails": ["..."],
  "message-id": "..."
}
```

`action` is one of: `no action`, `greylist`, `add header`, `rewrite subject`, `soft reject`, `reject`.

### `/stat` — what determines your spam-statistics UI

Confirmed to exist and to be GET/read-only `[CONFIRMED: docs.rspamd.com/workers/controller]`. A partial field list
surfaced from a real deployment example: `scanned`, `learned`, `connections`, `control_connections`
`[INFERRED — search snippet quoting `{"scanned":0,"learned":0,"connections":0,"control_connections":0}`, not an
official schema page]`. Widely-reported (but **not independently verified this session**) additional fields include
`actions` (object keyed by action name → count), `ham_count`, `spam_count`, `bayes_stat` / `statfiles[]` (per
Bayes-classifier learned counts), `version`, `uptime`, `pools`. **Recommendation: don't hardcode this field list into
UI code — hit `/stat` on the running container once during implementation, snapshot the real JSON, and build the
dashboard against confirmed keys only.** `rspamc stat` (CLI) hits the same endpoint and is a zero-effort way to get
a real sample: `docker exec <container> rspamc stat`.

### `/history` — persistence and retention

`[INFERRED, converging evidence]`: history is an **in-memory ring buffer**, default size **`history_rows = 200`**
entries (`options.inc` default) `[INFERRED: fossies.org mirror of rspamd conf/options.inc + GitHub issue #3779]`.
This does **not survive a controller/rspamd restart** — there is no on-disk persistence by default. A separate,
opt-in **Redis history module** (`history_redis`, default `nrows = 200`) exists specifically to make history survive
restarts by writing it to Redis `[CONFIRMED: docs.rspamd.com/modules/history_redis/]` — its existence as a distinct
add-on module is itself evidence the default in-memory history is not persistent. **Practical implication: don't
promise a "spam history" chart that survives a container restart unless you've confirmed `history_redis` is
enabled** (docker-mailserver does not enable this by default, to the best of available evidence — verify in the
actual rspamd config shipped in the image).

Sources: docs.rspamd.com/workers/controller `[CONFIRMED]`, docs.rspamd.com/developers/protocol `[CONFIRMED]`,
docs.rspamd.com/developers/controller_endpoints/ `[CONFIRMED, partial]`, docs.rspamd.com/modules/history_redis/
`[CONFIRMED]`, github.com/rspamd/rspamd/blob/master/doc/rspamc.1.md `[CONFIRMED]`.

---

## 2. ClamAV

### Status, version, signature info — all via the clamd control socket protocol

`[CONFIRMED: docs.clamav.net/manual/Usage/ClamdProtocol.html]`

| Command                 | Purpose                          | Notes                                                                                                                                                                                                                                                              |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PING`                  | Health check                     | Healthy daemon replies `PONG`. Enabled by default.                                                                                                                                                                                                                 |
| `VERSION`               | Program + DB version             | Reply format (well-established, `[INFERRED]` exact string): `ClamAV 0.103.x/27xxx/Day Mon DD HH:MM:SS YYYY` — i.e. engine version / signature DB version number / DB build date, all in one line. Disable-able via `EnableVersionCommand`.                         |
| `VERSIONCOMMANDS`       | Version + supported command list | Good for capability-probing before calling privileged commands.                                                                                                                                                                                                    |
| `STATS`                 | Queue/thread/memory diagnostics  | **Explicitly documented as an unstable format** — "parse it as diagnostic text, not a fixed schema" `[CONFIRMED: docs.clamav.net]`. Typical shape includes `POOLS:`, `STATE:`, `THREADS: live N idle N max N idle-timeout N`, `QUEUE: N items`, plus memory stats. |
| `RELOAD`                | Reload signature DB              | Mutating (privileged in some configs).                                                                                                                                                                                                                             |
| `SHUTDOWN`, `SELFCHECK` | Admin ops                        | Mutating/administrative, only if enabled in `clamd.conf`.                                                                                                                                                                                                          |

Practical way to hit these from a `docker exec` argv array: use `clamdscan --ping`/`--version` (wraps the socket
protocol) or talk to the Unix socket directly (e.g. `echo VERSION | socat - UNIX-CONNECT:/var/run/clamav/clamd.ctl`,
or a tiny Node/`nc` one-liner) — no log-scraping needed for these three facts.

**Freshclam (signature updates):** `freshclam --version` and the freshclam log/state file report last-update
timestamp; `sigtool --info main.cvd` (or `daily.cvd`/`.cld`) gives per-database build time and version number
`[INFERRED — standard ClamAV tooling behavior, not verified verbatim against a live output this session]`. Treat
exact flag names as needing a one-time confirmation run inside the target image.

### Counting virus detections — honest answer

**No.** There is no clamd command or persistent counter for "number of viruses detected." `STATS` covers
queue/thread/memory, not detection history. **Log parsing (clamd's own log, or the MTA/milter log line recording a
rejection because ClamAV flagged the message) is the only route to a virus-detection count**
`[INFERRED from the absence of any such command in the protocol docs — a negative claim, flagged honestly per the
task's request]`. Build the UI feature as "detections, parsed from logs" — not as a live counter — or don't build it.

Sources: docs.clamav.net/manual/Usage/ClamdProtocol.html `[CONFIRMED]`, docs.clamav.net/manual/Usage/Scanning.html
`[CONFIRMED, partial]`, docs.clamav.net/manual/Usage/SignatureManagement.html `[CONFIRMED, partial — didn't yield
exact version-check command text]`.

---

## 3. `postqueue -j` and queue operations

`[CONFIRMED: postfix.org/postqueue.1.html]`

`postqueue -j` emits **JSON Lines** — one JSON object per queue file, one line each, no wrapping array. Confirmed
field names:

| Field           | Meaning                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `queue_name`    | Which queue the file is in (`incoming`, `active`, `deferred`, `hold`) — **this is your per-queue-count field**, just tally by this key. |
| `queue_id`      | The queue file ID (matches the ID in maillog lines).                                                                                    |
| `arrival_time`  | Seconds since epoch.                                                                                                                    |
| `message_size`  | Bytes.                                                                                                                                  |
| `forced_expire` | Bool, Postfix ≥ 3.5.                                                                                                                    |
| `sender`        | Envelope sender.                                                                                                                        |
| `recipients[]`  | Array of `{ address, orig_address (≥3.11), delay_reason, bounce_reason (≥3.11) }`.                                                      |

Sample line shape (field names confirmed, values illustrative) `[INFERRED formatting example around CONFIRMED
field names]`:

```json
{
  "queue_name": "deferred",
  "queue_id": "4Xk2mP1abc",
  "arrival_time": 1755123456,
  "message_size": 2345,
  "forced_expire": false,
  "sender": "a@example.com",
  "recipients": [{ "address": "b@example.org", "delay_reason": "connection timed out" }]
}
```

Per-queue counts: run `postqueue -j`, group-count by `queue_name`. There's no separate "give me counts only" flag —
you always get full line items, which is fine since it's cheap to count client-side.

### Queue operations — mutating vs destructive

`[CONFIRMED: postfix.org/postqueue.1.html general behavior]` `[INFERRED for postsuper specifics — standard, very
stable Postfix behavior]`

| Command                                 | Effect                                        | Destructive?                                                                                                                                     |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `postqueue -f`                          | Force delivery attempt of all queued mail now | Mutating (triggers real delivery attempts); docs explicitly warn frequent flushing hurts overall delivery performance — throttle this in the UI. |
| `postsuper -r <queue_id>`               | Requeue (re-evaluate) a message               | Mutating, not destructive — recoverable.                                                                                                         |
| `postsuper -h <queue_id>`               | Put message on hold                           | Mutating, recoverable (reversed by `-H`).                                                                                                        |
| `postsuper -H <queue_id>`               | Release message from hold                     | Mutating, recoverable.                                                                                                                           |
| `postsuper -d <queue_id>` (or `-d ALL`) | **Delete** message from queue                 | **Destructive, irreversible.** Require explicit confirmation in UI; never expose `-d ALL` behind a single click.                                 |

---

## 4. `doveadm pw`

`[CONFIRMED: doc.dovecot.org/main/core/man/doveadm-pw.1.html]` for flags/schemes; argv-safety is `[UNCERTAIN]`,
see the starred summary above for the full reasoning — repeating the essentials here:

| Flag          | Purpose                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `-s SCHEME`   | Hash scheme: `SHA512-CRYPT`, `ARGON2ID`, `BLF-CRYPT`, `SHA256-CRYPT`, `CRYPT` (default, bcrypt `$2y$` form), etc.                           |
| `-p password` | Plaintext password inline — **appears in argv, visible to `ps`/`docker top` on the host.** Avoid for anything beyond one-off local testing. |
| `-r rounds`   | Cost factor for BLF-CRYPT/SHA{256,512}-CRYPT.                                                                                               |
| `-V`          | Verify the generated hash internally.                                                                                                       |
| `-t hash`     | Test a plaintext password against an existing hash (verification mode).                                                                     |
| _(no flag)_   | Interactive prompt: `Enter new password:` / `Retype new password:`.                                                                         |

Example: `doveadm pw -s SHA512-CRYPT` → `{SHA512-CRYPT}$6$...`. `doveadm pw -s ARGON2ID` →
`{ARGON2ID}$argon2id$v=19$m=65536,t=3,p=1$...`.

**Unresolved and worth a 5-minute empirical check before you build the "create/reset password" feature:** whether
the interactive prompt path can be fed via piped/non-tty stdin (`docker exec -i`) instead of a real TTY. If it
requires `/dev/tty` (common for C password prompts, by design, precisely so stdin remains free for piping other
data — see `openssl passwd -stdin` needing an explicit flag for the same reason), then piping won't work and you're
choosing between `-p` (argv-visible) or `docker exec -e VAR=... ... sh -c 'doveadm pw -p "$VAR"'` (env-visible only
to same-UID/root via `/proc/<pid>/environ`, materially better than argv but still not perfect secrecy).
Docker-mailserver's own documented account-creation recipe uses the `-p "$MAIL_PASS"` shell-env-var form, not a
stdin form `[INFERRED from docker-mailserver docs search]` — suggesting the project itself doesn't rely on stdin
piping working.

Source: doc.dovecot.org/main/core/man/doveadm-pw.1.html `[CONFIRMED]`, doc.dovecot.org/main/core/config/auth/schemes.html
(scheme list) `[CONFIRMED, not individually re-fetched this session — cited from search index]`.

---

## 5. Sieve vacation with start/end dates

**Definitively real.** Two RFCs compose to make this work, and Pigeonhole (Dovecot's Sieve engine) implements both:

- **RFC 5230** — the base `vacation` extension (`:days`, `:subject`, `:addresses`, `:from`, `:handle`, `:mime`).
- **RFC 5260** — the `date`/`currentdate` extension, giving Sieve the `currentdate` test, which can compare "now"
  against a literal date using relational operators (`:value "ge"/"le"/"gt"/"lt"` etc against a `"date"` typed
  value) `[CONFIRMED: rfc-editor.org/rfc/rfc5260.html]`. Pigeonhole supports this extension (documented as
  supported since v0.1.12) `[INFERRED from doc.dovecot.org search result snippet — page itself wasn't fetchable
with full text this session]`.

The base `vacation` command alone has **no start/end date syntax** — `:days` only controls the _response
suppression interval_ (don't re-send to the same sender within N days), not a calendar window. The window comes
entirely from wrapping `vacation` in an `if allof(currentdate ..., currentdate ...)` condition. This is a
widely-attested, standard pattern (RFC 5260 itself uses vacation+currentdate as its motivating example):

```sieve
require ["date", "relational", "vacation"];

if allof(
    currentdate :zone "+0000" :value "ge" "date" "2026-08-01",
    currentdate :zone "+0000" :value "le" "date" "2026-08-15"
) {
    vacation :days 7
             :subject "Out of office"
             :addresses ["me@example.com"]
             "I'm away until Aug 15 and will reply when I'm back.";
}
```

`[CONFIRMED pattern via RFC 5260 + corroborating community examples found this session (spinics.net/info-cyrus
thread, RFC draft text)]`. Notes for implementation:

- All `currentdate` tests in one script must be evaluated against the same instant (guaranteed by the spec) — safe
  to use multiple `currentdate` tests in one `allof`.
- `:zone` lets you pin evaluation to a specific UTC offset instead of server-local time — worth exposing as a
  setting if users are in different timezones than the mail server.
- To actually activate this, generate the script server-side and push it via `doveadm sieve put -u <user> <name>`
  then `doveadm sieve activate -u <user> <name>` (or the ManageSieve protocol — see §6).

**Bottom line for the "is this feature real" gate: yes, build it.** The UI claim "autoresponder with start and end
date" is accurate and backed by real, standard Sieve syntax — not a Dovecot extension quirk, not vendor-specific.

---

## 6. Dovecot `doveadm` — quota, mailbox, who, sieve, stats

Output formatters `[CONFIRMED: doc.dovecot.org/main/core/man/doveadm-quota.1.html,
doc.dovecot.org/main/core/man/doveadm-who.1.html]`: doveadm supports a global `-f FORMATTER` flag with formatters
**`table`** (default, human-aligned), **`tab`** (tab-separated, header row), **`json`** (JSON array of objects),
**`flow`** (`key=value` per line), and **`pager`**. This is real and verified against two separate man pages — safe
to build UI parsing around `-f json` output.

| Command                    | Syntax                                                                                                                                                                                    | Output                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quota, all users           | `doveadm quota get -A`                                                                                                                                                                    | Rows: quota name / type (`STORAGE`,`MESSAGE`) / value / limit / %.                                                                                                                                            |
| Quota, one user            | `doveadm quota get -u <user>`                                                                                                                                                             | Same columns, one user.                                                                                                                                                                                       |
| Quota, user list from file | `doveadm quota get -F <file>`                                                                                                                                                             | Batch form.                                                                                                                                                                                                   |
| Mailbox list               | `doveadm mailbox list [-s] [-A \| -u user] [pattern]`                                                                                                                                     | Mailbox names; `-s` = subscribed only; `-7`/`-8` control mUTF-7 vs UTF-8 encoding of names.                                                                                                                   |
| Mailbox status             | `doveadm mailbox status [-u user] <fields> <mailbox>`                                                                                                                                     | Fields (space-separated arg, pick any): `messages`, `recent`, `unseen`, `uidnext`, `uidvalidity`, `vsize`, `guid`, `highestmodseq`, `deleted`, `firstsaved`, or `all`. `-t` totals across multiple mailboxes. |
| Connected sessions         | `doveadm who [-1] [user_mask] [ip[/bits]]`                                                                                                                                                | Columns: `username`, `#` (connection count), `proto` (imap/pop3/sieve/lmtp), `(pids)`, `(ips)`. `-1` = one row per connection instead of grouped.                                                             |
| Sieve scripts              | `doveadm sieve list -u <user>` / `sieve get -u <user> <name>` / `sieve put -u <user> <name>` (reads script from stdin) / `sieve activate -u <user> <name>` / `sieve deactivate -u <user>` | `put -a` activates immediately on upload.                                                                                                                                                                     |
| Stats                      | `doveadm stats dump [-f formatter] [table]`                                                                                                                                               | Dumps internal Dovecot stats counters/tables (connections, commands, etc).                                                                                                                                    |

Example (confirmed shape): `doveadm who` →

```
username                       # proto (pids)        (ips)
jane                           2 imap  (30155 30412) (::1)
john@example.com               1 imap  (30257)       (192.0.2.34)
```

### ManageSieve vs `doveadm sieve`

ManageSieve (RFC 5804) listens on **port 4190** by default `[CONFIRMED: doc.dovecot.org/main/core/config/sieve/managesieve.html

- IANA registration]`. For a `docker exec`-based admin panel, **prefer `doveadm sieve put/get/list/activate`over
ManageSieve** — it's a local CLI call with no extra network/auth surface to manage, works the same over`docker
  exec`'s argv array, and doesn't require opening/authenticating a second protocol. Reach for ManageSieve only if the
  panel needs to let _end users_ (not the admin) edit their own filters directly from a browser-based Sieve editor
  talking straight to Dovecot.

---

## 7. Postfix logs

`postconf` output formats `[CONFIRMED: postfix.org/postconf.1.html]`:

- `postconf -n` → only explicitly-set `main.cf` params, `key = value`, one per line.
- `postconf -d` → same shape but _default_ values instead of active ones (diffing `-n` vs `-d` tells you what an
  admin actually changed).
- `postconf -M` → `master.cf` service entries in structured form; filterable by service name / `name/type`
  (e.g. `postconf -Mf smtp/inet`).

All three are clean, stable, line-oriented, and trivial to parse — good candidates for a "current config" panel.

### Sample log lines

`[INFERRED — standard, extremely stable Postfix log format across versions; general shape/fields corroborated by
live search results this session (forums.freebsd.org, postfix bounce(8) docs) showing real `status=deferred`/
`status=sent` lines with the same field set]`:

```text
# Accepted from a client (smtpd)
Aug 15 10:22:31 mail postfix/smtpd[12345]: 4F2Tt2Q3Zbz1abc: client=unknown[203.0.113.5]

# Queued
Aug 15 10:22:31 mail postfix/cleanup[12350]: 4F2Tt2Q3Zbz1abc: message-id=<abc123@example.com>
Aug 15 10:22:31 mail postfix/qmgr[987]: 4F2Tt2Q3Zbz1abc: from=<sender@example.com>, size=2345, nrcpt=1 (queue active)

# Delivered
Aug 15 10:22:32 mail postfix/smtp[12360]: 4F2Tt2Q3Zbz1abc: to=<user@destination.com>, relay=mx.destination.com[198.51.100.9]:25, delay=1.2, delays=0.1/0.02/0.5/0.58, dsn=2.0.0, status=sent (250 2.0.0 OK)

# Deferred
Aug 15 10:25:10 mail postfix/smtp[12370]: 4F2Tt2Q3Zbz1abc: to=<user@destination.com>, relay=none, delay=1.5, delays=1.5/0/0/0, dsn=4.4.1, status=deferred (connect to mx.destination.com[198.51.100.9]:25: Connection timed out)

# Bounced
Aug 15 10:30:00 mail postfix/smtp[12380]: 4F2Tt2Q3Zbz1abc: to=<baduser@destination.com>, relay=mx.destination.com[198.51.100.9]:25, delay=0.9, delays=0.1/0.01/0.3/0.49, dsn=5.1.1, status=bounced (host mx.destination.com[198.51.100.9] said: 550 5.1.1 <baduser@destination.com>: Recipient address rejected: User unknown)

# Rejected (policy/RBL, pre-queue — note NOQUEUE, no queue id assigned)
Aug 15 10:31:00 mail postfix/smtpd[12390]: NOQUEUE: reject: RCPT from unknown[203.0.113.99]: 554 5.7.1 Service unavailable; Client host [203.0.113.99] blocked using zen.spamhaus.org; from=<spammer@example.net> to=<user@ourdomain.com> proto=ESMTP helo=<x>

# TLS established (inbound)
Aug 15 10:22:31 mail postfix/smtpd[12345]: Anonymous TLS connection established from unknown[203.0.113.5]: TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits)

# TLS established (outbound)
Aug 15 10:22:32 mail postfix/smtp[12360]: Trusted TLS connection established to mx.destination.com[198.51.100.9]:25: TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits) key-exchange X25519 server-signature RSA-PSSSHA256
```

Reliably extractable per event: **queue id** (e.g. `4F2Tt2Q3Zbz1abc`, absent/`NOQUEUE` for pre-queue rejects),
**from/to**, **status** (`sent`/`deferred`/`bounced`), **dsn** code, **relay** (host + IP + port, or `none`),
**delay** and **delays** (4-part breakdown: before-queue/queue-manager/connection-setup/transmission). Correlate
multi-line events (accept → cleanup → qmgr → smtp delivery) by **queue id**, which is stable across the whole
message lifecycle in a single log stream.

**Is log parsing the only route to mail-volume metrics? Effectively yes** `[INFERRED]` — Postfix itself exposes no
HTTP/JSON stats API; `postqueue -j` only shows what's _currently queued_, not historical throughput. Volume/rate
metrics (messages/hour, bounce rate over time, etc.) can only come from parsing the log stream (or shipping it to
something like a `postfix-exporter` for Prometheus, which itself is just a log/queue parser under the hood).

---

## 8. DNS checks from Node.js

`dns.promises.Resolver` `[CONFIRMED: nodejs.org/api/dns.html]`:

- Custom resolvers: `new Resolver({ timeout: 5000, tries: 4 })` + `resolver.setServers(['1.1.1.1', '8.8.8.8'])` —
  yes, per-instance, doesn't affect global `dns` module state.
- Per-record methods: `resolveMx`, `resolveTxt` (→ array of string-arrays — TXT records over 255 bytes come back
  as multiple chunks you must `.join('')`), `resolveCname`, `resolvePtr`, `resolve4`/`resolve6`, `resolveSoa`,
  `resolveNs`, `resolveSrv`, `resolveCaa`, `resolveTlsa`, `resolveAny`.
- TTL: only `resolve4`/`resolve6` support `{ ttl: true }` to get `{address, ttl}` objects — TXT/MX resolution does
  **not** expose TTL through this API `[CONFIRMED: nodejs.org/api/dns.html]`. If you need TTL on SPF/DKIM/DMARC TXT
  lookups specifically, you'd need a lower-level DNS library that exposes raw answer records — plain
  `dns.promises` won't give you that.
- Query a specific NS directly: yes, via `setServers([nsIp])` on a per-purpose `Resolver` instance (e.g. to check
  DNS propagation by querying each authoritative NS individually).
- No built-in timeout rejection on individual calls beyond the resolver's own `timeout`/`tries` — wrap in
  `Promise.race` for a hard app-level timeout, or rely on the resolver's own retry/timeout config.
- Reverse (PTR): `dnsPromises.reverse(ip)` or explicit `resolver.resolvePtr('<reversed-ip>.in-addr.arpa')`.

### SSRF/abuse risk — real, must validate

A user-supplied domain fed into DNS resolution is generally low-risk _for DNS itself_ (you're not fetching
arbitrary URLs), but real risks remain `[INFERRED, standard web-security reasoning]`:

- **Resolver target injection**: if the admin panel ever lets a caller specify _which DNS server_ to query (e.g. "check
  propagation against 10.0.0.5"), that's a pathway to probe internal network hosts on port 53 — treat custom
  resolver IPs as sensitive input, allowlist to known public resolvers unless the caller is trusted/admin-only.
- **Amplification/DoS via unbounded lookups**: a malicious domain can return huge TXT/ANY responses or chain many
  CNAME redirects — cap response size handling and set `tries`/`timeout` conservatively.
- **Rebinding isn't really a concern for DNS-answer-consumption** (you're not connecting to the resolved IP), but if
  the panel _also_ does a TLS-connect-to-mail-ports check (§9) based on resolved MX hosts, that step CAN hit
  arbitrary internal IPs if a malicious domain's MX/A record points at `127.0.0.1`/RFC1918 space — validate resolved
  IPs are public before connecting out from the panel's TLS-checker.
- **Validate input domains** with a strict hostname regex/`punycode`-aware check before passing to any resolver
  call, and cap total lookups per request (directly relevant to the SPF ">10 lookups" rule below, which is the same
  general failure mode).

### Is "DNS propagation checking" technically meaningful?

Yes, with a caveat: DNS "propagation" isn't really a global broadcast — it's TTL-driven cache expiry across
independent resolvers/caches worldwide. A meaningful implementation queries several **authoritative** nameservers
directly (bypassing caching resolvers, via `setServers([specific NS IPs])`) and compares answers — that tells you
whether the authoritative source is consistent, which is the real signal. Querying a handful of public recursive
resolvers (8.8.8.8, 1.1.1.1, 9.9.9.9) and comparing is the common pragmatic approximation, but it's checking cache
state, not "propagation" in a rigorous sense `[INFERRED, standard DNS operational knowledge]`.

### Common SPF/DMARC errors worth flagging

`[INFERRED, standard, well-established email-auth operational knowledge]`

- **Multiple SPF `TXT` records** for one domain: invalid per RFC 7208 — must be exactly one `v=spf1` record (though
  it may itself use `include:`/`redirect=` to compose others).
- **>10 DNS lookup mechanisms** (`a`, `mx`, `include`, `exists`, `redirect`, but not `ip4`/`ip6`/`all`) in SPF:
  hard RFC 7208 limit — exceeding it makes the record `permerror`, which many receivers treat as a fail. Detectable
  by resolving the include-chain recursively and counting.
- **`~all` (softfail) vs `-all` (hardfail)**: `~all` is common default-safe advice, `-all` is stricter enforcement —
  worth surfacing as "your SPF is in monitor mode" (`~all`) vs "enforced" (`-all`); `?all` (neutral) is effectively
  no protection and worth a warning.
- **DMARC `p=none`**: monitoring-only, no enforcement — worth flagging as "DMARC configured but not enforced."
- **Missing `rua=`** in DMARC: no aggregate-report destination configured, meaning the domain owner gets no
  visibility into who's sending as them / whether SPF/DKIM is passing at scale — worth flagging as incomplete setup.
- **DKIM selector record missing/malformed** at `<selector>._domainkey.<domain>` — needs the correct selector name,
  which isn't discoverable from DNS alone (you need it from the DKIM-Signature header of a real sent message, or
  from the mail server's own config) — the admin panel likely already knows its own selector from OpenDKIM/Dovecot
  config, so this is a config-value lookup, not a guess.

---

## 9. TLS certificate inspection

### Reading a PEM without shelling to openssl

`crypto.X509Certificate` (Node ≥15.6) `[CONFIRMED: nodejs.org/api/crypto.html#class-x509certificate]` — construct
directly from a PEM/DER buffer or string, no `openssl` subprocess needed:

```js
const { X509Certificate } = require('node:crypto');
const cert = new X509Certificate(pemBufferOrString);
cert.subject;
cert.issuer;
cert.validFrom;
cert.validFromDate;
cert.validTo;
cert.validToDate;
cert.subjectAltName;
cert.fingerprint256;
cert.serialNumber;
cert.ca;
cert.keyUsage;
cert.checkHost('mail.example.com'); // hostname-match validation
```

This directly covers issuer/subject/SANs/notBefore/notAfter/fingerprint — no external process required.

### Checking the cert actually served on 25/465/587/993

Practical and commonly done, but the _how_ differs by port `[CONFIRMED mechanism: nodejs.org/api/tls.html socket
option; STARTTLS sequencing itself is `[INFERRED]`, standard protocol knowledge — this is exactly what nodemailer
and similar libraries implement]`:

- **Implicit TLS (465 SMTPS, 993 IMAPS, 995 POP3S)**: straightforward — `tls.connect({host, port, servername})`
  directly, then `socket.getPeerCertificate(true)` (the `true` gets the full chain), optionally wrap the result in
  `new X509Certificate(...)` for the richer API above.
- **STARTTLS (25/587 SMTP, 143 IMAP, 110 POP3)**: Node's `tls` module has no protocol-aware STARTTLS helper — you
  must speak the plaintext protocol first over a plain `net.connect` socket (SMTP: read the greeting, send `EHLO`,
  send `STARTTLS`, wait for `220`; IMAP: send `a STARTTLS`, wait for `OK`), **then** call
  `tls.connect({ socket: thatExistingPlainSocket, host, servername })` — Node's `tls.connect` explicitly supports
  upgrading an existing socket via the `socket` option, which is exactly the mechanism STARTTLS needs. This is a
  well-established pattern (it's how nodemailer's own connection layer works), just not a one-liner — budget for
  writing a small per-protocol handshake helper for SMTP vs IMAP vs POP3.

Both paths are practical to implement server-side in the admin panel's backend (not from the browser — this needs
raw TCP, so it must run in the Node backend / inside the container, not client-side JS).

---

## 10. Fail2ban in docker-mailserver

`[CONFIRMED: docker-mailserver.github.io/docker-mailserver/v10.2/config/security/fail2ban/ +
raw config-examples/fail2ban-jail.cf from the docker-mailserver GitHub repo]`

- `setup fail2ban` (no args) — lists currently banned IPs.
- `setup fail2ban status` — detailed status view.
- `setup fail2ban ban <IP>` / `setup fail2ban unban <IP>` — mutating ban management.
- `setup fail2ban log` — shows the fail2ban log file.

Default jails shipped in the example config: **`dovecot`** (enabled) and **`postfix`** (enabled, `mode = extra`);
a **`custom`** jail template is provided (covering smtp/pop3/pop3s/imap/imaps/submission/submissions/sieve ports)
for admins to adapt, with `bantime = 180d` shown as an example override. Global defaults across jails:
**`findtime = 1 week`, `bantime = 1 week`, `maxretry = 6`**, `ignoreip = 127.0.0.1/8`,
`banaction = nftables-allports` (i.e. bans block all ports for the offending IP, not just the mail ports)
`[CONFIRMED: raw fail2ban-jail.cf from docker-mailserver repo]`.

**Is banned-IP output machine-readable?** `[UNCERTAIN]` — the docs don't state a JSON mode, and fail2ban's own
`fail2ban-client status <jail>` (which `setup fail2ban` almost certainly wraps) produces human-oriented plain text
by default, not JSON. Treat this as "parse plain text with a regex," and verify the exact output shape by running
`docker exec <container> setup fail2ban status` once against a real container before building a UI table around it.

---

## Sources

- Rspamd controller worker — https://docs.rspamd.com/workers/controller (redirected from rspamd.com/doc/workers/controller.html) `[CONFIRMED]`
- Rspamd HTTP protocol — https://docs.rspamd.com/developers/protocol `[CONFIRMED]`
- Rspamd controller endpoints dev guide — https://docs.rspamd.com/developers/controller_endpoints/ `[CONFIRMED, partial]`
- Rspamd Redis history module — https://docs.rspamd.com/modules/history_redis/ `[CONFIRMED]`
- Rspamd `rspamc` CLI reference — https://github.com/rspamd/rspamd/blob/master/doc/rspamc.1.md `[CONFIRMED]`
- Rspamd interface README — https://github.com/rspamd/rspamd/blob/master/interface/README.md `[CONFIRMED, no schema found]`
- Rspamd GitHub issues on password tiers — #2112, #4186 (rspamd/rspamd) `[CONFIRMED via search snippets]`
- Rspamd `options.inc` default `history_rows` — https://fossies.org/linux/rspamd/conf/options.inc (mirror) + https://github.com/rspamd/rspamd/issues/3779 `[INFERRED]`
- ClamAV clamd protocol — https://docs.clamav.net/manual/Usage/ClamdProtocol.html `[CONFIRMED]`
- ClamAV scanning usage — https://docs.clamav.net/manual/Usage/Scanning.html `[CONFIRMED, partial]`
- ClamAV signature management — https://docs.clamav.net/manual/Usage/SignatureManagement.html `[CONFIRMED, partial]`
- Postfix `postqueue(1)` — https://www.postfix.org/postqueue.1.html `[CONFIRMED]`
- Postfix `postconf(1)` — https://www.postfix.org/postconf.1.html `[CONFIRMED]`
- Postfix `bounce(8)` and community log examples — https://www.postfix.org/bounce.8.html, forums.freebsd.org thread `[CONFIRMED existence of fields, INFERRED full samples]`
- Dovecot `doveadm-pw(1)` — https://doc.dovecot.org/main/core/man/doveadm-pw.1.html `[CONFIRMED]`
- Dovecot password schemes — https://doc.dovecot.org/main/core/config/auth/schemes.html `[CONFIRMED via search index]`
- Dovecot `doveadm-quota(1)` — https://doc.dovecot.org/main/core/man/doveadm-quota.1.html `[CONFIRMED]`
- Dovecot `doveadm-mailbox(1)` — https://doc.dovecot.org/main/core/man/doveadm-mailbox.1.html `[CONFIRMED]`
- Dovecot `doveadm-who(1)` — https://doc.dovecot.org/main/core/man/doveadm-who.1.html `[CONFIRMED]`
- Dovecot `doveadm-sieve(1)` — https://doc.dovecot.org/2.4.4/core/man/doveadm-sieve.1.html / manpages mirrors `[CONFIRMED via search index]`
- Dovecot ManageSieve config — https://doc.dovecot.org/main/core/config/sieve/managesieve.html `[CONFIRMED via search index]`
- Pigeonhole vacation extension settings — https://doc.dovecot.org/2.3/settings/pigeonhole-ext/vacation/ `[CONFIRMED, config only, no syntax examples found]`
- RFC 5260 (Sieve date/currentdate) — https://www.rfc-editor.org/rfc/rfc5260.html `[CONFIRMED]`
- RFC 5230 (Sieve vacation) — referenced, not independently re-fetched `[INFERRED]`
- Sieve vacation+currentdate community examples — spinics.net/lists/info-cyrus/msg16261.html and related info-cyrus thread `[CONFIRMED via search snippet]`
- Node.js `dns` module — https://nodejs.org/api/dns.html `[CONFIRMED]`
- Node.js `crypto` module, `X509Certificate` — https://nodejs.org/api/crypto.html#class-x509certificate `[CONFIRMED]`
- Node.js `tls` module (`tls.connect` socket option, `getPeerCertificate`) — https://nodejs.org/api/tls.html `[INFERRED — not independently re-fetched this session, cited from general Node API knowledge]`
- docker-mailserver fail2ban docs — https://docker-mailserver.github.io/docker-mailserver/v10.2/config/security/fail2ban/ `[CONFIRMED]`
- docker-mailserver fail2ban jail example — https://raw.githubusercontent.com/docker-mailserver/docker-mailserver/master/config-examples/fail2ban-jail.cf `[CONFIRMED]`
- docker-mailserver account/password docs (search-indexed) — docker-mailserver.github.io user-management/accounts pages `[INFERRED via search snippet]`

## Flagged gaps needing runtime verification against the actual image

1. **Rspamd `/stat` exact JSON field list** — confirm with one `curl -H "Password: ..." http://127.0.0.1:11334/stat`
   (or `docker exec <container> rspamc stat`) against the real container before binding dashboard code to keys.
2. **Whether `history_redis` (persistent history) is enabled in docker-mailserver's shipped rspamd config** —
   determines if a "recent spam history" UI survives container restarts.
3. **`doveadm pw` non-tty stdin behavior** — test `printf 'pw\npw\n' | docker exec -i <container> doveadm pw -s
SHA512-CRYPT` to settle the argv-avoidance question definitively before building password-set/reset UI.
4. **ClamAV exact `VERSION`/freshclam output strings** in the specific docker-mailserver image build — run the
   commands once and capture real output rather than trusting the inferred format string.
5. **Fail2ban `setup fail2ban status` output shape** — run it once and confirm plain-text vs any structured option
   before building a bans table UI.
