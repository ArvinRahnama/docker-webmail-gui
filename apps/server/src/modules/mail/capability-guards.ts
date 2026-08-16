/**
 * Server-side capability gates for mail mutations (FEATURE_MATRIX.md §3,
 * §7; `drivers/dms/capabilities.ts`). Reads are always attempted honestly
 * (a config file that genuinely has no entries yields a genuinely empty
 * list); only *writes* are refused outright here, because a write that
 * "succeeds" against a capability this deployment does not have would be
 * silently meaningless (`capabilities.ts`'s own `localAccountManagement`
 * doc comment) — exactly the "fail obscurely" this project refuses to do.
 *
 * The web tier makes the same decision for *rendering* (§7: "render a
 * real `UnsupportedNotice` ... not an empty table") from the same
 * `GET /api/v1/mail/capabilities` document these functions read — server
 * and client are never allowed to disagree about what this deployment
 * can do.
 */
import type { DmsDriver } from '../../drivers/dms/index.js';
import { AppError } from '../../platform/errors.js';

const LOCAL_ACCOUNT_MANAGEMENT_FALLBACK_REASON =
  'Local mailbox/alias management is unsupported on this deployment.';
const QUOTAS_FALLBACK_REASON = 'Quota management is unsupported on this deployment.';

/** Throws `CAPABILITY_UNSUPPORTED` unless `ACCOUNT_PROVISIONER=FILE` — every mailbox/alias-mutating route calls this first. */
export async function assertLocalAccountManagementSupported(driver: DmsDriver): Promise<void> {
  const capabilities = await driver.getCapabilities();
  if (!capabilities.localAccountManagement.supported) {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      capabilities.localAccountManagement.reason ?? LOCAL_ACCOUNT_MANAGEMENT_FALLBACK_REASON,
    );
  }
}

/** Throws `CAPABILITY_UNSUPPORTED` unless `ENABLE_QUOTAS` is on — every quota-mutating route calls this first. */
export async function assertQuotasSupported(driver: DmsDriver): Promise<void> {
  const capabilities = await driver.getCapabilities();
  if (!capabilities.quotas.supported) {
    throw new AppError(
      'CAPABILITY_UNSUPPORTED',
      capabilities.quotas.reason ?? QUOTAS_FALLBACK_REASON,
    );
  }
}
