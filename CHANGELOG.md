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

### Notes

- No release has been published yet and no installation path is supported.
  See the project status banner in `README.md`.

[Unreleased]: https://github.com/ArvinRahnama/docker-webmail-gui/commits/main
