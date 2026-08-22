# The security model, for the person running this

Installing this panel means giving a container read/write access to your
Docker socket. That is not a detail — **read/write access to
`/var/run/docker.sock` is root on the host**, without qualification. One
`POST /containers/create` carrying a bind mount of `/` or
`Privileged: true` ends any discussion about what the container can and
cannot do.

This project exists because that is true, not in spite of it. This page
is the deal you are accepting, stated plainly: what the design protects
you from, what it does not, and which parts are enforced by something
mechanical rather than by intention.

`SECURITY.md` is the full threat model and control list. This page is the
operator's version — shorter, and written to be read before you install
rather than after something goes wrong.

## 1. The shape of the thing

Two containers, not one:

- **`server`** — the web tier. The API, the login, the business logic,
  the SPA. This is the part exposed to a browser, and therefore the part
  with realistic attack surface. **It has no Docker socket.**
- **`broker`** — the privileged tier. It holds the socket. It is small on
  purpose: one route, one authentication gate, one fixed vocabulary, no
  database, no templating, no user-facing surface at all. It publishes no
  port and sits alone on an internal-only Docker network with no route to
  or from the internet.

The web tier cannot reach Docker. It can only send the broker a **named
intent** — `container.restart`, `container.logs` — over that internal network.

## 2. What the boundary actually buys you

The property worth stating precisely:

> **Full remote code execution in the web tier yields the broker's
> allowlist, and nothing more.**

An attacker who completely owns the `server` container can do exactly
what the panel itself can do: list containers, restart the mail server,
read logs, prune dangling images, run one of a fixed set of
zero-argument diagnostic commands. They cannot create a container, mount
a host path, add a capability, or get a shell on the host — because
there is no message in the protocol that expresses any of those things.

That is the load-bearing part, and it is worth being clear about _why_ it
holds. It is not that the broker validates a container specification
carefully. **There is no field anywhere in the protocol that can carry a
container specification.** `HostConfig`, `Binds`, `Mounts`, `Privileged`,
`CapAdd`, `PidMode` and `NetworkMode` appear in no schema, and a test
fails the build if they ever do. `container.create`, `container.remove`
and `exec.*` are absent from the operation vocabulary entirely. The web
tier never sends a container id at all — the broker resolves the mail
container's identity itself, from its own configuration.

The complete vocabulary is these 18 operations, and nothing else:

```
container.list     container.inspect   container.start    container.stop
container.restart  container.stats     container.logs     system.ping
system.version     system.info         system.df          image.list
volume.list        network.list        volume.remove      image.prune
logs.file          console.exec
```

Three of those deserve a note, because they are the ones that could have
been passthroughs and deliberately are not. `volume.remove` takes a
volume _name_ and is refused broker-side for any volume backing a mail
data mount — re-derived from the managed container's own mounts on every
call, never from a hardcoded list. `image.prune` takes no parameters at
all; it always means "remove dangling images", never "remove image X".
`console.exec` takes a symbolic key naming one of a fixed set of
diagnostic commands whose argv the broker owns — the client never sends a
command string or an argv array.

## 3. What it does not protect you from

This is the half that documentation usually omits.

- **Anyone who can run the panel can restart your mail server, read your
  mail logs, and restore a backup over your mail data.** Those are the
  panel's job. The boundary limits what an attacker gains beyond the
  panel's own powers; it does not make the panel's own powers safe to
  hand out. Treat an admin account here as roughly equivalent to shell
  access on the mail container.
- **A compromise of the `broker` container is a compromise of the host.**
  Nothing changes that; it is why that tier is kept as small as it is,
  changes rarely, and has no user-facing surface to attack. It is
  reachable only from the `server` container, over an internal network,
  behind a shared secret.
- **A compromise of the Docker host is total.** This panel is one process
  on it, not a boundary around it.
- **It is not a substitute for not exposing the panel.** Put it behind
  TLS and, ideally, behind something that authenticates before the
  request ever reaches it. See §5.
- **Backups contain your mail.** Archives written to `BACKUP_DIR` are
  plain `tar` and are not encrypted. Their confidentiality is entirely
  the filesystem's.
- **The panel does not manage your mail server's own security.** It
  reports on TLS, DKIM, SPF, DMARC, Rspamd, ClamAV and Fail2ban. Acting
  on what it reports is still your job.

## 4. What is enforced mechanically, and what is intention

A control that depends on everyone remembering it is worth less than one
that fails a build. This project has a mix, and the difference matters:

| Property                                                    | Enforced by                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| No container spec, bind mount or capability in the protocol | A test that fails if those field names appear in any schema                                                     |
| Web tier holds no Docker client                             | An ESLint rule banning the import, plus a build-time assertion in the image that fails if the package reappears |
| Web tier has no socket on any path                          | CI inspects the running container's mounts on every install cycle                                               |
| Broker publishes no port; its network is internal           | The compose file, asserted against live containers in CI                                                        |
| No shell in any command invocation                          | An ESLint rule that fails the build on a shell in an argv array                                                 |
| Every mutating route requires session + CSRF                | A suite that reads the running app's own route table and fires every one of them                                |
| No secret reaches logs                                      | A suite that drives real logins with real secrets and greps the raw log output                                  |
| Both containers non-root, read-only, no capabilities        | The compose file, asserted against live containers in CI                                                        |

Where a claim in this repository is _not_ backed that way, the documents
say so rather than implying otherwise.

## 5. What you should actually do

1. **Terminate TLS in front of it.** The panel speaks plain HTTP. Put a
   reverse proxy in front, set `BIND_ADDRESS=127.0.0.1` so the published
   port exists only for that proxy, and leave `COOKIE_SECURE=true`.
   Without TLS, browsers refuse to store a `Secure` cookie on anything
   but `localhost`, and login will appear to do nothing at all — see
   [`configuration.md`](configuration.md).
2. **Do not expose it to the internet** unless something authenticates in
   front of it. This is an admin panel for a mail server; there is no
   reason for it to be publicly reachable.
3. **Change the bootstrap password immediately.** You are required to on
   first login, and then clear `BOOTSTRAP_ADMIN_EMAIL` and
   `BOOTSTRAP_ADMIN_PASSWORD` out of `.env`.
4. **Keep `.env` at mode 600.** The installer writes it that way. It
   holds the cookie secret, the broker shared secret and, until you clear
   them, the bootstrap credentials.
5. **Leave `ENABLE_EXEC_CONSOLE=false`** unless you specifically need the
   diagnostic console. It is off by default for a reason, even though
   what it can run is a fixed allowlist.
6. **Store backups somewhere you would be comfortable storing mail**,
   because that is what they are.

## 6. Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md) Part 1. Please use private disclosure
rather than a public issue.
