/** Injectable time source so expiry, rotation and rate-limit logic is testable without sleeping. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function iso(date: Date): string {
  return date.toISOString();
}
