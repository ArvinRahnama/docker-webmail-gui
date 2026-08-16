/**
 * Errors thrown by {@link DmsDriver} write methods (`types.ts`). Both
 * implementations (`RealDmsDriver`, `FakeDmsDriver`) throw the same two
 * types for the same two situations, mirroring the broker driver's own
 * `BrokerRequestError` pattern (`drivers/broker/real-broker-client.ts`) —
 * one typed error per failure class, never a raw string or a generic
 * `Error`.
 */

/**
 * A `commands.ts` builder rejected the input before any argv was ever
 * constructed (e.g. a malformed address, a missing mail-data choice). The
 * message is exactly the builder's own `error` string — already
 * human-readable and safe to show an admin, never a stack trace.
 */
export class DmsCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DmsCommandValidationError';
  }
}

/**
 * A validated command was actually invoked (via `DmsExecPort`, real
 * driver only) and exited non-zero. Carries the argv that was run (never
 * the stdin — a password must never end up in a log line via this error's
 * `.message` or any property on it) and DMS's own stderr text.
 */
export class DmsCommandExecutionError extends Error {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;

  constructor(argv: readonly string[], exitCode: number, stderr: string) {
    super(`"${argv.join(' ')}" exited ${exitCode}${stderr ? `: ${stderr.trim()}` : ''}`);
    this.name = 'DmsCommandExecutionError';
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}
