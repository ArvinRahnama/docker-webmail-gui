/**
 * The docker-mailserver operation vocabulary — the contract the web tier
 * and the broker agree on, and the reason `apps/server` can finally reach
 * a real DMS at all (M16).
 *
 * ---------------------------------------------------------------------
 * Why this file exists, and what it deliberately does not contain
 * ---------------------------------------------------------------------
 *
 * Until M16, `RealDmsDriver` built an argv array in the *web tier* and
 * handed it to a `DmsExecPort` that had no implementation, because the
 * only way to implement it would have been a broker `exec.run(argv)` /
 * `file.read(path)` pair. Both are the passthrough AGENT_BRIEF.md §2
 * forbids by name: an allowlist that validates a caller-supplied argv is
 * still a passthrough, and full RCE in the web tier would have become
 * arbitrary command execution inside the mail container — the exact
 * outcome the whole architecture exists to prevent.
 *
 * So the vocabulary moved instead. Every DMS write is now a **named
 * operation with typed leaf parameters**, exactly like `console.exec` and
 * `logs.file` before it (`broker.ts`): the web tier sends
 * `{ operation: 'dms.email.add', email, password }` and the broker
 * constructs the argv from its own builders (`apps/broker/src/dms/`).
 *
 * **There is no field in this file that carries an argv element, a shell
 * string, a file path, or a container specification**, and none that
 * could be made to. `broker.test.ts`'s dangerous-field suite feeds
 * poisoned input through the whole union, this file included.
 *
 * Two consequences worth naming:
 *
 *  - File reads take a **symbolic key**, never a path
 *    ({@link DMS_CONFIG_FILE_KEYS}). The broker owns the key -> path
 *    mapping, the same way `logs.file` owns its two log paths.
 *  - Environment reads return **only the six keys this project actually
 *    consumes** ({@link DMS_ENV_KEYS}), not the container's whole
 *    environment. The pre-M16 `DmsExecPort.getEnv()` returned everything,
 *    which would have handed a compromised web tier every secret in the
 *    mail container's environment for the sake of six capability flags.
 *    Narrowing it was free, and not doing so would have widened the blast
 *    radius in the same commit that was meant to contain it.
 *
 * Leaf validation lives in `dms-validators.ts` and is applied *here*, in
 * the schemas, so both tiers run byte-identical rules from one source:
 * the broker rejects on `BrokerRequestSchema.safeParse` before any
 * builder runs (authoritative — it can never trust its caller), and the
 * web tier's adapter parses the same schema first so an invalid value
 * still fails fast, locally, with the same message it always did.
 */
import { z } from 'zod';
import { MailDataChoiceSchema } from './mail.js';
import {
  validateAddressForArgv,
  validateDkimKeysize,
  validateDkimSelector,
  validateDomain,
  validateIpAddress,
  validatePassword,
  validateQuota,
  validateSieveScriptName,
} from './dms-validators.js';

// ---------------------------------------------------------------------------
// Leaf field schemas — one per validated value shape.
// ---------------------------------------------------------------------------

/** Wraps a `dms-validators.ts` validator (returns `null` when valid, a message otherwise) as a Zod string field carrying that exact message. One implementation, both tiers. */
function validatedString(validate: (value: string) => string | null): z.ZodType<string> {
  return z.string().superRefine((value, ctx) => {
    const error = validate(value);
    if (error !== null) ctx.addIssue({ code: 'custom', message: error });
  });
}

const AddressField = validatedString((value) => validateAddressForArgv(value));
/** `setup email restrict` and alias recipients accept a bare `@domain` catch-all, which `validateAddressForArgv` gates behind an explicit option. */
const CatchAllAddressField = validatedString((value) =>
  validateAddressForArgv(value, { allowCatchAll: true }),
);
const PasswordField = validatedString(validatePassword);
const QuotaField = validatedString(validateQuota);
const IpField = validatedString(validateIpAddress);
const DomainField = validatedString(validateDomain);
const DkimSelectorField = validatedString(validateDkimSelector);
/**
 * A stored Sieve script's name. The field carrying this is called
 * `script`, never `name`: `broker.test.ts`'s container-reference guard
 * rejects a `name` field on every operation but the one documented
 * exemption, and that bluntness is worth more than the nicer field name.
 * An operation vocabulary in which "name" sometimes means a container is
 * exactly the ambiguity the guard exists to prevent.
 */
const SieveScriptNameField = validatedString(validateSieveScriptName);
const DkimKeysizeField = z.number().superRefine((value, ctx) => {
  const error = validateDkimKeysize(value);
  if (error !== null) ctx.addIssue({ code: 'custom', message: error });
});

/**
 * Sieve script source. Deliberately *not* validated for content here:
 * `sieve-validator.ts` (web tier) rejects `vnd.dovecot.execute` and
 * `sieve_pipe` before this is ever built, and Pigeonhole itself compiles
 * the script on `doveadm sieve put` and fails the exec on a syntax error.
 * What matters for *this* file's guarantee is that the content travels to
 * the container over **stdin**, never as an argv element — see
 * `apps/broker/src/dms/commands.ts`'s `buildSievePutCommand`.
 */
const SieveContentField = z.string();

// ---------------------------------------------------------------------------
// Symbolic keys — the "never a path" half of this contract.
// ---------------------------------------------------------------------------

/**
 * The closed set of docker-mailserver config files this project reads.
 * Each maps, **broker-side only**, to one hardcoded absolute path inside
 * the managed container (`apps/broker/src/dms/paths.ts`). There is no
 * path field anywhere in this file: a caller selects *which* known file,
 * never *where*, exactly as `LOG_FILE_SOURCES` does for log files.
 */
export const DMS_CONFIG_FILE_KEYS = [
  'postfix-accounts',
  'postfix-virtual',
  'dovecot-quotas',
  'postfix-send-access',
  'postfix-receive-access',
] as const;
export type DmsConfigFileKey = (typeof DMS_CONFIG_FILE_KEYS)[number];
export const DmsConfigFileKeySchema = z.enum(DMS_CONFIG_FILE_KEYS);

/**
 * Every environment variable the web tier is allowed to learn about the
 * mail container — the four capability flags `capabilities.ts` reads,
 * `ACCOUNT_PROVISIONER`, and `SSL_TYPE` for the TLS page. The broker
 * returns these keys and nothing else; a value absent from the container
 * is simply absent from the response.
 *
 * This list is the whole reason `dms.env.read` is safe to expose at all.
 * A mail container's environment routinely holds credentials, and
 * returning it wholesale to the tier most likely to be compromised would
 * be a strange thing to do in the milestone whose purpose is containment.
 */
export const DMS_ENV_KEYS = [
  'ENABLE_QUOTAS',
  'ENABLE_RSPAMD',
  'ENABLE_CLAMAV',
  'ENABLE_FAIL2BAN',
  'ACCOUNT_PROVISIONER',
  'SSL_TYPE',
] as const;
export type DmsEnvKey = (typeof DMS_ENV_KEYS)[number];

/** clamd's control-socket verbs. A closed union, never caller-supplied text. */
export const CLAMD_VERBS = ['PING', 'VERSION', 'STATS'] as const;
export type ClamdVerb = (typeof CLAMD_VERBS)[number];
export const ClamdVerbSchema = z.enum(CLAMD_VERBS);

/** `setup email restrict <add|del|list>`. */
export const RESTRICT_ACTIONS = ['add', 'del', 'list'] as const;
export type RestrictAction = (typeof RESTRICT_ACTIONS)[number];
/** Which direction a restriction applies to — selects the `.cf` file DMS writes. */
export const RESTRICT_SCOPES = ['send', 'receive'] as const;
export type RestrictScope = (typeof RESTRICT_SCOPES)[number];

// Whether a deleted mailbox's mail data dies with the account is
// `mail.ts`'s `MailDataChoiceSchema`, reused here rather than redeclared:
// it is the same decision at the API edge and at the broker edge, and two
// enums for one concept is how they drift apart. It carries no default and
// no `.optional()` in either place — `setup email del` without an explicit
// `-y`/`-n` prompts, which hangs a non-interactive exec, and defaulting it
// would silently choose for an operator on the one operation in this
// project that destroys mail (AGENT_BRIEF.md §4).

// ---------------------------------------------------------------------------
// Request schemas — one per operation. Written out rather than generated:
// each one's *parameters* are the thing a reviewer needs to see, and a
// generated union would hide exactly that behind a mapped type.
// ---------------------------------------------------------------------------

const dmsOp = <const N extends string>(name: N) => z.literal(name);

export const DmsFileReadRequestSchema = z
  .object({ operation: dmsOp('dms.file.read'), file: DmsConfigFileKeySchema })
  .strict();

export const DmsEnvReadRequestSchema = z.object({ operation: dmsOp('dms.env.read') }).strict();

export const DmsDkimRecordReadRequestSchema = z
  .object({
    operation: dmsOp('dms.dkim.record.read'),
    domain: DomainField,
    selector: DkimSelectorField,
  })
  .strict();

// --- email ---------------------------------------------------------------

export const DmsEmailAddRequestSchema = z
  .object({ operation: dmsOp('dms.email.add'), email: AddressField, password: PasswordField })
  .strict();

export const DmsEmailUpdateRequestSchema = z
  .object({ operation: dmsOp('dms.email.update'), email: AddressField, password: PasswordField })
  .strict();

export const DmsEmailDeleteRequestSchema = z
  .object({
    operation: dmsOp('dms.email.del'),
    emails: z.array(AddressField).min(1),
    // No `.default()`, no `.optional()`. See MAIL_DATA_CHOICES.
    mailData: MailDataChoiceSchema,
  })
  .strict();

export const DmsEmailRestrictRequestSchema = z
  .object({
    operation: dmsOp('dms.email.restrict'),
    action: z.enum(RESTRICT_ACTIONS),
    scope: z.enum(RESTRICT_SCOPES),
    // Absent for `list`; required by the builder for `add`/`del`.
    email: CatchAllAddressField.optional(),
  })
  .strict();

export const DmsEmailListRequestSchema = z.object({ operation: dmsOp('dms.email.list') }).strict();

// --- alias ---------------------------------------------------------------

export const DmsAliasAddRequestSchema = z
  .object({
    operation: dmsOp('dms.alias.add'),
    alias: CatchAllAddressField,
    recipient: AddressField,
  })
  .strict();

export const DmsAliasDeleteRequestSchema = z
  .object({
    operation: dmsOp('dms.alias.del'),
    alias: CatchAllAddressField,
    recipient: AddressField,
  })
  .strict();

export const DmsAliasListRequestSchema = z.object({ operation: dmsOp('dms.alias.list') }).strict();

// --- quota ---------------------------------------------------------------

export const DmsQuotaSetRequestSchema = z
  .object({ operation: dmsOp('dms.quota.set'), email: AddressField, quota: QuotaField })
  .strict();

export const DmsQuotaDeleteRequestSchema = z
  .object({ operation: dmsOp('dms.quota.del'), email: AddressField })
  .strict();

export const DmsQuotaGetRequestSchema = z
  .object({ operation: dmsOp('dms.quota.get'), email: AddressField })
  .strict();

// --- dkim ----------------------------------------------------------------

export const DmsDkimGenerateRequestSchema = z
  .object({
    operation: dmsOp('dms.dkim.generate'),
    keysize: DkimKeysizeField.optional(),
    selector: DkimSelectorField.optional(),
    domains: z.array(DomainField).min(1).optional(),
  })
  .strict();

// --- fail2ban ------------------------------------------------------------

export const DmsFail2banListRequestSchema = z
  .object({ operation: dmsOp('dms.fail2ban.list') })
  .strict();
export const DmsFail2banStatusRequestSchema = z
  .object({ operation: dmsOp('dms.fail2ban.status') })
  .strict();
export const DmsFail2banLogRequestSchema = z
  .object({ operation: dmsOp('dms.fail2ban.log') })
  .strict();
export const DmsFail2banBanRequestSchema = z
  .object({ operation: dmsOp('dms.fail2ban.ban'), ip: IpField })
  .strict();
export const DmsFail2banUnbanRequestSchema = z
  .object({ operation: dmsOp('dms.fail2ban.unban'), ip: IpField })
  .strict();

// --- clamav --------------------------------------------------------------

export const DmsClamdControlRequestSchema = z
  .object({ operation: dmsOp('dms.clamd.control'), verb: ClamdVerbSchema })
  .strict();
export const DmsClamavUpdateRequestSchema = z
  .object({ operation: dmsOp('dms.clamav.update') })
  .strict();
export const DmsClamavLogRequestSchema = z.object({ operation: dmsOp('dms.clamav.log') }).strict();

// --- sieve ---------------------------------------------------------------

export const DmsSieveListRequestSchema = z
  .object({ operation: dmsOp('dms.sieve.list'), user: AddressField })
  .strict();
export const DmsSieveGetRequestSchema = z
  .object({ operation: dmsOp('dms.sieve.get'), user: AddressField, script: SieveScriptNameField })
  .strict();
export const DmsSievePutRequestSchema = z
  .object({
    operation: dmsOp('dms.sieve.put'),
    user: AddressField,
    script: SieveScriptNameField,
    content: SieveContentField,
  })
  .strict();
export const DmsSieveActivateRequestSchema = z
  .object({
    operation: dmsOp('dms.sieve.activate'),
    user: AddressField,
    script: SieveScriptNameField,
  })
  .strict();
export const DmsSieveDeactivateRequestSchema = z
  .object({ operation: dmsOp('dms.sieve.deactivate'), user: AddressField })
  .strict();

// --- queue ---------------------------------------------------------------

export const DmsQueueListRequestSchema = z.object({ operation: dmsOp('dms.queue.list') }).strict();

/**
 * Every DMS request schema, in the same order as {@link DMS_OPERATIONS}
 * below. Exported so `broker.ts` can splice them into the one union and
 * so the security suites can iterate them generically, exactly as
 * `BROKER_REQUEST_SCHEMAS` already does for the Docker half.
 */
export const DMS_REQUEST_SCHEMAS = [
  DmsFileReadRequestSchema,
  DmsEnvReadRequestSchema,
  DmsDkimRecordReadRequestSchema,
  DmsEmailAddRequestSchema,
  DmsEmailUpdateRequestSchema,
  DmsEmailDeleteRequestSchema,
  DmsEmailRestrictRequestSchema,
  DmsEmailListRequestSchema,
  DmsAliasAddRequestSchema,
  DmsAliasDeleteRequestSchema,
  DmsAliasListRequestSchema,
  DmsQuotaSetRequestSchema,
  DmsQuotaDeleteRequestSchema,
  DmsQuotaGetRequestSchema,
  DmsDkimGenerateRequestSchema,
  DmsFail2banListRequestSchema,
  DmsFail2banStatusRequestSchema,
  DmsFail2banLogRequestSchema,
  DmsFail2banBanRequestSchema,
  DmsFail2banUnbanRequestSchema,
  DmsClamdControlRequestSchema,
  DmsClamavUpdateRequestSchema,
  DmsClamavLogRequestSchema,
  DmsSieveListRequestSchema,
  DmsSieveGetRequestSchema,
  DmsSievePutRequestSchema,
  DmsSieveActivateRequestSchema,
  DmsSieveDeactivateRequestSchema,
  DmsQueueListRequestSchema,
] as const;

/**
 * The DMS half of the broker's operation enum. Order matches
 * {@link DMS_REQUEST_SCHEMAS} above; `dms.test.ts` pins that they stay
 * aligned, so neither list can drift from the other unnoticed.
 */
export const DMS_OPERATIONS = [
  'dms.file.read',
  'dms.env.read',
  'dms.dkim.record.read',
  'dms.email.add',
  'dms.email.update',
  'dms.email.del',
  'dms.email.restrict',
  'dms.email.list',
  'dms.alias.add',
  'dms.alias.del',
  'dms.alias.list',
  'dms.quota.set',
  'dms.quota.del',
  'dms.quota.get',
  'dms.dkim.generate',
  'dms.fail2ban.list',
  'dms.fail2ban.status',
  'dms.fail2ban.log',
  'dms.fail2ban.ban',
  'dms.fail2ban.unban',
  'dms.clamd.control',
  'dms.clamav.update',
  'dms.clamav.log',
  'dms.sieve.list',
  'dms.sieve.get',
  'dms.sieve.put',
  'dms.sieve.activate',
  'dms.sieve.deactivate',
  'dms.queue.list',
] as const;
export type DmsOperation = (typeof DMS_OPERATIONS)[number];

/**
 * The 26 operations that run a command inside the mail container, as
 * opposed to the three that read state (`dms.file.read`, `dms.env.read`,
 * `dms.dkim.record.read`). Every one of these resolves to a
 * broker-constructed argv and shares {@link DmsExecResponseSchema}.
 */
export const DMS_COMMAND_OPERATIONS = DMS_OPERATIONS.filter(
  (operation) =>
    operation !== 'dms.file.read' &&
    operation !== 'dms.env.read' &&
    operation !== 'dms.dkim.record.read',
) as readonly Exclude<DmsOperation, 'dms.file.read' | 'dms.env.read' | 'dms.dkim.record.read'>[];
export type DmsCommandOperation = (typeof DMS_COMMAND_OPERATIONS)[number];

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

/**
 * The uniform result of running one broker-built argv in the mail
 * container. Non-zero `exitCode` is returned, not thrown: `doveadm sieve
 * get` on a missing script and `fail2ban-client` with no jails are
 * diagnostic outcomes for the driver to interpret, not broker failures.
 *
 * Note what is *not* here: the argv itself. `console.exec` echoes its
 * argv back because its whole purpose is a diagnostic console showing the
 * operator what ran; these are internal driver calls, and echoing a
 * constructed command line into the web tier would hand a compromised
 * server a map of the exact strings the broker builds.
 */
export const DmsExecResponseSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
});
export type DmsExecResponse = z.infer<typeof DmsExecResponseSchema>;

/** A config file's current text, or `null` when it does not exist yet — a fresh DMS install has written no `postfix-accounts.cf` until the first mailbox is added, which is not an error. */
export const DmsFileReadResponseSchema = z.object({ content: z.string().nullable() });

/** Only the keys in {@link DMS_ENV_KEYS} that the container actually sets. */
export const DmsEnvReadResponseSchema = z.object({ env: z.record(z.string(), z.string()) });

/** The **public** DKIM DNS record file's text, or `null` when no key has been generated for this domain/selector. There is deliberately no operation anywhere that reads the `.private` counterpart. */
export const DmsDkimRecordReadResponseSchema = z.object({ content: z.string().nullable() });

/** Response schema per DMS operation — spliced into `BROKER_RESPONSE_SCHEMAS`. The 26 command operations share one schema by construction rather than by 26 identical hand-written lines, so an anomaly among them is visible instead of camouflaged. */
export const DMS_RESPONSE_SCHEMAS = {
  'dms.file.read': DmsFileReadResponseSchema,
  'dms.env.read': DmsEnvReadResponseSchema,
  'dms.dkim.record.read': DmsDkimRecordReadResponseSchema,
  ...(Object.fromEntries(
    DMS_COMMAND_OPERATIONS.map((operation) => [operation, DmsExecResponseSchema]),
  ) as Record<DmsCommandOperation, typeof DmsExecResponseSchema>),
} satisfies Record<DmsOperation, z.ZodTypeAny>;

// ---------------------------------------------------------------------------
// Inferred request types. One source for the broker's argv builders (which
// receive a parsed body) and the web tier's driver params (which are the
// same fields minus the discriminator) — so a schema change is a compile
// error on both sides rather than a silent divergence.
// ---------------------------------------------------------------------------

export type DmsFileReadRequest = z.infer<typeof DmsFileReadRequestSchema>;
export type DmsDkimRecordReadRequest = z.infer<typeof DmsDkimRecordReadRequestSchema>;
export type DmsEmailAddRequest = z.infer<typeof DmsEmailAddRequestSchema>;
export type DmsEmailUpdateRequest = z.infer<typeof DmsEmailUpdateRequestSchema>;
export type DmsEmailDeleteRequest = z.infer<typeof DmsEmailDeleteRequestSchema>;
export type DmsEmailRestrictRequest = z.infer<typeof DmsEmailRestrictRequestSchema>;
export type DmsAliasAddRequest = z.infer<typeof DmsAliasAddRequestSchema>;
export type DmsAliasDeleteRequest = z.infer<typeof DmsAliasDeleteRequestSchema>;
export type DmsQuotaSetRequest = z.infer<typeof DmsQuotaSetRequestSchema>;
export type DmsQuotaDeleteRequest = z.infer<typeof DmsQuotaDeleteRequestSchema>;
export type DmsQuotaGetRequest = z.infer<typeof DmsQuotaGetRequestSchema>;
export type DmsDkimGenerateRequest = z.infer<typeof DmsDkimGenerateRequestSchema>;
export type DmsFail2banIpRequest = z.infer<typeof DmsFail2banBanRequestSchema>;
export type DmsClamdControlRequest = z.infer<typeof DmsClamdControlRequestSchema>;
export type DmsSieveListRequest = z.infer<typeof DmsSieveListRequestSchema>;
export type DmsSieveGetRequest = z.infer<typeof DmsSieveGetRequestSchema>;
export type DmsSievePutRequest = z.infer<typeof DmsSievePutRequestSchema>;
export type DmsSieveActivateRequest = z.infer<typeof DmsSieveActivateRequestSchema>;
export type DmsSieveDeactivateRequest = z.infer<typeof DmsSieveDeactivateRequestSchema>;

/** The driver-facing shape of an operation body: the same validated fields, without the discriminator the transport needs. */
export type DmsParams<T extends { operation: string }> = Omit<T, 'operation'>;
