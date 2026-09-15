import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../platform/config.js';
import { ConfigRepository } from './config.repository.js';
import { filterStartupOverrides } from './settings-allowlist.js';
import { authedInject, loginAs, setUpConfigApp } from './config-test-harness.js';

describe('/api/v1/config', () => {
  it('requires authentication', async () => {
    const { app } = await setUpConfigApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/config/settings' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('lists every allowlisted setting with secrets masked', async () => {
    const { app } = await setUpConfigApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/config/settings',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      settings: { key: string; secret: boolean; masked: boolean; value: string | null }[];
    };
    expect(body.settings.length).toBeGreaterThan(0);

    const secretSetting = body.settings.find((s) => s.secret);
    expect(secretSetting).toBeDefined();
    expect(secretSetting?.masked).toBe(true);
    expect(secretSetting?.value).toBeNull();

    const nonSecretSetting = body.settings.find((s) => !s.secret);
    expect(nonSecretSetting?.masked).toBe(false);
    expect(nonSecretSetting?.value).not.toBeNull();
    await app.close();
  });

  it('reveals a secret value and writes an audit row', async () => {
    const { app, db } = await setUpConfigApp({}, { RSPAMD_PASSWORD: 'super-secret-value' });
    const auth = await loginAs(app);

    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/config/settings/RSPAMD_PASSWORD/reveal',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { key: string; value: string | null };
    expect(body.key).toBe('RSPAMD_PASSWORD');
    expect(body.value).toBe('super-secret-value');

    const rows = db.all<{ action: string; target: string }>(
      "SELECT action, target FROM audit_log WHERE action = 'config.reveal_secret'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe('setting:RSPAMD_PASSWORD');
    await app.close();
  });

  it('refuses to reveal a non-secret setting', async () => {
    const { app } = await setUpConfigApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/config/settings/LOG_LEVEL/reveal',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('404s revealing an unknown key', async () => {
    const { app } = await setUpConfigApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/config/settings/NOT_A_REAL_KEY/reveal',
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  describe('validate — the allowlist gate', () => {
    it('rejects a key outside the allowlist', async () => {
      const { app } = await setUpConfigApp();
      const auth = await loginAs(app);
      const response = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/validate',
        payload: { changes: { NOT_A_REAL_SETTING: 'anything' } },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { valid: boolean; changes: { allowed: boolean }[] };
      expect(body.valid).toBe(false);
      expect(body.changes[0]?.allowed).toBe(false);
      await app.close();
    });

    it('rejects a read-only key', async () => {
      const { app } = await setUpConfigApp();
      const auth = await loginAs(app);
      const response = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/validate',
        payload: { changes: { DMS_CONTAINER_NAME: 'something-else' } },
      });
      const body = response.json() as {
        valid: boolean;
        changes: { allowed: boolean; classification: string }[];
      };
      expect(body.valid).toBe(false);
      expect(body.changes[0]?.allowed).toBe(false);
      expect(body.changes[0]?.classification).toBe('read-only');
      await app.close();
    });

    it('allows an editable key and reports its impact classification', async () => {
      const { app } = await setUpConfigApp();
      const auth = await loginAs(app);
      const response = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/validate',
        payload: { changes: { LOG_LEVEL: 'debug' } },
      });
      const body = response.json() as { valid: boolean; highestImpact: string };
      expect(body.valid).toBe(true);
      expect(body.highestImpact).toBe('needs-restart');
      await app.close();
    });
  });

  describe('apply', () => {
    it('rejects without confirm: true', async () => {
      const { app } = await setUpConfigApp();
      const auth = await loginAs(app);
      const response = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/apply',
        payload: { changes: { LOG_LEVEL: 'debug' } },
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it('rejects a path outside the allowlist and applies nothing (whole set refused, never partial)', async () => {
      const { app, db } = await setUpConfigApp();
      const auth = await loginAs(app);
      const response = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/apply',
        payload: { changes: { LOG_LEVEL: 'debug', NOT_A_REAL_SETTING: 'x' }, confirm: true },
      });
      expect(response.statusCode).toBe(400);

      const rows = db.all('SELECT * FROM settings');
      expect(rows).toHaveLength(0);
      await app.close();
    });

    it('applies an editable change, persists it, and audits keys but never the value', async () => {
      const { app, db } = await setUpConfigApp();
      const auth = await loginAs(app);
      const response = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/apply',
        payload: { changes: { LOG_LEVEL: 'debug' }, confirm: true },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { applied: string[]; snapshotId: string };
      expect(body.applied).toEqual(['LOG_LEVEL']);
      expect(body.snapshotId).toBeTruthy();

      const settingsRows = db.all<{ key: string; value: string }>('SELECT * FROM settings');
      expect(settingsRows).toHaveLength(1);
      expect(settingsRows[0]).toMatchObject({ key: 'LOG_LEVEL', value: 'debug' });

      const auditRows = db.all<{ details: string }>(
        "SELECT details FROM audit_log WHERE action = 'config.apply'",
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.details).toContain('LOG_LEVEL');
      expect(auditRows[0]?.details).not.toContain('debug');

      const snapshotRows = db.all('SELECT * FROM config_snapshots');
      expect(snapshotRows).toHaveLength(1);
      await app.close();
    });

    it('never writes a secret value into the audit log details', async () => {
      const { app, db } = await setUpConfigApp({}, { RSPAMD_PASSWORD: 'original-secret' });
      const auth = await loginAs(app);
      await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/apply',
        payload: { changes: { RSPAMD_PASSWORD: 'brand-new-secret-value' }, confirm: true },
      });

      const auditRows = db.all<{ details: string }>(
        "SELECT details FROM audit_log WHERE action = 'config.apply'",
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.details).not.toContain('brand-new-secret-value');
      expect(auditRows[0]?.details).not.toContain('original-secret');
      await app.close();
    });
  });

  describe('snapshots + rollback', () => {
    it('lists snapshots without leaking values', async () => {
      const { app } = await setUpConfigApp();
      const auth = await loginAs(app);
      await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/apply',
        payload: { changes: { LOG_LEVEL: 'debug' }, confirm: true },
      });

      const response = await authedInject(app, auth, {
        method: 'GET',
        url: '/api/v1/config/snapshots',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { snapshots: Record<string, unknown>[] };
      expect(body.snapshots).toHaveLength(1);
      expect(body.snapshots[0]).not.toHaveProperty('values');
      await app.close();
    });

    it('rolling back restores the pre-change value', async () => {
      const { app, db } = await setUpConfigApp();
      const auth = await loginAs(app);

      const firstApply = (
        await authedInject(app, auth, {
          method: 'POST',
          url: '/api/v1/config/apply',
          payload: { changes: { LOG_LEVEL: 'debug' }, confirm: true },
        })
      ).json() as { snapshotId: string };

      // Snapshot taken by the *first* apply captures the state from
      // before LOG_LEVEL was ever overridden — rolling back to it should
      // remove the override rather than merely changing its value.
      const rollbackResponse = await authedInject(app, auth, {
        method: 'POST',
        url: `/api/v1/config/snapshots/${firstApply.snapshotId}/rollback`,
        payload: { confirm: true },
      });
      expect(rollbackResponse.statusCode).toBe(200);

      const settingsRows = db.all<{ key: string; value: string }>(
        "SELECT * FROM settings WHERE key = 'LOG_LEVEL'",
      );
      // The pre-change snapshot had no LOG_LEVEL override at all (the
      // environment default was in effect), so rollback either removes
      // the row or restores it to the environment default — either way,
      // it must not still read 'debug'.
      expect(settingsRows.every((row) => row.value !== 'debug')).toBe(true);
      await app.close();
    });

    it('404s rolling back an unknown snapshot', async () => {
      const { app } = await setUpConfigApp();
      const auth = await loginAs(app);
      const response = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/snapshots/cfs_does_not_exist/rollback',
        payload: { confirm: true },
      });
      expect(response.statusCode).toBe(404);
      await app.close();
    });
  });

  // Regression coverage for the bug this milestone fixes: applying a
  // change persisted it, but nothing ever read it back at process start,
  // so a restart silently reverted to the environment/compose default.
  describe('overrides actually take effect on the next process start', () => {
    it('a value applied through /apply is what index.ts-style startup (loadConfig + filterStartupOverrides) would load', async () => {
      const { app, db } = await setUpConfigApp();
      const auth = await loginAs(app);

      const applyResponse = await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/apply',
        payload: { changes: { ENABLE_EXEC_CONSOLE: 'true' }, confirm: true },
      });
      expect(applyResponse.statusCode).toBe(200);

      // Mirrors index.ts's own two-pass load: filter the persisted
      // overrides down to what startup may honour, then fold them onto
      // a fresh environment the same way a real restart would.
      const overrides = filterStartupOverrides(new ConfigRepository(db).getAllOverrides());
      const reloaded = loadConfig({}, overrides);
      expect(reloaded.enableExecConsole).toBe(true);

      await app.close();
    });

    it('/settings shows the saved value as pendingValue while the value still running is the old one', async () => {
      const { app } = await setUpConfigApp();
      const auth = await loginAs(app);

      await authedInject(app, auth, {
        method: 'POST',
        url: '/api/v1/config/apply',
        payload: { changes: { ENABLE_EXEC_CONSOLE: 'true' }, confirm: true },
      });

      const response = await authedInject(app, auth, {
        method: 'GET',
        url: '/api/v1/config/settings',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        settings: { key: string; value: string | null; pendingValue: string | null }[];
      };
      const setting = body.settings.find((s) => s.key === 'ENABLE_EXEC_CONSOLE');
      // This test harness's server process was never restarted, so the
      // *running* AppConfig still reflects the environment default —
      // only the saved/pending value should show the applied change.
      expect(setting?.value).toBe('false');
      expect(setting?.pendingValue).toBe('true');

      await app.close();
    });

    it('an override for a read-only key is never honoured at startup, even if one were somehow persisted', async () => {
      const { db } = await setUpConfigApp();
      const now = new Date().toISOString();
      new ConfigRepository(db).setOverride('DMS_CONTAINER_NAME', 'a-different-container', now);

      const overrides = filterStartupOverrides(new ConfigRepository(db).getAllOverrides());
      expect(overrides).not.toHaveProperty('DMS_CONTAINER_NAME');

      const reloaded = loadConfig({}, overrides);
      expect(reloaded.dms.containerName).toBe('mailserver');
    });
  });
});
