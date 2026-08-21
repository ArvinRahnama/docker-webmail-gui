/**
 * @dwg/shared
 *
 * Home for the Zod schemas, DTO types, constants and error codes shared by
 * `apps/server`, `apps/broker` and `apps/web` — per ARCHITECTURE.md §3, the
 * *same* schema artifact backs both runtime validation and static types, so
 * contract drift between the API and its consumers becomes a compile error
 * instead of a runtime surprise.
 */

export * from './version.js';
export * from './errors.js';
export * from './api.js';
export * from './auth.js';
export * from './broker.js';
export * from './mail.js';
export * from './security.js';
export * from './antispam.js';
export * from './sieve.js';
export * from './docker.js';
export * from './jobs.js';
export * from './backups.js';
export * from './config-editor.js';
