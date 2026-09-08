/**
 * The port panel self-update's "what version could I update to" question
 * is built on (docs/design/self-update.md §3, §9.1 — auto-latest only,
 * no version picker in v1), mirroring `drivers/registry/types.ts`'s
 * interface+real+fake shape (AGENT_BRIEF.md §5) deliberately: same
 * "outbound HTTPS call, nothing here touches the Docker socket or the
 * broker" reasoning, so this lives entirely in `apps/server`, same as
 * `RegistryClientPort`.
 *
 * This is a genuinely different question from `RegistryClientPort`'s,
 * not a duplicate of it. `RegistryClientPort.resolveTagDigest` answers
 * "what digest does the registry serve for *this exact tag right now*" —
 * the right question for docker-mailserver, which is tracked by a
 * floating tag (`:latest`). `docker-webmail-gui` is released as pinned
 * semver tags (`v0.1.0`, `v0.2.0`, ... — `git tag`, `CHANGELOG.md` and
 * `DWG_VERSION` all kept in lockstep, `docker/compose.yaml`'s own
 * convention), so the question that matters is "what is the newest
 * *version* that has been published at all" — a question a tag-digest
 * lookup cannot answer, because there is no single floating tag to ask
 * about. This port answers that different question, against the
 * project's own GitHub Releases (the same record `CHANGELOG.md` already
 * mirrors — see docs/design/self-update.md §9.2, verified against the
 * real release workflow before this was approved).
 */

export interface SelfUpdateRelease {
  /** A bare semver string, e.g. `"0.4.0"` — never a `v`-prefixed tag, never an image reference. Matches exactly what `PanelSelfUpdateApplyRequestSchema.targetVersion` (`@dwg/shared`) accepts. */
  readonly version: string;
  /** ISO 8601 — the release's own `published_at`, for display only (never used to decide anything). */
  readonly publishedAt: string;
}

export interface SelfUpdateReleaseSourcePort {
  /**
   * Resolves the newest published `docker-webmail-gui` release. Returns
   * `null` — **never throws** — when the network is unreachable, the API
   * responds with anything other than success, the response cannot be
   * parsed, or the latest release's tag is not a plain `vX.Y.Z` this
   * project's own convention produces (e.g. a draft/pre-release tag
   * shaped differently). Same "Unknown, not Invalid" discipline every
   * other driver in this codebase follows (AGENT_BRIEF.md §4's DNS-state
   * example, `RegistryClientPort`'s identical contract) — a transient
   * failure must read as "could not check", never as "no update
   * available" or a crashed page.
   */
  resolveLatestRelease(): Promise<SelfUpdateRelease | null>;
}
