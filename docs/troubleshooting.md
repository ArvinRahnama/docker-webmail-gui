# Troubleshooting

Ordered roughly by when you would hit them.

## Mail features and the broker

Everything this panel does to `docker-mailserver` — create a mailbox, set
a quota, install a Sieve script, ban an IP — crosses the privilege
boundary as a **named operation**, never as a command line. The web tier
sends `dms.email.add` with an address and a password; the broker decides
that this means `setup email add <address>` with the password on stdin.
There is no field in that protocol that can carry a command, a flag or a
path, which is why a compromise of the web tier cannot become arbitrary
command execution inside your mail container.

This matters for troubleshooting in one practical way: if a mail
operation fails, the error names the _operation_ (`"dms.sieve.get"
exited 68`), not a command line, because the web tier never had one. The
command that actually ran is the broker's, and its stderr is passed
through to you verbatim.

**Historical note.** Until M16 this port had no implementation at all,
and the server refused to start in `APP_MODE=production` rather than
serve fake data in a real deployment. If you are running a build from
before that milestone you will see `createDmsDriver: a real DmsExecPort
is required` in the server log and an install that never reaches health.
The fix is to update, not to change any setting.

## Install

**"port 3000 is already in use."** Something else has it. Run
`PORT=8080 ./installer/install.sh`, or free the port.

**"could not determine the group GID of /var/run/docker.sock."** The
socket is not where the installer expects, or is not a socket. Set
`DOCKER_GID` in `.env` to the socket's group GID by hand and re-run.

**"docker is installed but the daemon is not reachable."** Either the
daemon is not running, or your user is not in the `docker` group. Adding
yourself to that group is equivalent to granting root — that is the same
fact this whole project is built around.

**"Incorrect email or password" with the password you are sure of.** The
login page never says which part was wrong, by design. The usual causes:
the password was changed and forgotten; `BOOTSTRAP_ADMIN_PASSWORD` was
edited in `.env` after the first start (it is applied only once, when no
administrator exists yet); or the bootstrap password contained a `$`, which
Docker Compose's `.env` interpolation removed, so the stored password was
never the one in the file. The server log says if bootstrap refused to
create the administrator at all. Whatever the cause, reset it from the
host:

```sh
docker exec dwg-server node apps/server/dist/cli/reset-admin-password.js admin@example.com
```

It prints a new password (you choose your own at the next sign-in),
re-enables the account, signs out its sessions and clears the lockout. If
no administrator exists yet, it creates that one.

**"Too many failed sign-in attempts. Try again in N minutes."** Ten failures
for one address, or thirty from one IP, within 15 minutes. It lifts on its
own; retrying meanwhile does not extend it. Behind a reverse proxy, check
`TRUST_PROXY` ([`configuration.md`](configuration.md)) — otherwise every
visitor counts as the proxy, and strangers' failures lock you out too. The
reset command above also clears it.

**Login appears to succeed and then bounces back to the login page.**
Almost always `COOKIE_SECURE=true` over plain HTTP on a non-localhost
address. See [`configuration.md`](configuration.md).

## Reading `Unknown` correctly

`Unknown` in this panel means **"we could not determine this"**, and it
is never a synonym for zero, healthy, or broken. A resolver failure
renders as `Unknown` in grey, never as `Invalid` in yellow, precisely so
that a network problem cannot be mistaken for a misconfigured DNS record.

Nine parsers were originally written against documented formats rather
than captured output. All nine have since been checked against a live
`docker-mailserver` (see `FEATURE_MATRIX.md`): seven were right, DKIM's
key path and record format were wrong and are fixed, and one fallback —
ClamAV's — turns out to fire on a stock image. Each still has a defined
fallback, and the fallback is what you would see if your deployment
differs from the one that was tested.
[`FEATURE_MATRIX.md`](../FEATURE_MATRIX.md)'s "Deferred to runtime
verification" table is the authoritative list; in operator terms:

| If you see                                                 | The likely cause                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mailbox or storage usage as `Unknown` rather than a number | `doveadm -f json quota get`'s key casing or units did not match. It reports `Unknown` rather than a guessed figure.                                                                                                                                                             |
| ClamAV shown as `Unknown`                                  | `ENABLE_CLAMAV=1` is not set in docker-mailserver, or clamd is still loading its signatures (a minute or so after start). The status check uses the image's own `nc`; earlier releases used `socat`, which docker-mailserver does not install, so they always showed `Unknown`. |
| A ClamAV version shown as a raw string                     | The `VERSION` string format was not as documented, so it is displayed verbatim rather than parsed.                                                                                                                                                                              |
| The Fail2ban page showing raw command output               | `setup fail2ban status`'s output shape differed from the documented one. Raw output beats invented structure.                                                                                                                                                                   |
| DKIM key path or status as `Unknown`                       | The key path under `ENABLE_RSPAMD=1` is detected at runtime rather than assumed.                                                                                                                                                                                                |
| A spam statistic missing rather than zero                  | Rspamd `/stat` field names are bound defensively; only confirmed fields render.                                                                                                                                                                                                 |
| Restriction status not reflecting a restriction you set    | `postfix-{send,receive}-access.cf`'s exact line format was parsed as standard Postfix `access(5)` syntax, unconfirmed against a real sample.                                                                                                                                    |

None of these are failures of the panel so much as honest reporting of
the limit of what it knows. If you hit one against a real DMS, that is
exactly the information this project needs — the fallback exists to make
the gap visible instead of producing a confident wrong number.

## Mail server not found

**"no running 'mailserver' container found."** The installer looked for a
container matching `DMS_CONTAINER_NAME` (default `mailserver`) or
`DMS_CONTAINER_LABEL` and found none. This is a warning, not a failure —
the panel installs without one. Start your mail server, then re-run
`./installer/install.sh` to pick it up.

**Rspamd shows `Unavailable` even though DMS is running.** The one thing
that needs real network reachability to DMS is the web tier's direct HTTP
call to Rspamd's controller; every Docker-level operation goes through
the broker's socket instead. The installer joins the `server` container
to your DMS container's network automatically. If it could not, connect
it by hand — see [`docker.md`](docker.md) §3 — or set `RSPAMD_PASSWORD`
if the controller requires one.

## Spam filter

**Spam is still rejected / Junk moves change nothing.** The mail-server half
is not installed; Security → Sender Lists says so. Run
`./installer/install-dms-integration.sh` ([`../docker/dms/README.md`](../docker/dms/README.md)).
If it is installed but spam is still rejected, look for
`rspamd/override.d/actions.conf` in docker-mailserver's config directory
setting `reject` — an operator override wins, and the container log warns
about it at start.

**A report did not show up.** Reports are read from the mail log once a
minute. Moving mail to Trash is deliberately not a report. Moves made while
the integration was not installed are not recorded anywhere.

## MCP connections

Problems with the optional MCP integration — "not configured", the service
unreachable, OAuth discovery failing behind a proxy, a connection showing
**Suspended**, a mailbox password rejected right after it was changed —
have their own table in [`mcp-integration.md`](mcp-integration.md) §17.

## Things that are refused, not broken

Some controls answer with a reason instead of doing the thing. That is
deliberate, and the reason is always stated in the response:

- **Applying an update** refuses and names the missing Docker operation.
  Applying means create-and-replace a container, and `container.create`
  is the root-equivalent call the broker exists to withhold. Image pull
  and rollback are absent for the same reason.
- **Creating or deleting a domain** does not exist. `docker-mailserver`
  has no such concept — the domain list is derived from address parts.
  The page offers "Add mailbox" instead.
- **Disabling a mailbox** does not exist either. What exists is send and
  receive restriction, and it is labelled that way.
- **Bulk mailbox deletion** is refused by this project. Bulk restrict and
  bulk quota changes are fine.
- **Editing Rspamd's configuration** is refused: that config embeds Lua
  and its maps fetch URLs, which is code execution plus SSRF. Thresholds,
  symbol scores and learn spam/ham are available.
- **Removing a volume that backs mail data** is refused broker-side,
  re-derived from the live container's own mounts on every call.

## Logs

```sh
docker compose -f docker/compose.yaml --env-file .env logs server broker
```

Logs are JSON (pino). Secrets are redacted structurally, and a test suite
drives real logins with real secrets and greps the raw output to prove
it. Log files rotate at 10 MB × 5 per container.

## Starting over

`./installer/uninstall.sh --purge` removes the containers, networks, this
project's own volumes and the generated `.env`, leaving your mail server
and its data untouched. A subsequent install is a genuinely fresh one
with a new bootstrap credential. See [`docker.md`](docker.md) §5.
