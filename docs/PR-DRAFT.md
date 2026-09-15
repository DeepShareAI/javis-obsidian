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
