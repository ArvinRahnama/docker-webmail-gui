import { describe, expect, it } from 'vitest';
import {
  computeContainerStats,
  computeCpuPercent,
  computeMemoryPercent,
  computeMemoryUsedBytes,
  detectCgroupVersion,
} from './stats.js';
import type { RawContainerStats } from './docker-types.js';

describe('computeCpuPercent — known inputs', () => {
  it('cgroup v1 shape (percpu_usage present, 4 CPUs): 0.2 * 4 * 100 = 80%', () => {
    const stats: Pick<RawContainerStats, 'cpu_stats' | 'precpu_stats'> = {
      cpu_stats: {
        cpu_usage: { total_usage: 2_000_000_000, percpu_usage: [1, 2, 3, 4] },
        system_cpu_usage: 10_000_000_000,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 1_600_000_000, percpu_usage: [1, 2, 3, 4] },
        system_cpu_usage: 8_000_000_000,
      },
    };

    expect(computeCpuPercent(stats)).toBeCloseTo(80, 6);
  });

  it('cgroup v2 shape (no percpu_usage, online_cpus=2): 0.3 * 2 * 100 = 60%', () => {
    const stats: Pick<RawContainerStats, 'cpu_stats' | 'precpu_stats'> = {
      cpu_stats: {
        cpu_usage: { total_usage: 3_000_000_000 },
        system_cpu_usage: 50_000_000_000,
        online_cpus: 2,
      },
      precpu_stats: { cpu_usage: { total_usage: 2_700_000_000 }, system_cpu_usage: 49_000_000_000 },
    };

    expect(computeCpuPercent(stats)).toBeCloseTo(60, 6);
  });

  it('treats an empty percpu_usage array the same as absent — falls back to online_cpus', () => {
    const stats: Pick<RawContainerStats, 'cpu_stats' | 'precpu_stats'> = {
      cpu_stats: {
        cpu_usage: { total_usage: 3_000_000_000, percpu_usage: [] },
        system_cpu_usage: 50_000_000_000,
        online_cpus: 2,
      },
      precpu_stats: { cpu_usage: { total_usage: 2_700_000_000 }, system_cpu_usage: 49_000_000_000 },
    };

    expect(computeCpuPercent(stats)).toBeCloseTo(60, 6);
  });

  it('defaults number_cpus to 1 when neither percpu_usage nor online_cpus is available', () => {
    const stats: Pick<RawContainerStats, 'cpu_stats' | 'precpu_stats'> = {
      cpu_stats: { cpu_usage: { total_usage: 2_000_000_000 }, system_cpu_usage: 10_000_000_000 },
      precpu_stats: { cpu_usage: { total_usage: 1_600_000_000 }, system_cpu_usage: 8_000_000_000 },
    };

    // (400_000_000 / 2_000_000_000) * 1 * 100 = 20
    expect(computeCpuPercent(stats)).toBeCloseTo(20, 6);
  });

  it('returns 0, not NaN/Infinity, on the first sample (system_cpu_delta == 0 — precpu_stats not yet meaningful)', () => {
    const stats: Pick<RawContainerStats, 'cpu_stats' | 'precpu_stats'> = {
      cpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 5_000_000_000 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 5_000_000_000 },
    };

    const result = computeCpuPercent(stats);
    expect(result).toBe(0);
    expect(Number.isFinite(result)).toBe(true);
  });

  it('returns 0 when system_cpu_delta is negative (clock/sample inconsistency)', () => {
    const stats: Pick<RawContainerStats, 'cpu_stats' | 'precpu_stats'> = {
      cpu_stats: { cpu_usage: { total_usage: 2_000 }, system_cpu_usage: 4_000_000_000 },
      precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 5_000_000_000 },
    };

    expect(computeCpuPercent(stats)).toBe(0);
  });

  it('returns 0 when cpu_delta is negative even though system_cpu_delta is positive', () => {
    const stats: Pick<RawContainerStats, 'cpu_stats' | 'precpu_stats'> = {
      cpu_stats: { cpu_usage: { total_usage: 500 }, system_cpu_usage: 6_000_000_000 },
      precpu_stats: { cpu_usage: { total_usage: 1_000 }, system_cpu_usage: 5_000_000_000 },
    };

    expect(computeCpuPercent(stats)).toBe(0);
  });
});

describe('detectCgroupVersion', () => {
  it('is v1 when stats.cache is present', () => {
    expect(detectCgroupVersion({ usage: 0, limit: 0, stats: { cache: 100 } })).toBe('v1');
  });

  it('is v2 when stats.cache is absent, even if inactive_file is present', () => {
    expect(detectCgroupVersion({ usage: 0, limit: 0, stats: { inactive_file: 100 } })).toBe('v2');
  });

  it('is v2 when neither field is present', () => {
    expect(detectCgroupVersion({ usage: 0, limit: 0, stats: {} })).toBe('v2');
  });
});

describe('computeMemoryUsedBytes / computeMemoryPercent — known inputs', () => {
  it('cgroup v1: subtracts stats.cache, not stats.inactive_file', () => {
    const memoryStats = {
      usage: 500_000_000,
      limit: 1_000_000_000,
      stats: { cache: 100_000_000, inactive_file: 999_999_999 }, // if this were used instead, the assertion below would fail
    };

    expect(computeMemoryUsedBytes(memoryStats)).toBe(400_000_000);
    expect(computeMemoryPercent(memoryStats)).toBeCloseTo(40, 6);
  });

  it('cgroup v2: subtracts stats.inactive_file (cache is absent)', () => {
    const memoryStats = {
      usage: 800_000_000,
      limit: 2_000_000_000,
      stats: { inactive_file: 50_000_000 },
    };

    expect(computeMemoryUsedBytes(memoryStats)).toBe(750_000_000);
    expect(computeMemoryPercent(memoryStats)).toBeCloseTo(37.5, 6);
  });

  it('getting the branch wrong would massively over-report memory — pinned explicitly', () => {
    // Same usage/limit, only the cgroup version differs. Using the v1
    // field (cache) on v2-shaped data — the exact mistake the research
    // doc warns about — would report 90% instead of the correct 40%.
    const v2Shaped = {
      usage: 500_000_000,
      limit: 1_000_000_000,
      stats: { inactive_file: 400_000_000 },
    };
    expect(computeMemoryPercent(v2Shaped)).toBeCloseTo(10, 6);
    expect(computeMemoryPercent(v2Shaped)).not.toBeCloseTo(90, 0);
  });

  it('floors used memory at 0 rather than going negative on an inconsistent sample', () => {
    const memoryStats = { usage: 100, limit: 1_000, stats: { cache: 500 } };
    expect(computeMemoryUsedBytes(memoryStats)).toBe(0);
  });

  it('returns 0% (not a divide-by-zero) when limit is not positive', () => {
    expect(computeMemoryPercent({ usage: 100, limit: 0, stats: { cache: 0 } })).toBe(0);
    expect(computeMemoryPercent({ usage: 100, limit: -1, stats: { cache: 0 } })).toBe(0);
  });
});

describe('computeContainerStats — combined shape', () => {
  it('produces the full computed shape for a cgroup v1 sample, including pids and summed multi-interface network', () => {
    const stats: RawContainerStats = {
      cpu_stats: {
        cpu_usage: { total_usage: 2_000_000_000, percpu_usage: [1, 2, 3, 4] },
        system_cpu_usage: 10_000_000_000,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 1_600_000_000, percpu_usage: [1, 2, 3, 4] },
        system_cpu_usage: 8_000_000_000,
      },
      memory_stats: { usage: 500_000_000, limit: 1_000_000_000, stats: { cache: 100_000_000 } },
      pids_stats: { current: 12 },
      networks: {
        eth0: { rx_bytes: 1000, tx_bytes: 500 },
        eth1: { rx_bytes: 2000, tx_bytes: 1500 },
      },
    };

    const result = computeContainerStats(stats);

    expect(result.cpuPercent).toBeCloseTo(80, 6);
    expect(result.memory).toEqual({
      usageBytes: 400_000_000,
      limitBytes: 1_000_000_000,
      percent: 40,
    });
    expect(result.pids).toBe(12);
    expect(result.network).toEqual({ rxBytes: 3000, txBytes: 2000 });
  });

  it('reports pids null and network null when the daemon omits them', () => {
    const stats: RawContainerStats = {
      cpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      memory_stats: { usage: 0, limit: 0, stats: {} },
    };

    const result = computeContainerStats(stats);
    expect(result.pids).toBeNull();
    expect(result.network).toBeNull();
  });

  it('produces the full computed shape for a cgroup v2 sample', () => {
    const stats: RawContainerStats = {
      cpu_stats: {
        cpu_usage: { total_usage: 3_000_000_000 },
        system_cpu_usage: 50_000_000_000,
        online_cpus: 2,
      },
      precpu_stats: { cpu_usage: { total_usage: 2_700_000_000 }, system_cpu_usage: 49_000_000_000 },
      memory_stats: {
        usage: 800_000_000,
        limit: 2_000_000_000,
        stats: { inactive_file: 50_000_000 },
      },
      pids_stats: { current: 7 },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
    };

    const result = computeContainerStats(stats);

    expect(result.cpuPercent).toBeCloseTo(60, 6);
    expect(result.memory).toEqual({
      usageBytes: 750_000_000,
      limitBytes: 2_000_000_000,
      percent: 37.5,
    });
    expect(result.pids).toBe(7);
    expect(result.network).toEqual({ rxBytes: 10, txBytes: 20 });
  });
});
