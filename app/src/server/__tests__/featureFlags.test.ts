// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  evaluateScope, getFlag, getAllFlags, getFlagMetadata, listFlags,
  setFlag, deleteFlag, getStaleFlags, initFeatureFlags, _resetFlagCache,
  type FlagUserContext, type FlagDef,
} from '../featureFlags.js';

let dataRoot: string;
const flagsFile = () => path.join(dataRoot, 'feature-flags.json');
const auditFile = () => path.join(dataRoot, 'feature-flags-audit.ndjson');

function ctx(p: Partial<FlagUserContext>): FlagUserContext {
  return { storageUserId: '_local', principalName: '', isAdmin: false, env: 'web', ...p };
}

const SEED: Record<string, FlagDef> = {
  'example-feature': {
    name: 'example-feature', enabled: true, scope: 'global',
    description: 'Example seed flag',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'seed',
  },
  'admin-only-feature': {
    name: 'admin-only-feature', enabled: true, scope: 'role:admin',
    description: 'Admin-only seed flag',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'seed',
  },
};

let currentUser: FlagUserContext = ctx({});

describe('evaluateScope', () => {
  it('global matches everyone', () => {
    expect(evaluateScope('global', ctx({}))).toBe(true);
    expect(evaluateScope('', ctx({}))).toBe(true);
  });

  it('role:admin matches only admins', () => {
    expect(evaluateScope('role:admin', ctx({ isAdmin: true }))).toBe(true);
    expect(evaluateScope('role:admin', ctx({ isAdmin: false }))).toBe(false);
  });

  it('user:list matches by principal or storage id (case-insensitive)', () => {
    expect(evaluateScope('user:alice,bob', ctx({ storageUserId: 'alice' }))).toBe(true);
    expect(evaluateScope('user:alice,bob', ctx({ principalName: 'Alice' }))).toBe(true);
    expect(evaluateScope('user:alice', ctx({ storageUserId: 'charlie' }))).toBe(false);
  });

  it('env matches the running environment', () => {
    expect(evaluateScope('env:web', ctx({ env: 'web' }))).toBe(true);
    expect(evaluateScope('env:electron', ctx({ env: 'web' }))).toBe(false);
  });

  it('compound (+) requires ALL parts', () => {
    expect(evaluateScope('role:admin+env:web', ctx({ isAdmin: true, env: 'web' }))).toBe(true);
    expect(evaluateScope('role:admin+env:web', ctx({ isAdmin: true, env: 'electron' }))).toBe(false);
    expect(evaluateScope('role:admin+env:web', ctx({ isAdmin: false, env: 'web' }))).toBe(false);
  });

  it('unknown scope type fails closed', () => {
    expect(evaluateScope('frobnicate:yes', ctx({}))).toBe(false);
  });
});

describe('feature flag CRUD + resolution', () => {
  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flags-'));
    currentUser = ctx({});
    initFeatureFlags({
      dataDir: dataRoot,
      getContext: () => currentUser,
      seedFlags: SEED,
    });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    _resetFlagCache();
  });

  it('unknown flags are fail-closed', () => {
    expect(getFlag('does-not-exist')).toBe(false);
  });

  it('seed flags resolve with no file present', () => {
    expect(getFlag('example-feature')).toBe(true);
  });

  it('seed flags remain accessible when feature-flags.json exists without them', () => {
    setFlag('custom-only', { enabled: true, scope: 'global' });
    _resetFlagCache();
    expect(getFlag('example-feature')).toBe(true);
    expect(getFlag('custom-only')).toBe(true);
  });

  it('file flags take precedence over seed flags with the same name', () => {
    setFlag('example-feature', { enabled: false, scope: 'global' });
    _resetFlagCache();
    expect(getFlag('example-feature')).toBe(false);
  });

  it('setFlag persists to feature-flags.json and appends an audit entry', () => {
    setFlag('my-flag', { enabled: true, scope: 'global', description: 'x' }, 'admin');
    expect(fs.existsSync(flagsFile())).toBe(true);
    const stored = JSON.parse(fs.readFileSync(flagsFile(), 'utf-8'));
    expect(stored.flags['my-flag'].enabled).toBe(true);
    const audit = fs.readFileSync(auditFile(), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ action: 'set', flag: 'my-flag', by: 'admin' });
    expect(getFlagMetadata('my-flag')?.enabled).toBe(true);
  });

  it('disabled and expired flags resolve false', () => {
    setFlag('off', { enabled: false, scope: 'global' });
    setFlag('expired', { enabled: true, scope: 'global', expires_at: '2000-01-01T00:00:00.000Z' });
    expect(getFlag('off')).toBe(false);
    expect(getFlag('expired')).toBe(false);
  });

  it('role:admin flag resolves per the current user', () => {
    setFlag('admin-test', { enabled: true, scope: 'role:admin' });
    currentUser = ctx({ storageUserId: 'admin-user', isAdmin: true });
    expect(getFlag('admin-test')).toBe(true);
    currentUser = ctx({ storageUserId: 'regular-user', isAdmin: false });
    expect(getFlag('admin-test')).toBe(false);
  });

  it('getAllFlags returns resolved booleans', () => {
    setFlag('a', { enabled: true, scope: 'global' });
    setFlag('b', { enabled: false, scope: 'global' });
    const all = getAllFlags();
    expect(all.a).toBe(true);
    expect(all.b).toBe(false);
  });

  it('deleteFlag removes and audits', () => {
    setFlag('temp', { enabled: true });
    expect(deleteFlag('temp', 'admin')).toBe(true);
    expect(getFlagMetadata('temp')).toBeNull();
    expect(deleteFlag('temp')).toBe(false);
    const audit = fs.readFileSync(auditFile(), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(audit.some((e: { action: string; flag: string }) => e.action === 'delete' && e.flag === 'temp')).toBe(true);
  });

  it('getStaleFlags finds old flags with no expiry', () => {
    setFlag('fresh', { enabled: true });
    const cfg = JSON.parse(fs.readFileSync(flagsFile(), 'utf-8'));
    cfg.flags['ancient'] = { name: 'ancient', enabled: true, scope: 'global', created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' };
    fs.writeFileSync(flagsFile(), JSON.stringify(cfg));
    _resetFlagCache();
    const stale = getStaleFlags(30).map(f => f.name);
    expect(stale).toContain('ancient');
    expect(stale).not.toContain('fresh');
  });
});
