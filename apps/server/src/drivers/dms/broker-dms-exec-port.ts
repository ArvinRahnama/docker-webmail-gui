/**
 * The concrete {@link DmsExecPort} — the piece that did not exist before
 * M16, and whose absence is why `createDmsDriver` threw at startup in
 * production and the whole panel could not boot.
 *
 * It is deliberately thin. Every method is one broker call with the
 * parameters it was given; there is no command construction, no path
 * assembly and no branching on anything the caller supplied, because all
 * of that now happens on the far side of the boundary
 * (`apps/broker/src/dms/handlers.ts`). If this file ever grows a string
 * template that looks like a path or a command, something has gone wrong
 * with the design rather than with this file.
 */
import type { DmsConfigFileKey, DmsExecResponse } from '@dwg/shared';
import type { BrokerClient } from '../broker/types.js';
import type { DmsCommandRequest, DmsExecPort } from './exec-port.js';

export class BrokerDmsExecPort implements DmsExecPort {
  constructor(private readonly broker: BrokerClient) {}

  async readFile(file: DmsConfigFileKey): Promise<string | null> {
    return this.broker.dmsFileRead(file);
  }

  async runCommand(request: DmsCommandRequest): Promise<DmsExecResponse> {
    return this.broker.dmsCommand(request);
  }

  async readEnv(): Promise<Readonly<Record<string, string>>> {
    return this.broker.dmsEnvRead();
  }

  async readDkimRecord(domain: string, selector: string): Promise<string | null> {
    return this.broker.dmsDkimRecordRead(domain, selector);
  }
}
