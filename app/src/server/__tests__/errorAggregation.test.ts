// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeMessage,
  summarizeErrors,
  getErrorSummaryCached,
  _resetErrorSummaryCache,
  type ErrorEntry,
} from '../errorAggregation.js';

describe('normalizeMessage', () => {
  it('strips UUIDs so variant messages group together', () => {
    const a = normalizeMessage('Failed to load resource 3f9a1b2c-aaaa-bbbb-cccc-1234567890ab');
    const b = normalizeMessage('Failed to load resource 99998888-7777-6666-5555-000011112222');
    expect(a).toBe(b);
    expect(a).toContain('{uuid}');
  });

  it('strips ISO-8601 timestamps', () => {
    const a = normalizeMessage('snapshot at 2026-06-30T11:00:00.123Z failed');
    const b = normalizeMessage('snapshot at 2026-01-01T00:00:00Z failed');
    expect(a).toBe(b);
    expect(a).toContain('{ts}');
  });

  it('strips long hex (>16) and bare numeric IDs (4+ digits)', () => {
    expect(normalizeMessage('hash deadbeefdeadbeefdeadbeef mismatch')).toContain('{hex}');
    expect(normalizeMessage('node 1048576 over limit')).toBe(normalizeMessage('node 999999 over limit'));
    expect(normalizeMessage('node 1048576 over limit')).toContain('{n}');
  });

  it('keeps genuinely different messages distinct', () => {
    expect(normalizeMessage('Circuit breaker OPEN')).not.toBe(normalizeMessage('Synthesis timeout'));
  });
});

describe('summarizeErrors', () => {
  const NOW = Date.parse('2026-06-30T12:00:00Z');
  const mk = (over: Partial<ErrorEntry>): ErrorEntry => ({
    id: 'x', timestamp: new Date(NOW).toISOString(), error: { name: 'Error', message: 'm' }, ...over,
  });

  it('counts today / last7d / last30d by window', () => {
    const s = summarizeErrors([
      mk({ timestamp: '2026-06-30T01:00:00Z' }),
      mk({ timestamp: '2026-06-27T12:00:00Z' }),
      mk({ timestamp: '2026-06-10T12:00:00Z' }),
      mk({ timestamp: '2026-04-01T12:00:00Z' }),
    ], NOW);
    expect(s.total).toBe(4);
    expect(s.today).toBe(1);
    expect(s.last7d).toBe(2);
    expect(s.last30d).toBe(3);
  });

  it('groups variant errors via normalizeMessage, counting occurrences + distinct users', () => {
    const s = summarizeErrors([
      mk({ userId: 'u1', error: { name: 'ActionableError', message: 'Failed to load resource 3f9a1b2c-aaaa-bbbb-cccc-1234567890ab' } }),
      mk({ userId: 'u2', error: { name: 'ActionableError', message: 'Failed to load resource 99998888-7777-6666-5555-000011112222' } }),
      mk({ userId: 'u1', error: { name: 'TypeError', message: 'x is undefined' } }),
    ], NOW);
    expect(s.topErrors).toHaveLength(2);
    const top = s.topErrors[0];
    expect(top.name).toBe('ActionableError');
    expect(top.count).toBe(2);
    expect(top.affectedUsers).toBe(2);
  });

  it('builds a byDay histogram over the trailing 30 days', () => {
    const s = summarizeErrors([
      mk({ timestamp: '2026-06-30T01:00:00Z' }),
      mk({ timestamp: '2026-06-30T05:00:00Z' }),
      mk({ timestamp: '2026-06-29T05:00:00Z' }),
    ], NOW);
    expect(s.byDay.find(d => d.date === '2026-06-30')?.count).toBe(2);
    expect(s.byDay.find(d => d.date === '2026-06-29')?.count).toBe(1);
  });

  it('ignores entries with unparseable timestamps', () => {
    const s = summarizeErrors([mk({ timestamp: 'not-a-date' }), mk({ timestamp: '2026-06-30T01:00:00Z' })], NOW);
    expect(s.today).toBe(1);
  });
});

describe('getErrorSummaryCached (30s TTL)', () => {
  beforeEach(() => _resetErrorSummaryCache());

  it('serves a cached result within 30s and recomputes after expiry', async () => {
    let calls = 0;
    const load = async (): Promise<ErrorEntry[]> => { calls++; return []; };
    const t0 = Date.parse('2026-06-30T12:00:00Z');

    await getErrorSummaryCached(load, t0);
    await getErrorSummaryCached(load, t0 + 10_000);
    expect(calls).toBe(1);

    await getErrorSummaryCached(load, t0 + 31_000);
    expect(calls).toBe(2);
  });
});
