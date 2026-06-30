// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  validateAndMerge, getDefaults, getConfig, forceReload,
  getConfigState, writeConfig, diffFromDefaults, initRuntimeConfig,
  type RuntimeConfig,
} from '../runtimeConfig.js';

const defaults = (): RuntimeConfig => getDefaults();

describe('getDefaults', () => {
  it('returns the documented defaults', () => {
    const d = getDefaults();
    expect(d.resilience.circuitThreshold).toBe(5);
    expect(d.resilience.throttleEnterFactor).toBe(2.0);
    expect(d.flightRecorder.maxTotalDumpSizeBytes).toBe(52_428_800);
    expect(d.server.longOperationTimeoutMs).toBe(600_000);
    expect(d.cache.defaultTtlMs).toBe(30_000);
  });

  it('returns a deep copy — mutating the result does not leak', () => {
    const a = getDefaults();
    a.resilience.circuitThreshold = 999;
    const b = getDefaults();
    expect(b.resilience.circuitThreshold).toBe(5);
  });
});

describe('validateAndMerge — happy paths', () => {
  it('a valid full config passes through unchanged with no errors', () => {
    const { config, errors } = validateAndMerge(getDefaults(), defaults());
    expect(errors).toEqual([]);
    expect(config).toEqual(getDefaults());
  });

  it('a partial config deep-merges over defaults', () => {
    const { config, errors } = validateAndMerge(
      { resilience: { circuitThreshold: 8 }, sessions: { anonymousMaxSessions: 200 } },
      defaults(),
    );
    expect(errors).toEqual([]);
    expect(config.resilience.circuitThreshold).toBe(8);
    expect(config.resilience.circuitCooldownMs).toBe(60_000);
    expect(config.sessions.anonymousMaxSessions).toBe(200);
    expect(config.sessions.anonymousTtlMs).toBe(14_400_000);
  });

  it('accepts a config tagged with _meta.version 1', () => {
    const { config, errors } = validateAndMerge(
      { _meta: { version: 1, updatedBy: 'admin' }, cache: { defaultTtlMs: 60_000 } },
      defaults(),
    );
    expect(errors).toEqual([]);
    expect(config.cache.defaultTtlMs).toBe(60_000);
  });
});

describe('validateAndMerge — type & range handling', () => {
  it('falls back to default on wrong type and records an error', () => {
    const { config, errors } = validateAndMerge({ resilience: { circuitThreshold: 'five' } }, defaults());
    expect(config.resilience.circuitThreshold).toBe(5);
    expect(errors.some(e => e.includes('circuitThreshold') && e.includes('expected number'))).toBe(true);
  });

  it('clamps above-max values', () => {
    const { config, errors } = validateAndMerge({ resilience: { circuitThreshold: 99_999 } }, defaults());
    expect(config.resilience.circuitThreshold).toBe(1_000);
    expect(errors.some(e => e.includes('above max'))).toBe(true);
  });

  it('clamps below-min values', () => {
    const { config, errors } = validateAndMerge({ rateLimiting: { windowMs: -5 } }, defaults());
    expect(config.rateLimiting.windowMs).toBe(0);
    expect(errors.some(e => e.includes('below min'))).toBe(true);
  });

  it('rounds non-integer values for integer fields', () => {
    const { config } = validateAndMerge({ resilience: { circuitThreshold: 5.7 } }, defaults());
    expect(config.resilience.circuitThreshold).toBe(6);
  });

  it('caps server timeouts at 1h while session durations allow up to 24h', () => {
    const { config, errors } = validateAndMerge(
      { server: { longOperationTimeoutMs: 7_200_000 }, sessions: { anonymousTtlMs: 7_200_000 } },
      defaults(),
    );
    expect(config.server.longOperationTimeoutMs).toBe(3_600_000);
    expect(config.sessions.anonymousTtlMs).toBe(7_200_000);
    expect(errors.some(e => e.includes('longOperationTimeoutMs') && e.includes('above max'))).toBe(true);
  });
});

describe('validateAndMerge — throttle factors & cross-field rule', () => {
  it('rejects a factor <= 1.0, using the default', () => {
    const { config, errors } = validateAndMerge({ resilience: { throttleEnterFactor: 0.5 } }, defaults());
    expect(config.resilience.throttleEnterFactor).toBe(2.0);
    expect(errors.some(e => e.includes('throttleEnterFactor') && e.includes('> 1.0'))).toBe(true);
  });

  it('reverts the whole resilience section when exitFactor >= enterFactor', () => {
    const { config, errors } = validateAndMerge(
      { resilience: { circuitThreshold: 9, throttleEnterFactor: 2.0, throttleExitFactor: 3.0 } },
      defaults(),
    );
    expect(config.resilience).toEqual(getDefaults().resilience);
    expect(config.resilience.circuitThreshold).toBe(5);
    expect(errors.some(e => e.includes('throttleExitFactor') && e.includes('throttleEnterFactor'))).toBe(true);
  });

  it('accepts a valid factor pair (exit < enter)', () => {
    const { config, errors } = validateAndMerge(
      { resilience: { throttleEnterFactor: 4.0, throttleExitFactor: 2.5 } },
      defaults(),
    );
    expect(errors).toEqual([]);
    expect(config.resilience.throttleEnterFactor).toBe(4.0);
    expect(config.resilience.throttleExitFactor).toBe(2.5);
  });
});

describe('validateAndMerge — malformed / forward-compat', () => {
  it('returns defaults for a non-object root', () => {
    for (const bad of [null, 42, 'nope', [1, 2, 3]]) {
      const { config, errors } = validateAndMerge(bad, defaults());
      expect(config).toEqual(getDefaults());
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('refuses to merge a non-v1 config and uses defaults', () => {
    const { config, errors } = validateAndMerge(
      { _meta: { version: 2 }, sessions: { anonymousMaxSessions: 99 } },
      defaults(),
    );
    expect(config).toEqual(getDefaults());
    expect(config.sessions.anonymousMaxSessions).toBe(100);
    expect(errors.some(e => e.includes('_meta.version'))).toBe(true);
  });

  it('ignores a wrong-typed section and uses its defaults', () => {
    const { config, errors } = validateAndMerge({ resilience: 'not-an-object' }, defaults());
    expect(config.resilience).toEqual(getDefaults().resilience);
    expect(errors.some(e => e.includes('resilience') && e.includes('expected object'))).toBe(true);
  });
});

describe('getConfig / forceReload — ENOENT fail-safe', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtcfg-'));
    initRuntimeConfig({ configDir: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('getConfig returns defaults when no config file exists', () => {
    expect(getConfig()).toEqual(getDefaults());
  });

  it('forceReload reports ok:false when falling back to defaults', () => {
    expect(forceReload().ok).toBe(false);
  });
});

describe('REST-endpoint support — file round-trip', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtcfg-'));
    initRuntimeConfig({ configDir: root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const configFile = () => path.join(root, 'runtime-config.json');

  it('getConfigState reports fileExists:false before any write', () => {
    const state = getConfigState();
    expect(state.fileExists).toBe(false);
    expect(state.lastModified).toBeNull();
    expect(state.errors).toEqual([]);
    expect(state.config).toEqual(getDefaults());
  });

  it('writeConfig persists a valid partial config with refreshed _meta', () => {
    expect(writeConfig({ resilience: { circuitThreshold: 8 } }, 'tester')).toEqual({ ok: true, errors: [] });

    const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(written._meta.version).toBe(1);
    expect(written._meta.updatedBy).toBe('tester');
    expect(typeof written._meta.updatedAt).toBe('string');
    expect(written.resilience.circuitThreshold).toBe(8);

    const state = getConfigState();
    expect(state.fileExists).toBe(true);
    expect(state.lastModified).not.toBeNull();
    expect(state.config.resilience.circuitThreshold).toBe(8);
    expect(state.config.sessions.anonymousMaxSessions).toBe(100);
  });

  it('writeConfig rejects an out-of-range config, leaving the file untouched', () => {
    const result = writeConfig({ sessions: { anonymousMaxSessions: 99_999_999 } }, 'tester');
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('anonymousMaxSessions'))).toBe(true);
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('writeConfig rejects a cross-field violation without writing', () => {
    const result = writeConfig({ resilience: { throttleEnterFactor: 2.0, throttleExitFactor: 5.0 } }, 'tester');
    expect(result.ok).toBe(false);
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('a partial PUT merges over the live config, not defaults', () => {
    expect(writeConfig({ resilience: { circuitThreshold: 8 } }, 'a').ok).toBe(true);
    expect(writeConfig({ cache: { defaultTtlMs: 60_000 } }, 'b').ok).toBe(true);
    const state = getConfigState();
    expect(state.config.resilience.circuitThreshold).toBe(8);
    expect(state.config.cache.defaultTtlMs).toBe(60_000);
  });

  it('diffFromDefaults returns only changed leaves', () => {
    expect(diffFromDefaults()).toEqual([]);
    writeConfig({ resilience: { circuitThreshold: 9 } }, 'tester');
    expect(diffFromDefaults()).toEqual([{ path: 'resilience.circuitThreshold', current: 9, default: 5 }]);
  });
});
