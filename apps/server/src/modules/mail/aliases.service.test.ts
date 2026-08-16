/**
 * Unit coverage for {@link detectsAliasLoop} — the pure function behind
 * FEATURE_MATRIX.md §4's "loop and self-reference detection" security
 * note. `aliases.routes.test.ts` already exercises the 0-hop
 * (self-reference) and 2-hop cases end-to-end through the HTTP layer;
 * this file pins the function's exact boundary behaviour directly,
 * including cases (a 3-hop chain, an already-cyclic unrelated part of the
 * graph, a disconnected graph) that would be slow and awkward to force
 * through a full request/response round trip.
 */
import { describe, expect, it } from 'vitest';
import { detectsAliasLoop } from './aliases.service.js';

describe('detectsAliasLoop', () => {
  it('is false when no recipient is, or leads to, an alias at all', () => {
    const aliasMap = new Map<string, readonly string[]>();
    expect(detectsAliasLoop('new@example.com', ['real-mailbox@example.com'], aliasMap)).toBe(false);
  });

  it('is true for a direct self-reference (0-hop)', () => {
    const aliasMap = new Map<string, readonly string[]>();
    expect(detectsAliasLoop('self@example.com', ['self@example.com'], aliasMap)).toBe(true);
  });

  it('is true for a 2-hop loop (A -> B, proposing B -> A)', () => {
    const aliasMap = new Map<string, readonly string[]>([['a@example.com', ['b@example.com']]]);
    expect(detectsAliasLoop('b@example.com', ['a@example.com'], aliasMap)).toBe(true);
  });

  it('is true for a 3-hop loop (A -> B -> C, proposing C -> A)', () => {
    const aliasMap = new Map<string, readonly string[]>([
      ['a@example.com', ['b@example.com']],
      ['b@example.com', ['c@example.com']],
    ]);
    expect(detectsAliasLoop('c@example.com', ['a@example.com'], aliasMap)).toBe(true);
  });

  it('is false when the chain terminates at a real mailbox rather than looping back', () => {
    const aliasMap = new Map<string, readonly string[]>([
      ['a@example.com', ['b@example.com']],
      ['b@example.com', ['real-mailbox@example.com']],
    ]);
    expect(detectsAliasLoop('new@example.com', ['a@example.com'], aliasMap)).toBe(false);
  });

  it('is case-insensitive when matching the target address', () => {
    const aliasMap = new Map<string, readonly string[]>();
    expect(detectsAliasLoop('Self@Example.com', ['self@example.com'], aliasMap)).toBe(true);
  });

  it('terminates and returns false even when an unrelated part of the graph already contains a cycle', () => {
    const aliasMap = new Map<string, readonly string[]>([
      ['x@example.com', ['y@example.com']],
      ['y@example.com', ['x@example.com']], // unrelated pre-existing cycle
    ]);
    expect(detectsAliasLoop('new@example.com', ['x@example.com'], aliasMap)).toBe(false);
  });

  it('is false for multiple recipients where none of them, nor anything they lead to, is the target', () => {
    const aliasMap = new Map<string, readonly string[]>([['b@example.com', ['c@example.com']]]);
    expect(
      detectsAliasLoop('target@example.com', ['a@example.com', 'b@example.com'], aliasMap),
    ).toBe(false);
  });

  it('is true if any one of several recipients leads back to the target', () => {
    const aliasMap = new Map<string, readonly string[]>([
      ['b@example.com', ['target@example.com']],
    ]);
    expect(
      detectsAliasLoop('target@example.com', ['a@example.com', 'b@example.com'], aliasMap),
    ).toBe(true);
  });
});
