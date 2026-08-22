import { describe, expect, it } from 'vitest';
import {
  BROKER_OPERATIONS,
  BROKER_REQUEST_SCHEMAS,
  BROKER_RESPONSE_SCHEMAS,
  BrokerOperationSchema,
  BrokerRequestSchema,
  ConsoleExecRequestSchema,
  ContainerLogsRequestSchema,
  ContainerListRequestSchema,
  LogsFileRequestSchema,
  LOGS_TAIL_MAX,
  LOGS_TAIL_MIN,
  type BrokerOperation,
} from './broker.js';

describe('BROKER_OPERATIONS', () => {
  it('is exactly the documented vocabulary, with no duplicates', () => {
    // Written out in full rather than derived, so growing the vocabulary is
    // always a deliberate edit here. M9 added the last four; each takes a
    // symbolic selector only — a volume name, a log-source enum value, or a
    // command key — never a path, argv, or container reference.
    const expected = [
      'container.list',
      'container.inspect',
      'container.start',
      'container.stop',
      'container.restart',
      'container.stats',
      'container.logs',
      'system.ping',
      'system.version',
      'system.info',
      'system.df',
      'image.list',
      'volume.list',
      'network.list',
      'volume.remove',
      'image.prune',
      'logs.file',
      'console.exec',
      // M16 — the docker-mailserver vocabulary. Written out here in full
      // for the same reason as everything above it: growing the set of
      // things a compromised web tier can ask the privileged tier to do is
      // always a deliberate edit in this list, never a side effect of
      // spreading an array from another module.
      'dms.file.read',
      'dms.env.read',
      'dms.dkim.record.read',
      'dms.email.add',
      'dms.email.update',
      'dms.email.del',
      'dms.email.restrict',
      'dms.email.list',
      'dms.alias.add',
      'dms.alias.del',
      'dms.alias.list',
      'dms.quota.set',
      'dms.quota.del',
      'dms.quota.get',
      'dms.dkim.generate',
      'dms.fail2ban.list',
      'dms.fail2ban.status',
      'dms.fail2ban.log',
      'dms.fail2ban.ban',
      'dms.fail2ban.unban',
      'dms.clamd.control',
      'dms.clamav.update',
      'dms.clamav.log',
      'dms.sieve.list',
      'dms.sieve.get',
      'dms.sieve.put',
      'dms.sieve.activate',
      'dms.sieve.deactivate',
      'dms.queue.list',
    ];
    expect([...BROKER_OPERATIONS].sort()).toEqual([...expected].sort());
    expect(new Set(BROKER_OPERATIONS).size).toBe(BROKER_OPERATIONS.length);
  });

  it('deliberately omits container.create, container.remove and every exec.* operation', () => {
    for (const forbidden of ['container.create', 'container.remove', 'exec.run', 'exec.start']) {
      expect((BROKER_OPERATIONS as readonly string[]).includes(forbidden)).toBe(false);
    }
  });

  it('has one request schema per operation, in the same order', () => {
    expect(BROKER_REQUEST_SCHEMAS.length).toBe(BROKER_OPERATIONS.length);
  });
});

describe('BrokerOperationSchema', () => {
  it('accepts every known operation and rejects an unknown one', () => {
    for (const op of BROKER_OPERATIONS) {
      expect(BrokerOperationSchema.safeParse(op).success).toBe(true);
    }
    expect(BrokerOperationSchema.safeParse('container.create').success).toBe(false);
    expect(BrokerOperationSchema.safeParse('exec.run').success).toBe(false);
    expect(BrokerOperationSchema.safeParse('').success).toBe(false);
  });
});

describe('BrokerRequestSchema — unknown operation and extra-field rejection', () => {
  it('rejects a request naming an operation outside the enum (container.create)', () => {
    const result = BrokerRequestSchema.safeParse({
      operation: 'container.create',
      Image: 'alpine',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a request naming exec, which was never in the vocabulary at all', () => {
    const result = BrokerRequestSchema.safeParse({
      operation: 'exec.run',
      Cmd: ['postqueue', '-p'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a completely made-up operation string', () => {
    const result = BrokerRequestSchema.safeParse({ operation: 'not.a.real.op' });
    expect(result.success).toBe(false);
  });

  it('rejects a well-formed operation carrying an unexpected extra field', () => {
    const result = BrokerRequestSchema.safeParse({
      operation: 'system.ping',
      extra: 'field',
    });
    expect(result.success).toBe(false);
  });

  it('accepts the same well-formed operation without the extra field', () => {
    const result = BrokerRequestSchema.safeParse({ operation: 'system.ping' });
    expect(result.success).toBe(true);
  });
});

describe('container.list — the one operation that can address containers plural', () => {
  it('accepts an omitted, true, or false "all"', () => {
    expect(ContainerListRequestSchema.safeParse({ operation: 'container.list' }).success).toBe(
      true,
    );
    expect(
      ContainerListRequestSchema.safeParse({ operation: 'container.list', all: true }).success,
    ).toBe(true);
    expect(
      ContainerListRequestSchema.safeParse({ operation: 'container.list', all: false }).success,
    ).toBe(true);
  });

  it('rejects a non-boolean "all" and any container-identifying field', () => {
    expect(
      ContainerListRequestSchema.safeParse({ operation: 'container.list', all: 'true' }).success,
    ).toBe(false);
    expect(
      ContainerListRequestSchema.safeParse({ operation: 'container.list', id: 'abc123' }).success,
    ).toBe(false);
    expect(
      ContainerListRequestSchema.safeParse({ operation: 'container.list', name: 'mailserver' })
        .success,
    ).toBe(false);
  });
});

describe('container.logs — bounded params only', () => {
  it('accepts an omitted tail/since/timestamps, and values at the documented bounds', () => {
    expect(ContainerLogsRequestSchema.safeParse({ operation: 'container.logs' }).success).toBe(
      true,
    );
    expect(
      ContainerLogsRequestSchema.safeParse({ operation: 'container.logs', tail: LOGS_TAIL_MIN })
        .success,
    ).toBe(true);
    expect(
      ContainerLogsRequestSchema.safeParse({ operation: 'container.logs', tail: LOGS_TAIL_MAX })
        .success,
    ).toBe(true);
    expect(
      ContainerLogsRequestSchema.safeParse({
        operation: 'container.logs',
        since: 0,
        timestamps: true,
      }).success,
    ).toBe(true);
  });

  it('rejects tail outside the bounded range, fractional tail, and a negative since', () => {
    expect(
      ContainerLogsRequestSchema.safeParse({
        operation: 'container.logs',
        tail: LOGS_TAIL_MIN - 1,
      }).success,
    ).toBe(false);
    expect(
      ContainerLogsRequestSchema.safeParse({
        operation: 'container.logs',
        tail: LOGS_TAIL_MAX + 1,
      }).success,
    ).toBe(false);
    expect(
      ContainerLogsRequestSchema.safeParse({ operation: 'container.logs', tail: 1.5 }).success,
    ).toBe(false);
    expect(
      ContainerLogsRequestSchema.safeParse({ operation: 'container.logs', since: -1 }).success,
    ).toBe(false);
  });
});

describe('logs.file — a fixed source enum, never a client-supplied path', () => {
  it('accepts each documented source', () => {
    expect(
      LogsFileRequestSchema.safeParse({ operation: 'logs.file', source: 'mail' }).success,
    ).toBe(true);
    expect(
      LogsFileRequestSchema.safeParse({ operation: 'logs.file', source: 'fail2ban' }).success,
    ).toBe(true);
  });

  it('rejects anything outside the enum, including path-traversal and absolute-path attempts', () => {
    for (const source of [
      '../../etc/passwd',
      '/etc/shadow',
      '/var/log/mail/mail.log',
      'mail.log',
      'mail/../fail2ban',
      '',
      'MAIL',
    ]) {
      expect(
        LogsFileRequestSchema.safeParse({ operation: 'logs.file', source }).success,
        source,
      ).toBe(false);
    }
  });

  it('rejects a path field alongside a valid source — there is no field to put one in', () => {
    expect(
      LogsFileRequestSchema.safeParse({
        operation: 'logs.file',
        source: 'mail',
        path: '/etc/passwd',
      }).success,
    ).toBe(false);
  });
});

describe('console.exec — a fixed zero-argument command enum, never a client-supplied argv', () => {
  it('accepts each documented command', () => {
    for (const command of ['postqueue-p', 'postconf-n', 'doveconf-n', 'doveadm-who']) {
      expect(
        ConsoleExecRequestSchema.safeParse({ operation: 'console.exec', command }).success,
      ).toBe(true);
    }
  });

  it('rejects an unlisted command string', () => {
    for (const command of ['rm-rf', 'whoami', 'postqueue -p', '']) {
      expect(
        ConsoleExecRequestSchema.safeParse({ operation: 'console.exec', command }).success,
        command,
      ).toBe(false);
    }
  });

  it('rejects an argv array passed alongside a valid command key', () => {
    expect(
      ConsoleExecRequestSchema.safeParse({
        operation: 'console.exec',
        command: 'postqueue-p',
        argv: ['postqueue', '-p'],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The schema-level security test: no request schema anywhere accepts a
// HostConfig/Binds/Privileged/CapAdd/PidMode-shaped field. This does not
// merely inspect the schemas' declared shape — it feeds poisoned input
// through safeParse and demands rejection, so it fails if a future
// operation schema is ever added without `.strict()`, or grows a
// passthrough field.
// ---------------------------------------------------------------------------

describe('BrokerRequestSchema — dangerous Docker fields are structurally impossible', () => {
  const DANGEROUS_KEYS = [
    'HostConfig',
    'Binds',
    'Privileged',
    'CapAdd',
    'PidMode',
    'NetworkMode',
    'Mounts',
    'Devices',
    'SecurityOpt',
  ];

  /**
   * The minimal valid body for every operation. Kept as a literal map
   * (not derived from the schemas) so it is an independent cross-check —
   * if these two lists (this map's keys, and {@link BROKER_OPERATIONS})
   * disagree, the coverage test below catches the drift before the
   * poisoning test could ever silently skip an operation.
   */
  const MINIMAL_VALID_BODY: Record<BrokerOperation, Record<string, unknown>> = {
    'container.list': { operation: 'container.list' },
    'container.inspect': { operation: 'container.inspect' },
    'container.start': { operation: 'container.start' },
    'container.stop': { operation: 'container.stop' },
    'container.restart': { operation: 'container.restart' },
    'container.stats': { operation: 'container.stats' },
    'container.logs': { operation: 'container.logs' },
    'system.ping': { operation: 'system.ping' },
    'system.version': { operation: 'system.version' },
    'system.info': { operation: 'system.info' },
    'system.df': { operation: 'system.df' },
    'image.list': { operation: 'image.list' },
    'volume.list': { operation: 'volume.list' },
    'network.list': { operation: 'network.list' },
    // M9 additions. Each carries a symbolic selector, never a path, argv or
    // container spec — which is what keeps the poisoning test below meaningful
    // as the vocabulary grows.
    'volume.remove': { operation: 'volume.remove', name: 'some-unprotected-volume' },
    'image.prune': { operation: 'image.prune' },
    'logs.file': { operation: 'logs.file', source: 'mail' },
    'console.exec': { operation: 'console.exec', command: 'postqueue-p' },
    // M16 — the docker-mailserver vocabulary (`dms.ts`). Same discipline as
    // the M9 additions above: a symbolic file key, a closed verb enum, and
    // validated leaf values (an address, a quota, an IP, a script name).
    // Nothing here is a path, an argv element or a container spec, which is
    // exactly what the poisoning test below is here to keep true.
    'dms.file.read': { operation: 'dms.file.read', file: 'postfix-accounts' },
    'dms.env.read': { operation: 'dms.env.read' },
    'dms.dkim.record.read': {
      operation: 'dms.dkim.record.read',
      domain: 'example.com',
      selector: 'mail',
    },
    'dms.email.add': { operation: 'dms.email.add', email: 'a@example.com', password: 'pw' },
    'dms.email.update': { operation: 'dms.email.update', email: 'a@example.com', password: 'pw' },
    'dms.email.del': {
      operation: 'dms.email.del',
      emails: ['a@example.com'],
      mailData: 'keep',
    },
    'dms.email.restrict': { operation: 'dms.email.restrict', action: 'list', scope: 'send' },
    'dms.email.list': { operation: 'dms.email.list' },
    'dms.alias.add': {
      operation: 'dms.alias.add',
      alias: 'a@example.com',
      recipient: 'b@example.com',
    },
    'dms.alias.del': {
      operation: 'dms.alias.del',
      alias: 'a@example.com',
      recipient: 'b@example.com',
    },
    'dms.alias.list': { operation: 'dms.alias.list' },
    'dms.quota.set': { operation: 'dms.quota.set', email: 'a@example.com', quota: '1G' },
    'dms.quota.del': { operation: 'dms.quota.del', email: 'a@example.com' },
    'dms.quota.get': { operation: 'dms.quota.get', email: 'a@example.com' },
    'dms.dkim.generate': { operation: 'dms.dkim.generate' },
    'dms.fail2ban.list': { operation: 'dms.fail2ban.list' },
    'dms.fail2ban.status': { operation: 'dms.fail2ban.status' },
    'dms.fail2ban.log': { operation: 'dms.fail2ban.log' },
    'dms.fail2ban.ban': { operation: 'dms.fail2ban.ban', ip: '203.0.113.4' },
    'dms.fail2ban.unban': { operation: 'dms.fail2ban.unban', ip: '203.0.113.4' },
    'dms.clamd.control': { operation: 'dms.clamd.control', verb: 'PING' },
    'dms.clamav.update': { operation: 'dms.clamav.update' },
    'dms.clamav.log': { operation: 'dms.clamav.log' },
    'dms.sieve.list': { operation: 'dms.sieve.list', user: 'a@example.com' },
    'dms.sieve.get': { operation: 'dms.sieve.get', user: 'a@example.com', script: 'vacation' },
    'dms.sieve.put': {
      operation: 'dms.sieve.put',
      user: 'a@example.com',
      script: 'vacation',
      content: 'keep;',
    },
    'dms.sieve.activate': {
      operation: 'dms.sieve.activate',
      user: 'a@example.com',
      script: 'vacation',
    },
    'dms.sieve.deactivate': { operation: 'dms.sieve.deactivate', user: 'a@example.com' },
    'dms.queue.list': { operation: 'dms.queue.list' },
  };

  it('the fixture above covers every operation the enum defines, exactly', () => {
    expect(Object.keys(MINIMAL_VALID_BODY).sort()).toEqual([...BROKER_OPERATIONS].sort());
  });

  it('sanity check: the minimal body for every operation is valid on its own', () => {
    for (const operation of BROKER_OPERATIONS) {
      const result = BrokerRequestSchema.safeParse(MINIMAL_VALID_BODY[operation]);
      expect(result.success, `operation ${operation} should accept its own minimal body`).toBe(
        true,
      );
    }
  });

  it('rejects every operation once any dangerous Docker field is added to it', () => {
    for (const operation of BROKER_OPERATIONS) {
      for (const key of DANGEROUS_KEYS) {
        const poisoned = { ...MINIMAL_VALID_BODY[operation], [key]: { anything: true } };
        const result = BrokerRequestSchema.safeParse(poisoned);
        expect(result.success, `operation ${operation} must reject a "${key}" field`).toBe(false);
      }
    }
  });

  /**
   * `volume.remove` legitimately takes a volume `name`, so it is the one
   * operation/field pairing this guard cannot assert against.
   *
   * The exemption is deliberately scoped to that single pairing rather than
   * dropping `name` from the key list, which would silently weaken the guard
   * for all seventeen other operations. A volume name is not a container
   * reference: it cannot designate a container, and it cannot carry a spec.
   *
   * What protects volume names is a different control with its own test —
   * the broker refuses any volume backing a DMS data mount, re-derived from
   * the managed container's own mounts on every call rather than from a
   * hardcoded list. See `apps/broker/src/operations.ts`.
   */
  const CONTAINER_REF_GUARD_EXEMPTIONS = new Set(['volume.remove::name']);

  it('rejects a container id/name on every operation, including container.inspect/start/stop/restart', () => {
    for (const operation of BROKER_OPERATIONS) {
      for (const key of ['id', 'Id', 'container', 'containerId', 'name', 'Name']) {
        if (CONTAINER_REF_GUARD_EXEMPTIONS.has(`${operation}::${key}`)) continue;
        const poisoned = { ...MINIMAL_VALID_BODY[operation], [key]: 'mailserver' };
        const result = BrokerRequestSchema.safeParse(poisoned);
        expect(result.success, `operation ${operation} must reject a "${key}" field`).toBe(false);
      }
    }
  });

  it('exempts nothing beyond the single documented volume-name pairing', () => {
    // Pins the exemption set itself, so a future operation cannot quietly
    // opt out of the container-reference guard by adding an entry above.
    expect([...CONTAINER_REF_GUARD_EXEMPTIONS]).toEqual(['volume.remove::name']);
  });
});

describe('BROKER_RESPONSE_SCHEMAS', () => {
  it('has exactly one response schema per operation (also enforced at compile time by "satisfies")', () => {
    expect(Object.keys(BROKER_RESPONSE_SCHEMAS).sort()).toEqual([...BROKER_OPERATIONS].sort());
  });
});
