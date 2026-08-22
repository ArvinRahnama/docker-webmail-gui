# Documentation

Two audiences, deliberately separated.

## For operators — running this thing

Read in this order if you are installing for the first time:

1. **[`security-model.md`](security-model.md)** — the deal you are
   accepting. Installing this means giving a container access to your
   Docker socket; this says what that does and does not protect you from.
   Read it _before_ installing, not after.
2. **[`docker.md`](docker.md)** — deployment: what gets deployed, how to
   install, connect it to your mail server, the hardening actually
   applied, uninstall, and what is verified where.
3. **[`configuration.md`](configuration.md)** — the settings that need a
   decision, especially the TLS/cookie interaction that silently locks
   people out. [`.env.example`](../.env.example) remains the
   authoritative per-variable reference.
4. **[`operations.md`](operations.md)** — what each area of the panel
   does, and what it deliberately does not.
5. **[`backup-restore.md`](backup-restore.md)** — the archive format, the
   manual restore path, and why restore is deliberately awkward.
6. **[`troubleshooting.md`](troubleshooting.md)** — symptoms and causes,
   including the current blocking limitation and how to read `Unknown`
   correctly.

> **Start here if something is already wrong:**
> [`troubleshooting.md`](troubleshooting.md).

## For contributors — changing this thing

Different reader, different documents. These live at the repository root:

- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — the design and the reasoning.
- [`SECURITY.md`](../SECURITY.md) — the full threat model and control
  list. [`security-model.md`](security-model.md) is its operator-facing
  summary, not a replacement.
- [`FEATURE_MATRIX.md`](../FEATURE_MATRIX.md) — every feature, its
  status, and what is unsupported and why. **The authority for feature
  status**; anything on this site that disagrees with it is wrong.
- [`UX_ARCHITECTURE.md`](../UX_ARCHITECTURE.md) — screens, flows,
  components.
- [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) — milestones and
  progress.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how to work on it.
- [`AGENT_BRIEF.md`](AGENT_BRIEF.md) — the condensed working context that
  replaces reading all of the above. Written for agents implementing a
  milestone; not an operator document.

## Research

[`research/`](research/) holds the technical investigation this project's
decisions rest on: `docker-mailserver`'s real capabilities, the Docker
Engine API and its socket security boundary, mail-stack component data
sources, and dependency licensing. Where a document here says "verified
against", this is usually what it means.
