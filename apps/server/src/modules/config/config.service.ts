/**
 * The config editor's fixed flow (M10 — FEATURE_MATRIX.md §28-29: "Flow
 * is fixed: validate -> diff -> explain consequences -> confirm -> apply
 * -> verify -> audit"). `validate` and `apply` share one allowlist check
 * (`validateChangeSet`) so the two can never silently disagree about what
 * is allowed; `apply` re-runs it server-side rather than trusting a
 * client's earlier `validate` call, and refuses the *entire* change set
 * wholesale on any single disallowed key — never a partial apply.
 *
 * Confirm/audit are not this file's job: `config.routes.ts` owns the
 * Tier-appropriate confirm gate (`ApplyConfigRequestSchema`'s
 * `confirm: true`) and every audit write, matching how every other module
 * in this codebase keeps HTTP-adjacent concerns out of its service layer.
 */
import type {
  ApplyConfigResponse,
  ConfigChangeSet,
  ConfigChangeValidation,
  ConfigSettingClassification,
  ConfigSettingsResponse,
  ConfigSnapshotSummary,
  RevealSettingResponse,
  ValidateConfigResponse,
} from '@dwg/shared';
import type { AppConfig } from '../../platform/config.js';
import type { Database } from '../../platform/db.js';
import { AppError } from '../../platform/errors.js';
import type { ConfigRepository } from './config.repository.js';
import {
  SETTINGS_ALLOWLIST,
  describeSetting,
  findSettingDefinition,
} from './settings-allowlist.js';

export interface ConfigActor {
  readonly adminId: string | null;
  readonly label: string;
}

/** `needs-recreate` > `needs-restart` > `editable-live` — never actually reached above `needs-restart` today (no allowlist entry is `needs-recreate`; see that file's header), but ranked completely so the comparison stays correct if one is ever added. */
const IMPACT_RANK: Readonly<Record<ConfigSettingClassification, number>> = {
  'read-only': -1,
  'editable-live': 0,
  'needs-restart': 1,
  'needs-recreate': 2,
};

function computeHighestImpact(
  classifications: readonly ConfigSettingClassification[],
): ConfigSettingClassification | null {
  if (classifications.length === 0) return null;
  return classifications.reduce((highest, current) =>
    IMPACT_RANK[current] > IMPACT_RANK[highest] ? current : highest,
  );
}

export class ConfigService {
  constructor(
    private readonly repository: ConfigRepository,
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /** Every allowlisted setting's *currently running* value — secrets masked. */
  describe(): ConfigSettingsResponse {
    return {
      settings: SETTINGS_ALLOWLIST.map((definition) =>
        describeSetting(definition, this.config, false),
      ),
    };
  }

  /** The unmasked value of one secret setting — callers (`config.routes.ts`) must audit this call themselves; see this file's header for why that discipline lives at the route layer. */
  reveal(key: string): RevealSettingResponse {
    const definition = findSettingDefinition(key);
    if (definition === null) {
      throw new AppError('NOT_FOUND', `${key} is not an editable setting.`);
    }
    if (!definition.secret) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${key} is not a secret; its value is already visible.`,
      );
    }
    const described = describeSetting(definition, this.config, true);
    return { key, value: described.value };
  }

  /** Validate + diff + impact, all in one response — see this file's header for why `apply` cannot skip re-running this. */
  validate(changes: ConfigChangeSet): ValidateConfigResponse {
    const results: ConfigChangeValidation[] = Object.entries(changes).map(
      ([key, proposedValue]) => {
        const definition = findSettingDefinition(key);
        if (definition === null) {
          return {
            key,
            allowed: false,
            reason: `${key} is not an editable setting.`,
            classification: null,
            currentValue: null,
            proposedValue,
          };
        }
        // A secret's *current* value never appears in a diff preview,
        // matching "secrets are masked" everywhere except the explicit,
        // audited reveal endpoint — `proposedValue` is safe to echo as-is
        // because it is only ever the caller's own just-typed input.
        const currentValue = definition.secret ? null : definition.getValue(this.config);
        if (definition.classification === 'read-only') {
          return {
            key,
            allowed: false,
            reason: definition.description,
            classification: 'read-only',
            currentValue,
            proposedValue,
          };
        }
        return {
          key,
          allowed: true,
          reason: null,
          classification: definition.classification,
          currentValue,
          proposedValue,
        };
      },
    );

    const allowedClassifications = results
      .filter((result) => result.allowed && result.classification !== null)
      .map((result) => result.classification!);

    return {
      valid: results.every((result) => result.allowed),
      changes: results,
      highestImpact: computeHighestImpact(allowedClassifications),
    };
  }

  /**
   * Snapshots the full current allowlisted state, then persists every
   * changed key into the `settings` table and reads each one back to
   * confirm it stuck — the "verify" step the milestone's flow names
   * explicitly. Refuses the whole set (never applies a subset) if
   * `validate` finds even one disallowed key.
   *
   * **Honesty boundary, stated here because it is easy to miss:** this
   * persists the admin's intent durably and audibly. It does not, and
   * does not claim to, change this running process's behaviour — every
   * editable setting here is `needs-restart` (`settings-allowlist.ts`'s
   * header explains why `editable-live` has no entry yet), so the caller
   * (`config.routes.ts`) is responsible for telling the admin a restart
   * is required, not this method pretending otherwise.
   */
  apply(changes: ConfigChangeSet, actor: ConfigActor): ApplyConfigResponse {
    const validation = this.validate(changes);
    if (!validation.valid) {
      throw new AppError(
        'VALIDATION_FAILED',
        'One or more settings in this change set are not editable — no changes were applied.',
        {
          details: validation.changes
            .filter((change) => !change.allowed)
            .map((change) => ({ key: change.key, reason: change.reason })),
        },
      );
    }

    const currentValues: Record<string, string> = {};
    for (const definition of SETTINGS_ALLOWLIST) {
      const value = definition.getValue(this.config);
      if (value !== null) currentValues[definition.key] = value;
    }
    const snapshotId = this.repository.insertSnapshot({
      createdByAdminId: actor.adminId,
      createdByLabel: actor.label,
      values: currentValues,
    });

    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(changes)) {
        this.repository.setOverride(key, value, now);
      }
    });

    for (const [key, value] of Object.entries(changes)) {
      const stored = this.repository.getOverride(key);
      if (stored !== value) {
        throw new AppError(
          'INTERNAL',
          `Failed to persist ${key}: the value read back after writing did not match what was applied.`,
        );
      }
    }

    return { applied: Object.keys(changes).sort(), snapshotId };
  }

  /** Identity/provenance only — never `values` (see `ConfigSnapshotSchema`'s doc comment, `@dwg/shared`). */
  listSnapshots(): readonly ConfigSnapshotSummary[] {
    return this.repository.listSnapshots().map((snapshot) => ({
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      createdByAdminId: snapshot.createdByAdminId,
      createdByLabel: snapshot.createdByLabel,
    }));
  }

  /** Re-applies a prior snapshot's editable values through the exact same validate/snapshot/apply/verify pipeline — a rollback is itself a config change, and gets its own pre-change snapshot and audit row for the same reason. Read-only keys in the snapshot (captured for the historical record, e.g. `DMS_CONTAINER_NAME`) are silently skipped rather than causing the whole rollback to be refused. */
  rollback(snapshotId: string, actor: ConfigActor): ApplyConfigResponse {
    const snapshot = this.repository.getSnapshotById(snapshotId);
    if (snapshot === null) {
      throw new AppError('NOT_FOUND', `No config snapshot with id ${snapshotId}.`);
    }
    const editableValues: ConfigChangeSet = {};
    for (const [key, value] of Object.entries(snapshot.values)) {
      const definition = findSettingDefinition(key);
      if (definition !== null && definition.classification !== 'read-only') {
        editableValues[key] = value;
      }
    }
    return this.apply(editableValues, actor);
  }
}
