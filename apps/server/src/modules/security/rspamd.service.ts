/**
 * Rspamd service (FEATURE_MATRIX.md §13-15). Every write here goes
 * through {@link RspamdClientPort}'s own closed set of named operations
 * (`drivers/rspamd/types.ts`) — this service adds nothing beyond
 * capability-gating and error mapping, so it cannot itself become a
 * path to a general config write no matter how it grows.
 */
import {
  parseRspamdActions,
  parseRspamdStat,
  parseRspamdSymbols,
  type RspamdClientPort,
} from '../../drivers/rspamd/index.js';
import type { DmsDriver } from '../../drivers/dms/index.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import { getRspamdTrend } from './rspamd-sampler.js';
import type { RspamdStatusResponse, RspamdTrendResponse } from '@dwg/shared';

const HISTORY_CAVEAT =
  "Rspamd's own /history is a 200-entry in-memory ring buffer that does not survive a restart. The trend above is our own periodic sampling instead.";

export class RspamdService {
  constructor(
    private readonly dmsDriver: DmsDriver,
    private readonly client: RspamdClientPort,
    private readonly db: Database,
  ) {}

  async getStatus(): Promise<RspamdStatusResponse> {
    const capabilities = await this.dmsDriver.getCapabilities();

    if (!capabilities.rspamd.supported) {
      return {
        capability: capabilities.rspamd,
        reachable: false,
        error: null,
        stat: null,
        symbols: [],
        actions: [],
        historyCaveat: HISTORY_CAVEAT,
      };
    }

    const [statResult, symbolsResult, actionsResult] = await Promise.all([
      this.client.getStat(),
      this.client.getSymbols(),
      this.client.getActions(),
    ]);

    if (!statResult.ok) {
      return {
        capability: capabilities.rspamd,
        reachable: false,
        error: statResult.error,
        stat: null,
        symbols: [],
        actions: [],
        historyCaveat: HISTORY_CAVEAT,
      };
    }

    const symbolsParsed = symbolsResult.ok ? parseRspamdSymbols(symbolsResult.value) : null;
    const actionsParsed = actionsResult.ok ? parseRspamdActions(actionsResult.value) : null;

    return {
      capability: capabilities.rspamd,
      reachable: true,
      error: null,
      stat: parseRspamdStat(statResult.value),
      symbols: symbolsParsed?.ok ? [...symbolsParsed.symbols] : [],
      actions: actionsParsed?.ok ? [...actionsParsed.actions] : [],
      historyCaveat: HISTORY_CAVEAT,
    };
  }

  async getTrend(): Promise<RspamdTrendResponse> {
    return getRspamdTrend(this.db);
  }

  private async assertSupported(): Promise<void> {
    const capabilities = await this.dmsDriver.getCapabilities();
    if (!capabilities.rspamd.supported) {
      throw new AppError(
        'CAPABILITY_UNSUPPORTED',
        capabilities.rspamd.reason ?? 'Rspamd is unsupported on this deployment.',
      );
    }
  }

  async setActionThreshold(action: string, score: number): Promise<void> {
    await this.assertSupported();
    const result = await this.client.saveActionThreshold(action, score);
    if (!result.ok) throw new AppError('UPSTREAM_UNAVAILABLE', result.error);
  }

  async setSymbolScore(symbol: string, score: number): Promise<void> {
    await this.assertSupported();
    const result = await this.client.saveSymbolScore(symbol, score);
    if (!result.ok) throw new AppError('UPSTREAM_UNAVAILABLE', result.error);
  }

  async learnSpam(message: string): Promise<void> {
    await this.assertSupported();
    const result = await this.client.learnSpam(message);
    if (!result.ok) throw new AppError('UPSTREAM_UNAVAILABLE', result.error);
  }

  async learnHam(message: string): Promise<void> {
    await this.assertSupported();
    const result = await this.client.learnHam(message);
    if (!result.ok) throw new AppError('UPSTREAM_UNAVAILABLE', result.error);
  }
}
