/**
 * The visible-service allowlist (v0.3 — FEATURE_MATRIX.md §22-26). On a
 * shared Docker host the panel runs alongside unrelated containers,
 * images, volumes and networks; this module decides which of them the
 * panel is allowed to see at all.
 *
 * **It narrows, it never widens.** Filtering happens broker-side, on the
 * `container.list`/`image.list`/`volume.list`/`network.list` results,
 * *before* they leave the privileged tier — so the web tier physically
 * cannot enumerate host resources outside this set, not merely declines
 * to render them. The patterns and identities that define the set live in
 * broker configuration (`apps/broker/src/config.ts`), never in a request:
 * there is no field anywhere in the broker protocol (`broker.ts`) that
 * could carry a filter, so a compromised web tier cannot widen the set to
 * "show everything". `FakeBrokerClient` applies the identical functions to
 * its fixtures, so development and tests see the same narrowed view
 * production does.
 *
 * The functions here are **pure** — like `computeProtectedVolumeNames`
 * (broker.ts), the safety-relevant matching lives in one place both the
 * real broker and the fake call, so the two cannot drift.
 */

/**
 * A container's identity as this project addresses it: an exact container
 * name, or a `key=value` label selector that wins when present. The exact
 * same shape the broker's `container-resolver.ts` resolves the managed
 * mail container and the panel's own containers by — reused here so
 * "which containers are always visible" and "which container do we act
 * on" are answered by one definition of identity, not two.
 */
export interface ServiceIdentity {
  readonly containerName: string;
  /** Raw `key=value` selector, e.g. `"com.docker-webmail-gui.role=mail"`, or `null` to match by name. */
  readonly containerLabel: string | null;
}

/** The subset of a container's fields identity/pattern matching needs — satisfied structurally by both the broker's raw list item and `ContainerSummary`. */
export interface IdentifiableContainer {
  readonly names: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
}

/** Strips Docker's leading `/` from a container name (`/mailserver` -> `mailserver`) so name matching deals in plain names throughout, whether or not the source already normalised them. */
export function stripLeadingSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

/**
 * True when `container` matches `identity`. Label selector wins when
 * configured (matched **exactly** on `key=value`); otherwise the plain
 * container name must appear **exactly** in the names list. Never a
 * substring match — Docker's own `name` filter is substring-based, which
 * would make `"mailserver"` also match `"mailserver-old"`; this project
 * always matches the full value instead (see `container-resolver.ts`'s own
 * note on that pitfall).
 */
export function matchesServiceIdentity(
  container: IdentifiableContainer,
  identity: ServiceIdentity,
): boolean {
  if (identity.containerLabel !== null) {
    const eq = identity.containerLabel.indexOf('=');
    const key = eq === -1 ? identity.containerLabel : identity.containerLabel.slice(0, eq);
    const value = eq === -1 ? '' : identity.containerLabel.slice(eq + 1);
    return container.labels[key] === value;
  }
  const wanted = stripLeadingSlash(identity.containerName);
  return container.names.some((name) => stripLeadingSlash(name) === wanted);
}

/**
 * Compiles one operator-supplied glob (`*` = any run of characters, all
 * other characters literal) to an anchored, case-insensitive `RegExp`.
 * Every regex metacharacter except `*` is escaped, so a pattern can only
 * ever mean "this text, with `*` wildcards" — never an injected regexp.
 */
function globToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : `\\${ch}`));
  return new RegExp(`^${source}$`, 'i');
}

/** True when `value` matches any of the glob `patterns`. */
export function matchesAnyPattern(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

/**
 * Default visible-service patterns, applied to container names and image
 * repo tags. Covers the three services a stock install ships or manages —
 * the docker-mailserver image (`*mailserver*`), the panel's own images
 * (`*docker-webmail-gui*`) — and the owner's stated third category,
 * "roundcube or other mail gui" (`roundcube*`, which matches both
 * `roundcube` and `roundcube-db`). An operator adds other webmail GUIs by
 * appending to `VISIBLE_SERVICE_PATTERNS`. The panel's and mail server's
 * own *containers* are additionally always visible by identity, so they
 * appear even if an operator narrows these patterns.
 */
export const DEFAULT_VISIBLE_SERVICE_PATTERNS: readonly string[] = [
  '*mailserver*',
  'roundcube*',
  '*docker-webmail-gui*',
];

/**
 * Parses a comma-separated pattern list from configuration. Empty/unset
 * falls back to {@link DEFAULT_VISIBLE_SERVICE_PATTERNS} — an operator who
 * sets nothing gets the sensible defaults, never an empty set that would
 * hide everything.
 */
export function parseVisiblePatterns(raw: string | null | undefined): readonly string[] {
  if (raw === null || raw === undefined) return DEFAULT_VISIBLE_SERVICE_PATTERNS;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : DEFAULT_VISIBLE_SERVICE_PATTERNS;
}

/** Everything that decides whether a container is visible: the always-visible config-known identities, plus the name patterns. */
export interface ContainerVisibility {
  readonly identities: readonly ServiceIdentity[];
  readonly patterns: readonly string[];
}

/**
 * True when a container belongs to the visible webmail set: it matches one
 * of the config-known identities (the mail server, the panel's own server
 * and broker), or any of its names matches a visible-service pattern.
 */
export function isContainerVisible(
  container: IdentifiableContainer,
  visibility: ContainerVisibility,
): boolean {
  if (visibility.identities.some((identity) => matchesServiceIdentity(container, identity))) {
    return true;
  }
  return container.names.some((name) =>
    matchesAnyPattern(stripLeadingSlash(name), visibility.patterns),
  );
}

/**
 * True when an image belongs to the visible webmail set: any of its repo
 * tags matches a visible-service pattern, or its id/tags are the image of
 * a currently-visible container (`referencedImageRefs`). The second rule
 * keeps a supporting image a visible service actually runs — e.g. the
 * database image behind a webmail GUI — visible even when its repository
 * name matches no pattern, so the images list stays consistent with the
 * containers list rather than needing every supporting image spelled out.
 * A dangling (untagged) image matches no pattern and, unless a visible
 * container references it by id, is treated as unrelated host cruft and
 * hidden — `image.prune` still reclaims it host-wide regardless.
 */
export function isImageVisible(
  image: { readonly id: string; readonly repoTags: readonly string[] },
  patterns: readonly string[],
  referencedImageRefs: ReadonlySet<string>,
): boolean {
  if (image.repoTags.some((tag) => matchesAnyPattern(tag, patterns))) return true;
  if (referencedImageRefs.has(image.id)) return true;
  return image.repoTags.some((tag) => referencedImageRefs.has(tag));
}
