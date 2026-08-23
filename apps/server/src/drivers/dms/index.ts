/**
 * `apps/server/src/drivers/dms` — the docker-mailserver integration
 * driver (M5; ARCHITECTURE.md §5, §5.1). See `types.ts` for the
 * `DmsDriver` interface, `real-dms-driver.ts` / `fake-dms-driver.ts` for
 * the two implementations, and `create-dms-driver.ts` for how one is
 * selected — mirrors `drivers/broker/index.ts`.
 */
export type { DmsDriver, DkimRecordReadResult } from './types.js';
export { parseDkimZoneFile, parseDkimZoneFileValue, type DkimZoneRecord } from './dkim-record.js';
export { parseFail2banList, type Fail2banListResult } from './fail2ban-parser.js';
export { RealDmsDriver } from './real-dms-driver.js';
export { FakeDmsDriver } from './fake-dms-driver.js';
export { createDmsDriver } from './create-dms-driver.js';
export type { DmsExecPort, DmsCommandRequest } from './exec-port.js';
export { BrokerDmsExecPort } from './broker-dms-exec-port.js';
export { DmsCommandValidationError, DmsCommandExecutionError } from './errors.js';
export {
  type DmsCapabilities,
  type CapabilityStatus,
  type AccountProvisioner,
  detectCapabilities,
} from './capabilities.js';
export { deriveDomains, type DerivedDomain } from './domains.js';
export {
  parseDoveadmQuotaGet,
  parseQuotaToBytes,
  type QuotaUsage,
  type QuotaUsageResult,
} from './quota-usage.js';
export * from './params.js';
export * from './parsers/index.js';
