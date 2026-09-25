/**
 * 0.2.0 settings are additive: a 0.1.x `data.json` merged over the defaults
 * the way `loadSettings` does it (src/main.ts) yields the upload fields with
 * their defaults, i.e. nothing uploads until a folder is chosen.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../src/shell/contracts';
import { InsufficientScopeError, isAuthFatal } from '../src/shell/errors';

describe('upload settings defaults', () => {
  it('has typed, empty defaults', () => {
    expectTypeOf(DEFAULT_SETTINGS.uploadFolders).toEqualTypeOf<string[]>();
    expect(DEFAULT_SETTINGS.uploadFolders).toEqual([]);
    expect(DEFAULT_SETTINGS.uploadOnEdit).toBe(false);
    expect(DEFAULT_SETTINGS.uploadMemory).toEqual({});
    expect(DEFAULT_SETTINGS.lastUpload).toBeNull();
    expect(DEFAULT_SETTINGS.pendingReuploadAll).toBe(false);
  });

  it('a 0.1.x data.json loads with uploads off', () => {
    const old011 = {
      baseUrl: 'https://mcp.javis.is',
      oauthClient: null,
      syncOnVaultOpen: true,
      intervalEnabled: false,
      intervalMinutes: 30,
      cachedCursor: '2026-09-20T00:00:00Z',
      pendingFullResync: false,
      lastSyncAt: null,
      lastSyncSummary: null,
    };
    const merged = { ...DEFAULT_SETTINGS, ...old011 };
    expect(merged.uploadFolders).toEqual([]);
    expect(merged.uploadOnEdit).toBe(false);
    expect(merged.cachedCursor).toBe('2026-09-20T00:00:00Z');
  });
});

describe('InsufficientScopeError', () => {
  it('needs the user, is not retryable, and is not a revocation', () => {
    const err = new InsufficientScopeError();
    expect(err.code).toBe('insufficient-scope');
    expect(err.needsUserAction).toBe(true);
    expect(err.retryable).toBe(false);
    expect(isAuthFatal(err)).toBe(false);
    expect(err.message).toMatch(/Reconnect/);
  });
});
