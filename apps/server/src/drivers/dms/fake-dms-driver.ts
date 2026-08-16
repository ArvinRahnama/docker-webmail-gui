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
  FIXTURE_POSTFIX_VIRTUAL_CF,
} from './fixtures/index.js';
import type { ParseResult } from './parsers/parse-result.js';
import { parseDovecotQuotas, type DovecotQuotaEntry } from './parsers/dovecot-quotas.js';
import { parsePostfixAccounts, type PostfixAccountEntry } from './parsers/postfix-accounts.js';
import { parsePostfixVirtual, type PostfixVirtualEntry } from './parsers/postfix-virtual.js';
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

export class FakeDmsDriver implements DmsDriver {
  private accounts: PostfixAccountEntry[];
  private aliases: PostfixVirtualEntry[];
  private quotas: DovecotQuotaEntry[];

  constructor() {
    // Seeded once, at construction, by parsing the same fixture file
    // content a real DMS install would have written — so the fake starts
    // from state that has actually round-tripped through the real parsers
    // at least once, rather than a hand-built object graph that could
    // drift from what the parsers actually produce.
    this.accounts = [...parsePostfixAccounts(FIXTURE_POSTFIX_ACCOUNTS_CF).entries];
    this.aliases = [...parsePostfixVirtual(FIXTURE_POSTFIX_VIRTUAL_CF).entries];
    this.quotas = [...parseDovecotQuotas(FIXTURE_DOVECOT_QUOTAS_CF).entries];
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
    // Send/receive restriction is enforced by Postfix access maps this
    // project does not otherwise track (FEATURE_MATRIX.md §3's "Restrict
    // sending / receiving" is real but separate from the three files this
    // driver reads) — validated and accepted, with nothing further for an
    // in-memory fake to model.
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
