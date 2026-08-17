/**
 * Restricted console service (M9 — FEATURE_MATRIX.md §32;
 * docs/research/02-docker-api-security.md §C.4). Gated on
 * `ENABLE_EXEC_CONSOLE`, off by default (AGENT_BRIEF.md §4) — modelled as
 * a `CapabilityStatus` for the same reason every other flag-gated feature
 * in this codebase is (`assertQuotasSupported`, `capability-guards.ts`):
 * one consistent "unsupported/disabled" shape the web tier already knows
 * how to render, rather than a bespoke boolean.
 *
 * This service enforces the flag; it does not enforce the command
 * allowlist — that is `ConsoleCommand`'s job (`@dwg/shared`), a closed
 * enum this method's own parameter type is pinned to, so there is no
 * TypeScript-legal way to call `exec` with anything outside it, and Zod
 * rejects an out-of-enum value from the wire before this method is ever
 * reached (`console.routes.ts`).
 */
import type { CapabilityStatus, ConsoleCommand, ConsoleExecResponse } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';
import { AppError } from '../../platform/errors.js';

const DISABLED_REASON =
  'The command console is disabled on this deployment (ENABLE_EXEC_CONSOLE=false).';

export class ConsoleService {
  constructor(
    private readonly broker: BrokerClient,
    private readonly enabled: boolean,
  ) {}

  getAvailability(): CapabilityStatus {
    return this.enabled
      ? { supported: true, reason: null }
      : { supported: false, reason: DISABLED_REASON };
  }

  async exec(command: ConsoleCommand): Promise<ConsoleExecResponse> {
    this.assertEnabled();
    return this.broker.consoleExec(command);
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new AppError('CAPABILITY_UNSUPPORTED', DISABLED_REASON);
    }
  }
}
