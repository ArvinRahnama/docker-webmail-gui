/**
 * Fixture provenance: **CONSTRUCTED**, following the documented Postfix
 * `access(5)` map syntax `setup email restrict add send|receive <EMAIL>`
 * writes into (`docs/research/01-docker-mailserver.md` §8) — no live
 * docker-mailserver container exists in this environment to capture a
 * literal example line from (ARCHITECTURE.md §9), unlike
 * `postfix-accounts.ts`/`postfix-virtual.ts`/`dovecot-quotas.ts`, each of
 * which could quote one confirmed upstream line.
 *
 * `sales@example.com` is restricted from sending only, deliberately not
 * receiving — so `FakeDmsDriver`'s two scopes are exercised as genuinely
 * independent state, matching `MailboxRestrictionSchema`'s `{ send,
 * receive }` shape (`@dwg/shared`'s `mail.ts`) rather than one boolean.
 */

export const FIXTURE_POSTFIX_SEND_ACCESS_CF = ['sales@example.com REJECT'].join('\n');

export const FIXTURE_POSTFIX_RECEIVE_ACCESS_CF = '';
