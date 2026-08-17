/**
 * `DmsDriver` — the single interface the rest of the app uses to talk to
 * docker-mailserver, mirroring `drivers/broker/types.ts`'s `BrokerClient`.
 * Two implementations: `RealDmsDriver` (parses real config files via a
 * `DmsExecPort`, invokes `setup` through the same port) and `FakeDmsDriver`
 * (deterministic, in-memory, fixture-seeded — the development default;
 * see `create-dms-driver.ts`).
 *
 * Read methods return a `ParseResult` for the three file-backed lists (so
 * a caller can always show "N loaded, M lines could not be read" rather
 * than silently losing state — `parsers/parse-result.ts`), or a plain
 * array/object for `listDomains`/`getCapabilities`, which are computed
 * views with no "unparseable line" concept of their own.
 *
 * Write methods build their argv via the matching `commands.ts` builder
 * and throw `DmsCommandValidationError` for input a builder rejected, or
 * (real driver only, once a command was actually invoked)
 * `DmsCommandExecutionError` for a non-zero exit — see `errors.ts`. There
 * is deliberately no generic `run(argv)` escape hatch here, same rationale
 * as `BrokerClient`: nothing holding a `DmsDriver` can express an
 * operation this interface does not already name.
 */
import type { ParseResult } from './parsers/parse-result.js';
import type { PostfixAccountEntry } from './parsers/postfix-accounts.js';
import type { PostfixVirtualEntry } from './parsers/postfix-virtual.js';
import type { DovecotQuotaEntry } from './parsers/dovecot-quotas.js';
import type { PostfixAccessEntry } from './parsers/postfix-access.js';
import type { DerivedDomain } from './domains.js';
import type { DmsCapabilities } from './capabilities.js';
import type { QuotaUsageResult } from './quota-usage.js';
import type { DkimZoneRecord } from './dkim-record.js';
import type { Fail2banListResult } from './fail2ban-parser.js';
import type {
  AddAliasParams,
  AddMailboxParams,
  ConfigDkimParams,
  DeleteAliasParams,
  DeleteMailboxParams,
  DeleteQuotaParams,
  Fail2banIpParams,
  RestrictMailboxParams,
  RestrictScope,
  SetQuotaParams,
  UpdateMailboxPasswordParams,
} from './commands.js';

/**
 * `getDkimRecord`'s result — mirrors `QuotaUsageResult`'s `ok`/reason
 * shape (`quota-usage.ts`). `'not-generated'` means no key exists yet for
 * this domain/selector (not an error — a fresh deployment, or a domain
 * that has never had `generateDkim` called for it); `'unparseable'` means
 * a `.txt` file exists but its content did not match the expected
 * zone-file shape (`dkim-record.ts`'s `parseDkimZoneFile` returned
 * `null`) — reported honestly rather than guessed at, same discipline as
 * every other "could not confidently parse" branch in this driver.
 */
export type DkimRecordReadResult =
  | { readonly ok: true; readonly record: DkimZoneRecord }
  | { readonly ok: false; readonly reason: 'not-generated' | 'unparseable' };

export interface DmsDriver {
  // Reads — parse config state (FEATURE_MATRIX.md §0 Rule 1).
  listMailboxes(): Promise<ParseResult<PostfixAccountEntry>>;
  listAliases(): Promise<ParseResult<PostfixVirtualEntry>>;
  listQuotas(): Promise<ParseResult<DovecotQuotaEntry>>;
  /** Derived, read-only — there is no `setup domain` command (★1; FEATURE_MATRIX.md §2). */
  listDomains(): Promise<readonly DerivedDomain[]>;
  getCapabilities(): Promise<DmsCapabilities>;
  /** Reads `postfix-{send,receive}-access.cf` — the read half of "Restrict sending / receiving" (FEATURE_MATRIX.md §3; `parsers/postfix-access.ts`). */
  getRestrictedAddresses(scope: RestrictScope): Promise<ParseResult<PostfixAccessEntry>>;
  /** Live usage via `doveadm -f json quota get -u` (FEATURE_MATRIX.md §7; `quota-usage.ts`) — distinct from `listQuotas`, which only reads the configured *limit*. */
  getMailboxUsage(email: string): Promise<QuotaUsageResult>;
  /** The **public** DKIM record only (FEATURE_MATRIX.md §11) — see `DmsExecPort.readDkimPublicKeyFile`'s doc comment for why there is no equivalent private-key read anywhere. */
  getDkimRecord(domain: string, selector: string): Promise<DkimRecordReadResult>;
  /** `SSL_TYPE` from the DMS environment (FEATURE_MATRIX.md §12: "`SSL_TYPE` mode display") — `null` when unset. A narrow, single-purpose read rather than folded into `getCapabilities()`, which is documented as strictly the `ENABLE_*` on/off surface. */
  getSslType(): Promise<string | null>;
  /** `setup fail2ban` — currently banned IPs, defensively extracted (`fail2ban-parser.ts`) plus the raw output for fallback display. */
  fail2banList(): Promise<Fail2banListResult>;
  /** `setup fail2ban status` — deliberately returned as **raw text only**: FEATURE_MATRIX.md's own deferred-verification table flags this output's shape as `[UNCERTAIN]` and names "show raw output if parsing fails" as the fallback; this method takes that fallback as the primary (and only) contract rather than committing to a table structure with no confirmed example to parse against. */
  fail2banStatus(): Promise<string>;

  // Writes — invoke `setup` via commands.ts builders (Rule 1's other half).
  addMailbox(params: AddMailboxParams): Promise<void>;
  updateMailboxPassword(params: UpdateMailboxPasswordParams): Promise<void>;
  /** `params.mailData` is required with no default (★4) — see `commands.ts`'s `MailDataChoice`. */
  deleteMailbox(params: DeleteMailboxParams): Promise<void>;
  restrictMailbox(params: RestrictMailboxParams): Promise<void>;
  setQuota(params: SetQuotaParams): Promise<void>;
  deleteQuota(params: DeleteQuotaParams): Promise<void>;
  addAlias(params: AddAliasParams): Promise<void>;
  deleteAlias(params: DeleteAliasParams): Promise<void>;
  generateDkim(params?: ConfigDkimParams): Promise<void>;
  fail2banBan(params: Fail2banIpParams): Promise<void>;
  fail2banUnban(params: Fail2banIpParams): Promise<void>;
}
