/**
 * Log viewer service (M9 — FEATURE_MATRIX.md §19-21, §26). Two sources:
 * the managed container's own stdout/stderr (`containerLogs`, Docker's
 * `container.logs`), and a fixed two-value enum of in-container log files
 * (`file`, `logs.file`) — mail and fail2ban. There is no third method that
 * takes a path: `LogFileSource` (`@dwg/shared`) is a closed enum, and this
 * service's `file` signature only accepts that type, so a caller cannot
 * even construct a request for an arbitrary path at the TypeScript level,
 * let alone reach one at runtime.
 */
import type { ContainerLogLine, LogFileSource } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';

// `?: T | undefined` rather than a bare `?: T` (AGENT_BRIEF.md §5) — routes
// forward a zod-parsed query object straight through, and zod's own
// `.optional()` inference includes explicit `undefined` in the value type,
// which `exactOptionalPropertyTypes` then requires this interface to
// accept too.
export interface ContainerLogsParams {
  readonly tail?: number | undefined;
  readonly since?: number | undefined;
  readonly timestamps?: boolean | undefined;
}

export interface LogFileParams {
  readonly tail?: number | undefined;
}

export class LogsService {
  constructor(private readonly broker: BrokerClient) {}

  async containerLogs(params: ContainerLogsParams = {}): Promise<readonly ContainerLogLine[]> {
    return this.broker.containerLogs(params);
  }

  async file(source: LogFileSource, params: LogFileParams = {}): Promise<readonly string[]> {
    return this.broker.logsFile(source, params);
  }
}
