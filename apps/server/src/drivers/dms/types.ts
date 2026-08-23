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
import type { SieveScriptSummary } from './sieve-list-parser.js';
import type { MailQueueEntry } from './parsers/postqueue.js';
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
  SievePutParams,
  SieveScriptParams,
  SieveUserParams,
  UpdateMailboxPasswordParams,
} from './params.js';

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

/**
 * Result shape for every ClamAV **read** (`clamavPing`/`clamavVersion`/
 * `clamavStats`/`clamavLogTail`). Deliberately a soft `ok`/`reason` result
 * rather than a thrown error, unlike almost every other `DmsDriver` read —
 * an unreachable clamd (or a missing `socat`/log file) is an expected,
 * routine runtime state the UI renders as "reachable: false"
 * (FEATURE_MATRIX.md §16), not a request the admin needs to fix, so it
 * must never surface as an HTTP 5xx via the global `DmsCommandExecutionError`
 * mapping (`platform/errors.ts`). This mirrors `RspamdClientPort`'s own
 * `RspamdResult` for the identical reason (`drivers/rspamd/types.ts`).
 */
export type ClamavReadResult =
  { readonly ok: true; readonly output: string } | { readonly ok: false; readonly reason: string };

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

  /** clamd `PING` over the control socket — see `ClamavReadResult`'s doc comment for why this never throws on an unreachable daemon. */
  clamavPing(): Promise<ClamavReadResult>;
  /** clamd `VERSION` — raw reply; `clamav-parser.ts`'s `parseClamdVersion` splits it further, defensively. */
  clamavVersion(): Promise<ClamavReadResult>;
  /** clamd `STATS` — raw reply, intentionally never parsed (module comment, `clamav-parser.ts`): upstream documents this as unstable free text. */
  clamavStats(): Promise<ClamavReadResult>;
  /** The last `CLAMAV_LOG_TAIL_LINES` lines of the combined mail log — the only route to a virus-detection count (FEATURE_MATRIX.md §16; clamd itself exposes no counter). */
  clamavLogTail(): Promise<ClamavReadResult>;

  /** `doveadm -f json sieve list -u <user>` — every stored script for this mailbox plus which one is active. */
  sieveList(user: string): Promise<readonly SieveScriptSummary[]>;
  /** `doveadm sieve get -u <user> <name>` — a script's current source. */
  sieveGet(user: string, name: string): Promise<string>;
  /** `postqueue -j` (M11 — dashboard's "Mail queue" tile, FEATURE_MATRIX.md §1) — every queued message this call could parse, grouping is the caller's job (`parsers/postqueue.ts`'s own doc comment quotes the research doc on why). */
  getMailQueue(): Promise<ParseResult<MailQueueEntry>>;

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
  /** `freshclam` — triggers a signature database update. Unlike the ClamAV reads above, this genuinely does throw on failure (`DmsCommandExecutionError`, mapped globally to `UPSTREAM_UNAVAILABLE`): it is an admin-initiated mutation with a single real outcome to report, not a routine "is the daemon up" probe. Resolves with `freshclam`'s own stdout. */
  clamavUpdateSignatures(): Promise<string>;
  /** `doveadm sieve put -u <user> <name>`, content via stdin — see `commands.ts`'s `buildSievePutCommand` doc comment for why a non-zero exit here means a real Pigeonhole compile failure, not an unrelated upstream error. */
  sievePut(params: SievePutParams): Promise<void>;
  /** `doveadm sieve activate -u <user> <name>`. */
  sieveActivate(params: SieveScriptParams): Promise<void>;
  /** `doveadm sieve deactivate -u <user>` — deactivates whichever script is currently active; no-op-safe to call when none is. */
  sieveDeactivate(params: SieveUserParams): Promise<void>;
}
