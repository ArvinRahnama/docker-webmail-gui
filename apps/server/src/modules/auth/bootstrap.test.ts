import { describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../platform/db.js';
import { migrations, runMigrations } from '../../platform/migrations/index.js';
import { loadConfig } from '../../platform/config.js';
import { createLogger } from '../../platform/logger.js';
import { AdminsRepository } from './admins.repository.js';
import { bootstrapFirstAdmin } from './bootstrap.js';
import { hashPassword } from './password.js';

const BOOTSTRAP_EMAIL = 'bootstrap-admin@example.com';
const BOOTSTRAP_PASSWORD = 'a-perfectly-fine-bootstrap-password';

/** Mirrors logger.test.ts's `createCapturingLogger` so log assertions read the same way across the suite. */
function createCapturingLogger() {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'warn',
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  });
  return { logger, lines };
}

function setUp() {
  const db = createDatabase(':memory:');
  runMigrations(db, migrations);
  const admins = new AdminsRepository(db);
  return { db, admins };
}

describe('bootstrapFirstAdmin — creates the first administrator', () => {
  it('creates exactly one administrator, flagged to force a password change', async () => {
    const { db, admins } = setUp();
    const { logger } = createCapturingLogger();
    const config = loadConfig({
      BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
      BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    });

    await bootstrapFirstAdmin({ db, admins, config, logger });

    expect(admins.count()).toBe(1);
    const created = admins.findByEmail(BOOTSTRAP_EMAIL);
    expect(created).toBeDefined();
    expect(created?.forcePasswordChange).toBe(true);
    expect(created?.disabled).toBe(false);
    expect(created?.role).toBe('administrator');

    db.close();
  });

  it('records an admin.bootstrap_created audit event, and never logs the password', async () => {
    const { db, admins } = setUp();
    const { logger, lines } = createCapturingLogger();
    const config = loadConfig({
      BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
      BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    });

    await bootstrapFirstAdmin({ db, admins, config, logger });

    const rows = db.all<{ action: string; details: string }>(
      'SELECT action, details FROM audit_log',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('admin.bootstrap_created');

    for (const line of lines) {
      expect(line).not.toContain(BOOTSTRAP_PASSWORD);
    }

    db.close();
  });

  it('is idempotent: a second call creates no second administrator', async () => {
    const { db, admins } = setUp();
    const { logger } = createCapturingLogger();
    const config = loadConfig({
      BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
      BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    });

    await bootstrapFirstAdmin({ db, admins, config, logger });
    await bootstrapFirstAdmin({ db, admins, config, logger });
    await bootstrapFirstAdmin({ db, admins, config, logger });

    expect(admins.count()).toBe(1);

    db.close();
  });

  it('does nothing when an administrator already exists, even if bootstrap credentials are configured', async () => {
    const { db, admins } = setUp();
    const { logger } = createCapturingLogger();
    const existing = admins.create({
      email: 'already-here@example.com',
      passwordHash: await hashPassword('whatever-existing-password'),
      role: 'administrator',
      forcePasswordChange: false,
    });
    const config = loadConfig({
      BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
      BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    });

    await bootstrapFirstAdmin({ db, admins, config, logger });

    expect(admins.count()).toBe(1);
    expect(admins.findByEmail(BOOTSTRAP_EMAIL)).toBeUndefined();
    expect(admins.findById(existing.id)).toBeDefined();

    db.close();
  });
});

describe('bootstrapFirstAdmin — refuses to invent a known account', () => {
  it('creates no administrator and logs a clear, actionable message when nothing is configured', async () => {
    const { db, admins } = setUp();
    const { logger, lines } = createCapturingLogger();
    const config = loadConfig({});

    await bootstrapFirstAdmin({ db, admins, config, logger });

    expect(admins.count()).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('BOOTSTRAP_ADMIN_EMAIL');
    expect(lines[0]).toContain('BOOTSTRAP_ADMIN_PASSWORD');

    db.close();
  });

  it('creates no administrator when the configured password fails the password policy', async () => {
    const { db, admins } = setUp();
    const { logger, lines } = createCapturingLogger();
    const config = loadConfig({
      BOOTSTRAP_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
      // Below PASSWORD_MIN_LENGTH (12).
      BOOTSTRAP_ADMIN_PASSWORD: 'short',
    });

    await bootstrapFirstAdmin({ db, admins, config, logger });

    expect(admins.count()).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('BOOTSTRAP_ADMIN_PASSWORD');
    // The message explains what's wrong without echoing the secret itself.
    expect(lines[0]).not.toContain('short');

    db.close();
  });

  it('never creates a hardcoded or default account under any configuration', async () => {
    const { db, admins }: { db: Database; admins: AdminsRepository } = setUp();
    const { logger } = createCapturingLogger();
    const config = loadConfig({});

    await bootstrapFirstAdmin({ db, admins, config, logger });

    expect(admins.list()).toEqual([]);

    db.close();
  });
});
