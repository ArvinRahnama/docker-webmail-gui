/**
 * The real {@link DmsDriver}: reads config files and invokes `setup`
 * through a {@link DmsExecPort} (`exec-port.ts` — see that file's doc
 * comment for why this takes a port rather than a concrete broker client
 * today). Every read parses a file with the matching `parsers/` module;
 * every write builds its argv with the matching `commands.ts` builder and
 * hands it to the port, never touching a shell, never assembling a string
 * (FEATURE_MATRIX.md §0 Rule 1 and ARCHITECTURE.md §5).
 */
import {
  DmsAliasAddRequestSchema,
  DmsAliasDeleteRequestSchema,
  DmsDkimGenerateRequestSchema,
  DmsEmailAddRequestSchema,
  DmsEmailDeleteRequestSchema,
  DmsEmailRestrictRequestSchema,
  DmsEmailUpdateRequestSchema,
  DmsFail2banBanRequestSchema,
  DmsFail2banUnbanRequestSchema,
  DmsQuotaDeleteRequestSchema,
  DmsQuotaSetRequestSchema,
  DmsSieveActivateRequestSchema,
  DmsSieveDeactivateRequestSchema,
  DmsSievePutRequestSchema,
  type DmsConfigFileKey,
} from '@dwg/shared';
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
import { parseDmsRequest } from './request.js';
import { detectCapabilities, type DmsCapabilities } from './capabilities.js';
import { deriveDomains, type DerivedDomain } from './domains.js';
import { parseDkimZoneFile } from './dkim-record.js';
import { parseFail2banList, type Fail2banListResult } from './fail2ban-parser.js';
import { parseSieveList, type SieveScriptSummary } from './sieve-list-parser.js';
import { DmsCommandExecutionError } from './errors.js';
import type { DmsCommandRequest, DmsExecPort } from './exec-port.js';
import type { ParseResult } from './parsers/parse-result.js';
import { parseDovecotQuotas, type DovecotQuotaEntry } from './parsers/dovecot-quotas.js';
import { parsePostfixAccounts, type PostfixAccountEntry } from './parsers/postfix-accounts.js';
import { parsePostfixVirtual, type PostfixVirtualEntry } from './parsers/postfix-virtual.js';
import { parsePostfixAccess, type PostfixAccessEntry } from './parsers/postfix-access.js';
import { parseDoveadmQuotaGet, type QuotaUsageResult } from './quota-usage.js';
import { parsePostqueueJson, type MailQueueEntry } from './parsers/postqueue.js';
import type { ClamavReadResult, DkimRecordReadResult, DmsDriver } from './types.js';

/** Which broker-owned config-file key backs each restriction direction. A symbolic key, never a filename — see `exec-port.ts`. */
const RESTRICT_SCOPE_FILE_KEY = {
  send: 'postfix-send-access',
  receive: 'postfix-receive-access',
} as const satisfies Record<RestrictScope, DmsConfigFileKey>;

export class RealDmsDriver implements DmsDriver {
  constructor(private readonly execPort: DmsExecPort) {}

  async listMailboxes(): Promise<ParseResult<PostfixAccountEntry>> {
    const content = await this.execPort.readFile('postfix-accounts');
    return parsePostfixAccounts(content ?? '');
  }

  async listAliases(): Promise<ParseResult<PostfixVirtualEntry>> {
    const content = await this.execPort.readFile('postfix-virtual');
    return parsePostfixVirtual(content ?? '');
  }

  async listQuotas(): Promise<ParseResult<DovecotQuotaEntry>> {
    const content = await this.execPort.readFile('dovecot-quotas');
    return parseDovecotQuotas(content ?? '');
  }

  async listDomains(): Promise<readonly DerivedDomain[]> {
    const [accounts, aliases] = await Promise.all([this.listMailboxes(), this.listAliases()]);
    return deriveDomains(accounts.entries, aliases.entries);
  }

  async getCapabilities(): Promise<DmsCapabilities> {
    const env = await this.execPort.readEnv();
    return detectCapabilities(env);
  }

  async getRestrictedAddresses(scope: RestrictScope): Promise<ParseResult<PostfixAccessEntry>> {
    const content = await this.execPort.readFile(RESTRICT_SCOPE_FILE_KEY[scope]);
    return parsePostfixAccess(content ?? '');
  }

  async getMailboxUsage(email: string): Promise<QuotaUsageResult> {
    const stdout = await this.runRead({ operation: 'dms.quota.get', email });
    return parseDoveadmQuotaGet(stdout);
  }

  async getDkimRecord(domain: string, selector: string): Promise<DkimRecordReadResult> {
    const content = await this.execPort.readDkimRecord(domain, selector);
    if (content === null) return { ok: false, reason: 'not-generated' };
    const record = parseDkimZoneFile(content, domain, selector);
    if (record === null) return { ok: false, reason: 'unparseable' };
    return { ok: true, record };
  }

  async getSslType(): Promise<string | null> {
    const env = await this.execPort.readEnv();
    const raw = env['SSL_TYPE'];
    return raw === undefined || raw.trim().length === 0 ? null : raw.trim();
  }

  /**
   * Every write method funnels through here. Validation has already
   * happened at the call site (`parseDmsRequest` against the shared
   * schema, which throws `DmsCommandValidationError` before the port is
   * ever touched); this only sends the operation and turns a non-zero
   * exit into {@link DmsCommandExecutionError}.
   */
  private async run(request: DmsCommandRequest): Promise<void> {
    const execResult = await this.execPort.runCommand(request);
    if (execResult.exitCode !== 0) {
      throw new DmsCommandExecutionError(
        [request.operation],
        execResult.exitCode,
        execResult.stderr,
      );
    }
  }

  async addMailbox(params: AddMailboxParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsEmailAddRequestSchema, { operation: 'dms.email.add', ...params }),
    );
  }

  async updateMailboxPassword(params: UpdateMailboxPasswordParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsEmailUpdateRequestSchema, { operation: 'dms.email.update', ...params }),
    );
  }

  async deleteMailbox(params: DeleteMailboxParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsEmailDeleteRequestSchema, { operation: 'dms.email.del', ...params }),
    );
  }

  async restrictMailbox(params: RestrictMailboxParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsEmailRestrictRequestSchema, {
        operation: 'dms.email.restrict',
        ...params,
      }),
    );
  }

  async setQuota(params: SetQuotaParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsQuotaSetRequestSchema, { operation: 'dms.quota.set', ...params }),
    );
  }

  async deleteQuota(params: DeleteQuotaParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsQuotaDeleteRequestSchema, { operation: 'dms.quota.del', ...params }),
    );
  }

  async addAlias(params: AddAliasParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsAliasAddRequestSchema, { operation: 'dms.alias.add', ...params }),
    );
  }

  async deleteAlias(params: DeleteAliasParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsAliasDeleteRequestSchema, { operation: 'dms.alias.del', ...params }),
    );
  }

  async generateDkim(params: ConfigDkimParams = {}): Promise<void> {
    await this.run(
      parseDmsRequest(DmsDkimGenerateRequestSchema, { operation: 'dms.dkim.generate', ...params }),
    );
  }

  async fail2banBan(params: Fail2banIpParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsFail2banBanRequestSchema, { operation: 'dms.fail2ban.ban', ...params }),
    );
  }

  async fail2banUnban(params: Fail2banIpParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsFail2banUnbanRequestSchema, {
        operation: 'dms.fail2ban.unban',
        ...params,
      }),
    );
  }

  /** Runs a read-only command (never a validated write) and returns its stdout, throwing the same two typed errors as every write path. */
  private async runRead(request: DmsCommandRequest): Promise<string> {
    const execResult = await this.execPort.runCommand(request);
    if (execResult.exitCode !== 0) {
      throw new DmsCommandExecutionError(
        [request.operation],
        execResult.exitCode,
        execResult.stderr,
      );
    }
    return execResult.stdout;
  }

  async fail2banList(): Promise<Fail2banListResult> {
    const stdout = await this.runRead({ operation: 'dms.fail2ban.list' });
    return parseFail2banList(stdout);
  }

  async fail2banStatus(): Promise<string> {
    return this.runRead({ operation: 'dms.fail2ban.status' });
  }

  /**
   * Runs a command and reports failure as data, never an exception — see
   * `ClamavReadResult`'s doc comment (`types.ts`) for why the ClamAV reads
   * below need this instead of `runRead`'s throw-on-failure contract.
   */
  private async execSoft(request: DmsCommandRequest): Promise<ClamavReadResult> {
    try {
      const execResult = await this.execPort.runCommand(request);
      if (execResult.exitCode !== 0) {
        return {
          ok: false,
          reason:
            execResult.stderr.trim() || `"${request.operation}" exited ${execResult.exitCode}`,
        };
      }
      return { ok: true, output: execResult.stdout };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'Command failed to run.' };
    }
  }

  async clamavPing(): Promise<ClamavReadResult> {
    return this.execSoft({ operation: 'dms.clamd.control', verb: 'PING' });
  }

  async clamavVersion(): Promise<ClamavReadResult> {
    return this.execSoft({ operation: 'dms.clamd.control', verb: 'VERSION' });
  }

  async clamavStats(): Promise<ClamavReadResult> {
    return this.execSoft({ operation: 'dms.clamd.control', verb: 'STATS' });
  }

  async clamavLogTail(): Promise<ClamavReadResult> {
    return this.execSoft({ operation: 'dms.clamav.log' });
  }

  /** Unlike the four reads above, a failed `freshclam` run is a real error to surface (`types.ts`'s doc comment on this method) — `runRead` already throws on a non-zero exit, which is exactly the behaviour wanted here. */
  async clamavUpdateSignatures(): Promise<string> {
    return this.runRead({ operation: 'dms.clamav.update' });
  }

  async sieveList(user: string): Promise<readonly SieveScriptSummary[]> {
    const stdout = await this.runRead({ operation: 'dms.sieve.list', user });
    return parseSieveList(stdout);
  }

  async sieveGet(user: string, name: string): Promise<string> {
    return this.runRead({ operation: 'dms.sieve.get', user, script: name });
  }

  async sievePut(params: SievePutParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsSievePutRequestSchema, { operation: 'dms.sieve.put', ...params }),
    );
  }

  async sieveActivate(params: SieveScriptParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsSieveActivateRequestSchema, {
        operation: 'dms.sieve.activate',
        ...params,
      }),
    );
  }

  async sieveDeactivate(params: SieveUserParams): Promise<void> {
    await this.run(
      parseDmsRequest(DmsSieveDeactivateRequestSchema, {
        operation: 'dms.sieve.deactivate',
        ...params,
      }),
    );
  }

  async getMailQueue(): Promise<ParseResult<MailQueueEntry>> {
    const stdout = await this.runRead({ operation: 'dms.queue.list' });
    return parsePostqueueJson(stdout);
  }
}
