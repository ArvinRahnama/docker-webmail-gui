# Contributing

Thanks for your interest in Docker Webmail GUI — a self-hosted web admin panel
for `docker-mailserver`, with Docker access held behind a privilege-separated
broker. This document covers what you need to get set up and what we expect
from a change before it merges.

If anything here conflicts with `IMPLEMENTATION_PLAN.md` or `SECURITY.md`,
those documents win; this file is the practical on-ramp, not the source of
truth.

## Prerequisites

- **Node.js 24** (see `.nvmrc`) and npm.
- **Docker is not required to develop this project.** In development mode the
  server and broker default to mock/fake drivers, so you can build and test
  the vast majority of the codebase — including the web UI, the API layer,
  and unit/integration tests — on a machine with no Docker daemon at all.
  Real Docker is only needed if you're deliberately exercising the live
  broker↔Docker↔`docker-mailserver` path, and that integration tier runs in
  CI on Linux, not on your workstation (see Testing, below).

## Getting started

```bash
npm install
npm run dev
```

`npm install` sets up all four workspaces (`apps/server`, `apps/broker`,
`apps/web`, `packages/shared`) in one pass — this is an npm-workspaces
monorepo, so there is one lockfile and one install at the repo root, never a
per-package one. `npm run dev` runs each workspace's own `dev` script
concurrently.

Useful scripts, all run from the repo root (see `package.json`):

| Script | What it does |
| --- | --- |
| `npm run dev` | Run every workspace in development mode |
| `npm run build` | Build every workspace |
| `npm run test` | Run every workspace's test suite |
| `npm run lint` | ESLint across the repo |
| `npm run format` | Prettier, writing fixes |
| `npm run format:check` | Prettier, check only (what CI runs) |
| `npm run typecheck` | `tsc --build` across all project references |
| `npm run check` | lint + typecheck + test, in one shot |

Run `npm run check` before opening a PR — it's the fastest way to catch what
CI will catch.

## Workspace layout

- **`apps/server`** — the web tier (Fastify). Owns auth, sessions, SQLite,
  audit logging, and job orchestration, and serves the built SPA. This is the
  only internet-facing process, and it holds **no Docker socket and no
  Docker vocabulary** — see `ARCHITECTURE.md`.
- **`apps/broker`** — the privileged Docker broker. Small and deliberately
  boring: it validates a named operation against a fixed enum, resolves
  container identity from its own configuration, and makes one Docker call.
  It has no database, no business logic, and no user-facing surface. Changes
  here are security-relevant by definition — see `SECURITY.md` Part 3.1 and
  4.1 before touching it.
- **`apps/web`** — the React SPA (Vite) that admins actually use.
- **`packages/shared`** — Zod schemas, DTO types, constants, and error codes
  shared across all three apps. If a shape crosses a process boundary
  (server↔broker, server↔web), it belongs here, validated at both ends.

## Coding standards

- **TypeScript strict, everywhere.** The base config
  (`tsconfig.base.json`) turns on `strict` plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, and
  `noFallthroughCasesInSwitch`. These are non-negotiable, not aspirational.
- **No `any`.** If a type is genuinely unknown, use `unknown` and narrow it.
  An `any` is a hole in every guarantee this project makes about itself.
- **Zod at every boundary.** Anything arriving from outside the current
  process — an HTTP request body, a broker response, a parsed config file, an
  environment variable — is validated with a Zod schema before the rest of
  the code trusts its shape. This is how `packages/shared` earns its keep.

### The nine working agreements

These come from `IMPLEMENTATION_PLAN.md` §5, reproduced here verbatim because
they are the project's non-negotiables. Every PR is implicitly reviewed
against this checklist:

- [ ] **No control ships that the backend cannot perform.** A feature is
      real, explicitly unsupported, or absent.
- [ ] **Reads parse state; writes use the CLI.** No parsing decorative CLI
      output for data.
- [ ] **Argv arrays only.** No `sh -c`, ever.
- [ ] **No client-supplied path or container spec** reaches a filesystem or
      the Docker API.
- [ ] **Secrets never enter logs, responses, the bundle, or browser
      storage.**
- [ ] **Every mutation is audited.**
- [ ] **Destructive operations are structurally hard**, not merely warned
      about.
- [ ] **Fixtures are captured, never invented.**
- [ ] **Every claim in the docs traces to research or a test.**

If a change appears to require breaking one of these, that's a sign to stop
and discuss it in the PR or an issue before writing more code — it's very
unlikely the answer is "break the agreement quietly."

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — a new feature
- `fix:` — a bug fix
- `docs:` — documentation only
- `chore:` — tooling, dependencies, config, no behavior change
- `test:` — tests only
- `refactor:` — code change that neither fixes a bug nor adds a feature

Keep the subject line short and imperative; put the "why" in the body when
it isn't obvious from the diff.

## Pull request process

1. **Open small.** Vertical slices (schema → service → API → UI → tests for
   one feature) are much easier to review than a wide, shallow change across
   many files.
2. **Tests included.** A PR that adds behavior without a test for it is
   incomplete, not merely risky — see Testing, below.
3. **`npm run check` passes locally**, and CI is green.
4. **Fill in the PR template**, including the security checklist. It exists
   because the working agreements above are easy to violate by accident
   (a debug `sh -c`, a stray `console.log` of a token) and hard to notice in
   review without a prompt.
5. A maintainer reviews for correctness, adherence to the working agreements,
   and consistency with `ARCHITECTURE.md` / `FEATURE_MATRIX.md`. Expect
   requested changes on anything touching the broker, auth, or a destructive
   operation — that scrutiny is deliberate, not personal.

## Testing expectations

Per `IMPLEMENTATION_PLAN.md` §2.4:

- **Unit tests (Vitest) run everywhere**, including a machine with no Docker
  daemon — parsers, command builders, validation, auth/authz, backup
  manifest logic, health rules, security functions. If you're adding logic,
  add a unit test alongside it in the same PR.
- **Integration tests against fake drivers (Vitest) run everywhere** —
  service→driver flows, job lifecycle, SSE, error mapping.
- **Integration tests against real Docker + a live `docker-mailserver`
  container run in CI on Linux**, not on contributors' machines. Don't block
  a PR on being able to run these locally; CI is the integration authority.
- **E2E (Playwright)** covers the critical workflows (login, create mailbox,
  create alias, change password, DNS check, DKIM generate, restart
  container, view logs, backup, restore, update, logout) and runs in CI.
- **Security tests** cover the ten checks in `SECURITY.md` Part 5 and run in
  CI.
- Fixtures must carry a provenance header naming their source. **Invented
  fixtures are prohibited** — see the working agreements above.

## Reporting security issues

**Do not open a public issue or a public PR for a security vulnerability** —
including a PR that "fixes" one, since the diff itself would disclose it.
Follow the private disclosure flow in `SECURITY.md` Part 1 (GitHub Security
Advisories → *Report a vulnerability*) instead. Functional bugs that aren't
security-sensitive are welcome as normal issues.
