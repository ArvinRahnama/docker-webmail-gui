/**
 * Errors thrown by {@link DmsDriver} write methods (`types.ts`). Both
 * implementations (`RealDmsDriver`, `FakeDmsDriver`) throw the same two
 * types for the same two situations, mirroring the broker driver's own
 * `BrokerRequestError` pattern (`drivers/broker/real-broker-client.ts`) —
 * one typed error per failure class, never a raw string or a generic
 * `Error`.
 */

/**
 * The request was rejected before it ever reached the broker (a malformed
 * address, a missing mail-data choice) — by `@dwg/shared`'s DMS request
 * schema, which carries the same `dms-validators.ts` rules the broker
 * itself applies. The message is that validator's own string: already
 * human-readable and safe to show an admin, never a stack trace.
 */
export class DmsCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DmsCommandValidationError';
  }
}

/**
 * A validated command was actually invoked and exited non-zero. Carries
 * DMS's own stderr text and an identifier for what ran — never the stdin,
 * because a password must not end up in a log line via this error's
 * `.message` or any property on it.
 *
 * `command` is deliberately not called `argv` any more. Since M16 the web
 * tier does not build an argv: `RealDmsDriver` populates this with the
 * *operation name* it asked for (`['dms.email.add']`), which is the only
 * identity it has. `FakeDmsDriver` still populates it with the argv it is
 * imitating, because imitating DMS's own output is its whole job. Naming
 * the field `argv` while the real driver put an operation name in it
 * would have been the kind of small lie this project tries not to tell.
 */
export class DmsCommandExecutionError extends Error {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(command: readonly string[], exitCode: number, stderr: string) {
    super(`"${command.join(' ')}" exited ${exitCode}${stderr ? `: ${stderr.trim()}` : ''}`);
    this.name = 'DmsCommandExecutionError';
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}
