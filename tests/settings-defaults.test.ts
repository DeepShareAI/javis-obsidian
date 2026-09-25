/**
 * 0.2.0 settings are additive: a 0.1.x `data.json` run through
 * `sanitizeSettings` (what `loadSettings` in src/main.ts calls) yields the
 * upload fields with their defaults, i.e. nothing uploads until a folder is
 * chosen. And a malformed field can only be repaired toward "unknown".
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../src/shell/contracts';
import { joinMissing, sanitizeMissing, sanitizeSettings, splitMissing } from '../src/shell/settings-load';
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
    const loaded = sanitizeSettings(old011);
    expect(loaded.uploadFolders).toEqual([]);
    expect(loaded.uploadOnEdit).toBe(false);
    expect(loaded.uploadMemory).toEqual({});
    expect(loaded.lastUpload).toBeNull();
    expect(loaded.cachedCursor).toBe('2026-09-20T00:00:00Z');
    expect(loaded.intervalMinutes).toBe(30);
  });

  it('no data.json at all is the defaults', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('garbage')).toEqual(DEFAULT_SETTINGS);
  });
});

describe('sanitizeSettings (review: loadSettings was untested and trusted memory entries)', () => {
  const ID = '00000000-0000-4000-8000-000000000001';

  it('clamps the interval and normalizes folders', () => {
    const s = sanitizeSettings({ intervalMinutes: 1, uploadFolders: [' /Journal/ ', 7, 'Inbox'] });
    expect(s.intervalMinutes).toBe(5);
    expect(s.uploadFolders).toEqual(['Journal', 'Inbox']);
  });

  it('a non-number missingSince can only DELAY a delete: it becomes null (the debounce restarts)', () => {
    const s = sanitizeSettings({
      uploadMemory: { [ID]: { path: 'J/a.md', hash: 'h', bytes: 10, missingSince: '2026' } },
    });
    expect(s.uploadMemory[ID]!.missingSince).toBeNull();
  });

  it('repairs wrong-typed hash and bytes to "unknown", and drops entries it cannot use', () => {
    const s = sanitizeSettings({
      uploadMemory: {
        [ID.toUpperCase()]: { path: 'J/a.md', hash: 3, bytes: '10', missingSince: Number.NaN },
        'not-a-uuid': { path: 'J/b.md', hash: null, bytes: 1, missingSince: null },
        '00000000-0000-4000-8000-000000000002': { path: 5 },
        '00000000-0000-4000-8000-000000000003': 'x',
        '00000000-0000-4000-8000-000000000004': { path: 'J/d.md', hash: null, bytes: -1, missingSince: 1.5e12 },
      },
    });
    expect(s.uploadMemory).toEqual({
      [ID]: { path: 'J/a.md', hash: null, bytes: null, missingSince: null },
      // Any debounce clock in data.json is dropped: see the next describe.
      '00000000-0000-4000-8000-000000000004': { path: 'J/d.md', hash: null, bytes: null, missingSince: null },
    });
  });

  it('a lastUpload from before serverFailures existed loads with an empty list', () => {
    const old = { failures: [], skipped: [], held: [], waiting: [], invalidFolders: [], undoReports: [], counts: {}, summary: 's', at: 'x' };
    expect(sanitizeSettings({ lastUpload: old }).lastUpload?.serverFailures).toEqual([]);
    expect(sanitizeSettings({ lastUpload: { ...old, serverFailures: 'x' } }).lastUpload?.serverFailures).toEqual([]);
  });

  it('a lastUpload without its lists is dropped rather than crashing the settings tab', () => {
    expect(sanitizeSettings({ lastUpload: { summary: 'x' } }).lastUpload).toBeNull();
    expect(sanitizeSettings({ lastUpload: [] }).lastUpload).toBeNull();
  });

  it('booleans are booleans', () => {
    const s = sanitizeSettings({ uploadOnEdit: 'yes', pendingReuploadAll: 1 });
    expect(s.uploadOnEdit).toBe(false);
    expect(s.pendingReuploadAll).toBe(false);
  });
});

describe('missingSince is per device, never in the synced data.json (review, §F.3.3)', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';

  it('a missingSince another device wrote into data.json is not trusted: the debounce restarts here', () => {
    const s = sanitizeSettings({ uploadMemory: { [A]: { path: 'J/a.md', hash: null, bytes: 1, missingSince: 1.5e12 } } });
    expect(s.uploadMemory[A]!.missingSince).toBeNull();
  });

  it('split keeps the clocks out of what is synced; join puts only this device\'s back', () => {
    const { synced, missing } = splitMissing({
      [A]: { path: 'J/a.md', hash: 'h', bytes: 1, missingSince: 100 },
      [B]: { path: 'J/b.md', hash: null, bytes: null, missingSince: null },
    });
    expect(synced).toEqual({
      [A]: { path: 'J/a.md', hash: 'h', bytes: 1, missingSince: null },
      [B]: { path: 'J/b.md', hash: null, bytes: null, missingSince: null },
    });
    expect(missing).toEqual({ [A]: 100 });
    // A clock for an id no longer remembered is dropped on join.
    expect(joinMissing(synced, { ...missing, '00000000-0000-4000-8000-00000000000c': 5 })).toEqual({
      [A]: { path: 'J/a.md', hash: 'h', bytes: 1, missingSince: 100 },
      [B]: { path: 'J/b.md', hash: null, bytes: null, missingSince: null },
    });
  });

  it('device-local clocks are sanitized toward "unknown"', () => {
    expect(sanitizeMissing(null)).toEqual({});
    expect(sanitizeMissing('x')).toEqual({});
    expect(sanitizeMissing({ [A.toUpperCase()]: 7, [B]: '8', 'not-a-uuid': 1, '00000000-0000-4000-8000-00000000000c': -1 })).toEqual({
      [A]: 7,
    });
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
