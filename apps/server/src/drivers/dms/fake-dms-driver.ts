/**
 * Deterministic, in-memory {@link DmsDriver} seeded from fixtures
 * (`fixtures/index.ts`). Touches no file system, no exec, no broker.
 * **The development default** — see `create-dms-driver.ts` — so the panel
 * is fully developable without a running docker-mailserver container.
 *
 * Every write method runs its input through the *same* `commands.ts`
 * builder `RealDmsDriver` would use, so an invalid call is rejected
 * identically by both implementations — only a validated call ever
 * reaches this class's own in-memory bookkeeping. That bookkeeping models
 * DMS's own confirmed write semantics where the research doc is explicit
 * (e.g. ★4's account-delete side effects: quota entry and pointing
 * aliases are always removed alongside the account). Where the doc is
 * silent on an edge case (e.g. whether `email add` on an already-existing
 * address is rejected or silently overwrites), this class makes the
 * conservative choice — reject — and says so in a comment, rather than
 * presenting an invented behaviour as researched fact.
 */
import {
  buildAliasAddCommand,
  buildAliasDeleteCommand,
  buildConfigDkimCommand,
  buildEmailAddCommand,
  buildEmailDeleteCommand,
  buildEmailRestrictCommand,
  buildEmailUpdateCommand,
  buildFail2banBanCommand,
  buildFail2banUnbanCommand,
  buildQuotaDeleteCommand,
  buildQuotaSetCommand,
  type AddAliasParams,
  type AddMailboxParams,
  type CommandResult,
  type ConfigDkimParams,
  type DeleteAliasParams,
  type DeleteMailboxParams,
  type DeleteQuotaParams,
  type Fail2banIpParams,
  type RestrictMailboxParams,
  type RestrictScope,
  type SetQuotaParams,
  type UpdateMailboxPasswordParams,
} from './commands.js';
import { detectCapabilities, type DmsCapabilities } from './capabilities.js';
import { deriveDomains, type DerivedDomain } from './domains.js';
import { DmsCommandValidationError } from './errors.js';
import {
  FIXTURE_DMS_ENV,
  FIXTURE_DOVECOT_QUOTAS_CF,
  FIXTURE_POSTFIX_ACCOUNTS_CF,
  FIXTURE_POSTFIX_RECEIVE_ACCESS_CF,
  FIXTURE_POSTFIX_SEND_ACCESS_CF,
  FIXTURE_POSTFIX_VIRTUAL_CF,
} from './fixtures/index.js';
import type { ParseResult } from './parsers/parse-result.js';
import { parseDovecotQuotas, type DovecotQuotaEntry } from './parsers/dovecot-quotas.js';
import { parsePostfixAccounts, type PostfixAccountEntry } from './parsers/postfix-accounts.js';
import { parsePostfixVirtual, type PostfixVirtualEntry } from './parsers/postfix-virtual.js';
import {
  isRestrictAction,
  parsePostfixAccess,
  type PostfixAccessEntry,
} from './parsers/postfix-access.js';
import { parseQuotaToBytes, type QuotaUsageResult } from './quota-usage.js';
import type { DmsDriver } from './types.js';

/** Marker hash the fake writes for a freshly-added/updated mailbox. Never a real `doveadm pw` digest — this project never computes real password hashes (FEATURE_MATRIX.md §6). */
const FAKE_PASSWORD_HASH_MARKER = '{FAKE-HASH-DEV-ONLY}';

/** Throws {@link DmsCommandValidationError} for a rejected `commands.ts` result; otherwise a no-op. Every write method below calls this *before* touching any in-memory state, so a rejected call never partially mutates anything. */
function assertValid(result: CommandResult): void {
  if (!result.ok) throw new DmsCommandValidationError(result.error);
}

/** Re-derives `{localPart, domain}` for a value `commands.ts` has already validated as `local@domain` — used only when constructing a brand-new fixture entry, never on unvalidated input. */
function splitForFixture(email: string): { localPart: string; domain: string } {
  const atIndex = email.lastIndexOf('@');
  return { localPart: email.slice(0, atIndex), domain: email.slice(atIndex + 1).toLowerCase() };
}

/** Like {@link splitForFixture} but also accepts an already-validated catch-all (`@domain`). */
function splitAliasForFixture(address: string): { localPart: string; domain: string } {
  if (address.startsWith('@')) return { localPart: '', domain: address.slice(1).toLowerCase() };
  return splitForFixture(address);
}

const DEFAULT_FIXTURE_QUOTA_BYTES = 1024 ** 3; // 1 GiB nominal total for an unlimited mailbox's pseudo-usage bar.

/** A stable pseudo-random fraction in `[0.05, 0.95)` derived from `input` — same input always yields the same output (`getMailboxUsage`'s doc comment). Not a cryptographic hash; this only ever feeds fixture display data. */
function stableFraction(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return 0.05 + (hash % 900) / 1000;
}

export class FakeDmsDriver implements DmsDriver {
  private accounts: PostfixAccountEntry[];
  private aliases: PostfixVirtualEntry[];
  private quotas: DovecotQuotaEntry[];
  private sendAccess: PostfixAccessEntry[];
  private receiveAccess: PostfixAccessEntry[];

  constructor() {
    // Seeded once, at construction, by parsing the same fixture file
    // content a real DMS install would have written — so the fake starts
    // from state that has actually round-tripped through the real parsers
    // at least once, rather than a hand-built object graph that could
    // drift from what the parsers actually produce.
    this.accounts = [...parsePostfixAccounts(FIXTURE_POSTFIX_ACCOUNTS_CF).entries];
    this.aliases = [...parsePostfixVirtual(FIXTURE_POSTFIX_VIRTUAL_CF).entries];
    this.quotas = [...parseDovecotQuotas(FIXTURE_DOVECOT_QUOTAS_CF).entries];
    this.sendAccess = [...parsePostfixAccess(FIXTURE_POSTFIX_SEND_ACCESS_CF).entries];
    this.receiveAccess = [...parsePostfixAccess(FIXTURE_POSTFIX_RECEIVE_ACCESS_CF).entries];
  }

  /** Selects the in-memory array `getRestrictedAddresses`/`restrictMailbox` operate on for a given scope — mirrors `RealDmsDriver`'s `RESTRICT_SCOPE_FILE_NAME`. */
  private accessListFor(scope: RestrictScope): PostfixAccessEntry[] {
    return scope === 'send' ? this.sendAccess : this.receiveAccess;
  }

  async listMailboxes(): Promise<ParseResult<PostfixAccountEntry>> {
    return { entries: [...this.accounts], issues: [] };
  }

  async listAliases(): Promise<ParseResult<PostfixVirtualEntry>> {
    return { entries: [...this.aliases], issues: [] };
  }

  async listQuotas(): Promise<ParseResult<DovecotQuotaEntry>> {
    return { entries: [...this.quotas], issues: [] };
  }

  async listDomains(): Promise<readonly DerivedDomain[]> {
    return deriveDomains(this.accounts, this.aliases);
  }

  async getCapabilities(): Promise<DmsCapabilities> {
    return detectCapabilities(FIXTURE_DMS_ENV);
  }

  async getRestrictedAddresses(scope: RestrictScope): Promise<ParseResult<PostfixAccessEntry>> {
    return { entries: [...this.accessListFor(scope)], issues: [] };
  }

  /**
   * Deterministic, fixture-only pseudo-usage — never real telemetry. The
   * fake has no Maildir to measure, so it derives a stable percentage from
   * the email string itself (same input always yields the same output,
   * which is what makes it usable in a snapshot-style dev screenshot or a
   * test asserting the *shape* of a usage response) and scales it against
   * the mailbox's configured quota when one exists, or a fixed nominal
   * total otherwise.
   */
  async getMailboxUsage(email: string): Promise<QuotaUsageResult> {
    const quotaEntry = this.quotas.find((quota) => quota.email === email);
    const limitBytes = quotaEntry ? parseQuotaToBytes(quotaEntry.quota) : null;
    const totalForPseudoUsage = limitBytes ?? DEFAULT_FIXTURE_QUOTA_BYTES;
    const usedFraction = stableFraction(email);

    return {
      ok: true,
      usage: {
        storageBytesUsed: Math.round(totalForPseudoUsage * usedFraction),
        storageBytesLimit: limitBytes,
        messageCountUsed: Math.round(50 + usedFraction * 950),
        messageCountLimit: null,
      },
    };
  }

  async addMailbox(params: AddMailboxParams): Promise<void> {
    assertValid(buildEmailAddCommand(params));
    if (this.accounts.some((account) => account.email === params.email)) {
      throw new DmsCommandValidationError(`An account already exists for ${params.email}.`);
    }
    const split = splitForFixture(params.email);
    this.accounts = [
      ...this.accounts,
      {
        email: params.email,
        localPart: split.localPart,
        domain: split.domain,
        passwordHash: FAKE_PASSWORD_HASH_MARKER,
        attributes: '',
      },
    ];
  }

  async updateMailboxPassword(params: UpdateMailboxPasswordParams): Promise<void> {
    assertValid(buildEmailUpdateCommand(params));
    if (!this.accounts.some((account) => account.email === params.email)) {
      throw new DmsCommandValidationError(`No account exists for ${params.email}.`);
    }
    this.accounts = this.accounts.map((account) =>
      account.email === params.email
        ? { ...account, passwordHash: FAKE_PASSWORD_HASH_MARKER }
        : account,
    );
  }

  async deleteMailbox(params: DeleteMailboxParams): Promise<void> {
    assertValid(buildEmailDeleteCommand(params));
    for (const email of params.emails) {
      if (!this.accounts.some((account) => account.email === email)) {
        throw new DmsCommandValidationError(`No account exists for ${email}.`);
      }
    }

    // ★4: unconditionally, regardless of -y/-n — the account entry, its
    // quota entry, and any aliases pointing at it are removed. Only the
    // raw Maildir (which this in-memory fake never models at all) is
    // gated by the flag.
    const deletedEmails = new Set(params.emails);
    this.accounts = this.accounts.filter((account) => !deletedEmails.has(account.email));
    this.quotas = this.quotas.filter((quota) => !deletedEmails.has(quota.email));
    this.aliases = this.aliases
      .map((alias) => ({
        ...alias,
        recipients: alias.recipients.filter((recipient) => !deletedEmails.has(recipient)),
      }))
      .filter((alias) => alias.recipients.length > 0);
  }

  async restrictMailbox(params: RestrictMailboxParams): Promise<void> {
    assertValid(buildEmailRestrictCommand(params));
    // 'list' is a read, satisfied by getRestrictedAddresses instead — see
    // that method and mailboxes.service.ts, which never calls this method
    // with action: 'list'. Kept as a no-op branch here (rather than
    // rejecting it) because commands.ts's own builder already accepts it;
    // this method's contract is "validate and apply", not "re-narrow".
    if (params.action === 'list' || params.email === undefined) return;

    const email = params.email;
    const list = this.accessListFor(params.scope);
    const alreadyPresent = list.some(
      (entry) => entry.email === email && isRestrictAction(entry.action),
    );

    if (params.action === 'add' && !alreadyPresent) {
      const split = splitForFixture(email);
      list.push({ email, localPart: split.localPart, domain: split.domain, action: 'REJECT' });
    } else if (params.action === 'del') {
      const filtered = list.filter((entry) => entry.email !== email);
      list.length = 0;
      list.push(...filtered);
    }
  }

  async setQuota(params: SetQuotaParams): Promise<void> {
    assertValid(buildQuotaSetCommand(params));
    if (this.quotas.some((quota) => quota.email === params.email)) {
      this.quotas = this.quotas.map((quota) =>
        quota.email === params.email ? { ...quota, quota: params.quota } : quota,
      );
      return;
    }
    const split = splitForFixture(params.email);
    this.quotas = [
      ...this.quotas,
      {
        email: params.email,
        localPart: split.localPart,
        domain: split.domain,
        quota: params.quota,
      },
    ];
  }

  async deleteQuota(params: DeleteQuotaParams): Promise<void> {
    assertValid(buildQuotaDeleteCommand(params));
    this.quotas = this.quotas.filter((quota) => quota.email !== params.email);
  }

  async addAlias(params: AddAliasParams): Promise<void> {
    assertValid(buildAliasAddCommand(params));
    const existing = this.aliases.find((alias) => alias.address === params.alias);
    if (existing) {
      if (!existing.recipients.includes(params.recipient)) {
        this.aliases = this.aliases.map((alias) =>
          alias.address === params.alias
            ? { ...alias, recipients: [...alias.recipients, params.recipient] }
            : alias,
        );
      }
      return;
    }
    const split = splitAliasForFixture(params.alias);
    this.aliases = [
      ...this.aliases,
      {
        address: params.alias,
        isCatchAll: params.alias.startsWith('@'),
        localPart: split.localPart,
        domain: split.domain,
        recipients: [params.recipient],
      },
    ];
  }

  async deleteAlias(params: DeleteAliasParams): Promise<void> {
    assertValid(buildAliasDeleteCommand(params));
    const existing = this.aliases.find((alias) => alias.address === params.alias);
    if (!existing || !existing.recipients.includes(params.recipient)) {
      throw new DmsCommandValidationError(
        `No alias "${params.alias}" with recipient "${params.recipient}" exists.`,
      );
    }
    // ★2: removes one recipient, or the whole alias if it was the last one.
    this.aliases = this.aliases
      .map((alias) =>
        alias.address === params.alias
          ? {
              ...alias,
              recipients: alias.recipients.filter((recipient) => recipient !== params.recipient),
            }
          : alias,
      )
      .filter((alias) => alias.recipients.length > 0);
  }

  async generateDkim(params: ConfigDkimParams = {}): Promise<void> {
    assertValid(buildConfigDkimCommand(params));
    // DKIM key material lives outside the three files this driver reads
    // (★7) — nothing for an in-memory fake to model beyond validation.
  }

  async fail2banBan(params: Fail2banIpParams): Promise<void> {
    assertValid(buildFail2banBanCommand(params));
  }

  async fail2banUnban(params: Fail2banIpParams): Promise<void> {
    assertValid(buildFail2banUnbanCommand(params));
  }
}
