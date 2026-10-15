/**
 * The single-row `mcp_settings` document. Stored as JSON and re-validated
 * on every read against `McpSettingsSchema`, layered over defaults, so a
 * setting added in a later release reads its default on an upgraded install
 * instead of failing validation.
 *
 * `enabled` defaults to **false**: a fresh install and an upgraded install
 * both start with MCP switched off until the postmaster turns it on.
 */
import {
  MCP_SCOPES,
  McpSettingsSchema,
  type McpSettings,
  type McpSettingsPatch,
} from '@dwg/shared';
import type { Database } from '../platform/db.js';

export interface SettingsSeed {
  readonly publicBaseUrl: string | null;
  readonly mailHost: string;
}

export function defaultMcpSettings(seed: SettingsSeed): McpSettings {
  return {
    enabled: false,
    publicBaseUrl: seed.publicBaseUrl,
    mail: {
      imapHost: seed.mailHost,
      imapPort: 993,
      imapSecurity: 'tls',
      smtpHost: seed.mailHost,
      smtpPort: 465,
      smtpSecurity: 'tls',
      tlsServername: null,
      tlsVerify: true,
    },
    setupCredentialTtlHours: 24,
    connectionExpiryDays: null,
    defaultPermissions: [...MCP_SCOPES],
    maxConnectionsPerMailbox: 5,
    auditRetentionDays: 180,
    accessTokenTtlMinutes: 15,
    refreshTokenTtlDays: 30,
    rateLimits: {
      toolCallsPerMinute: 60,
      sendsPerHour: 20,
      sendsPerDay: 100,
      maxRecipientsPerMessage: 20,
    },
    maxAttachmentBytes: 10 * 1024 * 1024,
    saveSentCopies: true,
    clientRegistration: {
      dynamicRegistration: true,
      metadataDocuments: true,
      allowedMetadataHosts: [],
    },
  };
}

export class SettingsRepository {
  private cache: McpSettings | null = null;

  constructor(
    private readonly db: Database,
    private readonly seed: SettingsSeed,
  ) {}

  get(): McpSettings {
    if (this.cache !== null) return this.cache;
    const defaults = defaultMcpSettings(this.seed);
    const row = this.db.get<{ value: string }>('SELECT value FROM mcp_settings WHERE id = 1');
    let merged: McpSettings = defaults;
    if (row !== undefined) {
      try {
        const stored = JSON.parse(row.value) as Partial<McpSettings>;
        const candidate = { ...defaults, ...stored };
        const parsed = McpSettingsSchema.safeParse(candidate);
        // An unreadable stored document fails *closed*: defaults have
        // enabled=false, so a corrupted row disables MCP rather than
        // enabling something nobody configured.
        merged = parsed.success ? parsed.data : defaults;
      } catch {
        merged = defaults;
      }
    }
    this.cache = merged;
    return merged;
  }

  update(patch: McpSettingsPatch, nowIso: string): McpSettings {
    const next = McpSettingsSchema.parse({ ...this.get(), ...patch });
    this.db.run(
      `INSERT INTO mcp_settings (id, value, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify(next), nowIso],
    );
    this.cache = next;
    return next;
  }
}
