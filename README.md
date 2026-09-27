# Javis Wiki Sync

An Obsidian plugin that mirrors your Javis wiki into a vault — and, only if
you choose folders for it, uploads your own notes from those folders into the
wiki.

Every wiki page becomes a markdown file with working wikilinks, backlinks,
graph view, and search. The plugin writes only the text between its own
markers, and **never deletes a file**.

> **Uploading is off until you turn it on, and it sends your notes to a
> server.** See [Uploading your own notes](#uploading-your-own-notes-optional)
> for exactly what is sent, where, and how it is removed.

> **Try it on a scratch vault first.**
> Create an empty vault, connect it, let it sync, and look at what landed. This
> plugin writes into a `Javis-wiki/` folder of whatever vault it is enabled
> in, and if you already use that folder name for your own notes, its files
> will land beside yours. It never deletes a note: its only removal is an
> empty 0.2.x wiki folder (such as `Concepts/`) after its notes have been moved
> into `Javis-wiki/`. But "never deletes a note" is not the same as "cannot
> surprise you". Back up any vault you care about before pointing this at it.

## Requirements

- **Obsidian 1.11.4 or newer.** This is `minAppVersion` in `manifest.json`, and
  it is not padding: `App.secretStorage` is marked `@since 1.11.4` in the
  Obsidian typings. That is the OS keychain, and it is where your access and
  refresh tokens go. Older Obsidian has no keychain API, and the only other
  place to put a token would be `data.json` — which lives *inside the vault* and
  would replicate your refresh token to every device, git remote, and iCloud
  folder the vault touches. So the plugin requires the keychain rather than
  degrading to that.
- **Desktop only.** `isDesktopOnly: true`. Signing in runs an RFC 8252 loopback
  listener on `127.0.0.1`, which needs Node's `http` module. Mobile has none.
- **A Javis account and a network connection**, and a Javis server exposing
  `GET /wiki/export` (default origin `https://mcp.javis.is`). Uploading also
  needs the server's `/wiki/sources/obsidian` routes.

## Install

The plugin is not in the Obsidian community catalogue yet.

**Via BRAT** (recommended — you get updates):

1. Install **Obsidian42 - BRAT** from Community plugins.
2. `BRAT: Add a beta plugin for testing`, and give it this repository.
3. Enable **Javis Wiki Sync** under Settings → Community plugins.

**Uploading needs 0.2.0 or later.** 0.2.1 is the current release. If you
installed 0.1.1 earlier, update the plugin (BRAT does this for you).
Settings → **Javis Wiki Sync** shows an **Upload your notes** section only in
0.2.0 and later.

**Manually:**

1. Download `main.js` and `manifest.json` from a release, or build them with
   `npm install && npm run build`.
2. Put both in `<your vault>/.obsidian/plugins/javis-wiki-sync/`.
3. Reload Obsidian, then enable **Javis Wiki Sync** under Settings → Community
   plugins.

## Connect it

Settings → **Javis Wiki Sync** → **Connect**.

Your system browser opens, you sign in to Javis as usual, and the tab tells you
when you can close it. Nothing is typed into Obsidian: the plugin registers
itself with the server, hands the browser a one-time code challenge, and
receives the tokens back over a loopback address on your own machine.

Until you choose a folder to upload, the grant is **read-only** (`mcp:read`)
and the plugin cannot write to your wiki. Choosing the first upload folder asks
you to reconnect once, and that connection also grants `wiki:write` — the
permission to store the notes you upload. You can decline it on the consent
screen and keep the read-only sync.

Both tokens are stored in your OS keychain. **Disconnect** clears them. If the
connection ever dies for good, the plugin says so once and stops — it does not
retry in a loop or quietly sync stale data.

**Javis server** is editable in the same settings tab if you run your own.
Your sign-in only ever goes to the server that issued it: if the server URL in
the plugin's settings file changes any other way (a synced settings file, a
shared vault), syncing stops and asks you to change it back or reconnect.

## What it creates

One folder, `Javis-wiki/`, with a subfolder per page type:

```
Javis-wiki/
  Sources/  Entities/  Concepts/  Topics/  Comparisons/
  Questions/  Syntheses/  Decisions/  Gaps/
```

A subfolder is created only when a page needs it.

Page bodies contain links such as `[[Concepts/Foo]]` literally. Obsidian
resolves a link path by its ending, so that link finds
`Javis-wiki/Concepts/Foo.md`. The plugin never rewrites links, and the
upgrade moves notes without asking Obsidian to update links to them, so no
"Update links?" prompt appears and your own `[[Concepts/Foo]]` links stay as
they are and keep resolving.

**Upgrading from 0.2.x.** Earlier versions wrote the nine folders at the
vault root. The first sync after upgrading moves every Javis note from those
folders into `Javis-wiki/`, including notes you edited or adopted. Your own
notes in those folders stay where they are, including notes you upload
(any note with a `javis_source_id`). A root folder is removed only if
the move left it empty. If `Javis-wiki/` already has a note with the same
name, the root copy is left alone and Sync now tells you. Downgrading to
0.2.x writes a fresh copy of the wiki at the vault root.

## What a synced note looks like

`Javis-wiki/Concepts/Agent-Builder.md`:

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

`%%` is Obsidian's comment syntax, so the two marker lines are invisible in
reading and live-preview mode.

**The plugin replaces only the text between the markers.** Write whatever you
like above the block or below it — notes, links, embeds, your own headings —
and it survives every sync, forever. Add your own frontmatter keys and they
survive too; the plugin touches `title`, `aliases`, and the `javis_*` keys, and
leaves the rest of your properties alone. Aliases are a union, so one you add
by hand is never dropped.

`javis_rev` is the server's timestamp for that page and is how the plugin knows
whether anything changed. Leave it alone.

## Taking a page over: `javis_sync: false`

Edit the note's frontmatter:

```yaml
javis_sync: false
```

That page is now yours. The plugin skips it on every subsequent sync, including
when the server has a newer version — which is exactly the case you are
protecting yourself from. The flag is read from **your file**, so it takes
effect the moment you save it. Nothing needs to be configured on the server,
and there is no list of exceptions to maintain somewhere else.

Use it when you have edited a generated body and want to keep the edit. The
Javis pipeline overwrites page bodies wholesale on every re-ingest, so without
this flag your edit inside the marker block is replaced the next time that page
is regenerated.

Set it back to `true`, or delete the line, and the page starts syncing again on
the next run.

## When it syncs

- **When the vault opens** — once, shortly after Obsidian finishes loading. On
  by default.
- **On a timer** — off by default. Turn it on and set the minutes.
- **On demand** — `Javis Wiki Sync: Sync now` in the command palette, the
  refresh icon in the ribbon, or the button in settings.

One sync runs at a time. If you ask for another while one is running, it says
so rather than starting a second.

The status bar shows the result of the last run, and so does the settings tab.

## If something looks wrong

**A page is missing, or looks stale.** Settings → **Forget position**. The next
sync re-reads every page from scratch. This is safe at any time: writes are
idempotent, your text outside the markers is untouched, and nothing is deleted.

**A page disappeared from Javis.** Its note stays in your vault. The generated
block is emptied and a warning callout is added at the top explaining why. The
note, and everything you wrote in it, is yours to keep or delete.

**`data.json` got clobbered** by git, Obsidian Sync, or iCloud. Nothing is lost.
The plugin's real state is the `javis_rev` in each note's frontmatter;
`data.json` only caches a position to start from. A lost or conflicted one costs
one slower sync.

**You use Obsidian Sync, iCloud, or git on this vault too.** So do most people,
and this plugin is built on the assumption that something else is writing
underneath it. That is why it is one-way, why it never deletes, and why an
unchanged page re-renders byte-identically instead of showing up as a change.

## Uploading your own notes (optional)

Off by default. Nothing below happens until you add a folder under Settings →
**Javis Wiki Sync** → **Upload your notes**.

Uploading makes notes you write yourself part of your Javis wiki. The server
distills each note into wiki pages the same way it distills your voice sessions
and email, and those pages come back into this vault like every other wiki
page.

### Quick start

1. **Connect** (see [Connect it](#connect-it)) and let one sync finish.
2. Settings → **Javis Wiki Sync** → **Upload your notes** → **Add a folder**.
   Start typing a folder name, pick it from the list, and click **Add**. For
   example, `Journal` uploads every note in `Journal/` and its subfolders. You
   can add several folders.

   You cannot pick the vault root, `.obsidian/`, `Javis-wiki/`, or a folder
   inside one of them. Two picked folders cannot be inside each other.
3. **Allow uploads.** If you connected before choosing a folder, your sign-in
   is read-only. Click **Reconnect to allow uploads**. Your browser opens and
   you sign in to Javis. The consent screen lists an extra, optional
   permission as a ticked checkbox: *Store the text of notes in the folders you
   choose, and add them to your wiki.* Leave it ticked and allow, and Obsidian
   shows *Javis: uploads allowed.* If you untick it, you stay connected
   read-only and nothing is uploaded.
4. **Sync.** Click **Sync now** (the ribbon icon, the command palette, or
   settings). The upload runs right after the download. The first time a note
   is uploaded, the plugin adds one line to its properties,
   `javis_source_id: …` (see [Details](#details)).
5. **Wait for your wiki to catch up.** The server works through uploaded notes
   in the background, one at a time, a batch about once a minute, within an
   hourly limit per account. A handful of notes is done in minutes; a large
   first upload of hundreds of notes can take hours. New and updated pages
   arrive in `Javis-wiki/` on a later sync. Each uploaded note also
   gets its own source page, `Javis-wiki/Sources/obsidian-note-<id>.md`.

From then on, just write. An edited note is uploaded again on the next sync.
Turn on **Upload when a note is edited** to upload 2 minutes after you stop
typing instead.

### Checking progress

Everything is in Settings → **Javis Wiki Sync** → **Upload your notes**, under
the last upload:

| You see | It means |
| --- | --- |
| *On the server: … pending, … done* | How many of your notes the server is still processing, and how many are in the wiki. `failed` means the server gave up on a note; `deleted` counts removed notes. |
| **Failed** | The upload itself failed, for example because the network dropped. It is retried on the next sync. |
| **Not added to the wiki (edit the note to retry)** | The server could not distill the note. Editing the note sends it again. |
| **Too large**, **Unreadable**, **Unstampable**, **Invalid characters** | Notes that were skipped, with the reason: over 256 KB, only in the cloud (for example iCloud), a properties block with no closing `---`, or characters the server rejects. |
| **Held changes** | Removals or suspicious edits waiting for you. See [Stopping, and held changes](#stopping-and-held-changes). |
| **Will be removed from Javis if still missing** | Notes that disappeared and will be removed after the 5-minute check. |
| **Recently removed** | What each removal did, for example *removed from 4 pages; 2 older pages may still mention it*. |

### Stopping, and held changes

- **To stop uploading a folder**, click ✕ next to it. Its notes are then
  removed from Javis, not just paused: their stored text is deleted and the
  wiki is rebuilt without them, after the same safety checks as any removal.
  This applies even to the last folder.
- **To remove one note from Javis**, delete it or move it out of the selected
  folders.
- **Disconnect** only signs this device out. Notes you already uploaded stay in
  Javis. To take them out, remove them as above while connected.
- **If many notes vanish at once**, or a note suddenly empties, the plugin
  holds those changes instead of sending them. It says so once. Run **Review
  pending changes** from the command palette (or click **Review** in
  settings), check the list, and click **Send these changes**, or **Cancel**
  if the files are coming back. A hold clears itself when the files return.

### If uploads look stuck

- **Everything stays *pending*.** The server has not processed the notes yet.
  Large first uploads take hours because of the hourly limit. If nothing moves
  for a long time, the server's processing may be switched off; ask the Javis
  operator.
- **No Upload your notes section.** You are on 0.1.x. Install 0.2.0 (see
  [Install](#install)).
- **Uploads are paused: different account.** This device is signed in to a
  different Javis account than the one this vault uploaded to. Sign back in
  to that account, or click **Start uploads over**.
- **A note never shows up.** Check the skipped lists above. A note in a wiki
  folder is never uploaded, because the wiki is not fed back into itself.

### Details

**What is sent.** The full text of every `.md` note in the folders you select,
including subfolders — body and properties, except the plugin's own
`javis_*` lines — plus each note's path and title. Nothing outside those
folders: not attachments, canvases, or any other file, and never
`Javis-wiki/`, the vault root, or `.obsidian/`, which cannot be selected.

**Where it goes.** To your Javis server (the **Javis server** setting, by
default `https://mcp.javis.is`), over HTTPS, with your own sign-in. (The plugin
refuses a plain `http://` server address — for signing in, downloading and
uploading alike — unless the server runs on this computer.)

**Why.** The server feeds each note to an AI model that distills it into your
Javis wiki, the same way it distills your voice sessions and email. The pages
it produces come back into this vault on the next sync.

**It is stored.** The server keeps the text of each note as you last uploaded
it, so it can re-distill the note without asking the plugin again. Editing a
note uploads the new text and the wiki follows, including removals.

**How it is removed.** Delete a note, move it out of the selected folders, or
remove its folder from the list (the last folder too: the plugin keeps syncing
until everything it uploaded is removed). After the safety checks below, the plugin asks
the server to remove it: the stored text is deleted from the server's database
at that moment, pages only that note produced are removed, and pages it shared
with other sources are rebuilt from those sources. Pages created before this
feature existed cannot be rebuilt; they are marked instead and may still
mention the note. **Nothing in your vault is ever deleted** by any of this.

Each vault only ever removes notes it uploaded itself (or whose note it still
holds), so two vaults can upload to the same Javis account without removing
each other's notes. The plugin remembers what it uploaded in its settings file;
if that file is lost, a note that was deleted *before* the plugin saw its note
again stays on the server.

A vault's uploads belong to the Javis account they were first made to. If this
device is later signed in to a different account, uploads pause instead of
copying your notes into it; sign back in, or use **Start uploads over** in the
settings, which forgets the old uploads and your folder choice (what the old
account holds stays there).

**The one line the plugin writes into your note.** To recognize a note after a
rename or a move, the plugin adds a single property line to it the first time
it is uploaded:

```yaml
javis_source_id: 3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b
```

It is inserted as one line of text; the rest of your properties — comments,
quotes, lists, dates — are left byte for byte as you wrote them. A note whose
properties block has no closing `---` is not touched, and is listed in settings
instead. Leave the line alone: if you delete it, the note is uploaded as a new
one. A copied note gets a fresh id automatically.

**Safety checks before anything is removed.**
- A note must be missing on two syncs at least five minutes apart.
- A note that is listed but cannot be read (for example, an iCloud file that is
  only in the cloud) counts as present, never as deleted.
- If a selected folder suddenly lists no notes at all, nothing under it is
  removed.
- A note that is suddenly empty, or less than a fifth of the size it was last
  uploaded at, is not uploaded until you confirm it: its edit is held, even when
  it is the only change.
- If one sync would remove or empty more than a few notes — the smaller of 50
  and 20% of your uploaded notes, but at least 5 — every one of those changes
  is held.

Held changes are announced once and wait for you: run **Review pending
changes** from the command palette to see them and send them. If the files
come back, the hold simply disappears.

**When uploads happen.** On every sync, right after the download: when the vault
opens (which also catches edits made while Obsidian was closed), on the timer if
you enabled it, and on **Sync now**. Optionally, 2 minutes after you stop
editing a note (**Upload when a note is edited**, off by default).

**Privacy policy:** <https://javis.is/privacy>. The consent screen you see when
you allow uploads says the same thing as this section.

## What it does not do

Upload anything outside the folders you select, including attachments and
canvases. Write back edits you make to the generated wiki notes. Sync
transcripts, daily notes, or skill data. Create stub notes for links that point
nowhere. Delete, trash, or rename a file. Run on mobile. Run while Obsidian is
closed.

## Developing

```bash
npm install
npm test            # vitest
npm run typecheck   # tsc -noEmit
npm run build       # typecheck + esbuild production -> main.js
npm run dev         # esbuild watch
```

`src/core/` is pure: no Obsidian import, no filesystem, no clock. Every decision
in the sync design lives there and is unit-tested directly. `src/shell/` is the
part that talks to HTTP, OAuth, and the vault.

Design: `javis-server/docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md`
(the download) and `javis-server/docs/superpowers/specs/2026-09-24-obsidian-notes-ingest-design.md`
(the upload).

## License

MIT.
