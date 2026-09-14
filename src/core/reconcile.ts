/**
 * The decision, isolated from the doing.
 *
 * Spec §F.2 is a loop with five branches; this is those five branches as a
 * pure function over `(serverPage, existingFrontmatter)`. The adapter that
 * owns `vault` and `fileManager` does nothing but carry out the verdict, which
 * is what lets every rule in the design be tested without an Obsidian runtime
 * (§G).
 */

import type { Frontmatter, ServerPage } from './types';
import { JAVIS_DELETED } from './types';
import { fileRevision, isAdopted, mergeServerKeys } from './frontmatter';
import { pathForPage } from './slug';
import { render } from './render';

export type SkipReason =
  /** The file already holds this `javis_rev`. */
  | 'unchanged'
  /** The file carries `javis_sync: false`; the user adopted this page. */
  | 'adopted'
  /** The row is tombstoned and the file already says so. */
  | 'already-tombstoned'
  /** The row is tombstoned and no file was ever written for it. */
  | 'deleted-absent'
  /** `page_type` is not one of the nine; we have no folder for it. */
  | 'unknown-type';

export type SyncAction =
  | { kind: 'create'; path: string; content: string }
  | { kind: 'replace'; path: string; body: string; frontmatter: Frontmatter }
  | { kind: 'tombstone'; path: string }
  | { kind: 'skip'; reason: SkipReason };

/**
 * Decide what to do with one exported page.
 *
 * `existing` is the file's parsed frontmatter, or null when no file is at the
 * page's path. The distinction matters at every branch: this function reads the
 * FILE's frontmatter, never the server's, when deciding whether the user has
 * taken the page over.
 *
 * Branch order follows §F.2, with one addition argued at its branch: a
 * tombstone the file already records is a skip, because a deleted row stays in
 * every delta whose `since` predates the deletion.
 */
export function reconcile(page: ServerPage, existing: Frontmatter | null): SyncAction {
  const path = pathForPage(page.page_type, page.slug);
  if (path === null) {
    // A page type we have no folder for. Skipping is the only safe verdict:
    // inventing a folder would put files somewhere the user's links do not
    // point, and guessing a known type would write the wrong note.
    return { kind: 'skip', reason: 'unknown-type' };
  }

  if (page.deleted_at) {
    if (existing === null) {
      // Never create a file for a row that is already gone. The vault should
      // not grow a note the user has never seen just to mark it deleted.
      return { kind: 'skip', reason: 'deleted-absent' };
    }
    if (existing[JAVIS_DELETED] === true) {
      return { kind: 'skip', reason: 'already-tombstoned' };
    }
    return { kind: 'tombstone', path };
  }

  if (existing === null) {
    return { kind: 'create', path, content: render(page) };
  }

  // Before the revision check, not after: an adopted page must stay untouched
  // precisely when the server has moved on, which is exactly the case where the
  // revisions differ.
  if (isAdopted(existing)) {
    return { kind: 'skip', reason: 'adopted' };
  }

  if (fileRevision(existing) === page.updated_at) {
    return { kind: 'skip', reason: 'unchanged' };
  }

  return {
    kind: 'replace',
    path,
    body: page.body,
    frontmatter: mergeServerKeys(page, existing),
  };
}
