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

// ---------------------------------------------------------------------------
// The debounce clock is per device (review, §F.3.3)
// ---------------------------------------------------------------------------

/**
 * `localStorage` key (via `app.saveLocalStorage`, which is per vault AND per
 * device) for `{sourceId → missingSince}`.
 *
 * §F.3.3 asks for two misses at least five minutes apart, as seen by the
 * listing that is deciding. `data.json` replicates between devices (Sync,
 * iCloud, git), so a `missingSince` written by device A — during a
 * half-finished checkout, say, and never cleared because A was closed — used
 * to reach device B, whose very first scan could then plan the delete: B's
 * own vault-open run, with its initial sync still bringing files in, missed
 * the note once and deleted it. The claim that shared memory could only
 * restart a debounce was wrong. So the clock never enters `data.json`: the
 * synced memory carries `missingSince: null`, and each device keeps its own
 * clocks here. A device that loses them (a cleared profile, a new machine)
 * restarts the debounce, which only delays a delete.
 */
export const MISSING_SINCE_STORAGE_KEY = 'javis-wiki-sync:upload-missing-since';

/** Device-local clocks, repaired toward "unknown": a bad value is dropped. */
export function sanitizeMissing(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value)) {
    const id = key.toLowerCase();
    const at = count(raw);
    if (isUuid(id) && at !== null) out[id] = at;
  }
  return out;
}

/** `nextMemory` → what goes to `data.json` (no clocks) and what stays on this device. */
export function splitMissing(memory: UploadMemory): { synced: UploadMemory; missing: Record<string, number> } {
  const synced: UploadMemory = {};
  const missing: Record<string, number> = {};
  for (const [id, entry] of Object.entries(memory)) {
    synced[id] = { ...entry, missingSince: null };
    if (entry.missingSince !== null) missing[id] = entry.missingSince;
  }
  return { synced, missing };
}

/** The memory `planUpload` sees: the synced entries with THIS device's clocks. */
export function joinMissing(synced: UploadMemory, missing: Record<string, number>): UploadMemory {
  const out: UploadMemory = {};
  for (const [id, entry] of Object.entries(synced)) out[id] = { ...entry, missingSince: missing[id] ?? null };
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
  // No debounce clock is trusted from data.json: whichever device wrote it,
  // it did not come from this device's listing (see MISSING_SINCE_STORAGE_KEY).
  s.uploadMemory = splitMissing(sanitizeMemory(s.uploadMemory)).synced;
  s.uploadOnEdit = s.uploadOnEdit === true;
  s.pendingReuploadAll = s.pendingReuploadAll === true;
  s.lastUpload = lastUpload(s.lastUpload);
  return s;
}
