/**
 * Tests for the run-level helpers in src/shell/upload.ts: self-write
 * suppression, the upload-on-edit debounce, and download-then-upload.
 * Plus the 0.2.0 release metadata.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NetworkError, SyncCancelledError } from '../src/shell/errors';
import {
  EDIT_DEBOUNCE_MS,
  SelfWriteTracker,
  createTrailingDebounce,
  runDownloadThenUpload,
} from '../src/shell/upload';

describe('SelfWriteTracker (D-TRIG-2)', () => {
  it('suppresses the first modify within 10 s, once', () => {
    let now = 1000;
    const tracker = new SelfWriteTracker(() => now);
    tracker.mark('Journal/a.md');
    now += 9_000;
    expect(tracker.consume('Journal/a.md')).toBe(true);
    expect(tracker.consume('Journal/a.md')).toBe(false);
  });

  it('a mark expires after 10 s, so a real edit still counts', () => {
    let now = 1000;
    const tracker = new SelfWriteTracker(() => now);
    tracker.mark('Journal/a.md');
    now += 10_001;
    expect(tracker.consume('Journal/a.md')).toBe(false);
  });

  it('an unmarked path is never suppressed', () => {
    expect(new SelfWriteTracker(() => 0).consume('x.md')).toBe(false);
  });
});

describe('createTrailingDebounce (D-TRIG-1)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once, 2 minutes after the last of several pokes', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createTrailingDebounce(fn, EDIT_DEBOUNCE_MS);
    d.poke();
    vi.advanceTimersByTime(30_000);
    d.poke();
    vi.advanceTimersByTime(30_000);
    d.poke();
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS - 1);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel prevents the fire', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createTrailingDebounce(fn, EDIT_DEBOUNCE_MS);
    d.poke();
    d.cancel();
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS * 2);
    expect(fn).not.toHaveBeenCalled();
  });

  it('re-arms while a sync is busy instead of dropping the edit', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    let busy = true;
    const d = createTrailingDebounce(fn, EDIT_DEBOUNCE_MS, () => busy);
    d.poke();
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(fn).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(EDIT_DEBOUNCE_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('runDownloadThenUpload (D-RUN-1)', () => {
  it('runs the upload even when the download fails', async () => {
    const upload = vi.fn(async () => 'up');
    const out = await runDownloadThenUpload({
      download: async () => {
        throw new NetworkError('offline');
      },
      upload,
    });
    expect(out.download).toMatchObject({ ok: false });
    expect(out.upload).toEqual({ ok: true, value: 'up' });
  });

  it('keeps the download result when the upload fails', async () => {
    const out = await runDownloadThenUpload({
      download: async () => 'down',
      upload: async () => {
        throw new Error('boom');
      },
    });
    expect(out.download).toEqual({ ok: true, value: 'down' });
    expect(out.upload).toMatchObject({ ok: false });
  });

  it('a cancelled download (unload) skips the upload', async () => {
    const upload = vi.fn(async () => 'up');
    const out = await runDownloadThenUpload({
      download: async () => {
        throw new SyncCancelledError('bye');
      },
      upload,
    });
    expect(upload).not.toHaveBeenCalled();
    expect(out.upload).toBeNull();
  });

  it('uploadOnly skips the download', async () => {
    const download = vi.fn(async () => 'down');
    const out = await runDownloadThenUpload({ download, upload: async () => 'up', uploadOnly: true });
    expect(download).not.toHaveBeenCalled();
    expect(out.download).toBeNull();
  });

  it('runs download strictly before upload', async () => {
    const order: string[] = [];
    await runDownloadThenUpload({
      download: async () => {
        order.push('download');
      },
      upload: async () => {
        order.push('upload');
      },
    });
    expect(order).toEqual(['download', 'upload']);
  });
});
