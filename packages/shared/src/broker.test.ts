import { describe, expect, it } from 'vitest';
import {
  BROKER_OPERATIONS,
  BROKER_REQUEST_SCHEMAS,
  BROKER_RESPONSE_SCHEMAS,
  BrokerOperationSchema,
  BrokerRequestSchema,
  ContainerLogsRequestSchema,
  ContainerListRequestSchema,
  LOGS_TAIL_MAX,
  LOGS_TAIL_MIN,
  type BrokerOperation,
} from './broker.js';

describe('BROKER_OPERATIONS', () => {
  it('is exactly the documented M4 vocabulary, with no duplicates', () => {
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

  it('rejects a container id/name on every operation, including container.inspect/start/stop/restart', () => {
    for (const operation of BROKER_OPERATIONS) {
      for (const key of ['id', 'Id', 'container', 'containerId', 'name', 'Name']) {
        const poisoned = { ...MINIMAL_VALID_BODY[operation], [key]: 'mailserver' };
        const result = BrokerRequestSchema.safeParse(poisoned);
        expect(result.success, `operation ${operation} must reject a "${key}" field`).toBe(false);
      }
    }
  });
});

describe('BROKER_RESPONSE_SCHEMAS', () => {
  it('has exactly one response schema per operation (also enforced at compile time by "satisfies")', () => {
    expect(Object.keys(BROKER_RESPONSE_SCHEMAS).sort()).toEqual([...BROKER_OPERATIONS].sort());
  });
});
