/**
 * The broker-side half of the docker-mailserver vocabulary (M16) — where
 * a named operation with typed leaf parameters becomes an actual argv
 * array and an actual path.
 *
 * Everything that makes this safe is on *this* side of the boundary:
 *
 *  - **The argv is built here, never received.** `DMS_COMMAND_BUILDERS`
 *    maps each operation to one builder in `commands.ts`; the builder
 *    re-validates every leaf and assembles the array from its own string
 *    literals. Nothing in `@dwg/shared`'s request schemas can carry an
 *    argv element, a flag, or a shell string, so there is no input here
 *    that could widen a command even by one argument.
 *  - **The paths are constants here, never received.**
 *    {@link DMS_CONFIG_FILE_PATHS} maps a five-value symbolic key to one
 *    hardcoded absolute path, exactly as `operations.ts`'s
 *    `LOG_FILE_PATHS` does for log files.
 *  - **The environment is filtered here.** `dms.env.read` returns only
 *    `DMS_ENV_KEYS`, so a compromised web tier learns six capability
 *    flags rather than every credential in the mail container.
 *
 * Validation runs twice on purpose: once when Fastify parses the request
 * against `BrokerRequestSchema` (which is where a bad value is actually
 * rejected), and again inside each builder. The second pass is not
 * redundant defence-in-depth theatre — the builders are the module that
 * would be reused if this dispatch were ever refactored, and a builder
 * that trusts its caller is a builder that becomes unsafe the moment
 * someone calls it from somewhere new.
 */
import {
  DMS_ENV_KEYS,
  type BrokerRequest,
  type DmsCommandOperation,
  type DmsConfigFileKey,
  type DmsExecResponse,
} from '@dwg/shared';
import { BrokerError } from '../errors.js';
import type { OperationDeps } from '../operations.js';
import { resolveOrForbid } from '../operations.js';
import type { CommandResult } from './commands.js';
import {
  buildAliasAddCommand,
  buildAliasDeleteCommand,
  buildAliasListCommand,
  buildClamavLogTailCommand,
  buildClamdCommand,
  buildConfigDkimCommand,
  buildDoveadmQuotaGetCommand,
  buildEmailAddCommand,
  buildEmailDeleteCommand,
  buildEmailListCommand,
  buildEmailRestrictCommand,
  buildEmailUpdateCommand,
  buildFail2banBanCommand,
  buildFail2banListCommand,
  buildFail2banLogCommand,
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
} from './commands.js';

/**
 * docker-mailserver's config directory inside the container
 * (`docs/research/01-docker-mailserver.md` §6). One constant, used to
 * derive every path below, so there is exactly one place this location is
 * written down.
 */
const DMS_CONFIG_DIR = '/tmp/docker-mailserver';

/**
 * The symbolic-key -> absolute-path map. The whole point of the key enum
 * in `@dwg/shared` is that this table lives here, on the privileged side:
 * a caller selects a row, never a value.
 */
const DMS_CONFIG_FILE_PATHS: Record<DmsConfigFileKey, string> = {
  'postfix-accounts': `${DMS_CONFIG_DIR}/postfix-accounts.cf`,
  'postfix-virtual': `${DMS_CONFIG_DIR}/postfix-virtual.cf`,
  'dovecot-quotas': `${DMS_CONFIG_DIR}/dovecot-quotas.cf`,
  'postfix-send-access': `${DMS_CONFIG_DIR}/postfix-send-access.cf`,
  'postfix-receive-access': `${DMS_CONFIG_DIR}/postfix-receive-access.cf`,
};

/**
 * One builder per command operation. A `satisfies` on a `Record` keyed by
 * `DmsCommandOperation` is what makes it impossible to add an operation
 * to the shared enum without wiring a builder here — the build fails
 * rather than the operation silently 500ing at runtime.
 *
 * Each entry receives the already-parsed request body. The bodies carry
 * an extra `operation` discriminator the builders ignore, which is why
 * they accept it structurally rather than needing a strip step.
 */
const DMS_COMMAND_BUILDERS = {
  'dms.email.add': buildEmailAddCommand,
  'dms.email.update': buildEmailUpdateCommand,
  'dms.email.del': buildEmailDeleteCommand,
  'dms.email.restrict': buildEmailRestrictCommand,
  'dms.email.list': buildEmailListCommand,
  'dms.alias.add': buildAliasAddCommand,
  'dms.alias.del': buildAliasDeleteCommand,
  'dms.alias.list': buildAliasListCommand,
  'dms.quota.set': buildQuotaSetCommand,
  'dms.quota.del': buildQuotaDeleteCommand,
  'dms.quota.get': buildDoveadmQuotaGetCommand,
  'dms.dkim.generate': buildConfigDkimCommand,
  'dms.fail2ban.list': buildFail2banListCommand,
  'dms.fail2ban.status': buildFail2banStatusCommand,
  'dms.fail2ban.log': buildFail2banLogCommand,
  'dms.fail2ban.ban': buildFail2banBanCommand,
  'dms.fail2ban.unban': buildFail2banUnbanCommand,
  'dms.clamd.control': (body: Extract<BrokerRequest, { operation: 'dms.clamd.control' }>) =>
    buildClamdCommand(body.verb),
  'dms.clamav.update': buildFreshclamCommand,
  'dms.clamav.log': buildClamavLogTailCommand,
  'dms.sieve.list': buildSieveListCommand,
  'dms.sieve.get': buildSieveGetCommand,
  'dms.sieve.put': buildSievePutCommand,
  'dms.sieve.activate': buildSieveActivateCommand,
  'dms.sieve.deactivate': buildSieveDeactivateCommand,
  'dms.queue.list': buildPostqueueJsonCommand,
} satisfies Record<DmsCommandOperation, (body: never) => CommandResult>;

/** Every DMS request that resolves to a broker-built command. */
type DmsCommandRequest = Extract<BrokerRequest, { operation: DmsCommandOperation }>;

/**
 * Runs one named DMS command. The builder's own rejection becomes
 * `VALIDATION_FAILED` — a caller sending a value the schema accepted but
 * a builder refused is a caller bug, not an upstream failure.
 *
 * A non-zero exit is *returned*, not thrown: `doveadm sieve get` on a
 * missing script and `fail2ban-client` with no jails are both diagnostic
 * outcomes the driver interprets, and the response schema has `exitCode`
 * precisely so the broker does not have to guess which non-zero exits are
 * real failures. This mirrors `console.exec`, not `logs.file`.
 */
export async function handleDmsCommand(
  body: DmsCommandRequest,
  deps: OperationDeps,
): Promise<DmsExecResponse> {
  const ref = await resolveOrForbid(deps);
  // The indexed access is what ties the operation to its builder; the
  // cast is confined to this one line because a `Record` of functions with
  // mutually-incompatible parameter types cannot be called generically
  // without it. The `satisfies` above is what makes it sound: every key is
  // a real operation and every value is a real builder for that operation.
  const build = DMS_COMMAND_BUILDERS[body.operation] as (body: DmsCommandRequest) => CommandResult;
  const result = build(body);
  if (!result.ok) {
    throw new BrokerError('VALIDATION_FAILED', result.error);
  }
  const { argv, stdin } = result.command;
  const exec = await deps.docker.execContainer(
    ref.id,
    argv,
    stdin === undefined ? undefined : { stdin },
  );
  return { stdout: exec.stdout, stderr: exec.stderr, exitCode: exec.exitCode };
}

/**
 * Reads one known config file. A non-zero exit means the file is not
 * there — a fresh DMS install has no `postfix-accounts.cf` until the
 * first mailbox is added — which is `null`, not an error. A real I/O
 * failure surfaces from `execContainer` itself.
 */
export async function handleDmsFileRead(
  body: Extract<BrokerRequest, { operation: 'dms.file.read' }>,
  deps: OperationDeps,
): Promise<{ content: string | null }> {
  const ref = await resolveOrForbid(deps);
  const path = DMS_CONFIG_FILE_PATHS[body.file];
  const result = await deps.docker.execContainer(ref.id, ['cat', path]);
  return { content: result.exitCode === 0 ? result.stdout : null };
}

/**
 * The **public** DKIM record `opendkim-genkey` writes, at
 * `<config>/opendkim/keys/<domain>/<selector>.txt`
 * (`docs/research/01-docker-mailserver.md` §7). `domain` and `selector`
 * are already validated by the request schema — a domain cannot contain a
 * `/` or `..` and a selector is `[A-Za-z0-9][A-Za-z0-9_-]*` — so the two
 * interpolations below cannot leave the keys directory.
 *
 * **There is no operation anywhere that reads the `.private` counterpart**,
 * and that absence is the entire enforcement behind FEATURE_MATRIX.md
 * §11's "private keys are never returned by any API". Adding one is a
 * threat-model change, not a routine extension.
 */
export async function handleDmsDkimRecordRead(
  body: Extract<BrokerRequest, { operation: 'dms.dkim.record.read' }>,
  deps: OperationDeps,
): Promise<{ content: string | null }> {
  const ref = await resolveOrForbid(deps);
  const path = `${DMS_CONFIG_DIR}/opendkim/keys/${body.domain}/${body.selector}.txt`;
  const result = await deps.docker.execContainer(ref.id, ['cat', path]);
  return { content: result.exitCode === 0 ? result.stdout : null };
}

/**
 * The six allowlisted environment values, and nothing else.
 *
 * `printenv` rather than a new Docker inspect field: `docker exec` runs
 * with the container's own environment, so this reads the same values
 * `Config.Env` holds, without widening `DockerApi`'s surface or touching
 * the inspect path every other operation shares. Parsing is deliberately
 * conservative — split on the first `=`, keep the line only if its key is
 * in the allowlist — so a value containing a newline can at worst drop a
 * key, never smuggle one in.
 */
export async function handleDmsEnvRead(
  deps: OperationDeps,
): Promise<{ env: Record<string, string> }> {
  const ref = await resolveOrForbid(deps);
  const result = await deps.docker.execContainer(ref.id, ['printenv']);
  if (result.exitCode !== 0) {
    throw new BrokerError(
      'UPSTREAM_UNAVAILABLE',
      "Could not read the mail container's environment.",
    );
  }
  const allowed = new Set<string>(DMS_ENV_KEYS);
  const env: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (allowed.has(key)) {
      env[key] = line.slice(separator + 1);
    }
  }
  return { env };
}
