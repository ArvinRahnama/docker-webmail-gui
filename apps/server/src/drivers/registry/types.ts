/**
 * The port `modules/updates/updates.service.ts` is built on (M10 —
 * IMPLEMENTATION_PLAN.md §2.2 step 2: "Query the registry for the newest
 * matching tag and its digest"), mirroring `drivers/dns/`,
 * `drivers/tls/`, `drivers/rspamd/`'s interface+real+fake shape
 * (AGENT_BRIEF.md §5). Talking to a public container registry (Docker
 * Hub, GHCR, …) is an ordinary outbound HTTPS call — nothing here touches
 * the Docker socket or the broker, so this lives entirely in
 * `apps/server`, unlike `BrokerClient`.
 */

export interface RegistryClientPort {
  /**
   * Resolves the content digest the registry currently serves for one
   * image reference, e.g. `ghcr.io/docker-mailserver/docker-mailserver:latest`.
   * Returns `null` when the registry could not be reached, the reference
   * could not be parsed, or the tag was not found — **never throws** for
   * any of those. This is this project's "Unknown, not Invalid"
   * discipline (AGENT_BRIEF.md §4's DNS-state example) applied to
   * registry lookups: a transient network failure must read as "could not
   * check" in the UI, not as "no update available" or a crashed page.
   */
  resolveTagDigest(imageReference: string): Promise<string | null>;
}
