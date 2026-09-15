# Javis Wiki Sync

An Obsidian plugin that mirrors your Javis wiki into a vault, one way.

Every wiki page becomes a markdown file with working wikilinks, backlinks,
graph view, and search. The plugin writes only the text between its own
markers, and **never deletes a file**.

> **Try it on a scratch vault first.**
> Create an empty vault, connect it, let it sync, and look at what landed. This
> plugin writes into nine folders at the root of whatever vault it is enabled
> in, and if you already use those folder names for your own notes, its files
> will land beside yours. It cannot delete anything — there is no call to
> `vault.delete` or `vault.trash` anywhere in it — but "cannot delete" is not
> the same as "cannot surprise you". Back up any vault you care about before
> pointing this at it.

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
- **A Javis account**, and a Javis server exposing `GET /wiki/export`
  (default origin `https://mcp.javis.is`).

## Install

The plugin is not in the Obsidian community catalogue yet.

**Via BRAT** (recommended — you get updates):

1. Install **Obsidian42 - BRAT** from Community plugins.
2. `BRAT: Add a beta plugin for testing`, and give it this repository.
3. Enable **Javis Wiki Sync** under Settings → Community plugins.

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

The grant is **read-only** (`mcp:read`). This plugin cannot write to your wiki.

Both tokens are stored in your OS keychain. **Disconnect** clears them. If the
connection ever dies for good, the plugin says so once and stops — it does not
retry in a loop or quietly sync stale data.

**Javis server** is editable in the same settings tab if you run your own.

## What it creates

Nine folders, at the **root** of the vault, one per page type:

```
Sources/  Entities/  Concepts/  Topics/  Comparisons/
Questions/  Syntheses/  Decisions/  Gaps/
```

Root placement is not a style choice. Page bodies contain `[[Concepts/Foo]]`
literally, and Obsidian resolves that path from the vault root. Put the tree
one folder deeper and every link in every note would have to be rewritten on
every sync.

A folder is created only when a page needs it.

## What a synced note looks like

`Concepts/Agent-Builder.md`:

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

## What it does not do

Write anything back to Javis. Sync transcripts, daily notes, or skill data.
Create stub notes for links that point nowhere. Delete, trash, or rename a
file. Run on mobile. Run while Obsidian is closed.

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

Design: `javis-server/docs/superpowers/specs/2026-09-13-obsidian-wiki-sync-design.md`.

## License

MIT.
