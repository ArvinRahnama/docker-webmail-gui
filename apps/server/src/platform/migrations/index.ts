/** The full, ordered set of known migrations. Append-only: add new migrations here, never edit or remove a past one. */
import type { Migration } from './runner.js';
import { migration001Initial } from './001_initial.js';

export const migrations: readonly Migration[] = [migration001Initial];

export { runMigrations, MigrationError, type Migration } from './runner.js';
