# "Connected as …" Implementation Plan (javis-obsidian 0.3.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the plugin is connected and the stored access token carries an `email` claim, the settings tab says "Connected as {email}. Your wiki pages sync into this vault, one way." Otherwise it keeps today's text. Release as 0.3.1.

**Architecture:** `JavisOAuth.accountEmail()` reads the `email` claim from the keychain-held access token with the existing `decodeJwtClaims`, exactly as `accountKey()` reads `sub`. The three status strings move out of `settings.ts` (an untested Obsidian shell) into a new pure module `src/shell/connection-status.ts`, whose `connectionStatusText(status, email)` is unit-tested. `settings.ts#renderConnection` calls it on every `display()`. Nothing is written to `data.json`.

**Tech Stack:** TypeScript, Obsidian plugin API (`createEl({ text })` sets `textContent`, so the email cannot inject markup), vitest, esbuild.

**Spec (source of truth, lives in javis-server):** `/Users/samuelwei/GoogleDrive/LLM/javis-server/docs/superpowers/specs/2026-09-27-account-email-in-connection-design.md`, section "3. Plugin: Connected as …", the javis-obsidian Testing bullets, and Release.

## Global Constraints

- Branch `feat/connected-as`, already checked out. Never switch branches, never push, never open a PR, never deploy. Do not edit javis-server.
- `accountEmail()` is display text only. It is never used for any decision. `accountKey()` and the upload account-mismatch rule (`src/main.ts:602`) keep using `sub`, unchanged.
- The email is never stored in `JavisSettings`/`data.json`; it is read from the token on each `display()`.
- The status line shows the email only when `status === 'connected'`. `disconnected` and `needs-reconnect` text is unchanged.
- `JavisAuth` (`src/shell/contracts.ts`) is not changed: `plugin.auth` is typed `JavisOAuth` (`src/main.ts:98`), and no test fake implements `accountKey`, so none needs `accountEmail`.
- Release version is `0.3.1`; `minAppVersion` stays `1.11.4`.
- Run every command from `/Users/samuelwei/GoogleDrive/LLM/javis-obsidian`. Baseline before Task 1: `npx vitest run` → 668 passed; `npx tsc -noEmit` → exit 0.
- Every commit: one logical change, body references the spec path, ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- GitNexus (repo CLAUDE.md): before editing, run `impact({target: "accountKey", direction: "upstream"})` and `impact({target: "renderConnection", direction: "upstream"})`; before each commit run `detect_changes()`. If the MCP index is stale or unavailable, fall back to `grep -rn` and do not block. Expected blast radius: `accountKey` callers are `src/main.ts:452` and `:602` (not edited); `renderConnection` is called only by `display()`.

## Review Focus

1. **The email never decides anything.** Grep after Task 1: `accountEmail` is referenced only in `auth.ts`, `settings.ts` and tests.
2. **No refresh token → null**, the same guard as `accountKey()`: a leftover access token after a half-cleared keychain must not show "Connected as".
3. **Non-string / empty claim → null**, so `email: 42` or `email: ""` never renders "Connected as 42." or "Connected as ."
4. **Only `connected` shows the email.** A revoked (`needs-reconnect`) connection whose access token is still in the keychain must not show "Connected as".
5. **Markup safety.** The email reaches the DOM only via `createEl('p', { text })` (textContent), never `innerHTML`.

---

### Task 1: `JavisOAuth.accountEmail()`

**Files:**
- Modify: `src/shell/auth.ts` (new method directly after `accountKey()`, which ends at line 773)
- Test: `tests/auth.test.ts` (new `describe` directly after `describe('grantedScopes', …)`, which ends at line 1088)

- [ ] **Step 1: Write the failing tests**

Insert after the closing `});` of `describe('grantedScopes', …)` in `tests/auth.test.ts` (it uses the file's existing `harness`, `jwt`, `liveJwt`, `SECRET_ACCESS_TOKEN`, `SECRET_REFRESH_TOKEN`, `SECRET_TOKEN_ORIGIN`; no new imports):

```ts
// ---------------------------------------------------------------------------
// accountEmail: the signed-in account, for display only
// (javis-server spec 2026-09-27-account-email-in-connection-design §3)
// ---------------------------------------------------------------------------

describe('accountEmail', () => {
  const offline = (secrets: Record<string, string>) => harness(() => ({ status: 500, text: '' }), { secrets });

  it('returns the email claim of the stored access token', () => {
    const h = offline({
      [SECRET_ACCESS_TOKEN]: jwt({ sub: 'user_1', email: 'sam@example.com' }),
      [SECRET_REFRESH_TOKEN]: 'r',
    });
    expect(h.auth.accountEmail()).toBe('sam@example.com');
  });

  it('is null for a missing, non-string or empty claim', () => {
    expect(offline({ [SECRET_ACCESS_TOKEN]: liveJwt, [SECRET_REFRESH_TOKEN]: 'r' }).auth.accountEmail()).toBeNull();
    for (const email of [42, null, true, ['sam@example.com'], { v: 'sam@example.com' }, '']) {
      const h = offline({ [SECRET_ACCESS_TOKEN]: jwt({ sub: 'user_1', email }), [SECRET_REFRESH_TOKEN]: 'r' });
      expect(h.auth.accountEmail()).toBeNull();
    }
  });

  it('is null without an access token or without a refresh token', () => {
    expect(offline({ [SECRET_REFRESH_TOKEN]: 'r' }).auth.accountEmail()).toBeNull();
    const accessOnly = offline({ [SECRET_ACCESS_TOKEN]: jwt({ sub: 'user_1', email: 'sam@example.com' }) });
    expect(accessOnly.auth.accountEmail()).toBeNull();
    expect(offline({}).auth.accountEmail()).toBeNull();
  });

  it('is null for an undecodable token', () => {
    expect(offline({ [SECRET_ACCESS_TOKEN]: 'opaque', [SECRET_REFRESH_TOKEN]: 'r' }).auth.accountEmail()).toBeNull();
    expect(offline({ [SECRET_ACCESS_TOKEN]: 'a.b.c', [SECRET_REFRESH_TOKEN]: 'r' }).auth.accountEmail()).toBeNull();
  });

  it('leaves accountKey on sub: the email is display text, never an identity', () => {
    const h = offline({
      [SECRET_ACCESS_TOKEN]: jwt({ sub: 'user_1', email: 'sam@example.com' }),
      [SECRET_REFRESH_TOKEN]: 'r',
      [SECRET_TOKEN_ORIGIN]: 'https://mcp.javis.is',
    });
    expect(h.auth.accountKey()).toBe('https://mcp.javis.is user_1');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run tests/auth.test.ts -t accountEmail`
Expected: FAIL — `h.auth.accountEmail is not a function` (tests 1–4; test 5 passes already). `npx tsc -noEmit` also fails: `Property 'accountEmail' does not exist on type 'JavisOAuth'`.

- [ ] **Step 3: Implement**

In `src/shell/auth.ts`, directly after the closing `}` of `accountKey()` (line 773), add:

```ts

  /**
   * The signed-in account's email, from the stored access token's `email`
   * claim (javis-server spec 2026-09-27-account-email-in-connection-design,
   * D2); null when there is no access or refresh token, the token does not
   * decode, or the claim is missing, not a string, or empty. Tokens minted
   * before the server added the claim have none until their next refresh (D5).
   *
   * Display text only. Never used for any decision: `accountKey()` and the
   * upload account-mismatch rule stay on `sub`. Read from the keychain on each
   * call and never persisted, because `data.json` lives inside the vault.
   */
  accountEmail(): string | null {
    const access = this.readSecret(SECRET_ACCESS_TOKEN);
    if (!access || !this.readSecret(SECRET_REFRESH_TOKEN)) return null;
    const email = decodeJwtClaims(access)?.['email'];
    return typeof email === 'string' && email !== '' ? email : null;
  }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run tests/auth.test.ts && npx tsc -noEmit`
Expected: all auth tests pass (5 new), tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/shell/auth.ts tests/auth.test.ts
git commit -F - <<'EOF'
feat(auth): accountEmail() reads the email claim from the access token

Display text for the settings tab's "Connected as …" line. Null when there
is no access or refresh token, the token does not decode, or the claim is
missing, not a string, or empty. Never used for any decision: accountKey()
and the upload account check stay on sub.

Spec: javis-server/docs/superpowers/specs/2026-09-27-account-email-in-connection-design.md §3

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: "Connected as {email}" in the settings tab

**Files:**
- Create: `src/shell/connection-status.ts`
- Modify: `src/shell/settings.ts` (remove `STATUS_TEXT` at lines 55–61, import the new helper, change the status `<p>` in `renderConnection` at lines 110–114)
- Test: `tests/connection-status.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/connection-status.test.ts`:

```ts
/**
 * The connection line in the settings tab (javis-server spec
 * 2026-09-27-account-email-in-connection-design §3): the account's email when
 * connected and the token carries one, today's text otherwise.
 */

import { describe, expect, it } from 'vitest';

import { STATUS_TEXT, connectionStatusText } from '../src/shell/connection-status';

describe('connectionStatusText', () => {
  it('names the account when connected with an email', () => {
    expect(connectionStatusText('connected', 'sam@example.com')).toBe(
      'Connected as sam@example.com. Your wiki pages sync into this vault, one way.',
    );
  });

  it('keeps the old text when connected without an email', () => {
    expect(connectionStatusText('connected', null)).toBe('Connected. Your wiki pages sync into this vault, one way.');
  });

  it('never shows an email unless connected', () => {
    expect(connectionStatusText('disconnected', 'sam@example.com')).toBe(STATUS_TEXT.disconnected);
    expect(connectionStatusText('needs-reconnect', 'sam@example.com')).toBe(STATUS_TEXT['needs-reconnect']);
  });

  it('keeps the disconnected and needs-reconnect wording unchanged', () => {
    expect(STATUS_TEXT.disconnected).toBe('Not connected. Connect to sign in with your Javis account.');
    expect(STATUS_TEXT['needs-reconnect']).toBe(
      'The saved sign-in was rejected. Reconnect to sign in again — no notes have been changed.',
    );
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/connection-status.test.ts`
Expected: FAIL — `Failed to resolve import "../src/shell/connection-status"`.

- [ ] **Step 3: Implement the pure module**

Create `src/shell/connection-status.ts`:

```ts
/**
 * What the settings tab's Connection section says (spec §D; javis-server spec
 * 2026-09-27-account-email-in-connection-design §3).
 *
 * Pure, and outside settings.ts, so it can be tested: settings.ts imports
 * `obsidian` and is not unit-tested (see settings-load.ts for the same split).
 */

import type { AuthStatus } from './contracts';

/** What the three connection states say when no account email is known. */
export const STATUS_TEXT: Record<AuthStatus, string> = {
  disconnected: 'Not connected. Connect to sign in with your Javis account.',
  connected: 'Connected. Your wiki pages sync into this vault, one way.',
  'needs-reconnect':
    'The saved sign-in was rejected. Reconnect to sign in again — no notes have been changed.',
};

/**
 * The status line. `email` is `JavisOAuth.accountEmail()`: shown only when
 * connected, so a rejected sign-in whose access token is still in the keychain
 * never claims an account. The caller renders it as text, never as HTML.
 */
export function connectionStatusText(status: AuthStatus, email: string | null): string {
  if (status === 'connected' && email !== null) {
    return `Connected as ${email}. Your wiki pages sync into this vault, one way.`;
  }
  return STATUS_TEXT[status];
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run tests/connection-status.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Wire it into `settings.ts`**

In `src/shell/settings.ts`, add the import after the `./contracts` imports (line 25):

```ts
import { connectionStatusText } from './connection-status';
```

Change line 24 from

```ts
import type { AuthStatus, LastUploadReport } from './contracts';
```

to

```ts
import type { LastUploadReport } from './contracts';
```

(first run `grep -n "AuthStatus" src/shell/settings.ts`; if any use remains besides `STATUS_TEXT`, keep the import).

Delete the block at lines 55–61:

```ts
/** What the three connection states say, and what the button does next. */
const STATUS_TEXT: Record<AuthStatus, string> = {
  disconnected: 'Not connected. Connect to sign in with your Javis account.',
  connected: 'Connected. Your wiki pages sync into this vault, one way.',
  'needs-reconnect':
    'The saved sign-in was rejected. Reconnect to sign in again — no notes have been changed.',
};
```

In `renderConnection`, replace

```ts
    const status = this.plugin.auth.status();
    containerEl.createEl('p', {
      text: STATUS_TEXT[status],
      cls: 'setting-item-description',
    });
```

with

```ts
    const status = this.plugin.auth.status();
    // Read on every display(), never stored: the email lives only in the
    // keychain-held token. `text` sets textContent, so it cannot inject markup.
    containerEl.createEl('p', {
      text: connectionStatusText(status, this.plugin.auth.accountEmail()),
      cls: 'setting-item-description',
    });
```

Then confirm no other reference remains: `grep -n "STATUS_TEXT" src/shell/settings.ts` → no output.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -noEmit`
Expected: 677 passed (668 + 5 from Task 1 + 4 here), tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/shell/connection-status.ts src/shell/settings.ts tests/connection-status.test.ts
git commit -F - <<'EOF'
feat(settings): show "Connected as {email}" when the token names the account

The status strings move to a pure, tested module (connection-status.ts).
When connected and accountEmail() is non-null the line reads "Connected as
{email}. Your wiki pages sync into this vault, one way."; otherwise the text
is unchanged. The email is read on each display() and never stored.

Spec: javis-server/docs/superpowers/specs/2026-09-27-account-email-in-connection-design.md §3

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: README line about the account shown in settings

**Files:**
- Modify: `README.md` ("Connect it" section, the paragraph starting "Both tokens are stored in your OS keychain.", line 78)

- [ ] **Step 1: Edit**

Insert this paragraph immediately before the line `Both tokens are stored in your OS keychain. **Disconnect** clears them. If the`:

```markdown
Once connected, the settings tab shows which Javis account this device uses:
*Connected as you@example.com.* The consent page names the account too, so you
can choose **Deny** if it is the wrong one. A connection made before the Javis
server started sending the email shows plain *Connected.* until its next token
refresh, within an hour. The email is read from the token in your keychain and
is never written to the vault.

```

- [ ] **Step 2: Verify docs tests still pass**

Run: `npx vitest run tests/docs-links.test.ts`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -F - <<'EOF'
docs(readme): the settings tab shows the connected account

Spec: javis-server/docs/superpowers/specs/2026-09-27-account-email-in-connection-design.md (Release)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Correct the stale "javis-server: no change" in the 0.3.0 spec

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-javis-wiki-root-folder-design.md` (Release section, lines 220–221)

- [ ] **Step 1: Edit**

Replace

```markdown
- javis-server: no change. Source pages for uploaded notes now land in
  `Javis-wiki/Sources/`.
```

with

```markdown
- javis-server: the upload path guard had to change too (javis-server PR #162): it refused notes under the root type folders and now refuses only `Javis-wiki/`. Source pages for uploaded notes now land in `Javis-wiki/Sources/`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-27-javis-wiki-root-folder-design.md
git commit -F - <<'EOF'
docs(spec): 0.3.0 did need a server change — the upload guard (PR #162)

The Release section said "javis-server: no change". The PUT
/wiki/sources/obsidian path guard still refused root type folders and had to
follow Javis-wiki/ instead (javis-server PR #162).

Spec: javis-server/docs/superpowers/specs/2026-09-27-account-email-in-connection-design.md (Release)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Version 0.3.1

**Files:**
- Modify (by the tool): `package.json`, `package-lock.json`, `manifest.json`, `versions.json`

- [ ] **Step 1: Bump**

Run: `npm version patch --no-git-tag-version`
Expected: prints `v0.3.1`. The `version` script runs `version-bump.mjs` and `git add manifest.json versions.json`; no commit and no tag are created.

- [ ] **Step 2: Verify**

Run: `grep -n '"version"' package.json manifest.json && tail -3 versions.json && git status --short`
Expected: `package.json` and `manifest.json` show `0.3.1`; `versions.json` ends with `"0.3.1": "1.11.4"`; changed files are exactly `package.json`, `package-lock.json`, `manifest.json`, `versions.json`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json manifest.json versions.json
git commit -F - <<'EOF'
chore(release): 0.3.1

Spec: javis-server/docs/superpowers/specs/2026-09-27-account-email-in-connection-design.md (Release)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Release notes / PR draft

**Files:**
- Create: `docs/pr-drafts/0.3.1-connected-as.md`

- [ ] **Step 1: Run the final verification and record the output**

Run: `npx vitest run && npx tsc -noEmit && npm run build && git rev-parse --short HEAD && git diff --stat main...HEAD | tail -1 && git rev-list --count main..HEAD`
Expected: `Tests 677 passed (677)`, tsc exit 0, build exit 0. Use the actual lines, short SHA, diffstat and commit count in the draft below (the draft commits itself, so the count in the draft is this number + 1).

- [ ] **Step 2: Write the draft**

Create `docs/pr-drafts/0.3.1-connected-as.md`, filling the Verification block and "Shape of the diff" with the outputs from Step 1:

````markdown
## PR body

Paste the title into `gh pr create --title` and everything from the next heading
down to the "Generated with" line into `--body`.

**Title:** `Javis Wiki Sync 0.3.1: settings show which account is connected`

---

# Javis Wiki Sync 0.3.1: settings show which account is connected

**Branch:** `feat/connected-as` · target `main`

**Spec:** `javis-server/docs/superpowers/specs/2026-09-27-account-email-in-connection-design.md` (§3)
**Plan:** `docs/superpowers/plans/2026-09-27-connected-as.md`

**Shape of the diff:** <commit count from Step 1 + 1> commits, <files / insertions / deletions from Step 1>.

## What changes for users

- When connected, Settings → Javis Wiki Sync reads *Connected as you@example.com.
  Your wiki pages sync into this vault, one way.*
- Until the server issues the new `email` claim, or for a token minted before it
  did, the line stays *Connected. …* as today. A live connection picks the
  email up at its next token refresh (access tokens last one hour), with no
  reconnect.
- Nothing else changes. Uploads still decide "same account or not" by the
  token's `sub`, never by the email.

## How

- `JavisOAuth.accountEmail()` (`src/shell/auth.ts`) reads the `email` claim of
  the keychain-held access token with `decodeJwtClaims`. Null for no access or
  refresh token, an undecodable token, or a missing, non-string or empty claim.
- The status strings move to a pure module, `src/shell/connection-status.ts`,
  so the new line is unit-tested; `settings.ts` renders it with `createEl({ text })`.
- The email is never written to `data.json`.

## Also in this PR

- README: a paragraph under "Connect it" about the account shown in settings.
- The 0.3.0 spec's Release section no longer says "javis-server: no change":
  the upload path guard had to change (javis-server PR #162).

## Server

Needs the javis-mcp change from the same spec (the `email` claim and the
consent-page account line) to show anything new. Order does not matter: this
plugin shows today's text against an older server, and older plugins ignore
the claim.

## Verification

```
<the vitest summary line from Step 1>
npx tsc -noEmit  exit 0
npm run build    exit 0
```

Manual, after javis-mcp is deployed and this build is installed:

1. Disconnect, then Connect: the consent page shows "Signed in to Javis as
   <your email>" and the switch hint.
2. After Allow, settings show "Connected as <your email>."
3. On an existing connection, without reconnecting, the email appears within
   an hour.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
````

Every `<…>` above is replaced with the Step 1 output before committing; `grep -n '<' docs/pr-drafts/0.3.1-connected-as.md` must show only the `<your email>` lines of the manual steps.

- [ ] **Step 3: Commit**

```bash
git add docs/pr-drafts/0.3.1-connected-as.md
git commit -F - <<'EOF'
docs: 0.3.1 PR draft — "Connected as" in settings

Spec: javis-server/docs/superpowers/specs/2026-09-27-account-email-in-connection-design.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 4: Final check**

Run: `git status --short && git log --oneline main..HEAD && grep -rn "accountEmail" src`
Expected: clean tree; the plan commit plus six task commits; `accountEmail` appears only in `src/shell/auth.ts` (definition) and `src/shell/settings.ts` (display). Do not push.
