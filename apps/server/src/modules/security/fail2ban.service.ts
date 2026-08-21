/**
 * Fail2ban service (`docs/research/03-mail-stack-components.md` §10;
 * FEATURE_MATRIX.md §16b: "`setup fail2ban` provides jail status and the
 * banned-IP list; unbanning is a real mutation, so it requires
 * confirmation and is audited"). All three `DmsDriver` methods
 * this wraps (`fail2banList`, `fail2banStatus`, `fail2banBan`/
 * `fail2banUnban`) already exist — this service adds only capability
 * gating and the read-side merge, mirroring `RspamdService`'s shape.
 *
 * `setup fail2ban status`'s exact output shape is `[UNCERTAIN]`
 * (research doc §10 / FEATURE_MATRIX.md's deferred-verification table),
 * so `rawStatus` is always returned verbatim alongside the defensively
 * extracted `bannedIps` list (`drivers/dms/fail2ban-parser.ts`) — the UI
 * never depends solely on extraction succeeding.
 */
import type { DmsDriver } from '../../drivers/dms/index.js';
import { AppError } from '../../platform/errors.js';
import type { Fail2banStatusResponse } from '@dwg/shared';

export class Fail2banService {
  constructor(private readonly dmsDriver: DmsDriver) {}

  async getStatus(): Promise<Fail2banStatusResponse> {
    const capabilities = await this.dmsDriver.getCapabilities();

    if (!capabilities.fail2ban.supported) {
      return { capability: capabilities.fail2ban, bannedIps: [], rawStatus: '' };
    }

    // `fail2banList`'s own `raw` is the plain ban listing; `fail2banStatus`
    // is the richer per-jail dump `setup fail2ban status` produces — both
    // real, independent commands, fetched together so one screen shows
    // both without a second round trip.
    const [list, rawStatus] = await Promise.all([
      this.dmsDriver.fail2banList(),
      this.dmsDriver.fail2banStatus(),
    ]);

    return { capability: capabilities.fail2ban, bannedIps: [...list.bannedIps], rawStatus };
  }

  private async assertSupported(): Promise<void> {
    const capabilities = await this.dmsDriver.getCapabilities();
    if (!capabilities.fail2ban.supported) {
      throw new AppError(
        'CAPABILITY_UNSUPPORTED',
        capabilities.fail2ban.reason ?? 'Fail2ban is unsupported on this deployment.',
      );
    }
  }

  /** `setup fail2ban ban <IP>` — a real, symmetric counterpart to `unban`; named nowhere in FEATURE_MATRIX.md §16b, which mentions only unbanning, but the same capability and the same driver method exist for it, and an admin manually banning a problem IP is a legitimate action. */
  async ban(ip: string): Promise<void> {
    await this.assertSupported();
    await this.dmsDriver.fail2banBan({ ip });
  }

  /** `setup fail2ban unban <IP>` — restores network access for a previously-blocked IP; the route layer requires confirmation and always audits this call. */
  async unban(ip: string): Promise<void> {
    await this.assertSupported();
    await this.dmsDriver.fail2banUnban({ ip });
  }
}
