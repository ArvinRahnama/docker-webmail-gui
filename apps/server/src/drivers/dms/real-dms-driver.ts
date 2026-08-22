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
  buildAliasAddCommand,
  buildAliasDeleteCommand,
  buildClamavLogTailCommand,
  buildClamdCommand,
  buildConfigDkimCommand,
  buildDoveadmQuotaGetCommand,
  buildEmailAddCommand,
  buildEmailDeleteCommand,
  buildEmailRestrictCommand,
  buildEmailUpdateCommand,
  buildFail2banBanCommand,
  buildFail2banListCommand,
  buildFail2banStatusCommand,
  buildFail2banUnbanCommand,
  buildFreshclamCommand,
  buildPostqueueJsonCommand,
  buildQuotaDeleteCommand,
  buildQuotaSetCommand,
  buildSieveActivateCommand,
  buildSieveDeactivateCommand,
  buildSieveGetCommand,
  buildSieveListCommand,
  buildSievePutCommand,
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
  type SievePutParams,
  type SieveScriptParams,
  type SieveUserParams,
  type UpdateMailboxPasswordParams,
} from './commands.js';
import { detectCapabilities, type DmsCapabilities } from './capabilities.js';
import { deriveDomains, type DerivedDomain } from './domains.js';
import { parseDkimZoneFile } from './dkim-record.js';
import { parseFail2banList, type Fail2banListResult } from './fail2ban-parser.js';
import { parseSieveList, type SieveScriptSummary } from './sieve-list-parser.js';
import { DmsCommandExecutionError, DmsCommandValidationError } from './errors.js';
import type { DmsExecPort } from './exec-port.js';
import type { ParseResult } from './parsers/parse-result.js';
import { parseDovecotQuotas, type DovecotQuotaEntry } from './parsers/dovecot-quotas.js';
import { parsePostfixAccounts, type PostfixAccountEntry } from './parsers/postfix-accounts.js';
import { parsePostfixVirtual, type PostfixVirtualEntry } from './parsers/postfix-virtual.js';
import { parsePostfixAccess, type PostfixAccessEntry } from './parsers/postfix-access.js';
import { parseDoveadmQuotaGet, type QuotaUsageResult } from './quota-usage.js';
import { parsePostqueueJson, type MailQueueEntry } from './parsers/postqueue.js';
import type { ClamavReadResult, DkimRecordReadResult, DmsDriver } from './types.js';

const RESTRICT_SCOPE_FILE_NAME = {
  send: 'postfix-send-access.cf',
  receive: 'postfix-receive-access.cf',
} as const satisfies Record<RestrictScope, 'postfix-send-access.cf' | 'postfix-receive-access.cf'>;

export class RealDmsDriver implements DmsDriver {
  constructor(private readonly execPort: DmsExecPort) {}

  async listMailboxes(): Promise<ParseResult<PostfixAccountEntry>> {
    const content = await this.execPort.readFile('postfix-accounts.cf');
    return parsePostfixAccounts(content ?? '');
  }

  async listAliases(): Promise<ParseResult<PostfixVirtualEntry>> {
    const content = await this.execPort.readFile('postfix-virtual.cf');
    return parsePostfixVirtual(content ?? '');
  }

  async listQuotas(): Promise<ParseResult<DovecotQuotaEntry>> {
    const content = await this.execPort.readFile('dovecot-quotas.cf');
    return parseDovecotQuotas(content ?? '');
  }

  async listDomains(): Promise<readonly DerivedDomain[]> {
    const [accounts, aliases] = await Promise.all([this.listMailboxes(), this.listAliases()]);
    return deriveDomains(accounts.entries, aliases.entries);
  }

  async getCapabilities(): Promise<DmsCapabilities> {
    const env = await this.execPort.getEnv();
    return detectCapabilities(env);
  }

  async getRestrictedAddresses(scope: RestrictScope): Promise<ParseResult<PostfixAccessEntry>> {
    const content = await this.execPort.readFile(RESTRICT_SCOPE_FILE_NAME[scope]);
    return parsePostfixAccess(content ?? '');
  }

  async getMailboxUsage(email: string): Promise<QuotaUsageResult> {
    const result = buildDoveadmQuotaGetCommand({ email });
    if (!result.ok) throw new DmsCommandValidationError(result.error);
    const execResult = await this.execPort.exec(result.command.argv);
    if (execResult.exitCode !== 0) {
      throw new DmsCommandExecutionError(
        result.command.argv,
        execResult.exitCode,
        execResult.stderr,
      );
    }
    return parseDoveadmQuotaGet(execResult.stdout);
  }

  async getDkimRecord(domain: string, selector: string): Promise<DkimRecordReadResult> {
    const content = await this.execPort.readDkimPublicKeyFile(domain, selector);
    if (content === null) return { ok: false, reason: 'not-generated' };
    const record = parseDkimZoneFile(content, domain, selector);
    if (record === null) return { ok: false, reason: 'unparseable' };
    return { ok: true, record };
  }

  async getSslType(): Promise<string | null> {
    const env = await this.execPort.getEnv();
    const raw = env['SSL_TYPE'];
    return raw === undefined || raw.trim().length === 0 ? null : raw.trim();
  }

  /**
   * Every write method funnels through here: validate (throwing
   * {@link DmsCommandValidationError} for a builder rejection, *before*
   * ever calling the exec port) and, only for a validated command,
   * actually invoke it, throwing {@link DmsCommandExecutionError} for a
   * non-zero exit.
   */
  private async run(result: CommandResult): Promise<void> {
    if (!result.ok) throw new DmsCommandValidationError(result.error);
    const { argv, stdin } = result.command;
    const execResult = await this.execPort.exec(argv, stdin === undefined ? undefined : { stdin });
    if (execResult.exitCode !== 0) {
      throw new DmsCommandExecutionError(argv, execResult.exitCode, execResult.stderr);
    }
  }

  async addMailbox(params: AddMailboxParams): Promise<void> {
    await this.run(buildEmailAddCommand(params));
  }

  async updateMailboxPassword(params: UpdateMailboxPasswordParams): Promise<void> {
    await this.run(buildEmailUpdateCommand(params));
  }

  async deleteMailbox(params: DeleteMailboxParams): Promise<void> {
    await this.run(buildEmailDeleteCommand(params));
  }

  async restrictMailbox(params: RestrictMailboxParams): Promise<void> {
    await this.run(buildEmailRestrictCommand(params));
  }

  async setQuota(params: SetQuotaParams): Promise<void> {
    await this.run(buildQuotaSetCommand(params));
  }

  async deleteQuota(params: DeleteQuotaParams): Promise<void> {
    await this.run(buildQuotaDeleteCommand(params));
  }

  async addAlias(params: AddAliasParams): Promise<void> {
    await this.run(buildAliasAddCommand(params));
  }

  async deleteAlias(params: DeleteAliasParams): Promise<void> {
    await this.run(buildAliasDeleteCommand(params));
  }

  async generateDkim(params: ConfigDkimParams = {}): Promise<void> {
    await this.run(buildConfigDkimCommand(params));
  }

  async fail2banBan(params: Fail2banIpParams): Promise<void> {
    await this.run(buildFail2banBanCommand(params));
  }

  async fail2banUnban(params: Fail2banIpParams): Promise<void> {
    await this.run(buildFail2banUnbanCommand(params));
  }

  /** Runs a read-only command (never a validated write) and returns its stdout, throwing the same two typed errors as every write path. */
  private async runRead(result: CommandResult): Promise<string> {
    if (!result.ok) throw new DmsCommandValidationError(result.error);
    const execResult = await this.execPort.exec(result.command.argv);
    if (execResult.exitCode !== 0) {
      throw new DmsCommandExecutionError(
        result.command.argv,
        execResult.exitCode,
        execResult.stderr,
      );
    }
    return execResult.stdout;
  }

  async fail2banList(): Promise<Fail2banListResult> {
    const stdout = await this.runRead(buildFail2banListCommand());
    return parseFail2banList(stdout);
  }

  async fail2banStatus(): Promise<string> {
    return this.runRead(buildFail2banStatusCommand());
  }

  /**
   * Runs a command and reports failure as data, never an exception — see
   * `ClamavReadResult`'s doc comment (`types.ts`) for why the ClamAV reads
   * below need this instead of `runRead`'s throw-on-failure contract.
   */
  private async execSoft(result: CommandResult): Promise<ClamavReadResult> {
    if (!result.ok) return { ok: false, reason: result.error };
    const { argv, stdin } = result.command;
    try {
      const execResult = await this.execPort.exec(
        argv,
        stdin === undefined ? undefined : { stdin },
      );
      if (execResult.exitCode !== 0) {
        return {
          ok: false,
          reason: execResult.stderr.trim() || `"${argv.join(' ')}" exited ${execResult.exitCode}`,
        };
      }
      return { ok: true, output: execResult.stdout };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'Command failed to run.' };
    }
  }

  async clamavPing(): Promise<ClamavReadResult> {
    return this.execSoft(buildClamdCommand('PING'));
  }

  async clamavVersion(): Promise<ClamavReadResult> {
    return this.execSoft(buildClamdCommand('VERSION'));
  }

  async clamavStats(): Promise<ClamavReadResult> {
    return this.execSoft(buildClamdCommand('STATS'));
  }

  async clamavLogTail(): Promise<ClamavReadResult> {
    return this.execSoft(buildClamavLogTailCommand());
  }

  /** Unlike the four reads above, a failed `freshclam` run is a real error to surface (`types.ts`'s doc comment on this method) — `runRead` already throws on a non-zero exit, which is exactly the behaviour wanted here. */
  async clamavUpdateSignatures(): Promise<string> {
    return this.runRead(buildFreshclamCommand());
  }

  async sieveList(user: string): Promise<readonly SieveScriptSummary[]> {
    const stdout = await this.runRead(buildSieveListCommand({ user }));
    return parseSieveList(stdout);
  }

  async sieveGet(user: string, name: string): Promise<string> {
    return this.runRead(buildSieveGetCommand({ user, name }));
  }

  async sievePut(params: SievePutParams): Promise<void> {
    await this.run(buildSievePutCommand(params));
  }

  async sieveActivate(params: SieveScriptParams): Promise<void> {
    await this.run(buildSieveActivateCommand(params));
  }

  async sieveDeactivate(params: SieveUserParams): Promise<void> {
    await this.run(buildSieveDeactivateCommand(params));
  }

  async getMailQueue(): Promise<ParseResult<MailQueueEntry>> {
    const stdout = await this.runRead(buildPostqueueJsonCommand());
    return parsePostqueueJson(stdout);
  }
}
