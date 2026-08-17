/**
 * Deterministic, in-memory {@link RspamdClientPort} — the development
 * default and every Rspamd module test's double, mirroring
 * `drivers/dns/fake-resolver.ts`. Opens no socket. Learn/save calls are
 * recorded (not just validated) so a caller can assert on exactly what
 * was "trained"/"saved" without needing a real controller.
 */
import { FIXTURE_RSPAMD_ACTIONS, FIXTURE_RSPAMD_STAT, FIXTURE_RSPAMD_SYMBOLS } from './fixtures.js';
import type { RspamdClientPort, RspamdResult } from './types.js';

export interface RecordedLearn {
  readonly message: string;
}

export interface RecordedThreshold {
  readonly action: string;
  readonly score: number;
}

export interface RecordedSymbolScore {
  readonly symbol: string;
  readonly score: number;
}

export class FakeRspamdClient implements RspamdClientPort {
  private statValue: unknown = FIXTURE_RSPAMD_STAT;
  private symbolsValue: unknown = FIXTURE_RSPAMD_SYMBOLS;
  private actionsValue: unknown = FIXTURE_RSPAMD_ACTIONS;
  private unreachableError: string | null = null;

  readonly learnedSpam: RecordedLearn[] = [];
  readonly learnedHam: RecordedLearn[] = [];
  readonly savedThresholds: RecordedThreshold[] = [];
  readonly savedSymbolScores: RecordedSymbolScore[] = [];

  setStat(value: unknown): this {
    this.statValue = value;
    return this;
  }

  setSymbols(value: unknown): this {
    this.symbolsValue = value;
    return this;
  }

  setActionsResponse(value: unknown): this {
    this.actionsValue = value;
    return this;
  }

  /** Makes every call fail with `error`, simulating an unreachable/misconfigured controller. */
  setUnreachable(error: string): this {
    this.unreachableError = error;
    return this;
  }

  private guard<T>(value: T): RspamdResult<T> {
    if (this.unreachableError !== null) return { ok: false, error: this.unreachableError };
    return { ok: true, value };
  }

  async getStat(): Promise<RspamdResult<unknown>> {
    return this.guard(this.statValue);
  }

  async getSymbols(): Promise<RspamdResult<unknown>> {
    return this.guard(this.symbolsValue);
  }

  async getActions(): Promise<RspamdResult<unknown>> {
    return this.guard(this.actionsValue);
  }

  async learnSpam(message: string): Promise<RspamdResult<void>> {
    const guarded = this.guard(undefined);
    if (guarded.ok) this.learnedSpam.push({ message });
    return guarded;
  }

  async learnHam(message: string): Promise<RspamdResult<void>> {
    const guarded = this.guard(undefined);
    if (guarded.ok) this.learnedHam.push({ message });
    return guarded;
  }

  async saveActionThreshold(action: string, score: number): Promise<RspamdResult<void>> {
    const guarded = this.guard(undefined);
    if (guarded.ok) this.savedThresholds.push({ action, score });
    return guarded;
  }

  async saveSymbolScore(symbol: string, score: number): Promise<RspamdResult<void>> {
    const guarded = this.guard(undefined);
    if (guarded.ok) this.savedSymbolScores.push({ symbol, score });
    return guarded;
  }
}
