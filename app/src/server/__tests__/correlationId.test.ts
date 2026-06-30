// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  generateRequestId,
  runWithRequestContext,
  getRequestId,
  getRequestContext,
} from '../correlationId.js';

describe('generateRequestId', () => {
  it('returns a req-<uuid> id with no embedded PII', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id).not.toContain('@');
  });

  it('generates a fresh id each call', () => {
    expect(generateRequestId()).not.toBe(generateRequestId());
  });
});

describe('runWithRequestContext', () => {
  it('makes requestId available via getRequestId inside the callback', () => {
    const id = generateRequestId();
    runWithRequestContext({ requestId: id }, () => {
      expect(getRequestId()).toBe(id);
    });
  });

  it('returns undefined outside a request context', () => {
    expect(getRequestId()).toBeUndefined();
  });

  it('exposes full context via getRequestContext', () => {
    const ctx = { requestId: 'req-test', method: 'GET', path: '/api/health', userId: 'u1' };
    runWithRequestContext(ctx, () => {
      expect(getRequestContext()).toEqual(ctx);
    });
  });

  it('isolates nested contexts', () => {
    runWithRequestContext({ requestId: 'outer' }, () => {
      expect(getRequestId()).toBe('outer');
      runWithRequestContext({ requestId: 'inner' }, () => {
        expect(getRequestId()).toBe('inner');
      });
      expect(getRequestId()).toBe('outer');
    });
  });
});
