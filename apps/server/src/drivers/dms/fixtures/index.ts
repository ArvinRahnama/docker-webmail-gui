/**
 * Barrel for every DMS fixture. Each file carries its own provenance
 * header naming its source — see the individual files in this directory
 * and `drivers/broker/fixtures/` for the same convention.
 */
export * from './postfix-accounts.js';
export * from './postfix-virtual.js';
export * from './dovecot-quotas.js';
export * from './postfix-access.js';
export * from './env.js';
export * from './dkim.js';
