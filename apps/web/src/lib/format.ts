/** Small formatting helpers shared by the mail pages. Never invents a value — every function here either formats a real number or returns the "unknown" string, never a fabricated placeholder. */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unknown';
  if (bytes === 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log2(bytes) / 10), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = BYTE_UNITS[exponent] ?? 'TB';
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function formatQuota(quota: string | null): string {
  return quota ?? 'Unlimited';
}

export function formatPercent(fraction: number | null): string {
  if (fraction === null) return 'Unknown';
  return `${Math.round(fraction * 100)}%`;
}

export function formatCount(count: number | null): string {
  return count === null ? 'Unknown' : count.toLocaleString();
}

/** Formats an ISO-8601 timestamp for display; `null`/unparseable input never throws, it reads "Unknown". */
export function formatDateTime(iso: string | null): string {
  if (iso === null) return 'Unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
