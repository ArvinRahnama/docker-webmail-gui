/**
 * Validating a DMS operation body against the shared schema, web-tier
 * side (M16).
 *
 * Before M16 this validation was `commands.ts`'s builders returning a
 * `CommandResult` — the same module that produced the argv. The builders
 * now live in the broker, so the web tier validates the only way it still
 * can and the only way that stays honest: against `@dwg/shared`'s request
 * schemas, which carry the *same* `dms-validators.ts` rules the broker's
 * own parse applies. One rule set, two enforcement points.
 *
 * This is not the authoritative check — the broker's is, because the
 * broker can never trust its caller. This one exists so an invalid
 * address fails immediately, locally, with the message it always had,
 * instead of costing a round trip to come back as a generic upstream
 * validation error. `FakeDmsDriver` uses it for exactly the same reason:
 * it has no broker to ask, and a fake that accepted values the real path
 * rejects would make every development run a lie.
 */
import { z } from 'zod';
import { DmsCommandValidationError } from './errors.js';

/**
 * Zod reports every failing field; the driver's error carries one
 * message. The first issue is the one to surface — it is the field the
 * caller most likely got wrong, and concatenating all of them produces a
 * sentence no UI wants to render.
 */
function firstIssueMessage(error: z.ZodError): string {
  const [issue] = error.issues;
  return issue?.message ?? 'invalid request';
}

/** Parses `body`, returning it typed, or throws {@link DmsCommandValidationError} carrying the schema's own message. */
export function parseDmsRequest<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new DmsCommandValidationError(firstIssueMessage(result.error));
  }
  return result.data as z.infer<S>;
}

/** {@link parseDmsRequest} for callers that only need the rejection, not the parsed value — `FakeDmsDriver`, which then mutates its own fixtures. */
export function assertValidDmsRequest<S extends z.ZodType>(schema: S, body: unknown): void {
  parseDmsRequest(schema, body);
}
