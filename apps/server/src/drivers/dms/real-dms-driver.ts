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
import { DmsCommandExecutionError, DmsCommandValidationError } from './errors.js';
import type { DmsExecPort } from './exec-port.js';
import type { ParseResult } from './parsers/parse-result.js';
import { parseDovecotQuotas, type DovecotQuotaEntry } from './parsers/dovecot-quotas.js';
import { parsePostfixAccounts, type PostfixAccountEntry } from './parsers/postfix-accounts.js';
import { parsePostfixVirtual, type PostfixVirtualEntry } from './parsers/postfix-virtual.js';
import type { DmsDriver } from './types.js';

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
}
