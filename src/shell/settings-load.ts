/**
 * Loading `data.json`: the defaults, merged with whatever is on disk, made safe.
 *
 * Spec §D (what `data.json` may hold), 2026-09-24 §F.1 ("memory ... Losing it
 * only delays deletes").
 *
 * Pure, and outside settings.ts, so it can be tested: settings.ts imports
 * `obsidian` and is not unit-tested, and until review this logic lived in
 * `main.ts#loadSettings`, where the only test that claimed to cover it rebuilt
 * the merge by hand and never ran it.
 *
 * `data.json` is inside the vault. It is hand-edited, written by older
 * versions, and replicated between devices by Sync, iCloud or git — so every
 * field is checked against its declared type, and the rule for anything that
 * does not fit is the one §F.1 allows: repair toward "unknown", which can only
 * ever DELAY a delete. `uploadMemory` is where that matters. `planUpload` does
 * arithmetic on `missingSince`; a string there turned `missingSince +
 * DEBOUNCE_MS` into string concatenation, and the comparison that followed
 * could make a delete eligible on the first run, skipping the §F.3.3 two-scan
 * debounce. A bad `missingSince` is now null, which restarts the debounce.
 */

import { normalizeFolder } from '../core/folders';
import { isUuid } from '../core/note-text';
import type { MemoryEntry, UploadMemory } from '../core/upload';
import type { JavisSettings, LastUploadReport } from './contracts';
import { DEFAULT_SETTINGS } from './contracts';

/** Bounds on the interval field. Below a minute the plugin is a busy-loop. */
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 24 * 60;

/** Keep a typo out of `setInterval`. A blank or absurd value keeps the old one. */
export function clampMinutes(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < MIN_INTERVAL_MINUTES) return MIN_INTERVAL_MINUTES;
  if (parsed > MAX_INTERVAL_MINUTES) return MAX_INTERVAL_MINUTES;
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite, non-negative number, else null ("unknown"). */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * One memory entry, repaired, or null to drop it. The key must be a uuid (it
 * is a source id; the server refuses anything else) and `path` a string (it
 * is what presence and the keeper rule compare). The other fields fall back to
 * null, their documented "unknown": no hash, no shrink check, no debounce yet.
 */
function memoryEntry(value: unknown): MemoryEntry | null {
  if (!isRecord(value) || typeof value['path'] !== 'string') return null;
  return {
    path: value['path'],
    hash: typeof value['hash'] === 'string' ? value['hash'] : null,
    bytes: count(value['bytes']),
    missingSince: count(value['missingSince']),
  };
}

export function sanitizeMemory(value: unknown): UploadMemory {
  const out: UploadMemory = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const id = key.toLowerCase();
    if (!isUuid(id)) continue;
    const entry = memoryEntry(raw);
    if (entry !== null) out[id] = entry;
  }
  return out;
}

/**
 * The last run's report, or null. Only its shape is checked — the lists the
 * settings tab and "Review pending changes" iterate — because it is display
 * state: a malformed one is dropped and the next run writes a fresh one.
 */
function lastUpload(value: unknown): LastUploadReport | null {
  if (!isRecord(value)) return null;
  const lists = ['failures', 'skipped', 'held', 'waiting', 'invalidFolders', 'undoReports'] as const;
  if (!lists.every((key) => Array.isArray(value[key]))) return null;
  if (!isRecord(value['counts']) || typeof value['summary'] !== 'string' || typeof value['at'] !== 'string') {
    return null;
  }
  return value as unknown as LastUploadReport;
}

/** `loadData()`'s result → settings every other module can trust. */
export function sanitizeSettings(stored: unknown): JavisSettings {
  const s: JavisSettings = { ...DEFAULT_SETTINGS, ...(isRecord(stored) ? (stored as Partial<JavisSettings>) : {}) };
  s.intervalMinutes = clampMinutes(String(s.intervalMinutes), DEFAULT_SETTINGS.intervalMinutes);
  s.uploadFolders = Array.isArray(s.uploadFolders)
    ? s.uploadFolders.filter((f): f is string => typeof f === 'string').map(normalizeFolder)
    : [];
  s.uploadMemory = sanitizeMemory(s.uploadMemory);
  s.uploadOnEdit = s.uploadOnEdit === true;
  s.pendingReuploadAll = s.pendingReuploadAll === true;
  s.lastUpload = lastUpload(s.lastUpload);
  return s;
}
