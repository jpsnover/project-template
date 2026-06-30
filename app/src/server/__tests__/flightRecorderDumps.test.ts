// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  isValidDumpId,
  selectExpiredDumps,
  mergeDumps,
  type DumpFileInfo,
} from '../flightRecorderDumps.js';

describe('isValidDumpId', () => {
  it('accepts UUID-format strings', () => {
    expect(isValidDumpId('abc-123-def')).toBe(true);
  });

  it('accepts alphanumeric + underscore + hyphen', () => {
    expect(isValidDumpId('dump_2026-06-30_abcdef12')).toBe(true);
  });

  it('rejects non-strings', () => {
    expect(isValidDumpId(null)).toBe(false);
    expect(isValidDumpId(123)).toBe(false);
    expect(isValidDumpId(undefined)).toBe(false);
  });

  it('rejects strings with path traversal chars', () => {
    expect(isValidDumpId('../etc/passwd')).toBe(false);
    expect(isValidDumpId('foo/bar')).toBe(false);
  });

  it('rejects strings longer than 128 chars', () => {
    expect(isValidDumpId('a'.repeat(129))).toBe(false);
    expect(isValidDumpId('a'.repeat(128))).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(isValidDumpId('')).toBe(false);
  });
});

describe('selectExpiredDumps', () => {
  const mkFile = (dumpId: string, kind: 'client' | 'server', mtime: number, size = 1000): DumpFileInfo => ({
    name: `${kind}-${dumpId}.jsonl`, dumpId, mtime, size,
  });

  it('keeps newest groups up to maxGroups, deletes the rest', () => {
    const files = [
      mkFile('a', 'client', 100), mkFile('a', 'server', 100),
      mkFile('b', 'client', 200), mkFile('b', 'server', 200),
      mkFile('c', 'client', 300), mkFile('c', 'server', 300),
    ];
    const expired = selectExpiredDumps(files, 2); // keep 2 newest (b, c)
    expect(expired).toEqual(expect.arrayContaining(['client-a.jsonl', 'server-a.jsonl']));
    expect(expired).not.toContain('client-b.jsonl');
    expect(expired).not.toContain('client-c.jsonl');
  });

  it('deletes whole pairs — never orphans a half', () => {
    const files = [
      mkFile('a', 'client', 100),
      mkFile('a', 'server', 100),
    ];
    const expired = selectExpiredDumps(files, 0);
    expect(expired).toContain('client-a.jsonl');
    expect(expired).toContain('server-a.jsonl');
  });

  it('enforces byte cap by dropping oldest groups first', () => {
    const files = [
      mkFile('old', 'client', 100, 30_000_000),
      mkFile('new', 'client', 200, 30_000_000),
    ];
    const expired = selectExpiredDumps(files, 10, 40_000_000);
    expect(expired).toEqual(['client-old.jsonl']);
  });

  it('returns empty when everything fits', () => {
    const files = [mkFile('a', 'client', 100)];
    expect(selectExpiredDumps(files, 20, 50_000_000)).toEqual([]);
  });
});

describe('mergeDumps', () => {
  const clientDump = [
    JSON.stringify({ _type: 'header', timestamp: '2026-06-30T10:00:00Z', uptime_ms: 5000, capacity: 1000, retained: 10, lost: 0 }),
    JSON.stringify({ _type: 'dictionary', category: 'component', value: 'renderer', handle: 0 }),
    JSON.stringify({ _type: 'context', app_version: '1.0.0', user_id: 'u1' }),
    JSON.stringify({ _type: 'event', _wall: '2026-06-30T10:00:01Z', type: 'ui.click', component: 'button' }),
    JSON.stringify({ _type: 'event', _wall: '2026-06-30T10:00:03Z', type: 'api.request', component: 'bridge' }),
    JSON.stringify({ _type: 'trigger', trigger_type: 'explicit' }),
  ].join('\n');

  const serverDump = [
    JSON.stringify({ _type: 'header', timestamp: '2026-06-30T10:00:00Z', uptime_ms: 8000, capacity: 2000, retained: 5, lost: 0 }),
    JSON.stringify({ _type: 'dictionary', category: 'component', value: 'server', handle: 0 }),
    JSON.stringify({ _type: 'context', node_version: '22.0.0' }),
    JSON.stringify({ _type: 'event', _wall: '2026-06-30T10:00:02Z', type: 'api.response', component: 'handler' }),
    JSON.stringify({ _type: 'trigger', trigger_type: 'explicit' }),
  ].join('\n');

  it('produces a merged header with both sources', () => {
    const merged = mergeDumps(clientDump, serverDump);
    const header = JSON.parse(merged.split('\n')[0]);
    expect(header.merged).toBe(true);
    expect(header.sources).toEqual(['client', 'server']);
    expect(header.total_events).toBe(3);
    expect(header.client_uptime_ms).toBe(5000);
    expect(header.server_uptime_ms).toBe(8000);
  });

  it('deduplicates dictionary entries by category:value', () => {
    const dupClient = [
      JSON.stringify({ _type: 'header', timestamp: 'x' }),
      JSON.stringify({ _type: 'dictionary', category: 'component', value: 'shared', handle: 0 }),
    ].join('\n');
    const dupServer = [
      JSON.stringify({ _type: 'header', timestamp: 'x' }),
      JSON.stringify({ _type: 'dictionary', category: 'component', value: 'shared', handle: 0 }),
    ].join('\n');
    const merged = mergeDumps(dupClient, dupServer);
    const dictLines = merged.split('\n').filter(l => {
      try { return JSON.parse(l)._type === 'dictionary'; } catch { return false; }
    });
    expect(dictLines).toHaveLength(1);
  });

  it('interleaves events by _wall timestamp', () => {
    const merged = mergeDumps(clientDump, serverDump);
    const events = merged.split('\n')
      .filter(l => { try { const o = JSON.parse(l); return o._type === 'event' || o._merged_seq !== undefined; } catch { return false; } })
      .map(l => JSON.parse(l));
    expect(events).toHaveLength(3);
    expect(events[0]._wall).toBe('2026-06-30T10:00:01Z');
    expect(events[0]._source).toBe('client');
    expect(events[1]._wall).toBe('2026-06-30T10:00:02Z');
    expect(events[1]._source).toBe('server');
    expect(events[2]._wall).toBe('2026-06-30T10:00:03Z');
    expect(events[2]._source).toBe('client');
    expect(events[2]._merged_seq).toBe(2);
  });

  it('merges context with provenance tracking', () => {
    const merged = mergeDumps(clientDump, serverDump);
    const ctx = merged.split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .find(o => o?._type === 'context');
    expect(ctx.app_version).toBe('1.0.0');
    expect(ctx.node_version).toBe('22.0.0');
    expect(ctx._client_fields).toContain('app_version');
    expect(ctx._server_fields).toContain('node_version');
  });

  it('handles client-only dump', () => {
    const merged = mergeDumps(clientDump, null);
    const header = JSON.parse(merged.split('\n')[0]);
    expect(header.sources).toEqual(['client']);
    expect(header.total_events).toBe(2);
  });

  it('handles server-only dump', () => {
    const merged = mergeDumps(null, serverDump);
    const header = JSON.parse(merged.split('\n')[0]);
    expect(header.sources).toEqual(['server']);
    expect(header.total_events).toBe(1);
  });
});
