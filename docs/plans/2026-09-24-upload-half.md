# Plan: javis-obsidian 0.2.0, the upload half

**Spec (authoritative):** `javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md`
(§C.7, §E, §F.1–§F.5, the Plugin bullets of §H, §I step 4).
**Branch:** `feat/upload-half` (from `origin/main` @ `f25d934`).
**Baseline:** `npm test` = 290 passed (8 files); `npm run build` = `tsc -noEmit -skipLibCheck` + esbuild.

The server half (PR 1 OAuth hardening, PR 2 contributions, PR 3 routes) does not
exist in this worktree. Every HTTP shape below is coded against spec §E and
tested against a fake transport. Where §E leaves a key name open, this plan fixes
one and marks it **Decision (wire)**, so the PR 3 implementer can match it or
push back.

---

## 0. Ground truth read before planning

| What | Where | Why it matters here |
| --- | --- | --- |
| Core purity rule: "no Obsidian import, no filesystem, no clock" | `README.md:187-189` | `planUpload`, the stamp inserter, the hash, and folder validation all go in `src/core/`. The clock arrives as a number argument. |
| `VaultAdapter` has no delete and must never get one | `src/shell/contracts.ts:292-375`, `src/shell/vault.ts:17-22,285-299` | The upload vault seam is a separate, narrower interface with no delete either. |
| `read()` uses `cachedRead` on purpose for the download | `src/shell/vault.ts:301-314` | §F.2 needs `vault.read` for upload. Add a new method. Do not change `read()`, because the download depends on its documented behavior. |
| `process()` returns `void` | `src/shell/vault.ts:378-387`, contracts `:349` | The stamp needs the post-transform text (`Vault.process` returns `Promise<string>`, obsidian.d.ts:7510). Add `processText`. |
| Frontmatter fence rule (first line `---`, first later line exactly `---`, BOM skipped, CRLF normalized) | `src/shell/vault.ts:143-169` `extractFrontmatterBlock` | The stamp and the hash must agree with it. It is a pure helper that lives in the shell today. The core gets its own byte-preserving scanner (the shell one normalizes CRLF, and the stamp must not). The core scanner is tested to agree with `extractFrontmatterBlock` on fence detection. |
| Nine wiki folders | `src/core/slug.ts:18-28` `TYPE_TO_PLURAL`; `src/shell/vault.ts:102-104` `MANAGED_FOLDERS` | Folder validation (§F.3.1) takes the folder list from `TYPE_TO_PLURAL` in core. `MANAGED_FOLDERS` is in the shell, so core cannot import it. |
| `requestUrl` adapter with `throw: false`, transport seam, `headerValue`, `parseRetryAfterMs`, `parseJsonBody` | `src/shell/api.ts:87-180, 245-283, 396-405` | Reused unchanged by the new sources client. |
| 401 → one `refresh()` → one retry → `AuthExpiredError` | `src/shell/api.ts:556-575` | The sources client copies the same sequence. It does not refactor `JavisWikiApiClient.send` (see Decision D-API-1). |
| Scope is hard-coded `mcp:read`; `buildAuthorizeUrl` has no `resource` | `src/shell/auth.ts:71, 195-227` | Needs `scope` and `resource` parameters for step-up (§C.7). |
| `connect()` builds the URL without a scope argument | `src/shell/auth.ts:573-626` | It gains an optional `{scope, resource}`. |
| The token response carries `scope`, and the JWT signs `scope` and `aud` | server `javis_mcp/oauth/token.py:83-97, 127-140` (read-only check in the server worktree) | The granted scope can be read from the access token already in the keychain, so no new storage is needed. |
| JWT decode helper exists | `src/shell/auth.ts:294-307` `decodeJwtExpiry` | Add a sibling `decodeJwtClaims`/`grantedScopes`. |
| Single-flight guard, triggers, `onLayoutReady` + 2s delay, fire-and-forget `syncNow` | `src/main.ts:57-60, 118-126, 199-262` | Download-then-upload goes inside the same guarded run. GitNexus: `syncNow` is **HIGH** risk (4 direct callers, 3 processes: `onload`, `renderTriggers`, `renderConnection`), so its signature and return type stay as they are. |
| `JavisSettings` + `DEFAULT_SETTINGS` + no-token compile guard | `src/shell/contracts.ts:462-536` | GitNexus: `JavisSettings` is **HIGH** risk (18 direct). Changes are additive fields only, each with a default. `loadSettings` (`src/main.ts:146-155`) spreads defaults, so old `data.json` files load. |
| Error vocabulary with `code`, `retryable`, `needsUserAction` | `src/shell/errors.ts:20-67` | Add `InsufficientScopeError` (`'insufficient-scope'`). |
| Settings tab sections | `src/shell/settings.ts:49-73` | Add `renderUpload(containerEl)`. |
| Obsidian API | `node_modules/obsidian/obsidian.d.ts` (1.13.1): `AbstractInputSuggest` L294 (1.4.10), `getAllFolders` L7531 (1.6.6), `getMarkdownFiles` L7543, `read` L7412, `process` L7510, `on('modify')` L7564 | All are within `minAppVersion` 1.11.4. |
| GitNexus impact (repo `javis-obsidian`) | `buildAuthorizeUrl` LOW (0 upstream); `JavisOAuth.connect` LOW (1 direct: settings); `syncNow` HIGH; `JavisSettings` HIGH | Re-run `impact` before editing any other existing symbol (listed per task). |

---

## 1. Decisions (ambiguity resolutions)

Each has a one-line rationale. The conservative option wins unless the spec says otherwise.

**Hash and text**
- **D-HASH-1** The PUT's `text` is the *normalized* note, `uploadText(raw)`: leading U+FEFF stripped, `\r\n` and lone `\r` → `\n`, and top-level `javis_*:` lines inside the frontmatter block removed along with their indented continuation lines. `body_hash = sha256(utf8(text))` as 64 lowercase hex. §B.1 stores the body "with javis_* lines removed", and §E rejects `sha256(text) != body_hash`, so hashing exactly what is sent is the only reading where both hold.
- **D-HASH-2** A frontmatter block that is empty *after* removal is dropped together with its fences, **and so is one that was empty to begin with**. Without the second half, `hash(stamp(t)) == hash(t)` fails for a note with no frontmatter (the stamp prepends a fence pair) and for a note with an empty `---\n---` block. This is the "stamping never looks like an edit" property, and it is property-tested.
- **D-HASH-3** SHA-256 is a pure synchronous TypeScript implementation in `src/core/sha256.ts`, over `TextEncoder` bytes. It is cross-checked in tests against `node:crypto`. Keeps core pure and `planUpload` synchronous, and adds no dependency. Web Crypto is async and a global side channel.
- **D-HASH-4** `bytes` = UTF-8 length of the normalized `text`. `skip-oversize` when `bytes > 262144`. The server's 413 remains the backstop and is recorded as oversize.
- **D-HASH-5** Note for PR 3: a lone UTF-16 surrogate becomes U+FFFD under `TextEncoder`, while Python `str.encode('utf-8')` raises. The plugin hashes what `TextEncoder` produces, and `JSON.stringify` sends the lone surrogate. The server should hash `text.encode('utf-8', 'surrogatepass')`, or the plugin should reject such notes. **Plugin choice:** a note whose text contains a lone surrogate is `skip-unreadable` with the reason "contains invalid characters". It fails closed, and the case is rare.

**Identity and stamp**
- **D-ID-1** The id is read from the text, from the first top-level `javis_source_id:` line inside the frontmatter block, never through `parseYaml`/`metadataCache`. Identity must not depend on the rest of the user's YAML being valid. One layer of `'`/`"` quotes is stripped.
- **D-ID-2** A `javis_source_id` value that is not a canonical uuid (8-4-4-4-12 hex, case-insensitive, lowercased for the wire) → `skip-invalid-id`, reported in settings. The file is not touched. Rewriting a line the user hand-edited is an unrequested edit.
- **D-ID-3** Uuids come from `crypto.randomUUID()` in the shell, injected as `newId: () => string`. The core never generates one.
- **D-STAMP-1** The stamp uses the file's own line ending (the first line break found, default `\n`) for the inserted line(s), so a CRLF file stays uniformly CRLF. Byte-identity is asserted on everything except the one inserted line (or the three prepended lines).
- **D-STAMP-2** With a BOM, "prepend" means directly after the BOM, and fence detection skips the BOM (matching `extractFrontmatterBlock`, `src/shell/vault.ts:159`).
- **D-STAMP-3** The transform passed to `vault.process` is `stampText(content, id)`. It is idempotent: a content that already has a `javis_source_id:` line is returned unchanged. After `process` resolves, the shell re-reads the id from the returned text. If sync delivered another device's stamp between our read and our write, we adopt that id rather than ours.
- **D-STAMP-4** `restamp` is `restampText(content, newId)`: it replaces only the value on the existing top-level `javis_source_id:` line in the frontmatter, byte-identical elsewhere. Its transform is idempotent by checking "already this id".
- **D-STAMP-5** "Malformed" = an opening fence with no closing fence (§F.2). Syntactically invalid YAML inside a closed block is *not* malformed for our purposes, because the insert is text-level and cannot make it worse. Reported as `unstampable`.

**planUpload**
- **D-PLAN-1** Signature: `planUpload(local, server, memory, settings)`. `settings` = `{folders, configDir, now, reuploadAll, release}`. The injected clock is `settings.now` (epoch ms). `planUpload` returns `{actions, held, skipped, waiting, nextMemory, invalidFolders}`. `nextMemory` carries the `missingSince` bookkeeping, because the pure function is the only place that knows it. The shell merges successful PUT and DELETE outcomes into it.
- **D-PLAN-2** `LocalNote` = spec shape + `blank: boolean` (normalized text is whitespace-only) + `invalidChars: boolean` (D-HASH-5). "Reads as empty" (§F.3.5) cannot be derived from `bytes` when an editor leaves a newline behind.
- **D-PLAN-3** For an unreadable note, the shell fills `sourceId` from `metadataCache` frontmatter when the cache has it. It is a hint that can only *prevent* a delete, never cause a put.
- **D-PLAN-4** "Unreadable is unknown", made precise. A live server row counts as **present** if any listed note (readable or not) carries its id, or if any listed note sits at the row's server `vault_path` or its memory `path`. If a row is not present but there is an **unattributed** unreadable note (unreadable, no id hint, path matching no row or memory entry), that row's delete is held with reason `unreadable-ambiguous`. The evicted file could be that note after a rename.
- **D-PLAN-5** Debounce: the first run that sees a live row missing sets `missingSince = now` in `nextMemory` (creating the entry if memory was lost). A delete is planned only when `now - missingSince >= 300_000`. A row that is present again gets `missingSince = null`. Rows still inside the debounce appear in `waiting` (shown in settings as "will be removed after …"), not in `held`.
- **D-PLAN-6** Vanished folder: a selected folder with **no listed note under it** (missing and empty look the same in the listing, and unreadable notes count as listed) while live rows have server `vault_path` under it → every delete candidate whose server `vault_path` is under that folder is held with `vanished-folder`.
- **D-PLAN-7** Mass-change threshold `T = min(50, max(5, floor(0.2 × live)))`, where `live` = server rows with `deleted: false`. `count` = every delete candidate past the debounce (including ones already held by D-PLAN-4/6, which is the stricter count) + every suspicious put. When `count > T`, all deletes and all suspicious puts are held with `mass-change`. Floor, not ceil, and a strict `>`, are the smaller-threshold reading.
- **D-PLAN-8** Suspicious put = a `put` against a live server row whose hash differs, where either `blank` is true, or memory has `bytes` for that id and `local.bytes < 0.2 × memory.bytes`. Without memory, only the blank test applies (§F.1: losing memory "re-evaluates shrink checks"). A suspicious put is held only when the threshold trips, per §F.3.5 "held with the deletes". A single blank edit below the threshold is sent. This is spec-literal, and the conservative alternative (always hold blanks) is noted for review.
- **D-PLAN-9** A readable, blank note with no id and no server row → `skip-blank`: no stamp and no put. Stamping every freshly created `Untitled.md` is an unrequested write, and uploading nothing costs an LLM call.
- **D-PLAN-10** Copy rule: when several local notes share an id, the keeper is the note whose path equals the server row's `vault_path`. Failing that, the note whose path equals memory's `path`. Failing that, the lexicographically smallest path (deterministic, so two devices agree). All others get `restamp`. A server row with `deleted: true` → `restamp` for every local carrier.
- **D-PLAN-11** Any invalid selected folder (§F.3.1) makes `planUpload` return **no actions at all** plus `invalidFolders`. A bad selection (hand-edited `data.json`, a folder later renamed into a wiki folder) must not produce deletes. The UI prevents adding one in the first place.
- **D-PLAN-12** Defensive filter: a `LocalNote` whose path is not `.md` or not under a selected folder is ignored (as though unlisted, so it cannot count as present). The shell should never hand one over, and the core does not trust that.
- **D-PLAN-13** Deselecting a folder is "moving its notes out" (§Goals). Those rows go through the debounce and the mass cap like any other delete. The settings UI says so when a folder is removed.
- **D-PLAN-14** `release` is the set of hold keys the user confirmed (`put:<id>` / `delete:<id>`). A held action whose key is in `release` is emitted as an action instead. Holds are re-derived every run (§F.3.6), so a release only applies to what is *still* held when the confirming run plans.
- **D-PLAN-15** `reuploadAll` bypasses only the "hash and path equal → nothing to do" filter. It does not bypass any guard. Whether an equal-hash PUT resets `attempts` is PR 3's call (§D.5 vs §E wording). The plugin just sends the PUT.
- **D-PLAN-16** Action order: `stamp`/`restamp`/`put` first (by path), then `delete` (by id). A put can never race a delete of the same id, because a carried id is never a delete candidate.
- **D-PLAN-17** Title = the top-level `title:` scalar in the frontmatter block (text-level, quotes stripped, first line only), else the filename without `.md`. It is truncated to 500 chars (§B.1 `String(500)`).

**Folder validation**
- **D-FOLD-1** Paths are normalized first: trim, strip leading and trailing `/`, collapse `//`. Invalid: empty/root; `configDir` (`app.vault.configDir`, default `.obsidian`) or anything under it; any of the nine `TYPE_TO_PLURAL` folders or anything under one (case-sensitive, to match the download's own writes); a folder that is an ancestor or descendant of another selected folder; duplicates. Also invalid: any segment starting with `.`, because hidden folders are not indexed by Obsidian, so notes there are never listed and would look deleted.

**Shell run**
- **D-RUN-1** A run is download, then upload, inside the existing single-flight guard. Each half has its own try/catch, and each runs even if the other failed. **Exception:** a `SyncCancelledError` (unload) skips the upload.
- **D-RUN-2** The upload half is skipped with no request when no folder is selected. Old installs make exactly the 0.1.x requests.
- **D-RUN-3** The upload half is skipped (status "Uploads paused: reconnect to allow writing to your wiki") when the access token's decodable `scope` claim lacks `wiki:write`. An undecodable token → try it, and let a 403 drive step-up.
- **D-RUN-4** Run-level (stops the upload half, keeps `nextMemory` and progress): `AuthRequired/Expired/Revoked`, `InsufficientScopeError` after the one step-up, `SyncCancelledError`, `NetworkError`, `ProtocolError` on the GET, and `RateLimitedError` after backoff is exhausted. Per-note (collected in `failures`, the run continues): PUT/DELETE 400, 409, 413, other 4xx, 5xx, and a vault read or stamp failure. §F.2 says only "an auth failure stops the run". Network and exhausted rate-limit are added because they recur on every remaining note and would otherwise produce thousands of identical failure lines and extra load on the 120/min bucket.
- **D-RUN-5** 429 backoff: wait `Retry-After` if sent, else `min(60s, 2^n × 1s)`, with at most 4 retries of the same request. The sleep is injected and cancellable. Once retries are exhausted → run-level `RateLimitedError`.
- **D-RUN-6** 409 on PUT → per-note failure "was removed from Javis; will re-upload as a new note". No in-run restamp. The next run's GET shows `deleted: true`, and D-PLAN-10 restamps. This keeps "one decision per run, from the plan".
- **D-RUN-7** `uploadOnce` never throws. It returns `UploadResult` with `stoppedBy: {code, message} | null`, so memory and partial progress are always persisted.
- **D-RUN-8** The read timeout is 10 s via `Promise.race` with an injected `timeoutMs`. A late-completing read is ignored.
- **D-RUN-9** The PUT sends the normalized text of what `vault.process` returned after the stamp (D-STAMP-3), not the earlier read. For an unstamped `put`, it sends what `vault.read` returned.
- **D-RUN-10** `nextMemory` is persisted at the end of every upload half (success or stop) via `saveSettings`. A successful PUT (200/202) writes `{path, hash, bytes, missingSince: null}`. A successful DELETE (202/204) removes the entry.

**OAuth (§C.7)**
- **D-AUTH-1** `connect()` with no upload folder selected sends exactly what 0.1.x sends (`scope=mcp:read`, no `resource`). A 0.2.0 install against a server without PR 1/PR 3 keeps read-only sync working (§I.4, "old installs keep working"). With at least one folder selected, it sends `scope=mcp:read wiki:write` and `resource=<baseUrl>/wiki` on `/oauth/authorize` **and** on the authorization-code token request (RFC 8707 §2.2), never on refresh (a refresh keeps the granted scope, §C.7). Follow-up for 0.3.0: send `resource` always once the §C.3 compatibility window closes.
- **D-AUTH-2** The granted scope is decoded from the access token's JWT `scope` claim (space-separated), via `JavisOAuth.grantedScopes(): string[] | null`. No new persisted state. The claim is per-device, as the token is, whereas `data.json` replicates across devices.
- **D-AUTH-3** "A read-only connection prompts one reconnect": adding the first upload folder while `grantedScopes()` lacks `wiki:write` shows a Notice and a **Reconnect to allow uploads** button in the Upload section. The browser is never opened from a background trigger.
- **D-AUTH-4** On `403` whose `WWW-Authenticate` says `error="insufficient_scope"`: for an interactive trigger (`command`/`settings`/`review`), `uploadOnce` calls the injected `stepUp()` **once per run** (a `connect()` with the union scope), then retries that one request once. A second 403 → `InsufficientScopeError` (run-level, `needsUserAction`). For background triggers, `stepUp` is not supplied, so the first 403 is already run-level with the reconnect sentence. A 403 without `insufficient_scope` → `HttpError` (run-level, because it is an authorization problem).
- **D-AUTH-5** `resource` = `normalizeBaseUrl(baseUrl) + '/wiki'`. For the default origin this is `https://mcp.javis.is/wiki`, matching §C.3.

**Wire (§E) — the PR 3 server must match or amend these**
- **D-WIRE-1** `GET /wiki/sources/obsidian` → `200 {"sources": [Row], "counts": {"<status>": n, ...}}`. `Row` = `{source_id, vault_path, body_hash, status, deleted: bool, last_error: str|null, undo_report: UndoReport|null}`. `UndoReport` = `{pages_tombstoned, pages_rebuilt, pages_marked_stale, pages_skipped_adopted}` (ints). `source_id`, `vault_path`, `body_hash` (64 hex), `status` (any string), and `deleted` are required. A bad row → `ProtocolError` for the whole response, as `validateExportResponse` does (`src/shell/api.ts:415-441`), because a half-understood server list must not drive deletes. `counts` is optional, and values must be numbers. There is no paging: §E says "every row".
- **D-WIRE-2** `PUT /wiki/sources/obsidian/{uuid}` with a JSON body `{"vault_path","title","text","body_hash"}` and `Content-Type: application/json`. `200` → `unchanged`, `202` → `accepted` (the body is not required). `400` → `PutRejected` (per-note, with the server `detail`/`error` text truncated to 200). `409` → `conflict-deleted`. `413` → `oversize`.
- **D-WIRE-3** `DELETE /wiki/sources/obsidian/{uuid}` → `202` `deleting`, `204` `gone`. Anything else ≥ 400 → mapped as for PUT.
- **D-WIRE-4** The path segment is `encodeURIComponent(id)`. Ids are already validated as uuids, so this is belt-and-braces.

**API client**
- **D-API-1** A new `src/shell/sources-api.ts` (`JavisSourcesApiClient`) reuses `obsidianTransport`, `headerValue`, `parseRetryAfterMs`, and `parseJsonBody` from `api.ts` unchanged, and copies the 401 sequence rather than refactoring `JavisWikiApiClient.send`. The download client is untouched, so the 290 existing tests keep guarding it.
- **D-API-2** The sources client reads `baseUrl` through a function (`() => settings.baseUrl`), like `JavisOAuth` (`auth.ts:483-484`). `JavisWikiApiClient` captures it at construction (`api.ts:552`, `main.ts:92-96`), which is a latent Phase 1 bug. Not fixed here (out of scope); recorded in the PR draft.

**Triggers and UI**
- **D-TRIG-1** Upload-on-edit is off by default. The `modify` listener is registered inside `onLayoutReady` (§F.4). It ignores non-`.md` files, paths outside the selected folders, and self-writes. A 2-minute trailing debounce then runs **the upload half only** (new trigger `'edit'`) through `syncNow`'s single-flight guard. If a run is in progress when the timer fires, the debounce re-arms.
- **D-TRIG-2** Self-write suppression: `SelfWriteTracker.mark(path, now)` is called immediately before each stamp or restamp `process`. `consume(path, now)` returns true (and forgets the mark) for the first `modify` on that path within 10 s. The clock is injected. Only the upload-on-edit listener consults it, because the download never stamps.
- **D-TRIG-3** `SyncTrigger` gains `'edit'` and `'review'`. Existing values are unchanged, so `summarize` and every caller keep compiling (`syncNow` is HIGH-risk: the signature stays `syncNow(trigger)`). A new optional second parameter carries `{release?, reuploadAll?, uploadOnly?}`.
- **D-UI-1** Held-changes Notice: at most one per run, and only when the set of held keys differs from the previous run's. This avoids a Notice every 30 minutes for the same hold.
- **D-UI-2** Settings lists (failures, oversize, unreadable, unstampable, invalid-id, held, waiting, undo reports) show at most 10 entries each, plus "and N more".
- **D-UI-3** "Last undo reports" = server rows with a non-null `undo_report`, from the last GET, capped per D-UI-2. Wording follows §D.4: "removed from {tombstoned+rebuilt} pages; {stale} older pages may still mention it".
- **D-UI-4** Limitation sentence (§D.4/§F.4): "When a note leaves the selected folders, Javis rebuilds the pages it fed from their other sources. Pages created before provenance tracking can't be rebuilt, so they are marked and may still mention it."

**Release**
- **D-REL-1** Version 0.2.0 goes in `manifest.json`, `package.json`, `package-lock.json` (top-level and `packages[""]` `version`), and `versions.json` (`"0.2.0": "1.11.4"`). `minAppVersion` is unchanged. Edited by hand, not via `npm version` (which tags).

---

## 2. File map

New:
- `src/core/sha256.ts` — pure SHA-256 → hex.
- `src/core/note-text.ts` — `frontmatterRange`, `uploadText`, `noteHash`, `utf8Bytes`, `readSourceId`, `noteTitle`, `isUuid`, `hasLoneSurrogate`.
- `src/core/stamp.ts` — `stampText`, `restampText` (return `{kind:'ok', text} | {kind:'already'} | {kind:'malformed'}`).
- `src/core/folders.ts` — `normalizeFolder`, `validateFolders`, `isUnderFolder`.
- `src/core/upload.ts` — types (`LocalNote`, `ServerSource`, `UploadMemory`, `UploadAction`, `HeldAction`, `UploadPlan`, `UndoReport`) and `planUpload`.
- `src/shell/sources-api.ts` — `JavisSourcesApiClient`, `validateSourcesResponse`, `parseWwwAuthenticate`.
- `src/shell/upload.ts` — `uploadOnce`, `readWithTimeout`, `SelfWriteTracker`, `summarizeUpload`, `runDownloadThenUpload`.
- `src/shell/folder-suggest.ts` — `FolderSuggest extends AbstractInputSuggest<TFolder>` (Obsidian UI, not unit-tested, like `settings.ts`).
- `src/shell/review-modal.ts` — `ReviewPendingModal extends Modal` (UI, not unit-tested).
- Tests: `tests/sha256.test.ts`, `tests/note-text.test.ts`, `tests/stamp.test.ts`, `tests/folders.test.ts`, `tests/upload-plan.test.ts`, `tests/sources-api.test.ts`, `tests/upload.test.ts`, `tests/run.test.ts`.

Modified (run GitNexus `impact` upstream on each named symbol first):
- `src/shell/errors.ts` — `+ InsufficientScopeError`, `JavisErrorCode += 'insufficient-scope'`, `isAuthFatal` unchanged (step-up is not a revocation).
- `src/shell/contracts.ts` — `+ UploadVault`, `SourcesApi`, `UploadDeps`, `UploadResult`, `LastUploadReport`; `JavisSettings += uploadFolders, uploadOnEdit, uploadMemory, lastUpload, pendingReuploadAll`; `SyncTrigger += 'edit' | 'review'`; `JavisAuth.connect(options?)`, `+ grantedScopes()`.
- `src/shell/auth.ts` — `OAUTH_SCOPE_WRITE`, `buildAuthorizeUrl({resource?})`, `connect({scope, resource}?)`, `exchangeCode` resource, `decodeJwtClaims`, `grantedScopes`, `wikiResource(baseUrl)`.
- `src/shell/vault.ts` — `ObsidianVaultAdapter implements UploadVault`: `+ listNotesIn(folders)`, `readFresh(path)`, `processText(path, fn)`, `folderPaths()`, `configDir()`.
- `src/shell/settings.ts` — `+ renderUpload`; the Connect button passes the scope and resource.
- `src/main.ts` — wiring, download-then-upload, the `modify` listener, the review command, step-up.
- `tests/auth.test.ts` — new cases (additive only).
- `README.md`, `docs/PR-DRAFT.md`, `manifest.json`, `package.json`, `package-lock.json`, `versions.json`.

---

## 3. Tasks (TDD order; each ends green and committed)

Conventions for every task: write the test first and run `npx vitest run tests/<file>` to see it **fail** for the right reason. Then implement and re-run it to green. Then run `npm test && npm run build`. Commit with a message body that cites the spec section and this plan, ending in a blank line plus
`Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
Module header comments follow the existing density: a spec reference, then numbered load-bearing rules that argue *why* (see `src/core/reconcile.ts:1-9`, `src/shell/api.ts:1-39`).

### Task 1 — `src/core/sha256.ts`
Test `tests/sha256.test.ts`:
- `sha256Hex('')` = `e3b0c442…b855`, `'abc'` = `ba7816bf…15ad`, the 448-bit NIST vector, and 1,000,000 × `'a'` = `cdc76e5c…04f5`.
- For ~200 seeded pseudo-random strings (ASCII, CJK, emoji/astral, `\r\n`, lengths 0..5000 including 55/56/63/64/65 block boundaries), the result equals `createHash('sha256').update(s,'utf8').digest('hex')` from `node:crypto` (test-only import).
- Output matches `/^[0-9a-f]{64}$/`.

Implement: the standard FIPS 180-4 compression over a `Uint8Array` from `new TextEncoder().encode(s)`, with `sha256Hex(s: string): string` and `sha256HexBytes(b: Uint8Array)`. No Obsidian, no Node import.
Commit: `feat(core): pure sha256 for upload hashes`.

### Task 2 — `src/core/note-text.ts` (frontmatter range, normalization, hash, id, title)
Test `tests/note-text.test.ts`:
- `frontmatterRange(text)` agrees with `extractFrontmatterBlock` (`src/shell/vault.ts:158`) on: no fence; `---` fence closed; unclosed fence (→ `{kind:'malformed'}`); `---` as a later horizontal rule; BOM; CRLF; a file that is exactly `---`. It returns byte offsets into the *original* string (`openEnd`, `closeStart`, `closeEnd`, `eol`).
- `uploadText`: strips the BOM; CRLF/CR → LF; removes top-level `javis_source_id: …`, `javis_type: x`, and a `javis_foo:` followed by `  - a` continuation lines; keeps `javis_*` text in the body and indented `  javis_x:` under another key; drops a block that ends up empty (D-HASH-2); drops an originally empty block; leaves a malformed file's text only EOL-normalized (no block to edit).
- `noteHash(t) === sha256Hex(uploadText(t))`.
- **Invariant** (property-style over ~30 fixtures, including the §H YAML fixture with comments, quotes, and flow lists): `noteHash(stampText(t,id).text) === noteHash(t)` and `noteHash(restampText(...))` equality. This test is written here and marked `it.todo` until Task 3, then enabled.
- `readSourceId`: plain, `'quoted'`, `"quoted"`, trailing spaces, CRLF; not in body; not indented; the first of two wins; returns `{id, valid}` with `valid = isUuid`, lowercased.
- `noteTitle(text, path)`: `title: Foo` / `title: "Foo: bar"` / missing → basename without `.md`; `title:` empty → basename; truncates to 500.
- `utf8Bytes('é')===2`; `hasLoneSurrogate('\ud800')===true`, `'😀'`→false.

Commit: `feat(core): upload text normalization, hash, id and title readers`.

### Task 3 — `src/core/stamp.ts`
Test `tests/stamp.test.ts` (the §H stamp-inserter bullets):
- The YAML fixture with `# comment`, `'single'`, `"double"`, `tags: [a, b]`, `date: 2026-09-24`, `!!str x`, and a blank line → the output equals the input with exactly `javis_source_id: <uuid>\n` inserted immediately before the closing fence. Verified by removing that one line and asserting `===` the input.
- No frontmatter → `'---\njavis_source_id: <id>\n---\n' + input`; with a BOM → the BOM, then the fence.
- An empty block `---\n---\n` → an insert between the fences.
- CRLF file → the inserted line ends `\r\n`, and there is no bare `\n` in the output (D-STAMP-1).
- Unclosed fence → `{kind:'malformed'}`, nothing produced.
- A file that is exactly `---\n---` (no trailing EOL) → valid output.
- Idempotence: `stampText(stampText(t,a).text, b)` → `{kind:'already'}`. `stampText` on a note with an existing (even invalid) `javis_source_id` line → `already`.
- `restampText`: replaces the value only, keeps quotes style dropped (writes a bare uuid), byte-identical elsewhere, `malformed` passthrough, a no-op when the value already equals the new id (`already`).
- Enable the Task 2 hash-invariance todo.

Commit: `feat(core): text-level id stamp that never reformats frontmatter`.

### Task 4 — `src/core/folders.ts`
Test `tests/folders.test.ts`:
- `normalizeFolder(' /Journal/ ')` → `'Journal'`; `'a//b'` → `'a/b'`.
- `validateFolders(['', '/'])` → root errors; `['.obsidian', '.obsidian/x']` → config errors (with `configDir` param `'.obsidian'`, also a custom `'.config'`); each of the 9 `TYPE_TO_PLURAL` values and `'Concepts/Sub'` → wiki errors; `'Conceptsfoo'` → OK (a prefix is not a parent); `['A','A/B']` → nesting error on both; duplicates → error; `'.hidden'` → error (D-FOLD-1); `['Journal','Inbox']` → OK.
- The return shape is `{ok: string[], errors: {folder, reason}[]}`, with each reason as a user-facing sentence.
- `isUnderFolder('Journal/a.md','Journal')` true; `('Journal2/a.md','Journal')` false.

Commit: `feat(core): upload folder validation (§F.3.1)`.

### Task 5 — `src/core/upload.ts`: types and the simple actions
Test `tests/upload-plan.test.ts` (build fixtures with helpers `note()`, `row()`, `mem()`, `settings({now})`):
- **stamp**: a readable note without an id → `{kind:'stamp', path}`.
- **skip-blank** (D-PLAN-9), **skip-unreadable**, **skip-oversize** (262145 bytes vs 262144 OK), **skip-invalid-id**, and **skip-invalid-chars** land in `plan.skipped` with the path.
- **put** when there is no server row; when the hash differs; when the path differs (a rename within the selection); a **move between selected folders** → one put, no delete.
- No action when the hash and path are equal; `reuploadAll` → put (D-PLAN-15).
- **copy restamp**: two notes with the same id, the server path equals B → A restamp, B put-evaluated; the fallback to memory path; the fallback to lexicographic order (D-PLAN-10).
- **deleted-id restamp**: server `deleted:true` → restamp.
- A defensive filter: a note outside the folders, or not `.md`, is ignored (D-PLAN-12).
- An invalid folder → `actions:[]`, with `invalidFolders` populated (D-PLAN-11).
- Actions are ordered per D-PLAN-16.

Implement the types + `planUpload` minus the delete guards.
Commit: `feat(core): planUpload — stamp, restamp, put, skips`.

### Task 6 — `planUpload`: deletes, debounce, unreadable
Tests (same file):
- **move out of the selection**: the row path is outside the folders and no note carries the id → run 1 at `t0`: no delete, `waiting` has it, `nextMemory[id].missingSince === t0`. Run 2 at `t0+4m59s` with that memory: still waiting. Run 3 at `t0+5m`: `{kind:'delete', sourceId}`.
- **one miss holds nothing back, two misses 5+ minutes apart delete** (the §H wording), including the case where memory was lost (no entry → created with `missingSince=now`, no delete).
- A row that reappears → `missingSince` reset to null.
- **unreadable note (no put, no delete)**: an unreadable note at the row's server path, with no id → no delete, no put; with an id hint → no delete.
- Unattributed unreadable plus a missing row elsewhere → the delete is held `unreadable-ambiguous` (D-PLAN-4); when the unreadable note is attributed to another row by path → the missing row's delete proceeds.
- Rows with `deleted:true` are never delete candidates.

Commit: `feat(core): planUpload deletes behind the two-scan debounce and unreadable guard`.

### Task 7 — `planUpload`: vanished folder, mass cap, suspicious edits, release
Tests:
- **vanished folder**: folder `Inbox` lists nothing, and 3 live rows under `Inbox/` are past the debounce → 3 held `vanished-folder`. `Journal` deletes are unaffected (while under the cap).
- **the cap at 5**: 10 live rows, 5 deletes → sent; 6 → all held `mass-change`.
- **at 20%**: 100 live rows → T=20; 20 sent, 21 held.
- **at 50**: 1000 live rows → T=50 (not 200); 50 sent, 51 held.
- **empty note held as suspicious**: a blank note with a live row and a different hash, plus deletes up to exactly T → count T+1 → the put and all deletes are held. Alone (count 1 ≤ 5) → the put is sent (D-PLAN-8).
- **80% shrink**: memory bytes 1000, local 199 → suspicious; 200 → not; no memory → not.
- **holds re-derived**: the same inputs with files restored → `held` is empty and no delete is planned.
- **release**: a held `delete:<id>` in `settings.release` → emitted as an action; a release key for something no longer held is ignored.
- Deletes held by vanished-folder also count toward the cap (D-PLAN-7).

Commit: `feat(core): planUpload vanished-folder and mass-change holds (§F.3.4–6)`.

### Task 8 — errors and contracts
- Run `impact` on `JavisErrorCode`, `SyncTrigger`, `JavisAuth`.
- `src/shell/errors.ts`: `InsufficientScopeError` (`code:'insufficient-scope'`, `retryable:false`, `needsUserAction:true`), with the message "Javis did not grant permission to write to your wiki. Reconnect in the plugin settings and allow uploads."
- `src/shell/contracts.ts`: the types listed in §2, with doc comments. `DEFAULT_SETTINGS` additions: `uploadFolders: []`, `uploadOnEdit: false`, `uploadMemory: {}`, `lastUpload: null`, `pendingReuploadAll: false`. The token guard (`contracts.ts:521-536`) must still compile, so none of these names are token-shaped.
- Test: add to `tests/upload.test.ts` (created now) a type-level smoke `expectTypeOf(DEFAULT_SETTINGS.uploadFolders).toEqualTypeOf<string[]>()`, and a runtime check that `loadSettings`-style `{...DEFAULT_SETTINGS, ...old011Data}` yields `uploadFolders: []`. The `main.ts` merge itself is untested, as today.

Commit: `feat(shell): contracts and settings fields for the upload half`.

### Task 9 — `src/shell/sources-api.ts`
Test `tests/sources-api.test.ts` with a recording fake transport (pattern: `tests/api.test.ts:27-43`):
- URLs: `GET {base}/wiki/sources/obsidian`, `PUT|DELETE …/{id}`. A trailing slash on the base is tolerated. `Authorization: Bearer <t>`; PUT has `Content-Type: application/json` and the body JSON exactly `{vault_path,title,text,body_hash}`.
- GET validation (D-WIRE-1): happy path; a missing `sources` → `ProtocolError`; a row missing `body_hash` → `ProtocolError`; an unknown `status` string is accepted; `undo_report` null or object; `counts` absent → `{}`.
- PUT: 200 → `'unchanged'`, 202 → `'accepted'`, 400 → `{kind:'rejected', message}`, 409 → `'conflict-deleted'`, 413 → `'oversize'`, 500 → `HttpError` (retryable) thrown, 429 → `RateLimitedError` with `retryAfterMs` from `Retry-After: 3`.
- DELETE: 202 → `'deleting'`, 204 → `'gone'`.
- 401 → exactly one `refresh()` and one retry; a second 401 → `AuthExpiredError`.
- 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="mcp:read wiki:write", resource_metadata="…/wiki"` → `InsufficientScopeError`; a 403 without it → `HttpError(403)`. `parseWwwAuthenticate` handles quoted commas and case-insensitive header names.
- The transport throwing → `NetworkError`; the token never appears in any error message (assert via `String(err)`).
- An aborted signal before the request → `SyncCancelledError`.

Commit: `feat(shell): client for GET/PUT/DELETE /wiki/sources/obsidian (§E)`.

### Task 10 — OAuth step-up plumbing (`src/shell/auth.ts`)
- Run `impact` on `buildAuthorizeUrl` (LOW), `JavisOAuth.connect` (LOW), `exchangeCode`, and `decodeJwtExpiry`.
- Tests appended to `tests/auth.test.ts`:
  - `buildAuthorizeUrl({... scope:'mcp:read wiki:write', resource:'https://mcp.javis.is/wiki'})` has both params, space-encoded as `+` or `%20` (assert via `URLSearchParams.get`). Without them, the URL is byte-identical to today's (a regression guard for D-AUTH-1).
  - `connect({scope, resource})` → the fake browser receives the URL with both, and the token POST body includes `resource`. `connect()` with no args → no `resource` anywhere, `scope=mcp:read`.
  - `grantedScopes()` decodes `scope` from the stored JWT: `'mcp:read wiki:write'` → both; an undecodable token → null; no token → null.
  - `wikiResource('https://mcp.javis.is/')` → `'https://mcp.javis.is/wiki'`.
  - The refresh body never includes `resource` or `scope`.

Commit: `feat(auth): request wiki:write and the /wiki resource for uploads (§C.7)`.

### Task 11 — vault adapter additions (`src/shell/vault.ts`)
- Run `impact` on `ObsidianVaultAdapter`.
- Pure helper to test: `notesUnder(allMarkdownPaths, folders)` (prefix filter via `isUnderFolder`, `.md` only), in `tests/vault.test.ts` (additive).
- Class methods (untested per §H of the Phase 1 spec, like the rest of the class): `listNotesIn(folders)` → `{path, cachedSourceId}` from `getMarkdownFiles()` + `metadataCache.getFileCache(f)?.frontmatter?.javis_source_id` (D-PLAN-3); `readFresh(path)` → `vault.read` (not `cachedRead`, §F.2); `processText(path, fn)` → returns `vault.process`'s string; `folderPaths()` → `getAllFolders(false).map(f=>f.path)`; `configDir()` → `app.vault.configDir`. Still no delete or trash anywhere. Add a test-side grep assertion in `tests/vault.test.ts` that `src/` contains no `.delete(`/`.trash(` on a vault (read the source files with `node:fs`). The `SecretStore.delete` method is excluded by pattern `vault.delete|vault.trash|\.trash\(`.

Commit: `feat(vault): fresh reads, process-with-result, folder listing for uploads`.

### Task 12 — `src/shell/upload.ts`: `uploadOnce`
Test `tests/upload.test.ts` with `FakeUploadVault` (files map, per-path read delay/throw, `processText` applying the transform, records the call order) and `FakeSourcesApi` (scripted responses, records calls):
- **stamp before PUT**: a new note → the order is `processText(path)` then `put(id)`; the PUT id equals the id in the file after process; the PUT `text`/`body_hash` equal `uploadText`/`noteHash` of the post-stamp text; `selfWrites.mark(path)` is called before `processText`.
- **adopt a concurrent stamp** (D-STAMP-3): the fake's `processText` sees content that already has another id → the PUT uses that id.
- **interruption**: `processText` succeeds, then `put` throws `NetworkError` → the run stops, and the file keeps the id. A second `uploadOnce` over the same fake → no stamp, just a put with the same id (no second source, the obsync #181 case).
- **read timeout**: the fake read never resolves; `timeoutMs: 20` → the note is `skip-unreadable`, and there is no put or delete.
- **cancellation between notes**: abort after the first note's put → the second note is not touched, and `stoppedBy.code==='cancelled'`.
- **per-note failures**: PUT 400 on note A, 202 on note B → both attempted, `failures` has A with the server message, and memory is updated only for B.
- **auth stops the run**: `AuthRevokedError` on the first PUT → no further calls, `stoppedBy.code==='auth-revoked'`, and memory still carries the plan's `missingSince` updates.
- **429 backoff**: 429, 429, 202 → the injected `sleep` is called with 1000 then 2000 (or `Retry-After`), and the note succeeds. Five 429s → `stoppedBy.code==='rate-limited'`.
- **step-up once**: 403 insufficient_scope with `stepUp` supplied → `stepUp` is called once, the request is retried once and succeeds. The same case with a second 403 → `stoppedBy.code==='insufficient-scope'`, and `stepUp` is not called again for a later note. Without `stepUp` → it stops immediately.
- **409** → a per-note failure (D-RUN-6); **413** → `skipped.oversize`.
- **delete path**: memory with `missingSince` old enough + a live row with no note → DELETE is called; 204 → the memory entry is removed.
- **held**: a mass-change case → no DELETE is called, and `result.held` is populated; with `release` → DELETE is called.
- **no folders** → no API call at all (D-RUN-2). **Invalid folders** → no API call, `invalidFolders` reported.
- **GET failure** (`ProtocolError`) → no PUT or DELETE (nothing can be decided without the server list).
- `summarizeUpload(result)` strings: "3 uploaded, 1 unchanged, 2 removed, 4 held, 1 failed", "nothing to upload".

Commit: `feat(shell): upload run — enumerate, read, stamp, PUT/DELETE (§F.2)`.

### Task 13 — `SelfWriteTracker`, the edit debounce, `runDownloadThenUpload`
Tests in `tests/run.test.ts`:
- `SelfWriteTracker`: mark → the first consume within 10 s is true, and a second is false. A consume after 10 s is false (the mark expires), using the injected clock.
- `createTrailingDebounce(fn, 120_000, timers)` with `vi.useFakeTimers()`: 3 calls 30 s apart → one fire 2 min after the last; `cancel()` prevents the fire; a `busy()`→true at fire time re-arms (D-TRIG-1).
- `runDownloadThenUpload({download, upload})`: download throws `NetworkError` → the upload still runs and both outcomes are returned. The upload fails → the download result is intact. Download throws `SyncCancelledError` → the upload is not called (D-RUN-1). `uploadOnly` → the download is not called.

Commit: `feat(shell): self-write suppression, edit debounce, download-then-upload`.

### Task 14 — wiring in `src/main.ts` (HIGH-risk symbol: `syncNow`)
- Run `impact` on `syncNow`, `onload`, and `loadSettings`. Keep `syncNow(trigger)`'s existing behavior for all four current triggers. Add an optional `opts`.
- Construct `JavisSourcesApiClient({baseUrl: () => this.settings.baseUrl}, this.auth, obsidianTransport)`, a `SelfWriteTracker`, and the edit debounce.
- `syncNow`: inside the existing `#running` guard, call `runDownloadThenUpload`. The download branch is the current body (lines 217-254) moved into a closure unchanged. The upload branch calls `uploadOnce` with `now: Date.now()`, `newId: () => crypto.randomUUID()`, `stepUp` only for `command|settings|review` (D-AUTH-4), `release`, and `reuploadAll: opts.reuploadAll || settings.pendingReuploadAll`. After it: persist `uploadMemory = result.nextMemory`, `lastUpload`, and clear `pendingReuploadAll` on a clean run. Status bar: `Javis: <download summary> · upload: <upload summary>`. The held Notice follows D-UI-1. The failure Notice lists up to 5 notes, like `main.ts:246-253`. A `stoppedBy` with `needsUserAction` → a Notice even on a background trigger (like `main.ts:287-291`).
- `loadSettings`: sanitize `uploadFolders` (an array of strings, else `[]`), `uploadMemory` (a plain object, else `{}`), and `uploadOnEdit` (a boolean).
- `onLayoutReady`: register `this.registerEvent(this.app.vault.on('modify', …))` only there (D-TRIG-1). The handler checks `settings.uploadOnEdit`, `.md`, `isUnderFolder`, and `!selfWrites.consume(path, Date.now())`, then pokes the debounce, which calls `syncNow('edit', {uploadOnly: true})`.
- Command `review-pending-changes` ("Review pending changes") opens `ReviewPendingModal` over `settings.lastUpload.held`. Confirm → `syncNow('review', {release: keys, uploadOnly: true})`.
- `onunload`: also cancel the edit debounce.
- `npm run build` must pass (typecheck covers `main.ts`). Manual QA is deferred to the E2E runbook (§H).

Commit: `feat: run the upload half after every download (§F.4)`.

### Task 15 — settings UI (`src/shell/settings.ts`, `folder-suggest.ts`, `review-modal.ts`)
- Run `impact` on `JavisSettingTab.display` and `renderConnection`.
- `FolderSuggest extends AbstractInputSuggest<TFolder>`: `getSuggestions(q)` = `app.vault.getAllFolders(false)` filtered by a case-insensitive substring and by `validateFolders([...selected, f.path]).errors.length===0`. `renderSuggestion` shows the path. `selectSuggestion` sets the value and closes.
- `renderUpload(containerEl)`, in the order §F.4 lists:
  1. A heading "Upload your notes" and a disclosure paragraph (the same facts as the README §F.5 section, short).
  2. The folder input + **Add** button (`validateFolders` errors → Notice, nothing saved), then a removable list (`Setting` per folder with an `extraButton('x')`). Removal shows the D-PLAN-13 warning in the description.
  3. Step-up prompt (D-AUTH-3): when folders are non-empty, connected, and `grantedScopes()` lacks `wiki:write` → the **Reconnect to allow uploads** CTA calls `auth.connect({scope:'mcp:read wiki:write', resource: wikiResource(base)})`. The existing Connect button passes the same arguments when folders are non-empty (in `renderConnection`).
  4. The **Upload when a note is edited** toggle (default off; desc "2 minutes after you stop typing").
  5. Counts from `lastUpload.counts`; failures; oversize, unreadable, unstampable, invalid-id (D-UI-2).
  6. Held changes + the **Review pending changes** button; waiting deletes; the last undo reports (D-UI-3).
  7. **Re-upload all**: sets `pendingReuploadAll`, saves, and calls `syncNow('settings', {uploadOnly:true, reuploadAll:true})`.
  8. The limitation sentence (D-UI-4).
- `ReviewPendingModal`: a list of `put <path>` / `remove <path>` with reasons, plus **Send these changes** and **Cancel** buttons.
- Build must pass. The UI is not unit-tested, matching `vitest.config.ts:7-9`.

Commit: `feat(settings): Upload section, folder picker, review modal (§F.4)`.

### Task 16 — README disclosure (§F.5), PR draft, version 0.2.0
- `README.md`: a new section **"Uploading your own notes (optional)"** before "What it does not do". It covers what is sent (the full text of every `.md` in the folders you select, including frontmatter except `javis_*` lines), where it goes (your Javis server, default `https://mcp.javis.is`), why (it is distilled into your wiki by an LLM on the server), that it is **stored** server-side as last uploaded, how it is removed (delete or move the note out, or deselect the folder, then after the guards the text is deleted from the database immediately and pages are rebuilt or tombstoned; nothing in the vault is deleted), the one line the plugin writes into your note (`javis_source_id`) and why, the guards (debounce, holds, review command), that a network connection and a Javis account are required, and a link to the privacy policy (`https://javis.is/privacy`; flag in the PR draft that the URL must be confirmed against PR 3's privacy page). Update the stale lines: "The grant is read-only" (`README.md:60`) becomes conditional; "Write anything back to Javis" in "What it does not do" (`README.md:173`) is removed; add "Upload attachments, canvases, or anything outside the folders you select".
- `docs/PR-DRAFT.md`: a 0.2.0 section — what, the decisions list (link to this plan), test counts, the wire contract to confirm against PR 3 (D-WIRE-*), D-HASH-5, D-API-2, and the manual E2E runbook from spec §H.
- The version bump per D-REL-1. Test: `tests/run.test.ts` adds a check that `manifest.json.version === package.json.version === '0.2.0'`, `versions.json['0.2.0'] === '1.11.4'`, and `manifest.minAppVersion === '1.11.4'`.

Commit: `docs: README upload disclosure (§F.5); chore: 0.2.0`. These are two commits: docs first, then the version.

### Task 17 — full verification
- `npm test 2>&1 | tail -30` → 290 + new tests, all passing. `npm run build 2>&1 | tail -15` is clean.
- `grep -rn "from 'obsidian'\|require('obsidian')" src/core` → empty (purity).
- `grep -rnE "vault\.(delete|trash)|\.trash\(" src` → empty.
- `grep -rn "Date.now\|new Date" src/core` → empty (no clock in core).
- `git status` is clean. The branch is committed and **not pushed**.

---

## 4. Out of scope (recorded, not done)
- Fixing `JavisWikiApiClient`'s captured `baseUrl` (D-API-2) and Phase 1 `writeFrontmatter` reformatting (spec §L.2 follow-up).
- Sending `resource` on read-only connects (D-AUTH-1 follow-up for 0.3.0).
- Any server code. PR 3 must implement D-WIRE-1..4, or this plan's client changes to match it.

## Amendments after adversarial review (2026-09-24)

Confirmed review findings changed these decisions; the entries above are left
as written so the history reads, and the code follows this section.

- **D-AUTH-1** Every connect sends `resource=<baseUrl>/wiki` (§C.3 is
  unconditional). The union scope is still sent only with a folder selected.
  Reason: an `/mcp`-audience grant can never be moved by a refresh, so the
  deferred "0.3.0 follow-up" would have stranded every read-only 0.2.0 install
  when `/wiki/export` drops the old audience.
- **D-RUN-3** "Cannot write" also covers a decodable `aud` that is not `/wiki`.
  Interactive runs step up *before* the first request (no stamp ahead of a
  403); a declined write grant stops the run there (`uploadOnce` rule 7).
- **D-PLAN-4** Applied as written for id-less notes: a readable note with no
  id at a live, uncarried row's server or memory path keeps the row present;
  blank → skip, otherwise `put` with `adopt: true` (the same id is written
  back, then the ordinary changed/moved/shrink logic; `restore-id` when
  unchanged). A note carrying a different valid id still does not vouch.
- **D-PLAN-13 / D-RUN-2** An empty selection is planned like any other, so
  deselecting the last folder removes its notes behind the debounce and the
  cap; the upload half is skipped only with no folder *and* empty memory.
  With no folder, memory for ids without a live row is dropped.
- **D-FOLD-1** Case-insensitive throughout; plus notes carrying `javis_slug` /
  `javis_type` are skipped as `wiki-page`.
- **D-WIRE / sources client** `http:` is refused unless the host is loopback.
- **D-RUN-10** A run that stops before planning keeps the previous
  `held`/`skipped`/`waiting` in `lastUpload` (`UploadResult.planned`).
- **Task 14 `loadSettings`** is `sanitizeSettings` in `settings-load.ts`,
  tested directly; malformed memory entries are repaired toward "unknown".
