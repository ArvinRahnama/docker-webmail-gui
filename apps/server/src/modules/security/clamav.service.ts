/**
 * ClamAV service (FEATURE_MATRIX.md §16; `docs/research/03-mail-stack-components.md`
 * §2). Status (`PING`/`VERSION`/`STATS` over the clamd control socket) is a
 * read; triggering a signature update (`freshclam`) is a mutation, audited
 * like every other DMS write in this codebase.
 *
 * **Detection counts are log-derived, not a clamd counter — there is no
 * such counter** (research doc §2's ★2: "no clamd command or persistent
 * counter for 'number of viruses detected'"). `getDetections` tails the
 * combined mail log and counts plausible detection lines
 * (`drivers/dms/clamav-parser.ts`'s `countClamavDetections`), and the
 * response always states the sampling window alongside the number
 * (FEATURE_MATRIX.md §16: "Clearly labelled as log-derived, with its
 * retention window stated") — this is a bounded, best-effort sample,
 * never presented as a lifetime total.
 */
import {
  countClamavDetections,
  isPongReply,
  parseClamdVersion,
} from '../../drivers/dms/clamav-parser.js';
import type { DmsDriver } from '../../drivers/dms/index.js';
import { AppError } from '../../platform/errors.js';
import type {
  ClamAvDetectionsResponse,
  ClamAvStatusResponse,
  ClamAvUpdateResponse,
} from '@dwg/shared';

/** How far back `clamavLogTail`'s fixed tail window reaches — stated alongside every real count so it is never mistaken for a lifetime total. Kept in sync with `commands.ts`'s `CLAMAV_LOG_TAIL_LINES` by convention (both describe the same tail call); a mismatch here would only ever understate/overstate the caveat text, never the count itself. */
const CLAMAV_DETECTIONS_WINDOW =
  'the most recent ~5,000 lines of the mail log currently on disk (older entries are lost once the log rotates)';

export class ClamavService {
  constructor(private readonly dmsDriver: DmsDriver) {}

  async getStatus(): Promise<ClamAvStatusResponse> {
    const capabilities = await this.dmsDriver.getCapabilities();

    if (!capabilities.clamav.supported) {
      return {
        capability: capabilities.clamav,
        reachable: false,
        error: null,
        version: null,
        stats: null,
      };
    }

    const ping = await this.dmsDriver.clamavPing();
    // Exit code alone isn't enough: `socat` can succeed (exit 0) while
    // relaying something other than a real `PONG` from clamd (e.g. an
    // empty reply from a socket that accepted the connection but isn't
    // actually clamd) — `reachable` should mean "clamd answered," not just
    // "the exec didn't fail."
    if (!ping.ok || !isPongReply(ping.output)) {
      return {
        capability: capabilities.clamav,
        reachable: false,
        error: ping.ok ? `Unexpected reply to PING: "${ping.output.trim()}"` : ping.reason,
        version: null,
        stats: null,
      };
    }

    const [version, stats] = await Promise.all([
      this.dmsDriver.clamavVersion(),
      this.dmsDriver.clamavStats(),
    ]);

    return {
      capability: capabilities.clamav,
      reachable: true,
      error: null,
      version: version.ok ? parseClamdVersion(version.output).raw : null,
      // Never parsed — see the module comment and `clamav-parser.ts`.
      stats: stats.ok ? stats.output : null,
    };
  }

  async getDetections(): Promise<ClamAvDetectionsResponse> {
    const capabilities = await this.dmsDriver.getCapabilities();

    if (!capabilities.clamav.supported) {
      return {
        capability: capabilities.clamav,
        available: false,
        count: null,
        windowDescription: null,
        reason: capabilities.clamav.reason,
      };
    }

    const tail = await this.dmsDriver.clamavLogTail();
    if (!tail.ok) {
      return {
        capability: capabilities.clamav,
        available: false,
        count: null,
        windowDescription: null,
        reason: tail.reason,
      };
    }

    return {
      capability: capabilities.clamav,
      available: true,
      count: countClamavDetections(tail.output),
      windowDescription: CLAMAV_DETECTIONS_WINDOW,
      reason: null,
    };
  }

  private async assertSupported(): Promise<void> {
    const capabilities = await this.dmsDriver.getCapabilities();
    if (!capabilities.clamav.supported) {
      throw new AppError(
        'CAPABILITY_UNSUPPORTED',
        capabilities.clamav.reason ?? 'ClamAV is unsupported on this deployment.',
      );
    }
  }

  /** `freshclam` — a real, rate-limited-at-the-route-layer operation (FEATURE_MATRIX.md §16). */
  async triggerSignatureUpdate(): Promise<ClamAvUpdateResponse> {
    await this.assertSupported();
    const output = await this.dmsDriver.clamavUpdateSignatures();
    return { triggered: true, output };
  }
}
