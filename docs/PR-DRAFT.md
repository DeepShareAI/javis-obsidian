# Javis Wiki Sync 0.2.0 — the upload half

Uploads the user's own notes, from folders they choose, into the Javis wiki,
and removes them again when the notes leave those folders. Off until a folder
is selected; a 0.2.0 install that never opts in makes exactly the 0.1.x
requests.

Implements step 4 of §I in
`javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md`
(§C.7, §E client side, §F.1–§F.5, the Plugin bullets of §H), following
`docs/plans/2026-09-24-upload-half.md` task by task. **The server half (PR 1
OAuth hardening, PR 2 contributions, PR 3 routes) is not in this repository**;
every request is coded against §E and tested against a fake transport. Do not
release this before PR 3 is deployed.

## What changed

- `src/core/` (pure: no Obsidian, no clock, no I/O)
  - `sha256.ts` — synchronous FIPS 180-4, cross-checked against `node:crypto`.
  - `note-text.ts` — the frontmatter scanner (pinned to `extractFrontmatterBlock`),
    `uploadText` (the PUT's `text`: BOM stripped, EOLs normalized, top-level
    `javis_*` keys removed, an empty block dropped), `noteHash`, and text-level
    readers for `javis_source_id` and `title`.
  - `stamp.ts` — `stampText`/`restampText`: one inserted line, byte-identical
    elsewhere, file's own line ending, refuses an unclosed fence, idempotent.
  - `folders.ts` — §F.3.1 validation.
  - `upload.ts` — `planUpload(local, server, memory, settings)`: every §F.1
    action and every §F.3 guard.
- `src/shell/`
  - `sources-api.ts` — `GET/PUT/DELETE /wiki/sources/obsidian`.
  - `upload.ts` — `uploadOnce` (enumerate, fresh read with a 10 s timeout, plan,
    stamp before PUT, PUT/DELETE, 429 backoff, one step-up, never throws),
    `SelfWriteTracker`, the edit debounce, `runDownloadThenUpload`.
  - `auth.ts` — `connect({scope, resource})`, `grantedScopes()`, `wikiResource`.
  - `vault.ts` — `readFresh` (`vault.read`), `processText`, `listNotesIn`. Still
    no delete or trash; a test now scans `src/` for either.
  - `settings.ts`, `folder-suggest.ts`, `review-modal.ts` — the Upload section
    and the **Review pending changes** command.
- `src/main.ts` — a run is download then upload in the same single-flight
  guard; `syncNow(trigger)` keeps its signature.
- README disclosure (§F.5); version 0.2.0 (`minAppVersion` unchanged 1.11.4).

## Decisions a reviewer should check

All are listed with rationale in the plan (§1). The ones that are judgment
calls rather than spec text:

- **D-HASH-2** A frontmatter block that is empty after removing `javis_*` lines
  is dropped with its fences, and so is one that was empty to begin with.
  Without it, stamping a note with no properties would change its hash.
  Property-tested over 29 fixtures.
- **D-PLAN-4, refined.** A listed note whose identity cannot be read
  (unreadable with no cached id, a hand-mangled id, an unclosed fence) keeps
  alive any row at its path; one at no known path holds **every** delete
  (`unreadable-ambiguous`). Path-presence is *not* granted by a readable note
  with a different, valid id: that note proves the row's note is gone. A
  readable note with **no** id at a live row's path (a 0-byte sync glitch, a
  cleared note, frontmatter rewritten by another plugin) is that row's note:
  blank → nothing is sent and nothing deleted; otherwise the same id is
  written back (`adopt`) and the edit goes through the normal put and
  shrink checks. (Review fix: before, such a note let the row be deleted and
  the note re-ingested as a new source.)
  Second review: only a note that may *hide* an identity (unreadable with no
  hint, or a damaged id line) holds deletes — a fully read note with no id
  line (a `---` horizontal rule at the top) no longer holds every delete for
  as long as it exists; and only a live row that no listed note carries can
  explain such a note by path, one note per row, so a rename swap or a
  deleted row's path no longer lets a possibly-renamed note's source go.
- **D-PLAN-8, changed in review.** An emptied or 80%-shrunk note is always
  held (`suspicious-edit`) and counts toward the mass-change threshold
  (§F.3.5 "its `put` is held with the deletes"; §H). It used to be held only
  when the cap tripped, which let one truncated note through on its own.
- **D-PLAN-18 (review): only this vault's rows.** The listing is per
  account, so a second vault on the same account used to have its rows
  deleted as "missing" in a loop. A row is now this vault's only when upload
  memory has it (a PUT from here, or a readable note here carrying its id);
  no other row is deleted, adopted, or counted toward the cap. Cost: a row
  whose note vanished while `data.json` was lost stays on the server.
  **For PR 3 / a later spec:** a per-vault id on PUT and a filtered GET would
  remove this heuristic.
- **D-PLAN-9** A blank note with no id is not stamped or uploaded.
- **D-PLAN-11** An invalid folder selection plans nothing at all.
- **D-PLAN-13** Deselecting a folder removes its notes after the debounce and
  the mass cap, **the last folder included** (review fix: the empty selection
  used to plan nothing, so the settings text and README were false for it).
  The upload half is skipped with no request only when no folder is selected
  *and* nothing uploaded is remembered (D-RUN-2).
- **D-RUN-4** Network errors and 429-after-4-retries stop the run, in addition
  to §F.2's auth failures; 400/409/413/5xx are per-note.
- **D-RUN-6** A 409 is reported, not restamped in the same run; the next run's
  listing shows the row deleted and restamps then.
- Stamps and restamps are followed by their PUT in the same run; a copy or a
  deleted-id carrier is uploaded as a new source immediately.
- **D-AUTH-1, changed in review.** Every connect sends `resource=<origin>/wiki`
  (§C.3 is unconditional); the union scope is added only once a folder is
  selected. A read-only 0.2.0 connect used to send no resource and got an
  `/mcp`-audience grant that a refresh can never move, i.e. every read-only
  install would break when the server drops the one-release grace on
  `/wiki/export`. Pre-PR 1 servers ignore the parameter. A read-only device
  still on the old audience sees a one-line reconnect hint in settings.
- **D-RUN-3, widened in review.** "Cannot write" = the decodable scope lacks
  `wiki:write` **or** the decodable `aud` is not `/wiki`. A background run
  then does not try. An interactive run steps up **before its first request**
  (so no note is stamped by a run that then gets a 403 and a declined
  consent), and a declined write grant stops it there. Undecodable tokens are
  tried, and a 403 drives the one step-up.
- **Folder validation is case-insensitive** (review fix): on APFS/NTFS a
  `sources` folder is the download's `Sources`. Notes carrying the download's
  `javis_slug`/`javis_type` are skipped as `wiki-page` wherever they sit.
- **Uploads refuse `http:`** unless the host is loopback (review fix): note
  text and a `wiki:write` bearer must not go in the clear.
- **A run that stops before planning keeps the previous held / skipped /
  waiting lists** in `lastUpload` (review fix), so "Review pending changes"
  survives a network blip.
- **`data.json` is sanitized by a tested pure function** (`settings-load.ts`);
  a malformed memory entry is repaired toward "unknown" (e.g. a non-number
  `missingSince` → null), which can only delay a delete.

## Wire contract to confirm against PR 3 (D-WIRE-1..4)

- `GET /wiki/sources/obsidian` → `200 {"sources": [Row], "counts": {status: n}}`,
  `Row = {source_id, vault_path, body_hash (64 hex), status, deleted: bool,
  last_error: str|null, undo_report: {pages_tombstoned, pages_rebuilt,
  pages_marked_stale, pages_skipped_adopted}|null}`. No paging. Any malformed
  row fails the whole response (it drives deletes).
- `PUT …/{uuid}` JSON `{vault_path, title, text, body_hash}`; 200 unchanged, 202
  accepted, 400 (with `detail`, shown to the user), 409, 413.
- `DELETE …/{uuid}` → 202 or 204.
- 403 carries `WWW-Authenticate: Bearer error="insufficient_scope", …`.
  **Please make an old-audience token on these routes answer 403
  insufficient_scope, not 401**: a 401 is treated as expiry (refresh, retry,
  then "reconnect"), which never triggers the step-up. The plugin now steps up
  before the first request whenever it can decode an `/mcp` audience, so this
  matters only for tokens it cannot decode.
- **D-HASH-5** `body_hash = sha256(utf8(text))` where `text` is exactly the sent
  string. Notes containing a lone UTF-16 surrogate are not uploaded; the server
  should not need `surrogatepass`.
- The privacy URL in the README (`https://javis.is/privacy`) must match PR 3's
  privacy page.

## Known limits

- Reads are sequential with a 10 s timeout each. A folder of many *blocking*
  iCloud dataless files makes a run slow (10 s per file) though never unsafe.
- `JavisWikiApiClient` still captures `baseUrl` at construction (D-API-2,
  pre-existing, out of scope); the new sources client reads it live.
- `uploadMemory` lives in `data.json`, which replicates between devices, but
  its `missingSince` clocks do not (review fix): the old claim that a shared
  clock could only delay a delete was false — device B could delete on its
  first scan using a clock device A wrote. Each device now keeps its own
  clocks in `app.saveLocalStorage` (per vault, per device), and `data.json`
  always carries `missingSince: null`, so every device needs its own two
  misses. Losing the local clocks restarts the debounce. Holds are re-derived
  by each device on every run.

## Tests

Measured on this branch, 2026-09-24:

```
vitest run       17 files, 542 tests passed (baseline 290; 503 before review fixes)
tsc -noEmit      exit 0
esbuild prod     exit 0
```

New: `note-text` 62, `upload-plan` 46, `upload` 28, `sources-api` 19,
`folders` 11, `stamp` 15, `run` 12, `sha256` 5, `settings-defaults` 3; additions
to `auth` (+9) and `vault` (+3).

UI (`settings.ts`, `folder-suggest.ts`, `review-modal.ts`, `main.ts`) is not
unit-tested, as before.

## Manual E2E runbook (spec §H), scratch vault against a local server

1. Connect read-only, select a folder, and step up.
2. Upload 10 notes.
3. Edit one note to remove a paragraph and see it leave the shared pages.
4. Rename a note.
5. Delete a note and see its pages tombstone or rebuild.
6. Empty the folder, confirm the deletes are held, restore the folder, and
   confirm the hold clears.
7. Evict files with iCloud and confirm nothing is deleted.

Then a copy of the real vault, then the real vault (§I.4).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

---

# Javis Wiki Sync — the initial plugin

Mirrors the Javis wiki into an Obsidian vault, one way, and never deletes a
file.

Implements Phase 1, step 3 of
`javis-server/docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md`.
Steps 1 and 2 (the `deleted_at` migration, `export_pages`, both front doors,
and the `javis_sync` check in `_upsert_page`) land in javis-server on
`feat/obsidian-wiki-export`; this repository is the client that makes them do
anything.

## What it does

One `GET /wiki/export` delta per run, paged to exhaustion, written into nine
folders at the vault root. `wiki_pages` is already a vault expressed
relationally — `page_type` is a folder, `slug` is a filename, `frontmatter` is
YAML properties, and bodies already contain `[[Concepts/Foo]]` in Obsidian's
own syntax. Nothing here converts one data model into another. It moves rows
onto disk and lets Obsidian do links, backlinks, graph, and search.

A synced note looks like this — `Concepts/Agent-Builder.md`:

```markdown
---
title: Agent Builder
aliases: ["Agent-Builder"]
javis_type: concept
javis_slug: Agent-Builder
javis_rev: 2026-09-13T04:12:00Z
javis_sync: true
---

%% javis:generated:start %%
Body markdown, with [[Concepts/Foo]] passed through verbatim.
%% javis:generated:end %%
```

Everything above and below the markers belongs to the user permanently.

## Module boundary

`src/core/` is the whole design as pure functions, and it contains **zero
references to `obsidian`** — verified by grep, not by convention:

| module | what it decides |
| --- | --- |
| `core/slug.ts` | `sanitizeSlug`, `TYPE_TO_PLURAL`, `pathForPage` |
| `core/markers.ts` | `replaceMarkerBlock`, `extractMarkerBlock` |
| `core/reconcile.ts` | the five §F.2 branches as one function over plain data |
| `core/render.ts` | `render`, `applyTombstone`, the tombstone banner |
| `core/frontmatter.ts` | key merge, alias union, list coercion, YAML emission |
| `core/types.ts` | the wire shapes, mirroring `app/tools/wiki/schemas.py` |

`src/shell/` is the part that talks to something: `api.ts` (HTTP), `auth.ts`
(OAuth), `vault.ts` (disk), `sync.ts` (the loop), `settings.ts` (the tab),
`errors.ts` (one sentence per failure a user can act on), `contracts.ts` (the
seams, declared with no `obsidian` import so `sync.ts` can be tested against a
fake `VaultAdapter`). `src/main.ts` is composition, the three triggers, and a
single-flight guard.

**Deviation from §G, stated plainly.** The spec says one module imports
`obsidian`. Four do, and the reasons differ:

- `shell/vault.ts` — the adapter proper. `App`, `TFile`, `SecretStorage`.
- `shell/settings.ts` — `PluginSettingTab` and `Setting`; a settings tab cannot
  be written without them.
- `src/main.ts` — `Plugin` and `Notice`.
- `shell/api.ts` — a lazy, memoized `require('obsidian')` for `requestUrl`
  alone, so the module stays importable under vitest.

What §G was actually protecting is intact: no decision in the design imports
`obsidian`, and `sync.ts` — the loop itself — does not either.

## OAuth, RFC 8252 loopback

No server change was needed. `_redirect_allowed` already accepts
`http://127.0.0.1`, and rejects `obsidian://`, so loopback was both the allowed
option and the one RFC 8252 recommends.

1. Bind a loopback listener on an OS-assigned port, and read the port back.
2. `POST /oauth/register` with `redirect_uris:
   ["http://127.0.0.1:<port>/callback"]`; cache `clientId` **together with**
   that exact string.
3. PKCE (S256, 43-char verifier) plus a CSRF `state`; open
   `/oauth/authorize` in the **system** browser.
4. Clerk sign-in; `/oauth/callback` redirects to the loopback listener, which
   checks `state` before trusting anything and closes its socket in a `finally`
   either way. 180s timeout.
5. `POST /oauth/token`; store both tokens in `app.secretStorage` (OS keychain).
6. On 401: one refresh, one retry of the same request. A second 401, or
   `invalid_grant`, clears both secrets and says "reconnect" once — it does not
   loop.

Two details the spec's step ordering gets wrong and the code had to invert or
add. Steps 1 and 2 are **inverted**: `/oauth/authorize` compares `redirect_uri`
against the registered list by exact string, and the string contains the
ephemeral port, so the listener must exist before registration. And the refresh
token **rotates** on every use, so the new one is persisted before the refresh
resolves; persisting it afterwards would log the user out on the following run.

`JavisSettings` has no token-shaped field, and `contracts.ts` carries a
compile-time assertion that fails the build if anyone adds one. `data.json`
lives inside the vault and replicates wherever the vault does.

## Triggers

All three of §F.4, all routed through one `syncNow`:

- **Vault open**, inside `onLayoutReady` and then delayed, so the load-event
  storm is over first. On by default.
- **Interval**, default 30 minutes, **off** by default, minutes clamped on read
  so a hand-edited `data.json` cannot reach `setInterval`.
- **`Sync now`** from the command palette, plus a ribbon icon and a settings
  button.

`#running` is the whole concurrency story: a second trigger during a run is
refused with a Notice, not queued. Queueing is the same double write with a
delay in front of it.

## Safety

- **Never unlink.** `VaultAdapter` exposes no delete primitive, so `sync.ts` has
  none to call, and `ObsidianVaultAdapter` keeps `App` private. A deleted row
  blanks the marker block, sets `javis_deleted: true`, and prepends a callout
  explaining why the body emptied. The note stays.
- **Marker-block replacement only.** No merge step, so no merge failures.
  `replaceMarkerBlock` returns everything outside the markers byte for byte, and
  is idempotent on every input including a file with no markers, an empty file,
  and an unclosed `start` marker.
- **Frontmatter is the state.** Per-page state is `javis_rev` in that page's own
  frontmatter; the cursor in `data.json` is a cache over `max(javis_rev)` across
  the vault. Losing, corrupting, or git-conflicting `data.json` costs a rescan.
- **`javis_sync: false` is read from the file, never the server.** The user
  types it and the plugin stops writing that note immediately, before the
  revision check — an adopted page must stay untouched precisely when the
  server has moved on.
- **Writes go through Obsidian.** `Vault.process` and
  `FileManager.processFrontMatter`, never a direct filesystem write, so the
  plugin does not race an open editor's save cycle.
- **Failure is isolated, and does not lose a row.** A note the vault refuses is
  one line in `SyncResult.failures`; the run continues but does not advance the
  cursor. When the cursor came from the vault rescan rather than from
  `data.json`, withholding it is not enough — the rows that did land raise
  `max(javis_rev)` past the row that did not — so the run also sets
  `pendingFullResync` and the next run asks for everything.
- **No stub files** for unresolved links. Obsidian tracks those natively.
- **Byte-stable output.** Frontmatter key order is fixed so an unchanged page
  re-renders identically and does not show up as a change to Obsidian Sync,
  iCloud, or git.

## Tests

Measured on this branch, 2026-09-14:

```
vitest run       8 files, 289 tests passed
tsc -noEmit      exit 0
esbuild prod     exit 0, main.js 33,276 bytes
```

Per file: `auth` 74, `api` 65, `sync` 46, `vault` 41, `render` 26, `reconcile`
15, `slug` 11, `markers` 11.

The companion javis-server branch `feat/obsidian-wiki-export` is at **1705
passed, 7 skipped**.

`ObsidianVaultAdapter` against a real `App` is not unit-tested, by design; the
adapter tests run against a fake. It is exercised by hand in a scratch vault.

## Out of scope for Phase 1

Write-back to `wiki_pages`. Transcripts, daily notes, `skill_data`. Stub files
for unresolved links. Any file deletion. A conflict-resolution UI. Mobile
(`isDesktopOnly: true` — the loopback listener is `node:http`). A generated
`.base` file. Submission to the Obsidian community catalogue; installation is
BRAT or manual. None of these is foreclosed.

## Reviewing this

Read `src/core/` first — every rule in the design is there, in about 600 lines,
and it takes no Obsidian runtime to judge. Then `shell/sync.ts`, which is the
§F.2 loop and nothing else. `shell/auth.ts` is the longest file and the one
where a mistake costs the most.

Two open questions from §K of the spec are **still unanswered**: how many
`wiki_pages` rows exist in production, and whether any production slug contains
a filename-illegal character. The first decides whether the export needs a
materialization filter before this is pointed at a real vault; the second
decides whether `sanitizeSlug` is a formality or load-bearing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01EzwLfBfi4bBRwxH7xefsjA
