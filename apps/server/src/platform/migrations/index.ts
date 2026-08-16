/** The full, ordered set of known migrations. Append-only: add new migrations here, never edit or remove a past one. */
import type { Migration } from './runner.js';
import { migration001Initial } from './001_initial.js';
import { migration002Auth } from './002_auth.js';

export const migrations: readonly Migration[] = [migration001Initial, migration002Auth];

export { runMigrations, MigrationError, type Migration } from './runner.js';
