/**
 * CPU% and memory% maths, verbatim from
 * docs/research/02-docker-api-security.md §A.3:
 *
 * ```
 * cpu_delta        = cpu_stats.cpu_usage.total_usage        - precpu_stats.cpu_usage.total_usage
 * system_cpu_delta = cpu_stats.system_cpu_usage             - precpu_stats.system_cpu_usage
 * number_cpus      = length(cpu_stats.cpu_usage.percpu_usage)  OR  cpu_stats.online_cpus
 * CPU usage %      = (cpu_delta / system_cpu_delta) * number_cpus * 100.0
 *
 * used_memory      = memory_stats.usage - memory_stats.stats.cache          (cgroups v1)
 * used_memory      = memory_stats.usage - memory_stats.stats.inactive_file  (cgroups v2)
 * available_memory = memory_stats.limit
 * Memory usage %   = (used_memory / available_memory) * 100.0
 * ```
 *
 * The cgroup v1/v2 branch matters: `cache` (v1) and `inactive_file` (v2)
 * are both page-cache-ish "reclaimable" memory that Docker's raw `usage`
 * counter includes but which is not what a user means by "this
 * container's memory usage". Subtracting the wrong field — or neither —
 * massively over-reports memory (the research doc's own words). This
 * module has no I/O and no Docker dependency at all: it is pure
 * arithmetic over plain data, which is what makes it exhaustively
 * testable against hand-built inputs.
 */
import type { RawContainerStats, RawMemoryStats } from './docker-types.js';

export type CgroupVersion = 'v1' | 'v2';

/** cgroup v1 hosts report `stats.cache`; v2 hosts report `stats.inactive_file` instead (and omit `cache` entirely) — see docs/research/02-docker-api-security.md §A.3. */
export function detectCgroupVersion(memoryStats: RawMemoryStats): CgroupVersion {
  return memoryStats.stats.cache !== undefined ? 'v1' : 'v2';
}

/**
 * `(cpu_delta / system_cpu_delta) * number_cpus * 100`. Guards the
 * denominator: on the very first sample (no `precpu_stats` yet — e.g. a
 * `one-shot` read) `system_cpu_delta` is `<= 0`, which would otherwise
 * divide by zero or go negative. Returns `0` in that case rather than
 * `NaN`/`Infinity` — "no rate is computable yet" is a `0`, not an error,
 * for a value the UI will render as a percentage.
 */
export function computeCpuPercent(
  stats: Pick<RawContainerStats, 'cpu_stats' | 'precpu_stats'>,
): number {
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    (stats.cpu_stats.system_cpu_usage ?? 0) - (stats.precpu_stats.system_cpu_usage ?? 0);

  if (systemDelta <= 0 || cpuDelta < 0) {
    return 0;
  }

  const percpu = stats.cpu_stats.cpu_usage.percpu_usage;
  const numberOfCpus =
    percpu !== undefined && percpu.length > 0 ? percpu.length : (stats.cpu_stats.online_cpus ?? 1);

  return (cpuDelta / systemDelta) * numberOfCpus * 100;
}

/** `usage - cache` (v1) or `usage - inactive_file` (v2), floored at 0 so a stale/inconsistent sample never reports negative usage. */
export function computeMemoryUsedBytes(memoryStats: RawMemoryStats): number {
  const version = detectCgroupVersion(memoryStats);
  const reclaimable =
    version === 'v1' ? (memoryStats.stats.cache ?? 0) : (memoryStats.stats.inactive_file ?? 0);
  return Math.max(0, memoryStats.usage - reclaimable);
}

/** `used_memory / available_memory * 100`. `0` when `limit` is not positive (no cgroup memory limit configured), rather than a division by zero. */
export function computeMemoryPercent(memoryStats: RawMemoryStats): number {
  if (memoryStats.limit <= 0) return 0;
  return (computeMemoryUsedBytes(memoryStats) / memoryStats.limit) * 100;
}

export interface ComputedContainerStats {
  readonly cpuPercent: number;
  readonly memory: {
    readonly usageBytes: number;
    readonly limitBytes: number;
    readonly percent: number;
  };
  readonly pids: number | null;
  readonly network: { readonly rxBytes: number; readonly txBytes: number } | null;
}

function sumNetworks(networks: RawContainerStats['networks']): ComputedContainerStats['network'] {
  if (networks === undefined) return null;
  let rxBytes = 0;
  let txBytes = 0;
  for (const iface of Object.values(networks)) {
    rxBytes += iface.rx_bytes;
    txBytes += iface.tx_bytes;
  }
  return { rxBytes, txBytes };
}

/** Combines every formula above into the one shape that ever leaves the broker (`ContainerStatsResponseSchema` in `@dwg/shared`) — the raw ~40-field Docker payload never does. */
export function computeContainerStats(stats: RawContainerStats): ComputedContainerStats {
  return {
    cpuPercent: computeCpuPercent(stats),
    memory: {
      usageBytes: computeMemoryUsedBytes(stats.memory_stats),
      limitBytes: stats.memory_stats.limit,
      percent: computeMemoryPercent(stats.memory_stats),
    },
    pids: stats.pids_stats?.current ?? null,
    network: sumNetworks(stats.networks),
  };
}
