/**
 * Client-only password strength estimate (FEATURE_MATRIX.md §6:
 * "Generation (CSPRNG), confirmation, strength meter"). Pure and
 * side-effect free — the password never leaves this function, is never
 * logged, and this module has no network/storage access of any kind.
 *
 * A simple character-class-entropy estimate, not a dictionary/pattern
 * cracker (no zxcvbn-class dependency is installed) — good enough to
 * steer an admin away from `password1` without pretending to be a real
 * crack-time model we have no basis to claim.
 */

export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrength {
  readonly score: PasswordStrengthScore;
  readonly label: 'Very weak' | 'Weak' | 'Fair' | 'Good' | 'Strong';
  /** Rough estimated entropy in bits — informational only, shown nowhere as a false-precision number. */
  readonly bits: number;
}

const CHARSET_SIZES = {
  lower: 26,
  upper: 26,
  digit: 10,
  symbol: 33,
} as const;

function charsetSizeOf(password: string): number {
  let size = 0;
  if (/[a-z]/.test(password)) size += CHARSET_SIZES.lower;
  if (/[A-Z]/.test(password)) size += CHARSET_SIZES.upper;
  if (/[0-9]/.test(password)) size += CHARSET_SIZES.digit;
  if (/[^a-zA-Z0-9]/.test(password)) size += CHARSET_SIZES.symbol;
  return size;
}

const SCORE_THRESHOLDS: ReadonlyArray<{
  readonly bits: number;
  readonly score: PasswordStrengthScore;
}> = [
  { bits: 80, score: 4 },
  { bits: 60, score: 3 },
  { bits: 40, score: 2 },
  { bits: 28, score: 1 },
];

const LABELS: Readonly<Record<PasswordStrengthScore, PasswordStrength['label']>> = {
  0: 'Very weak',
  1: 'Weak',
  2: 'Fair',
  3: 'Good',
  4: 'Strong',
};

export function estimatePasswordStrength(password: string): PasswordStrength {
  if (password.length === 0) return { score: 0, label: LABELS[0], bits: 0 };

  const charsetSize = Math.max(charsetSizeOf(password), 1);
  const bits = Math.round(password.length * Math.log2(charsetSize));
  const score = SCORE_THRESHOLDS.find((t) => bits >= t.bits)?.score ?? 0;

  return { score, label: LABELS[score], bits };
}

const GENERATED_PASSWORD_LENGTH = 20;
// Excludes visually-ambiguous characters (0/O, 1/l/I) — this is generated
// for a human to read once and type/paste, not memorise.
const GENERATED_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*()-_=+';

/**
 * Generates a random password using the Web Crypto API's CSPRNG
 * (FEATURE_MATRIX.md §6: "Generation (CSPRNG)"). Rejection sampling
 * avoids modulo bias from mapping a random byte onto a charset whose
 * size does not evenly divide 256.
 */
export function generatePassword(length: number = GENERATED_PASSWORD_LENGTH): string {
  const charset = GENERATED_CHARSET;
  const maxValidByte = 256 - (256 % charset.length);
  const result: string[] = [];
  const buffer = new Uint8Array(1);

  while (result.length < length) {
    crypto.getRandomValues(buffer);
    const value = buffer[0]!;
    if (value >= maxValidByte) continue; // reject — would bias toward the low end of the charset
    result.push(charset[value % charset.length]!);
  }

  return result.join('');
}
