/**
 * `apps/server/src/drivers/rspamd` — Rspamd controller driver (M8;
 * FEATURE_MATRIX.md §13-15). Mirrors `drivers/dns/index.ts`'s shape.
 */
export type { RspamdClientPort, RspamdResult } from './types.js';
export { RealRspamdClient, createRealRspamdClient } from './real-client.js';
export { FakeRspamdClient } from './fake-client.js';
export { createRspamdClient } from './create-client.js';
export { parseRspamdStat } from './parse-stat.js';
export { parseRspamdSymbols, type RspamdSymbolsParseResult } from './parse-symbols.js';
export { parseRspamdActions, type RspamdActionsParseResult } from './parse-actions.js';
