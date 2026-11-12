/**
 * Reads docker/dms/dwg/install.sh's marker file: a single integer, the
 * integration's version, present only once the install succeeded inside
 * the running mail container.
 */
import type { SpamIntegrationStatus } from '@dwg/shared';

export const NOT_INSTALLED: SpamIntegrationStatus = Object.freeze({
  installed: false,
  version: null,
});

export function parseSpamIntegrationMarker(content: string | null): SpamIntegrationStatus {
  if (content === null) return NOT_INSTALLED;
  const match = /^\s*(\d{1,4})\s*$/.exec(content);
  if (match === null) return NOT_INSTALLED;
  return { installed: true, version: Number(match[1]) };
}
