/**
 * First-administrator bootstrap (M3 — ARCHITECTURE.md §7.3; SECURITY.md
 * "no default credentials").
 *
 * No default password ever ships. The *only* way an initial account
 * comes into existence is via `BOOTSTRAP_ADMIN_EMAIL`/
 * `BOOTSTRAP_ADMIN_PASSWORD`, applied once at startup and only when no
 * administrator row exists yet. When neither condition is met — no admin,
 * no configured credential — this deliberately leaves the system with no
 * administrator rather than inventing one: a known/guessable account is a
 * worse failure mode than an install that needs an operator to set
 * `BOOTSTRAP_ADMIN_EMAIL`/`PASSWORD` and restart.
 */
import type { Logger } from 'pino';
import { NewPasswordSchema } from '@dwg/shared';
import type { AppConfig } from '../../platform/config.js';
import type { Database } from '../../platform/db.js';
import { recordAuditEvent } from '../../platform/audit.js';
import { AdminsRepository, type AdminRow } from './admins.repository.js';
import { hashPassword } from './password.js';

export interface BootstrapDeps {
  readonly db: Database;
  readonly admins: AdminsRepository;
  readonly config: AppConfig;
  readonly logger: Logger;
}

const NO_ADMIN_NO_CONFIG_MESSAGE =
  'No administrator account exists and BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are not set. ' +
  'The application has no way to authenticate anyone until an administrator is created. ' +
  'Set both variables (see .env.example) and restart. Refusing to auto-create a known account.';

/**
 * Creates the first administrator if, and only if, none exists yet.
 * Idempotent — a no-op on every call once any admin row exists (including
 * one created by a previous call), so it is safe to invoke unconditionally
 * on every startup.
 */
export async function bootstrapFirstAdmin(deps: BootstrapDeps): Promise<void> {
  const { db, admins, config, logger } = deps;

  if (admins.count() > 0) {
    return;
  }

  const { email, password } = config.bootstrapAdmin;
  if (email === null || password === null) {
    // config.ts's superRefine already guarantees these are set together or
    // not at all, so "one without the other" cannot reach here — this is
    // squarely the "neither configured" case.
    logger.error(NO_ADMIN_NO_CONFIG_MESSAGE);
    return;
  }

  const policyCheck = NewPasswordSchema.safeParse(password);
  if (!policyCheck.success) {
    // Same refusal as the "not configured" case, for the same reason: a
    // policy-violating bootstrap credential is not something to silently
    // accept or silently weaken. The message never echoes the password
    // itself (config.ts's own rule for secrets), only what is wrong with it.
    logger.error(
      `BOOTSTRAP_ADMIN_PASSWORD does not meet the password policy: ${policyCheck.error.issues
        .map((issue) => issue.message)
        .join('; ')}. Fix it and restart — no administrator has been created.`,
    );
    return;
  }

  const passwordHash = await hashPassword(password);

  // hashPassword is the only async step in this function; everything
  // before and after it is synchronous, so re-checking the count inside
  // this transaction (rather than trusting the check above) is what
  // actually rules out a second bootstrap call racing this one in that
  // async gap, instead of merely making it look ruled out.
  const created: AdminRow | null = db.transaction(() => {
    if (admins.count() > 0) {
      return null;
    }

    const admin = admins.create({
      email,
      passwordHash,
      role: 'administrator',
      forcePasswordChange: true,
    });

    recordAuditEvent(db, {
      actor: { adminId: admin.id, label: admin.email },
      action: 'admin.bootstrap_created',
      target: { type: 'admin', id: admin.id },
      result: 'success',
      ip: null,
      userAgent: null,
    });

    return admin;
  });

  if (created === null) {
    return;
  }

  logger.warn(
    `Created initial administrator ${created.email}. It must change its password on first login.`,
  );
}
