# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is at `0.x`, the public API, configuration format, and
database schema may change between minor versions. Breaking changes will be
called out explicitly here.

## [Unreleased]

### Added

- Repository foundation: npm workspaces monorepo (`apps/server`, `apps/broker`,
  `apps/web`, `packages/shared`), strict TypeScript configuration, ESLint rules
  that enforce specific controls from `SECURITY.md`, Prettier, and CI.
- Planning documentation: `ARCHITECTURE.md`, `SECURITY.md`, `FEATURE_MATRIX.md`,
  `UX_ARCHITECTURE.md`, `LICENSE_AUDIT.md`, `IMPLEMENTATION_PLAN.md`.
- Technical research under `docs/research/`, covering docker-mailserver
  capabilities, the Docker Engine API and socket security boundary, mail-stack
  component data sources, and dependency licensing.
- Apache-2.0 licence, `NOTICE`, and community health files.
- Docker broker and the privilege boundary (M4): a closed operation
  vocabulary (`packages/shared/src/broker.ts`) covering container
  list/inspect/start/stop/restart/stats/logs plus Docker
  system/image/volume/network reads, deliberately omitting
  `container.create`, `container.remove` and `exec.*`. `apps/broker`
  enforces shared-secret authentication (compared in constant time,
  rejected before any request parsing), resolves the managed mail
  container's identity itself from configuration (the web tier can never
  supply a container id), decodes Docker's multiplexed log stream
  (TTY and non-TTY, including frames split across chunk boundaries), and
  computes CPU%/memory% with the documented formulas including the
  cgroup v1 vs v2 branch. `apps/server/src/drivers/broker` adds the web
  tier's `BrokerClient` interface with `RealBrokerClient` (HTTP via
  `undici`) and a fixture-seeded `FakeBrokerClient`, which is the
  development-mode default so the panel remains developable with no
  Docker daemon.

### Notes

- No release has been published yet and no installation path is supported.
  See the project status banner in `README.md`.

[Unreleased]: https://github.com/ArvinRahnama/docker-webmail-gui/commits/main
