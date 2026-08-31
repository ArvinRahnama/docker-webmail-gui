/** The full, ordered set of known migrations. Append-only: add new migrations here, never edit or remove a past one. */
import type { Migration } from './runner.js';
import { migration001Initial } from './001_initial.js';
import { migration002Auth } from './002_auth.js';
import { migration003AdminDelete } from './003_admin_delete.js';
import { migration004Maintenance } from './004_maintenance.js';
import { migration005BackupSchedule } from './005_backup_schedule.js';

export const migrations: readonly Migration[] = [
  migration001Initial,
  migration002Auth,
  migration003AdminDelete,
  migration004Maintenance,
  migration005BackupSchedule,
];

export { runMigrations, MigrationError, type Migration } from './runner.js';
