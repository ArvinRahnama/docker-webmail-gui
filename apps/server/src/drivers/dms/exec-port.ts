/**
 * The minimal capability {@link RealDmsDriver} (`real-dms-driver.ts`)
 * needs from "the broker" to do its job: read a config file's current
 * text, invoke an argv command (optionally piping stdin), and read the
 * DMS container's environment for capability detection.
 *
 * ARCHITECTURE.md §6 documents the intended broker operations for this —
 * `exec.run` (allowlisted argv only) and `file.{read,write}` (allowlisted
 * DMS config paths only) — but `packages/shared/src/broker.ts` (M4)
 * explicitly defers both: *"Deliberately omitted: `container.create`,
 * `container.remove`, and any `exec.*` operation ... Both are later
 * milestones, not oversights here."* `BrokerClient`
 * (`apps/server/src/drivers/broker`) therefore has no method for either
 * yet, and this milestone's own brief scopes M5 to "argv command builders"
 * — not to reopening that M4 decision or building the broker-side
 * `exec.run`/`file.read` handlers.
 *
 * Rather than block a genuine `RealDmsDriver` on that, or bypass the
 * broker boundary (FEATURE_MATRIX.md §0 Rule 2: "every mutation crosses
 * the broker boundary" — the web tier holds no Docker socket, ever), this
 * interface names exactly the two read primitives and one write primitive
 * `RealDmsDriver` needs and takes an implementation as a constructor
 * dependency. `RealDmsDriver`'s own logic (parse what it reads, validate
 * and build the command it invokes, surface exec failures) is fully real
 * and fully testable today against a hand-written `DmsExecPort` — see
 * `real-dms-driver.test.ts`. A concrete adapter backed by the real
 * broker's `exec.run`/`file.read` lands whenever those operations are
 * added to the broker vocabulary; that wiring is deferred, not decided,
 * here.
 */

export interface DmsExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export const DMS_CONFIG_FILE_NAMES = [
  'postfix-accounts.cf',
  'postfix-virtual.cf',
  'dovecot-quotas.cf',
  // Written by `setup email restrict add|del send|receive <EMAIL>`
  // (docs/research/01-docker-mailserver.md §8) — read by
  // `getRestrictedAddresses` (`types.ts`) via `parsers/postfix-access.ts`.
  'postfix-send-access.cf',
  'postfix-receive-access.cf',
] as const;

export type DmsConfigFileName = (typeof DMS_CONFIG_FILE_NAMES)[number];

export interface DmsExecOptions {
  /** Piped to the process's stdin — the only channel a password ever travels over (★3). */
  readonly stdin?: string;
}

export interface DmsExecPort {
  /**
   * Returns the named config file's current text, exactly as stored under
   * DMS's bind-mounted config directory (`docs/research/01-docker-mailserver.md`
   * §6). Returns `null` if the file does not exist yet — a fresh DMS
   * install may not have created it (e.g. no mailbox has ever been added,
   * so `postfix-accounts.cf` was never written). Never throws for a
   * missing file; a genuine I/O failure should still reject the promise.
   */
  readFile(name: DmsConfigFileName): Promise<string | null>;

  /**
   * Runs `argv` (already validated and built by `commands.ts` — this port
   * never sees an unvalidated leaf value) inside the resolved DMS
   * container, piping `options.stdin` if given. Resolves with the
   * process's result regardless of exit code; a non-zero `exitCode` is
   * the caller's (RealDmsDriver's) concern to interpret, not this port's
   * to throw on.
   */
  exec(argv: readonly string[], options?: DmsExecOptions): Promise<DmsExecResult>;

  /**
   * The DMS container's raw environment — the source `detectCapabilities`
   * (`capabilities.ts`) reads `ENABLE_QUOTAS`/`ENABLE_RSPAMD`/
   * `ENABLE_CLAMAV`/`ENABLE_FAIL2BAN`/`ACCOUNT_PROVISIONER` from
   * (ARCHITECTURE.md §5.1). Keys not set in the container are simply
   * absent, never `undefined`-valued entries.
   */
  getEnv(): Promise<Readonly<Record<string, string | undefined>>>;

  /**
   * Reads the **public** DKIM DNS record file `opendkim-genkey` writes —
   * `<selector>.txt` under `/tmp/docker-mailserver/opendkim/keys/<domain>/`
   * (`docs/research/01-docker-mailserver.md` §7). Returns `null` when no
   * key has been generated for this domain/selector yet (not an error —
   * a fresh deployment simply has none). `domain`/`selector` are always
   * already validated (`drivers/dns/hostname.ts`-shaped domain check,
   * `validators.ts`'s `validateDkimSelector`) by the caller before this
   * is invoked, so a real implementation can construct the file path
   * directly from them with no further sanitisation needed to stay
   * within the DKIM keys directory.
   *
   * **There is no corresponding method for the `.private` key file, on
   * this port or anywhere else in this codebase** — that omission is the
   * entire enforcement mechanism behind FEATURE_MATRIX.md §11's "Private
   * keys are never returned by any API and never rendered." A future
   * change that adds one is a change this project's threat model
   * requires extra scrutiny on, not a routine extension.
   */
  readDkimPublicKeyFile(domain: string, selector: string): Promise<string | null>;
}
