/**
 * What {@link RealDmsDriver} needs from the broker to do its job.
 *
 * ---------------------------------------------------------------------
 * What changed in M16, and why the old shape could never be implemented
 * ---------------------------------------------------------------------
 *
 * This port used to be `exec(argv, { stdin })` plus `readFile(name)`, and
 * it had **no implementation at all** — `createDmsDriver` threw in
 * production rather than construct a driver with nothing behind it.
 * Implementing it would have meant adding `exec.run(argv)` and
 * `file.read(path)` to the broker, and both are the passthrough
 * AGENT_BRIEF.md §2 forbids by name: an allowlist that validates a
 * caller-supplied argv is still a passthrough, and full RCE in the web
 * tier would have become arbitrary command execution inside the mail
 * container — the exact outcome the architecture exists to prevent.
 *
 * So the port now speaks **named operations with typed leaf parameters**
 * (`@dwg/shared`'s `dms.*` vocabulary). `RealDmsDriver` says *what* it
 * wants done; the broker decides what that means as an argv array and a
 * path. There is no method here that accepts a command, a flag or a path,
 * and there is no way to add one without adding a field to the shared
 * schemas that `broker.test.ts`'s dangerous-field suite would reject.
 *
 * `BrokerDmsExecPort` (`broker-dms-exec-port.ts`) is the real
 * implementation, over the same `BrokerClient` every Docker operation
 * already uses. `real-dms-driver.test.ts` uses a recording stub — which
 * is now a far more useful test subject than it was, because what it
 * records is the *intent* the driver expressed rather than a command line
 * the driver happened to assemble.
 */
import type {
  BrokerRequest,
  DmsCommandOperation,
  DmsConfigFileKey,
  DmsExecResponse,
} from '@dwg/shared';

/** Any DMS operation that resolves, broker-side, to a command run inside the mail container. */
export type DmsCommandRequest = Extract<BrokerRequest, { operation: DmsCommandOperation }>;

export interface DmsExecPort {
  /**
   * The named config file's current text, or `null` when it does not
   * exist — a fresh DMS install has written no `postfix-accounts.cf`
   * until the first mailbox is added, which is not an error.
   *
   * Takes a **symbolic key**, not a filename: the broker owns the
   * key -> path mapping (`apps/broker/src/dms/handlers.ts`). Nothing on
   * this side of the boundary knows, or can express, where these files
   * live.
   */
  readFile(file: DmsConfigFileKey): Promise<string | null>;

  /**
   * Runs one named operation and resolves with its result **regardless of
   * exit code** — a non-zero exit is the driver's to interpret (a missing
   * Sieve script, a Fail2ban with no jails), not this port's to throw on.
   */
  runCommand(request: DmsCommandRequest): Promise<DmsExecResponse>;

  /**
   * The mail container's environment, filtered broker-side to the six
   * keys this project consumes (`DMS_ENV_KEYS`). Deliberately not the
   * whole environment: a mail container's environment routinely holds
   * credentials, and the web tier needs four capability flags,
   * `ACCOUNT_PROVISIONER` and `SSL_TYPE`. Keys the container does not set
   * are absent.
   */
  readEnv(): Promise<Readonly<Record<string, string>>>;

  /**
   * The **public** DKIM record `opendkim-genkey` writes for this
   * domain/selector, or `null` when none has been generated.
   *
   * **There is no method here for the `.private` counterpart, and no
   * broker operation that could serve one.** That absence is the whole
   * enforcement behind FEATURE_MATRIX.md §11's "private keys are never
   * returned by any API"; a broker-side test asserts no code path in the
   * handler module even names such a file.
   */
  readDkimRecord(domain: string, selector: string): Promise<string | null>;
}
