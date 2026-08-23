import { describe, expect, it, vi } from 'vitest';
import { RealDmsDriver } from './real-dms-driver.js';
import { DmsCommandExecutionError, DmsCommandValidationError } from './errors.js';
import type { DmsConfigFileKey, DmsExecResponse } from '@dwg/shared';
import type { DmsCommandRequest, DmsExecPort } from './exec-port.js';

/**
 * A hand-written, in-memory `DmsExecPort`.
 *
 * What it records changed with M16, and the change is the point. It used
 * to capture the **argv** `RealDmsDriver` had assembled, because the
 * driver assembled one. The driver now sends a *named operation with
 * typed parameters* and the broker decides what argv that means, so this
 * records operation bodies — which is a better subject anyway: it asserts
 * the intent the web tier expressed, and the argv that intent produces is
 * asserted where it is now built, in `apps/broker/src/dms/`.
 */
class RecordingExecPort implements DmsExecPort {
  readonly execCalls: DmsCommandRequest[] = [];
  files = new Map<DmsConfigFileKey, string | null>();
  dkimFiles = new Map<string, string | null>();
  env: Readonly<Record<string, string>> = {};
  nextExecResult: DmsExecResponse = { stdout: '', stderr: '', exitCode: 0 };

  async readFile(file: DmsConfigFileKey): Promise<string | null> {
    return this.files.get(file) ?? null;
  }

  async runCommand(request: DmsCommandRequest): Promise<DmsExecResponse> {
    this.execCalls.push(request);
    return this.nextExecResult;
  }

  async readEnv(): Promise<Readonly<Record<string, string>>> {
    return this.env;
  }

  async readDkimRecord(domain: string, selector: string): Promise<string | null> {
    return this.dkimFiles.get(`${domain}::${selector}`) ?? null;
  }
}

describe('RealDmsDriver — reads parse files via the exec port, never invoke setup', () => {
  it('listMailboxes parses postfix-accounts.cf content from readFile', async () => {
    const port = new RecordingExecPort();
    port.files.set('postfix-accounts', 'user@example.com|{SHA512-CRYPT}$6$aaa');
    const driver = new RealDmsDriver(port);

    const result = await driver.listMailboxes();
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.email).toBe('user@example.com');
    expect(port.execCalls).toEqual([]);
  });

  it('listMailboxes treats a missing file (readFile returns null) as empty, not an error', async () => {
    const port = new RecordingExecPort();
    const driver = new RealDmsDriver(port);
    const result = await driver.listMailboxes();
    expect(result).toEqual({ entries: [], issues: [] });
  });

  it('listAliases parses postfix-virtual.cf content', async () => {
    const port = new RecordingExecPort();
    port.files.set('postfix-virtual', 'alias@example.com target@example.com');
    const driver = new RealDmsDriver(port);
    const result = await driver.listAliases();
    expect(result.entries).toHaveLength(1);
  });

  it('listQuotas parses dovecot-quotas.cf content', async () => {
    const port = new RecordingExecPort();
    port.files.set('dovecot-quotas', 'user@example.com:50M');
    const driver = new RealDmsDriver(port);
    const result = await driver.listQuotas();
    expect(result.entries).toHaveLength(1);
  });

  it('listDomains derives from both files read through the port', async () => {
    const port = new RecordingExecPort();
    port.files.set('postfix-accounts', 'user@mailboxdomain.tld|{SHA512-CRYPT}$6$aaa');
    port.files.set('postfix-virtual', '@aliasonlydomain.tld dump@mailboxdomain.tld');
    const driver = new RealDmsDriver(port);

    const domains = await driver.listDomains();
    expect(domains.map((d) => d.domain).sort()).toEqual([
      'aliasonlydomain.tld',
      'mailboxdomain.tld',
    ]);
  });

  it('getCapabilities reads the env through the port and runs it through detectCapabilities', async () => {
    const port = new RecordingExecPort();
    port.env = { ENABLE_QUOTAS: '0', ACCOUNT_PROVISIONER: 'LDAP' };
    const driver = new RealDmsDriver(port);

    const capabilities = await driver.getCapabilities();
    expect(capabilities.quotas.supported).toBe(false);
    expect(capabilities.accountProvisioner).toBe('LDAP');
    expect(capabilities.localAccountManagement.supported).toBe(false);
  });

  it('getDkimRecord reports not-generated when the exec port has no file for this domain/selector', async () => {
    const port = new RecordingExecPort();
    const driver = new RealDmsDriver(port);

    const result = await driver.getDkimRecord('example.com', 'mail');
    expect(result).toEqual({ ok: false, reason: 'not-generated' });
  });

  it('getDkimRecord parses a real zone-file body read through the port into a public record only', async () => {
    const port = new RecordingExecPort();
    port.dkimFiles.set(
      'example.com::mail',
      'mail._domainkey\tIN\tTXT\t( "v=DKIM1; h=sha256; k=rsa; " "p=ABC123" )  ; ----- DKIM key mail for example.com',
    );
    const driver = new RealDmsDriver(port);

    const result = await driver.getDkimRecord('example.com', 'mail');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record).toEqual({
        name: 'mail._domainkey.example.com',
        value: 'v=DKIM1; h=sha256; k=rsa; p=ABC123',
      });
      expect(Object.keys(result.record)).not.toContain('privateKey');
    }
  });

  it('getDkimRecord reports unparseable rather than throwing on unexpected file content', async () => {
    const port = new RecordingExecPort();
    port.dkimFiles.set('example.com::mail', 'not a zone file');
    const driver = new RealDmsDriver(port);

    const result = await driver.getDkimRecord('example.com', 'mail');
    expect(result).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('fail2banList runs "setup fail2ban" and parses IPs from stdout', async () => {
    const port = new RecordingExecPort();
    port.nextExecResult = { stdout: 'Banned: 203.0.113.5\n', stderr: '', exitCode: 0 };
    const driver = new RealDmsDriver(port);

    const result = await driver.fail2banList();
    expect(result.bannedIps).toEqual(['203.0.113.5']);
    expect(port.execCalls[0]).toEqual({ operation: 'dms.fail2ban.list' });
  });

  it('fail2banStatus runs "setup fail2ban status" and returns raw stdout', async () => {
    const port = new RecordingExecPort();
    port.nextExecResult = { stdout: 'Status\n|- Number of jail:\t2\n', stderr: '', exitCode: 0 };
    const driver = new RealDmsDriver(port);

    const result = await driver.fail2banStatus();
    expect(result).toBe('Status\n|- Number of jail:\t2\n');
    expect(port.execCalls[0]).toEqual({ operation: 'dms.fail2ban.status' });
  });

  it('fail2ban reads surface a non-zero exit as DmsCommandExecutionError, same as writes', async () => {
    const port = new RecordingExecPort();
    port.nextExecResult = { stdout: '', stderr: 'boom', exitCode: 1 };
    const driver = new RealDmsDriver(port);

    await expect(driver.fail2banList()).rejects.toBeInstanceOf(DmsCommandExecutionError);
  });

  it('getMailQueue runs "postqueue -j" and parses JSON-Lines stdout', async () => {
    const port = new RecordingExecPort();
    port.nextExecResult = {
      stdout: JSON.stringify({
        queue_name: 'deferred',
        queue_id: 'abc123',
        arrival_time: 1,
        message_size: 10,
        sender: 'a@example.com',
        recipients: [{ address: 'b@example.com' }],
      }),
      stderr: '',
      exitCode: 0,
    };
    const driver = new RealDmsDriver(port);

    const result = await driver.getMailQueue();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.queueName).toBe('deferred');
    expect(port.execCalls[0]).toEqual({ operation: 'dms.queue.list' });
  });

  it('getMailQueue surfaces a non-zero exit as DmsCommandExecutionError', async () => {
    const port = new RecordingExecPort();
    port.nextExecResult = { stdout: '', stderr: 'postqueue: not found', exitCode: 127 };
    const driver = new RealDmsDriver(port);

    await expect(driver.getMailQueue()).rejects.toBeInstanceOf(DmsCommandExecutionError);
  });
});

describe('RealDmsDriver — writes validate before ever calling exec', () => {
  it('an invalid addMailbox call never reaches the exec port', async () => {
    const port = new RecordingExecPort();
    const driver = new RealDmsDriver(port);

    await expect(
      driver.addMailbox({ email: 'not-an-email', password: 'x' }),
    ).rejects.toBeInstanceOf(DmsCommandValidationError);
    expect(port.execCalls).toEqual([]);
  });

  it('a valid addMailbox call sends the named operation, with the password as a typed field and no command line anywhere', async () => {
    const port = new RecordingExecPort();
    const driver = new RealDmsDriver(port);

    await driver.addMailbox({ email: 'user@example.com', password: 'hunter2pass' });

    expect(port.execCalls).toHaveLength(1);
    expect(port.execCalls[0]).toEqual({
      operation: 'dms.email.add',
      email: 'user@example.com',
      password: 'hunter2pass',
    });
    // The whole M16 property, asserted from the web tier's side: what
    // crosses the boundary is an intent. Turning the password into stdin
    // (never argv) happens broker-side and is asserted there.
    expect(JSON.stringify(port.execCalls[0])).not.toContain('setup');
  });

  it('deleteMailbox sends the explicit -y/-n flag through to exec', async () => {
    const port = new RecordingExecPort();
    const driver = new RealDmsDriver(port);

    await driver.deleteMailbox({ emails: ['user@example.com'], mailData: 'delete' });

    // The -y/-n flag is the broker's to add; what must never be lost on
    // this side is the *choice* itself, carried as a required field.
    expect(port.execCalls[0]).toEqual({
      operation: 'dms.email.del',
      emails: ['user@example.com'],
      mailData: 'delete',
    });
  });

  it('a non-zero exit is surfaced as DmsCommandExecutionError, carrying argv/exitCode/stderr', async () => {
    const port = new RecordingExecPort();
    port.nextExecResult = { stdout: '', stderr: 'account already exists', exitCode: 1 };
    const driver = new RealDmsDriver(port);

    const error = await driver
      .addMailbox({ email: 'user@example.com', password: 'hunter2pass' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DmsCommandExecutionError);
    const executionError = error as DmsCommandExecutionError;
    expect(executionError.command).toEqual(['dms.email.add']);
    expect(executionError.exitCode).toBe(1);
    expect(executionError.stderr).toBe('account already exists');
    // The password must never leak into the error's own message.
    expect(executionError.message).not.toContain('hunter2pass');
  });

  it('a successful exit (code 0) resolves the write with no error', async () => {
    const port = new RecordingExecPort();
    const driver = new RealDmsDriver(port);
    await expect(driver.deleteQuota({ email: 'user@example.com' })).resolves.toBeUndefined();
  });

  it('addAlias, setQuota, generateDkim and fail2banBan all delegate to exec with the expected argv', async () => {
    const port = new RecordingExecPort();
    const driver = new RealDmsDriver(port);

    await driver.addAlias({ alias: 'a@example.com', recipient: 'b@example.com' });
    await driver.setQuota({ email: 'a@example.com', quota: '50M' });
    await driver.generateDkim({ selector: 'mail' });
    await driver.fail2banBan({ ip: '203.0.113.5' });

    expect(port.execCalls).toEqual([
      { operation: 'dms.alias.add', alias: 'a@example.com', recipient: 'b@example.com' },
      { operation: 'dms.quota.set', email: 'a@example.com', quota: '50M' },
      { operation: 'dms.dkim.generate', selector: 'mail' },
      { operation: 'dms.fail2ban.ban', ip: '203.0.113.5' },
    ]);
  });

  it('never sends anything shaped like a command line — the port only ever receives a named operation', async () => {
    const port = new RecordingExecPort();
    const execSpy = vi.spyOn(port, 'runCommand');
    const driver = new RealDmsDriver(port);

    await driver.addAlias({ alias: 'a@example.com', recipient: 'b@example.com' });

    expect(execSpy).toHaveBeenCalledTimes(1);
    const [request] = execSpy.mock.calls[0] ?? [];
    expect(request).toBeDefined();
    // The property that replaced "argv is an array, not a shell string":
    // there is no argv at all, and no field that could hold one.
    expect(typeof request?.operation).toBe('string');
    expect(request).not.toHaveProperty('argv');
    expect(request).not.toHaveProperty('command');
    expect(request).not.toHaveProperty('path');
  });
});
