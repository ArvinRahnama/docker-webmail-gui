import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
  it('keeps a custom font-size token next to a text colour', () => {
    expect(cn('text-caption font-medium', 'text-status-healthy-fg')).toBe(
      'text-caption font-medium text-status-healthy-fg',
    );
    expect(cn('text-body text-text-primary', 'text-body-sm')).toBe(
      'text-text-primary text-body-sm',
    );
  });

  it('still lets a later font-size token override an earlier one', () => {
    expect(cn('text-h2 font-semibold', 'text-body')).toBe('font-semibold text-body');
    expect(cn('text-caption', 'text-mono-sm')).toBe('text-mono-sm');
  });

  it('still lets a later colour override an earlier colour', () => {
    expect(cn('text-text-primary', 'text-text-muted')).toBe('text-text-muted');
  });
});
