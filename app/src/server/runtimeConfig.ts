// Runtime configuration reader with file-based hot-reload.
//
// Externalizes server parameters into an optional JSON config file with
// mtime-cached reads (5s TTL). Fail-safe: missing file, malformed JSON,
// or out-of-range values all degrade to hardcoded DEFAULTS.
//
// Usage:
//   initRuntimeConfig({ configDir: '/data/admin' });
//   const cfg = getConfig();

import fs from 'fs';
import path from 'path';

// ── Types ──

export interface RuntimeConfig {
  resilience: {
    circuitThreshold: number;
    circuitCooldownMs: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    retryJitterMaxMs: number;
    maxRetryAfterMs: number;
    throttleWindowSize: number;
    throttleBaselineCount: number;
    throttleEnterFactor: number;
    throttleExitFactor: number;
    throttleDelayMs: number;
  };
  rateLimiting: {
    windowMs: number;
    cleanupCutoffMs: number;
  };
  sessions: {
    anonymousTtlMs: number;
    anonymousMaxSessions: number;
    anonymousMaxSizeBytes: number;
  };
  flightRecorder: {
    minDumpIntervalMs: number;
    maxDumpsPerWindow: number;
    dumpWindowMs: number;
    maxRetainedDumps: number;
    maxTotalDumpSizeBytes: number;
  };
  server: {
    defaultOperationTimeoutMs: number;
    longOperationTimeoutMs: number;
    subprocessBufferLimitBytes: number;
    apiKeyMaskLength: number;
  };
  cache: {
    defaultTtlMs: number;
  };
}

// Range bounds.
const DURATION_MAX = 86_400_000; // 24h
const LONG_OP_TIMEOUT_MAX = 3_600_000; // 1h
const SIZE_MAX = 1_073_741_824; // 1 GB

const DEFAULTS: RuntimeConfig = {
  resilience: {
    circuitThreshold: 5,
    circuitCooldownMs: 60_000,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 30_000,
    retryJitterMaxMs: 500,
    maxRetryAfterMs: 30_000,
    throttleWindowSize: 20,
    throttleBaselineCount: 10,
    throttleEnterFactor: 2.0,
    throttleExitFactor: 1.5,
    throttleDelayMs: 2_000,
  },
  rateLimiting: {
    windowMs: 60_000,
    cleanupCutoffMs: 120_000,
  },
  sessions: {
    anonymousTtlMs: 14_400_000,
    anonymousMaxSessions: 100,
    anonymousMaxSizeBytes: 10_485_760,
  },
  flightRecorder: {
    minDumpIntervalMs: 10_000,
    maxDumpsPerWindow: 5,
    dumpWindowMs: 60_000,
    maxRetainedDumps: 20,
    maxTotalDumpSizeBytes: 52_428_800,
  },
  server: {
    defaultOperationTimeoutMs: 120_000,
    longOperationTimeoutMs: 600_000,
    subprocessBufferLimitBytes: 10_485_760,
    apiKeyMaskLength: 4,
  },
  cache: {
    defaultTtlMs: 30_000,
  },
};

// ── Field validation helpers ──

interface NumOpts { min: number; max: number; integer?: boolean }

function vNum(val: unknown, def: number, opts: NumOpts, field: string, errors: string[]): number {
  if (val === undefined) return def;
  if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val)) {
    errors.push(`${field}: expected number, got ${typeof val} — using default ${def}`);
    return def;
  }
  let v = val;
  if (opts.integer && !Number.isInteger(v)) v = Math.round(v);
  if (v < opts.min) { errors.push(`${field}: ${val} below min ${opts.min} — clamped`); v = opts.min; }
  if (v > opts.max) { errors.push(`${field}: ${val} above max ${opts.max} — clamped`); v = opts.max; }
  return v;
}

function vFactor(val: unknown, def: number, field: string, errors: string[]): number {
  if (val === undefined) return def;
  if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val)) {
    errors.push(`${field}: expected number, got ${typeof val} — using default ${def}`);
    return def;
  }
  if (val <= 1.0) { errors.push(`${field}: ${val} must be > 1.0 — using default ${def}`); return def; }
  if (val > 100) { errors.push(`${field}: ${val} above max 100 — clamped`); return 100; }
  return val;
}

function section(raw: Record<string, unknown>, key: string, errors: string[]): Record<string, unknown> {
  const v = raw[key];
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    errors.push(`${key}: expected object — section ignored, using defaults`);
    return {};
  }
  return v as Record<string, unknown>;
}

/**
 * Deep-merge `raw` over `defaults`, validating each field. Returns the merged
 * config plus an `errors[]` array (empty when clean). Out-of-range values clamp;
 * wrong-typed fields fall back to their default.
 */
export function validateAndMerge(raw: unknown, defaults: RuntimeConfig): { config: RuntimeConfig; errors: string[] } {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('root: config is not an object — using defaults');
    return { config: structuredClone(defaults), errors };
  }
  const r = raw as Record<string, unknown>;

  const meta = r._meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta) && 'version' in meta) {
    const ver = (meta as Record<string, unknown>).version;
    if (ver !== 1) {
      errors.push(`_meta.version: expected 1, got ${JSON.stringify(ver)} — refusing to merge a non-v1 config, using defaults`);
      return { config: structuredClone(defaults), errors };
    }
  }

  const res = section(r, 'resilience', errors);
  const rl = section(r, 'rateLimiting', errors);
  const sess = section(r, 'sessions', errors);
  const fr = section(r, 'flightRecorder', errors);
  const srv = section(r, 'server', errors);
  const cache = section(r, 'cache', errors);

  let resilience: RuntimeConfig['resilience'] = {
    circuitThreshold: vNum(res.circuitThreshold, defaults.resilience.circuitThreshold, { min: 1, max: 1_000, integer: true }, 'resilience.circuitThreshold', errors),
    circuitCooldownMs: vNum(res.circuitCooldownMs, defaults.resilience.circuitCooldownMs, { min: 0, max: DURATION_MAX }, 'resilience.circuitCooldownMs', errors),
    retryBaseDelayMs: vNum(res.retryBaseDelayMs, defaults.resilience.retryBaseDelayMs, { min: 0, max: DURATION_MAX }, 'resilience.retryBaseDelayMs', errors),
    retryMaxDelayMs: vNum(res.retryMaxDelayMs, defaults.resilience.retryMaxDelayMs, { min: 0, max: DURATION_MAX }, 'resilience.retryMaxDelayMs', errors),
    retryJitterMaxMs: vNum(res.retryJitterMaxMs, defaults.resilience.retryJitterMaxMs, { min: 0, max: DURATION_MAX }, 'resilience.retryJitterMaxMs', errors),
    maxRetryAfterMs: vNum(res.maxRetryAfterMs, defaults.resilience.maxRetryAfterMs, { min: 0, max: DURATION_MAX }, 'resilience.maxRetryAfterMs', errors),
    throttleWindowSize: vNum(res.throttleWindowSize, defaults.resilience.throttleWindowSize, { min: 1, max: 10_000, integer: true }, 'resilience.throttleWindowSize', errors),
    throttleBaselineCount: vNum(res.throttleBaselineCount, defaults.resilience.throttleBaselineCount, { min: 1, max: 10_000, integer: true }, 'resilience.throttleBaselineCount', errors),
    throttleEnterFactor: vFactor(res.throttleEnterFactor, defaults.resilience.throttleEnterFactor, 'resilience.throttleEnterFactor', errors),
    throttleExitFactor: vFactor(res.throttleExitFactor, defaults.resilience.throttleExitFactor, 'resilience.throttleExitFactor', errors),
    throttleDelayMs: vNum(res.throttleDelayMs, defaults.resilience.throttleDelayMs, { min: 0, max: DURATION_MAX }, 'resilience.throttleDelayMs', errors),
  };
  if (resilience.throttleExitFactor >= resilience.throttleEnterFactor) {
    errors.push(`resilience: throttleExitFactor (${resilience.throttleExitFactor}) must be < throttleEnterFactor (${resilience.throttleEnterFactor}) — reverting resilience section to defaults`);
    resilience = structuredClone(defaults.resilience);
  }

  const config: RuntimeConfig = {
    resilience,
    rateLimiting: {
      windowMs: vNum(rl.windowMs, defaults.rateLimiting.windowMs, { min: 0, max: DURATION_MAX }, 'rateLimiting.windowMs', errors),
      cleanupCutoffMs: vNum(rl.cleanupCutoffMs, defaults.rateLimiting.cleanupCutoffMs, { min: 0, max: DURATION_MAX }, 'rateLimiting.cleanupCutoffMs', errors),
    },
    sessions: {
      anonymousTtlMs: vNum(sess.anonymousTtlMs, defaults.sessions.anonymousTtlMs, { min: 0, max: DURATION_MAX }, 'sessions.anonymousTtlMs', errors),
      anonymousMaxSessions: vNum(sess.anonymousMaxSessions, defaults.sessions.anonymousMaxSessions, { min: 1, max: 1_000_000, integer: true }, 'sessions.anonymousMaxSessions', errors),
      anonymousMaxSizeBytes: vNum(sess.anonymousMaxSizeBytes, defaults.sessions.anonymousMaxSizeBytes, { min: 0, max: SIZE_MAX, integer: true }, 'sessions.anonymousMaxSizeBytes', errors),
    },
    flightRecorder: {
      minDumpIntervalMs: vNum(fr.minDumpIntervalMs, defaults.flightRecorder.minDumpIntervalMs, { min: 0, max: DURATION_MAX }, 'flightRecorder.minDumpIntervalMs', errors),
      maxDumpsPerWindow: vNum(fr.maxDumpsPerWindow, defaults.flightRecorder.maxDumpsPerWindow, { min: 1, max: 1_000, integer: true }, 'flightRecorder.maxDumpsPerWindow', errors),
      dumpWindowMs: vNum(fr.dumpWindowMs, defaults.flightRecorder.dumpWindowMs, { min: 0, max: DURATION_MAX }, 'flightRecorder.dumpWindowMs', errors),
      maxRetainedDumps: vNum(fr.maxRetainedDumps, defaults.flightRecorder.maxRetainedDumps, { min: 1, max: 10_000, integer: true }, 'flightRecorder.maxRetainedDumps', errors),
      maxTotalDumpSizeBytes: vNum(fr.maxTotalDumpSizeBytes, defaults.flightRecorder.maxTotalDumpSizeBytes, { min: 0, max: SIZE_MAX, integer: true }, 'flightRecorder.maxTotalDumpSizeBytes', errors),
    },
    server: {
      defaultOperationTimeoutMs: vNum(srv.defaultOperationTimeoutMs, defaults.server.defaultOperationTimeoutMs, { min: 0, max: LONG_OP_TIMEOUT_MAX }, 'server.defaultOperationTimeoutMs', errors),
      longOperationTimeoutMs: vNum(srv.longOperationTimeoutMs, defaults.server.longOperationTimeoutMs, { min: 0, max: LONG_OP_TIMEOUT_MAX }, 'server.longOperationTimeoutMs', errors),
      subprocessBufferLimitBytes: vNum(srv.subprocessBufferLimitBytes, defaults.server.subprocessBufferLimitBytes, { min: 0, max: SIZE_MAX, integer: true }, 'server.subprocessBufferLimitBytes', errors),
      apiKeyMaskLength: vNum(srv.apiKeyMaskLength, defaults.server.apiKeyMaskLength, { min: 0, max: 64, integer: true }, 'server.apiKeyMaskLength', errors),
    },
    cache: {
      defaultTtlMs: vNum(cache.defaultTtlMs, defaults.cache.defaultTtlMs, { min: 0, max: DURATION_MAX }, 'cache.defaultTtlMs', errors),
    },
  };

  return { config, errors };
}

// ── Config loading with mtime cache (5s TTL) ──

let _configDir: string | null = null;
let _cache: RuntimeConfig | null = null;
let _cacheMtime = 0;
let _lastLoadTime = 0;
const CACHE_TTL = 5_000;

export interface RuntimeConfigInit {
  configDir: string;
}

export function initRuntimeConfig(opts: RuntimeConfigInit): void {
  _configDir = opts.configDir;
  _cache = null;
  _cacheMtime = 0;
  _lastLoadTime = 0;
}

function configPath(): string {
  if (!_configDir) throw new Error('runtimeConfig not initialized — call initRuntimeConfig({ configDir }) first');
  return path.join(_configDir, 'runtime-config.json');
}

function loadConfig(): RuntimeConfig {
  const p = configPath();
  try {
    const stat = fs.statSync(p);
    if (_cache && stat.mtimeMs === _cacheMtime) return _cache;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const { config, errors } = validateAndMerge(raw, DEFAULTS);
    if (errors.length > 0) {
      console.warn(`[runtime-config] Loaded with ${errors.length} validation issue(s):`, errors.slice(0, 20));
    }
    _cache = config;
    _cacheMtime = stat.mtimeMs;
    return _cache;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[runtime-config] Invalid config — using defaults:', (err as Error).message);
    }
    return DEFAULTS;
  }
}

export function getConfig(): RuntimeConfig {
  const now = Date.now();
  if (now - _lastLoadTime > CACHE_TTL) {
    _lastLoadTime = now;
    return loadConfig();
  }
  return _cache ?? loadConfig();
}

export function forceReload(): { ok: boolean; errors?: string[] } {
  _cache = null;
  _cacheMtime = 0;
  _lastLoadTime = Date.now();
  try {
    const config = loadConfig();
    return { ok: config !== DEFAULTS };
  } catch (err) {
    return { ok: false, errors: [String(err)] };
  }
}

export function getDefaults(): RuntimeConfig {
  return structuredClone(DEFAULTS);
}

// ── REST-endpoint support ──

export interface ConfigState {
  config: RuntimeConfig;
  defaults: RuntimeConfig;
  errors: string[];
  fileExists: boolean;
  lastModified: string | null;
}

export function getConfigState(): ConfigState {
  const p = configPath();
  try {
    const stat = fs.statSync(p);
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const { config, errors } = validateAndMerge(raw, DEFAULTS);
    return { config, defaults: getDefaults(), errors, fileExists: true, lastModified: new Date(stat.mtimeMs).toISOString() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { config: getDefaults(), defaults: getDefaults(), errors: [String(err)], fileExists: true, lastModified: null };
    }
    return { config: getDefaults(), defaults: getDefaults(), errors: [], fileExists: false, lastModified: null };
  }
}

export function writeConfig(incoming: unknown, updatedBy: string): { ok: boolean; errors: string[] } {
  const base = getConfig();
  const { config, errors } = validateAndMerge(incoming, base);
  if (errors.length > 0) return { ok: false, errors };
  const p = configPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const out = {
      $schema: './runtime-config.schema.json',
      _meta: { version: 1, updatedAt: new Date().toISOString(), updatedBy },
      ...config,
    };
    fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf-8');
    forceReload();
    return { ok: true, errors: [] };
  } catch (err) {
    return { ok: false, errors: [`write failed: ${String(err)}`] };
  }
}

export interface ConfigDiffEntry { path: string; current: unknown; default: unknown }

function collectDiff(cur: unknown, def: unknown, prefix: string, out: ConfigDiffEntry[]): void {
  if (cur !== null && typeof cur === 'object' && !Array.isArray(cur) &&
      def !== null && typeof def === 'object' && !Array.isArray(def)) {
    const c = cur as Record<string, unknown>;
    const d = def as Record<string, unknown>;
    for (const key of Object.keys(d)) {
      collectDiff(c[key], d[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  if (JSON.stringify(cur) !== JSON.stringify(def)) {
    out.push({ path: prefix, current: cur, default: def });
  }
}

export function diffFromDefaults(): ConfigDiffEntry[] {
  const out: ConfigDiffEntry[] = [];
  collectDiff(getConfig(), DEFAULTS, '', out);
  return out;
}
