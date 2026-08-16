/**
 * Pure, driver-shape -> DTO mapping helpers shared by every M7 mail
 * service (`domains.service.ts`, `mailboxes.service.ts`,
 * `aliases.service.ts`, `quotas.service.ts`). Kept dependency-free of
 * Fastify/the database — these are the same kind of pure projection
 * `drivers/dms/domains.ts`'s `deriveDomains` already is, just one layer
 * up (driver types -> `@dwg/shared` wire types).
 */
import type {
  AliasSummary,
  AliasType,
  DomainSummary,
  MailboxSummary,
  MailboxUsage,
} from '@dwg/shared';
import type { DerivedDomain } from '../../drivers/dms/domains.js';
import type { PostfixAccountEntry } from '../../drivers/dms/parsers/postfix-accounts.js';
import type { PostfixVirtualEntry } from '../../drivers/dms/parsers/postfix-virtual.js';
import {
  isRestrictAction,
  type PostfixAccessEntry,
} from '../../drivers/dms/parsers/postfix-access.js';
import type { QuotaUsageResult } from '../../drivers/dms/quota-usage.js';

export function toDomainSummaryDto(domain: DerivedDomain): DomainSummary {
  return {
    domain: domain.domain,
    mailboxCount: domain.mailboxCount,
    aliasCount: domain.aliasCount,
    aliasOnly: domain.aliasOnly,
  };
}

export interface RestrictionSets {
  readonly send: ReadonlySet<string>;
  readonly receive: ReadonlySet<string>;
}

/** Reduces the two `postfix-{send,receive}-access.cf` reads to the two email sets `toMailboxSummaryDto` needs — computed once per request, not once per mailbox. */
export function restrictionSetsFrom(
  sendEntries: readonly PostfixAccessEntry[],
  receiveEntries: readonly PostfixAccessEntry[],
): RestrictionSets {
  return {
    send: new Set(
      sendEntries.filter((entry) => isRestrictAction(entry.action)).map((e) => e.email),
    ),
    receive: new Set(
      receiveEntries.filter((entry) => isRestrictAction(entry.action)).map((e) => e.email),
    ),
  };
}

export function toMailboxSummaryDto(
  account: PostfixAccountEntry,
  quotaByEmail: ReadonlyMap<string, string>,
  restriction: RestrictionSets,
): MailboxSummary {
  return {
    email: account.email,
    localPart: account.localPart,
    domain: account.domain,
    quota: quotaByEmail.get(account.email) ?? null,
    restricted: {
      send: restriction.send.has(account.email),
      receive: restriction.receive.has(account.email),
    },
  };
}

/** `available: false` (never a fabricated number) whenever the underlying `doveadm` read failed or could not be confidently parsed — see `quota-usage.ts`'s doc comment. */
export function toMailboxUsageDto(result: QuotaUsageResult): MailboxUsage {
  if (!result.ok) {
    return {
      available: false,
      storageBytesUsed: null,
      storageBytesLimit: null,
      messageCountUsed: null,
      messageCountLimit: null,
    };
  }
  return {
    available: true,
    storageBytesUsed: result.usage.storageBytesUsed,
    storageBytesLimit: result.usage.storageBytesLimit,
    messageCountUsed: result.usage.messageCountUsed,
    messageCountLimit: result.usage.messageCountLimit,
  };
}

function domainOf(address: string): string {
  const atIndex = address.lastIndexOf('@');
  return atIndex === -1 ? '' : address.slice(atIndex + 1).toLowerCase();
}

/**
 * `internal` when every recipient's domain is one this DMS deployment is
 * already responsible for (i.e. it appears in the derived domain list —
 * `drivers/dms/domains.ts`); `external` when none are; `mixed` when both
 * (FEATURE_MATRIX.md §5). A recipient that is itself another local alias
 * counts as internal, matching Postfix's own recursive resolution of
 * alias-to-alias chains.
 */
export function classifyAliasType(
  recipients: readonly string[],
  localDomains: ReadonlySet<string>,
): AliasType {
  const internalCount = recipients.filter((recipient) =>
    localDomains.has(domainOf(recipient)),
  ).length;
  if (internalCount === recipients.length) return 'internal';
  if (internalCount === 0) return 'external';
  return 'mixed';
}

export function toAliasSummaryDto(
  entry: PostfixVirtualEntry,
  localDomains: ReadonlySet<string>,
): AliasSummary {
  return {
    id: entry.address,
    address: entry.address,
    isCatchAll: entry.isCatchAll,
    domain: entry.domain,
    recipients: [...entry.recipients],
    type: classifyAliasType(entry.recipients, localDomains),
  };
}
