/**
 * Barrel for every DMS config-file parser (`docs/research/01-docker-mailserver.md`
 * §6). See `parse-result.ts` for the shared `ParseResult`/`ParseIssue`
 * shape every parser here returns.
 */
export type { ParseIssue, ParseResult } from './parse-result.js';
export {
  isBlankOrComment,
  splitAliasAddress,
  splitEmailAddress,
  splitLines,
  type SplitAddress,
} from './shared.js';
export { parsePostfixAccounts, type PostfixAccountEntry } from './postfix-accounts.js';
export { parsePostfixVirtual, type PostfixVirtualEntry } from './postfix-virtual.js';
export { parseDovecotQuotas, type DovecotQuotaEntry } from './dovecot-quotas.js';
