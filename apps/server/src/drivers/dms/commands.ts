/**
 * Typed argv-array builders for every DMS `setup` write path this project
 * covers (`docs/research/01-docker-mailserver.md` ★2, ★3, ★4;
 * ARCHITECTURE.md §5; FEATURE_MATRIX.md §0 Rule 1: "writes use the CLI").
 *
 * Every builder here:
 *
 *  - returns a {@link CommandResult} — never throws, and never returns a
 *    string to be joined/interpolated. `argv[0]` is always the literal
 *    `'setup'`; every other element is either a fixed subcommand/flag
 *    (from this module's own source, never from caller input) or a single
 *    validated leaf value (`validators.ts`). This is exactly
 *    ARCHITECTURE.md §5's rule: "Subcommand and flags come from a
 *    server-side allowlist; only leaf values ... come from validated
 *    input."
 *  - never emits `sh`, `bash`, or `-c` — there is no code path in this
 *    file that could, since no argv element is ever assembled by string
 *    concatenation or interpolation, only array literals and validated
 *    leaves pushed as whole elements.
 *  - keeps a password out of every argv array. `buildEmailAddCommand` and
 *    `buildEmailUpdateCommand` return the password only via
 *    {@link DmsCommand.stdin}, formatted exactly as DMS's own
 *    `_password_request_if_missing` prompt protocol expects when fed
 *    non-interactively: the password, a newline, the password again, a
 *    newline (docs/research/01-docker-mailserver.md ★3) — never as an
 *    argv element, where it would be visible in `ps`.
 *  - for `email del`, makes the mail-data keep/delete choice a **required**
 *    parameter with no default (`mailData: 'delete' | 'keep'`, not
 *    optional) — see {@link buildEmailDeleteCommand}. There is no code
 *    path in this module that can produce a `setup email del` argv array
 *    without an explicit `-y` or `-n` in it.
 */
import {
  validateAddressForArgv,
  validateDkimKeysize,
  validateDkimSelector,
  validateDomain,
  validateIpAddress,
  validatePassword,
  validateQuota,
} from './validators.js';

export interface DmsCommand {
  readonly argv: readonly string[];
  /** Present only when the command has a value that must never appear in argv (a password). */
  readonly stdin?: string;
}

export type CommandResult =
  | { readonly ok: true; readonly command: DmsCommand }
  | { readonly ok: false; readonly error: string };

function ok(argv: readonly string[], stdin?: string): CommandResult {
  return stdin === undefined
    ? { ok: true, command: { argv } }
    : { ok: true, command: { argv, stdin } };
}

function err(error: string): CommandResult {
  return { ok: false, error };
}

/** DMS's stdin protocol for a password prompt: entry, newline, confirmation, newline (★3). */
function passwordStdin(password: string): string {
  return `${password}\n${password}\n`;
}

// ---------------------------------------------------------------------------
// email
// ---------------------------------------------------------------------------

export interface AddMailboxParams {
  readonly email: string;
  readonly password: string;
}

/** `setup email add <EMAIL>` — password via stdin, never argv (★3). */
export function buildEmailAddCommand(params: AddMailboxParams): CommandResult {
  const emailError = validateAddressForArgv(params.email);
  if (emailError) return err(emailError);
  const passwordError = validatePassword(params.password);
  if (passwordError) return err(passwordError);

  return ok(['setup', 'email', 'add', params.email], passwordStdin(params.password));
}

export interface UpdateMailboxPasswordParams {
  readonly email: string;
  readonly password: string;
}

/** `setup email update <EMAIL>` — password via stdin, never argv (★3). */
export function buildEmailUpdateCommand(params: UpdateMailboxPasswordParams): CommandResult {
  const emailError = validateAddressForArgv(params.email);
  if (emailError) return err(emailError);
  const passwordError = validatePassword(params.password);
  if (passwordError) return err(passwordError);

  return ok(['setup', 'email', 'update', params.email], passwordStdin(params.password));
}

/**
 * `'delete'` maps to `-y` (force-delete the Maildir); `'keep'` maps to
 * `-n` (force-keep it). There is no third option and no default — a
 * caller that does not know which the administrator chose has no way to
 * call this function (★4: with no flag, `setup email del` prompts
 * interactively and would hang a non-interactive exec).
 */
export type MailDataChoice = 'delete' | 'keep';

export interface DeleteMailboxParams {
  readonly emails: readonly string[];
  readonly mailData: MailDataChoice;
}

/**
 * `setup email del [-y|-n] <EMAIL> [<EMAIL>...]` — the flag is always
 * present; see {@link MailDataChoice}. `emails` accepts more than one
 * address because the underlying CLI does (★4: "multiple accounts can be
 * passed in one call"), and this module's job is to mirror what `setup`
 * can actually do, not to encode product policy. **FEATURE_MATRIX.md §3
 * separately decides the admin panel itself will never expose a bulk
 * multi-select delete UI/endpoint** ("the blast radius is unacceptable for
 * mail data") — that restriction belongs at the API/service layer that
 * calls this builder, by simply never passing more than one address from
 * an unrestricted bulk-select action, not here.
 */
export function buildEmailDeleteCommand(params: DeleteMailboxParams): CommandResult {
  if (params.mailData !== 'delete' && params.mailData !== 'keep') {
    // Reachable only from JavaScript (or a type-assertion) bypassing the
    // `MailDataChoice` type — TypeScript itself already makes every other
    // value a compile error. Kept as a runtime guard so "impossible to
    // construct" holds even without the type checker's help.
    return err(
      'mailData must be exactly "delete" or "keep" — an explicit choice is required, there is no default',
    );
  }
  if (params.emails.length === 0) return err('at least one email address is required');

  for (const email of params.emails) {
    const emailError = validateAddressForArgv(email);
    if (emailError) return err(emailError);
  }

  const flag = params.mailData === 'delete' ? '-y' : '-n';
  return ok(['setup', 'email', 'del', flag, ...params.emails]);
}

export type RestrictAction = 'add' | 'del' | 'list';
export type RestrictScope = 'send' | 'receive';

export interface RestrictMailboxParams {
  readonly action: RestrictAction;
  readonly scope: RestrictScope;
  /** Required for `add`/`del`; optional for `list` (lists every restricted address for the scope). */
  readonly email?: string;
}

/** `setup email restrict <add|del|list> <send|receive> [<EMAIL>]` (FEATURE_MATRIX.md §3 — "Restrict sending / receiving", never called "Disable"). */
export function buildEmailRestrictCommand(params: RestrictMailboxParams): CommandResult {
  if (params.action !== 'add' && params.action !== 'del' && params.action !== 'list') {
    return err('action must be "add", "del" or "list"');
  }
  if (params.scope !== 'send' && params.scope !== 'receive') {
    return err('scope must be "send" or "receive"');
  }

  if (params.email === undefined) {
    if (params.action !== 'list') {
      return err(`email is required for action "${params.action}"`);
    }
    return ok(['setup', 'email', 'restrict', params.action, params.scope]);
  }

  const emailError = validateAddressForArgv(params.email);
  if (emailError) return err(emailError);
  return ok(['setup', 'email', 'restrict', params.action, params.scope, params.email]);
}

/** `setup email list`. */
export function buildEmailListCommand(): CommandResult {
  return ok(['setup', 'email', 'list']);
}

// ---------------------------------------------------------------------------
// alias
// ---------------------------------------------------------------------------

export interface AddAliasParams {
  readonly alias: string;
  readonly recipient: string;
}

/** `setup alias add <EMAIL> <RECIPIENT>` — `alias` may be a catch-all (`@domain`); `recipient` may not (FEATURE_MATRIX.md §4, §5). */
export function buildAliasAddCommand(params: AddAliasParams): CommandResult {
  const aliasError = validateAddressForArgv(params.alias, { allowCatchAll: true });
  if (aliasError) return err(aliasError);
  const recipientError = validateAddressForArgv(params.recipient);
  if (recipientError) return err(recipientError);

  return ok(['setup', 'alias', 'add', params.alias, params.recipient]);
}

export interface DeleteAliasParams {
  readonly alias: string;
  readonly recipient: string;
}

/** `setup alias del <EMAIL> <RECIPIENT>` — removes one recipient (or the whole alias if it was the last one). */
export function buildAliasDeleteCommand(params: DeleteAliasParams): CommandResult {
  const aliasError = validateAddressForArgv(params.alias, { allowCatchAll: true });
  if (aliasError) return err(aliasError);
  const recipientError = validateAddressForArgv(params.recipient);
  if (recipientError) return err(recipientError);

  return ok(['setup', 'alias', 'del', params.alias, params.recipient]);
}

/** `setup alias list`. */
export function buildAliasListCommand(): CommandResult {
  return ok(['setup', 'alias', 'list']);
}

// ---------------------------------------------------------------------------
// quota
// ---------------------------------------------------------------------------

export interface SetQuotaParams {
  readonly email: string;
  readonly quota: string;
}

/**
 * `setup quota set <EMAIL> <QUOTA>`. Upstream's `<QUOTA>` argument is
 * technically optional, but a "set" with no value is a "del" wearing a
 * disguise — this project requires an explicit quota string here and
 * exposes clearing the quota as {@link buildQuotaDeleteCommand} instead,
 * so the two operations are never ambiguous at the call site.
 */
export function buildQuotaSetCommand(params: SetQuotaParams): CommandResult {
  const emailError = validateAddressForArgv(params.email);
  if (emailError) return err(emailError);
  const quotaError = validateQuota(params.quota);
  if (quotaError) return err(quotaError);

  return ok(['setup', 'quota', 'set', params.email, params.quota]);
}

export interface DeleteQuotaParams {
  readonly email: string;
}

/** `setup quota del <EMAIL>` — removes the quota entry (mailbox becomes unlimited). */
export function buildQuotaDeleteCommand(params: DeleteQuotaParams): CommandResult {
  const emailError = validateAddressForArgv(params.email);
  if (emailError) return err(emailError);

  return ok(['setup', 'quota', 'del', params.email]);
}

// ---------------------------------------------------------------------------
// config dkim
// ---------------------------------------------------------------------------

export interface ConfigDkimParams {
  readonly keysize?: number;
  readonly selector?: string;
  readonly domains?: readonly string[];
}

/** `setup config dkim [keysize N] [selector NAME] [domain LIST]` (★7). Every argument is optional individually; each is validated when present. */
export function buildConfigDkimCommand(params: ConfigDkimParams = {}): CommandResult {
  const argv: string[] = ['setup', 'config', 'dkim'];

  if (params.keysize !== undefined) {
    const keysizeError = validateDkimKeysize(params.keysize);
    if (keysizeError) return err(keysizeError);
    argv.push('keysize', String(params.keysize));
  }

  if (params.selector !== undefined) {
    const selectorError = validateDkimSelector(params.selector);
    if (selectorError) return err(selectorError);
    argv.push('selector', params.selector);
  }

  if (params.domains !== undefined) {
    if (params.domains.length === 0) return err('domains must not be an empty list');
    for (const domain of params.domains) {
      const domainError = validateDomain(domain);
      if (domainError) return err(domainError);
    }
    // A single comma-joined argv element, per ★7's documented
    // `domain '<comma,separated,list>'` syntax — not one element per
    // domain, since that is not the shape `setup config dkim` accepts.
    argv.push('domain', params.domains.join(','));
  }

  return ok(argv);
}

// ---------------------------------------------------------------------------
// fail2ban
// ---------------------------------------------------------------------------

/** `setup fail2ban` — lists currently banned IPs across all jails. */
export function buildFail2banListCommand(): CommandResult {
  return ok(['setup', 'fail2ban']);
}

export interface Fail2banIpParams {
  readonly ip: string;
}

/** `setup fail2ban ban <IP>`. */
export function buildFail2banBanCommand(params: Fail2banIpParams): CommandResult {
  const ipError = validateIpAddress(params.ip);
  if (ipError) return err(ipError);
  return ok(['setup', 'fail2ban', 'ban', params.ip]);
}

/** `setup fail2ban unban <IP>`. */
export function buildFail2banUnbanCommand(params: Fail2banIpParams): CommandResult {
  const ipError = validateIpAddress(params.ip);
  if (ipError) return err(ipError);
  return ok(['setup', 'fail2ban', 'unban', params.ip]);
}

/** `setup fail2ban log` — `cat /var/log/mail/fail2ban.log`. */
export function buildFail2banLogCommand(): CommandResult {
  return ok(['setup', 'fail2ban', 'log']);
}

/** `setup fail2ban status` — per-jail `fail2ban-client status` dump. */
export function buildFail2banStatusCommand(): CommandResult {
  return ok(['setup', 'fail2ban', 'status']);
}
