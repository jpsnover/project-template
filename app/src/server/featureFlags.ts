// Feature-flag evaluation engine with file-based persistence and audit trail.
//
// Reads {dataDir}/feature-flags.json with an mtime cache (30s TTL).
// Resolution is fail-closed: unknown, disabled, or expired flags return false.
//
// Scope grammar (compound parts joined by '+', ALL must match):
//   global                 — everyone
//   role:admin             — admin users
//   user:alice,bob         — listed principals / storage ids
//   env:web | env:electron — the running environment
//   role:admin+env:web     — admin AND web
//
// Usage:
//   initFeatureFlags({
//     dataDir: '/data/admin',
//     getContext: () => ({ storageUserId: 'alice', principalName: 'alice@example.com', isAdmin: false, env: 'web' }),
//   });
//   const enabled = getFlag('my-feature');

import fs from 'fs';
import path from 'path';

// ── Types ──

export interface FlagDef {
  name: string;
  enabled: boolean;
  scope: string;
  description?: string;
  created_at: string;
  updated_at: string;
  created_by?: string;
  expires_at?: string | null;
}

interface FlagsConfig { flags: Record<string, FlagDef> }

export interface FlagAuditEntry {
  timestamp: string;
  action: 'set' | 'delete';
  flag: string;
  by: string;
  before?: FlagDef | null;
  after?: FlagDef | null;
}

export interface FlagUserContext {
  storageUserId: string;
  principalName: string;
  isAdmin: boolean;
  env: 'web' | 'electron';
}

// ── Init ──

interface FeatureFlagInit {
  dataDir: string;
  getContext: () => FlagUserContext;
  seedFlags?: Record<string, FlagDef>;
}

let _dataDir: string | null = null;
let _getContext: (() => FlagUserContext) | null = null;
let _seedFlags: Record<string, FlagDef> = {};

export function initFeatureFlags(config: FeatureFlagInit): void {
  _dataDir = config.dataDir;
  _getContext = config.getContext;
  _seedFlags = config.seedFlags ?? {};
  _cache = null;
  _cacheMtime = -1;
  _lastLoadTime = 0;
}

// ── Config loading (mtime cache) ──

let _cache: FlagsConfig | null = null;
let _cacheMtime = -1;
let _lastLoadTime = 0;
const CACHE_TTL = 30_000;

function flagsPath(): string {
  if (!_dataDir) throw new Error('featureFlags not initialized — call initFeatureFlags() first');
  return path.join(_dataDir, 'feature-flags.json');
}

function auditPath(): string {
  if (!_dataDir) throw new Error('featureFlags not initialized — call initFeatureFlags() first');
  return path.join(_dataDir, 'feature-flags-audit.ndjson');
}

function loadConfig(): FlagsConfig {
  const p = flagsPath();
  try {
    const stat = fs.statSync(p);
    if (_cache && stat.mtimeMs === _cacheMtime) return _cache;
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<FlagsConfig>;
    _cache = { flags: { ..._seedFlags, ...(data.flags ?? {}) } };
    _cacheMtime = stat.mtimeMs;
    return _cache;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[feature-flags] Failed to load — using seed defaults:', (err as Error).message);
    }
    _cache = { flags: { ..._seedFlags } };
    _cacheMtime = -1;
    return _cache;
  }
}

function getConfig(): FlagsConfig {
  const now = Date.now();
  if (now - _lastLoadTime > CACHE_TTL) { _lastLoadTime = now; return loadConfig(); }
  return _cache ?? loadConfig();
}

function persist(config: FlagsConfig): void {
  const p = flagsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  _cache = config;
  _cacheMtime = -1;
}

function appendAudit(entry: FlagAuditEntry): void {
  try {
    const p = auditPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch {
    // Audit write failure is non-fatal.
  }
}

// ── Scope evaluation (pure) ──

function matchScopePart(part: string, ctx: FlagUserContext): boolean {
  if (part === 'global' || part === '') return true;
  const i = part.indexOf(':');
  const type = i < 0 ? part : part.slice(0, i);
  const value = i < 0 ? '' : part.slice(i + 1);
  switch (type) {
    case 'role':
      return value === 'admin' && ctx.isAdmin;
    case 'user':
      return value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        .some(id => id === ctx.principalName.toLowerCase() || id === ctx.storageUserId.toLowerCase());
    case 'env':
      return value === ctx.env;
    default:
      return false;
  }
}

export function evaluateScope(scope: string, ctx: FlagUserContext): boolean {
  const parts = (scope || 'global').split('+').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every(p => matchScopePart(p, ctx));
}

function currentContext(): FlagUserContext {
  if (!_getContext) throw new Error('featureFlags not initialized — call initFeatureFlags() first');
  return _getContext();
}

function resolve(def: FlagDef | undefined, ctx: FlagUserContext): boolean {
  if (!def || !def.enabled) return false;
  if (def.expires_at && Date.parse(def.expires_at) <= Date.now()) return false;
  return evaluateScope(def.scope || 'global', ctx);
}

// ── Public API ──

export function getFlag(name: string): boolean {
  return resolve(getConfig().flags[name], currentContext());
}

export function getAllFlags(): Record<string, boolean> {
  const ctx = currentContext();
  const out: Record<string, boolean> = {};
  for (const [name, def] of Object.entries(getConfig().flags)) out[name] = resolve(def, ctx);
  return out;
}

export function getFlagMetadata(name: string): FlagDef | null {
  return getConfig().flags[name] ?? null;
}

export function listFlags(): FlagDef[] {
  return Object.values(getConfig().flags);
}

export function setFlag(name: string, patch: Partial<FlagDef>, by = '_local'): FlagDef {
  const config = { flags: { ...getConfig().flags } };
  const before = config.flags[name] ?? null;
  const now = new Date().toISOString();
  const def: FlagDef = {
    name,
    enabled: patch.enabled ?? before?.enabled ?? false,
    scope: patch.scope ?? before?.scope ?? 'global',
    description: patch.description ?? before?.description,
    created_at: before?.created_at ?? now,
    updated_at: now,
    created_by: before?.created_by ?? by,
    expires_at: patch.expires_at !== undefined ? patch.expires_at : before?.expires_at,
  };
  config.flags[name] = def;
  persist(config);
  appendAudit({ timestamp: now, action: 'set', flag: name, by, before, after: def });
  return def;
}

export function deleteFlag(name: string, by = '_local'): boolean {
  const config = { flags: { ...getConfig().flags } };
  const before = config.flags[name];
  if (!before) return false;
  delete config.flags[name];
  persist(config);
  appendAudit({ timestamp: new Date().toISOString(), action: 'delete', flag: name, by, before, after: null });
  return true;
}

export function getStaleFlags(daysOld: number): FlagDef[] {
  const cutoff = Date.now() - daysOld * 86_400_000;
  return listFlags().filter(f => !f.expires_at && Date.parse(f.updated_at) < cutoff);
}

export function _resetFlagCache(): void { _cache = null; _cacheMtime = -1; _lastLoadTime = 0; }
