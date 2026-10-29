/**
 * `ObsidianVaultAdapter.removeFolderIfEmpty` and `folderExists`, against a stand-in
 * `App` that behaves the way Obsidian 1.13.7 did in the E2E run of 2026-09-27.
 *
 * The rest of the adapter is exempt from unit tests by §H. These two methods are
 * not: the first version called `vault.delete(folder)`, the fake in
 * tests/sync.test.ts accepted it, and in a real vault every call failed with
 * "rm returned EISDIR" — eight emptied wiki folders stayed behind. Console probes
 * in that vault established the rules this stand-in encodes:
 *
 * - `vault.delete(folder)` and `adapter.rmdir(path, false)` both throw EISDIR,
 *   even on a folder that is empty on disk.
 * - `adapter.rmdir(path, true)` removes the folder and Obsidian's tree follows.
 * - `adapter.list(path)` reports hidden files such as `.DS_Store`, which the
 *   folder's `children` do not.
 */

import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';

import { notesUnder, ObsidianVaultAdapter } from '../src/shell/vault';

interface FakeDir {
  files: string[];
  folders: string[];
  /** What Obsidian's tree lists: no hidden files. */
  children: string[];
}

function obsidian113(dirs: Record<string, FakeDir>) {
  const calls: string[] = [];
  const eisdir = (path: string) =>
    Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${path}`), { code: 'ERR_FS_EISDIR' });
  // A child that is itself a folder carries `children`, as a TFolder does.
  const child = (parent: string, name: string) =>
    dirs[parent === '' ? name : `${parent}/${name}`] === undefined ? { name } : { name, children: [] };
  const folderAt = (path: string) =>
    dirs[path] === undefined ? null : { path, name: path.split('/').pop(), children: dirs[path]!.children.map((name) => child(path, name)) };
  const app = {
    vault: {
      getFolderByPath: (path: string) => folderAt(path),
      getRoot: () => ({ path: '', children: Object.keys(dirs).filter((p) => !p.includes('/')).map((name) => child('', name)) }),
      async delete(file: { path: string }) {
        calls.push(`vault.delete ${file.path}`);
        throw eisdir(file.path);
      },
      adapter: {
        async list(path: string) {
          calls.push(`list ${path}`);
          const dir = dirs[path];
          if (dir === undefined) throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
          return { files: [...dir.files], folders: [...dir.folders] };
        },
        async rmdir(path: string, recursive: boolean) {
          calls.push(`rmdir ${path} recursive=${recursive}`);
          if (!recursive) throw eisdir(path);
          delete dirs[path];
        },
      },
    },
  };
  return { adapter: new ObsidianVaultAdapter(app as unknown as App), calls, dirs };
}

describe('ObsidianVaultAdapter.removeFolderIfEmpty (E2E 2026-09-27: EISDIR)', () => {
  it('removes a folder that is empty on disk', async () => {
    const { adapter, calls, dirs } = obsidian113({ Topics: { files: [], folders: [], children: [] } });

    await adapter.removeFolderIfEmpty('Topics');

    expect(dirs.Topics).toBeUndefined();
    expect(calls).toEqual(['list Topics', 'rmdir Topics recursive=true']);
  });

  it('leaves a folder holding a hidden file Obsidian does not list', async () => {
    const { adapter, calls, dirs } = obsidian113({ Topics: { files: ['Topics/.DS_Store'], folders: [], children: [] } });

    await adapter.removeFolderIfEmpty('Topics');

    expect(dirs.Topics).toBeDefined();
    expect(calls).toEqual(['list Topics']);
  });

  it('leaves a folder that holds a note or a subfolder', async () => {
    const { adapter, calls } = obsidian113({
      Concepts: { files: ['Concepts/mine.md'], folders: [], children: ['mine.md'] },
      Gaps: { files: [], folders: ['Gaps/old'], children: ['old'] },
    });

    await adapter.removeFolderIfEmpty('Concepts');
    await adapter.removeFolderIfEmpty('Gaps');

    expect(calls.filter((c) => c.startsWith('rmdir'))).toEqual([]);
  });

  it('does nothing for a folder that is not there', async () => {
    const { adapter, calls } = obsidian113({});

    await adapter.removeFolderIfEmpty('Topics');

    expect(calls).toEqual([]);
  });
});

describe('ObsidianVaultAdapter.folderExists', () => {
  it('answers from the folder tree, matching Javis-wiki in any case', async () => {
    const { adapter } = obsidian113({
      Topics: { files: [], folders: [], children: [] },
      'javis-wiki': { files: [], folders: ['javis-wiki/Topics'], children: ['Topics'] },
      'javis-wiki/Topics': { files: [], folders: [], children: [] },
    });

    expect(await adapter.folderExists('Topics')).toBe(true);
    expect(await adapter.folderExists('Gaps')).toBe(false);
    expect(await adapter.folderExists('Javis-wiki/Topics')).toBe(true);
  });
});

/**
 * The listings walk only the folders they are given (review recommendation
 * "Vault Enumeration", 2026-10-28): `getMarkdownFiles` is never called.
 * Bug doc: docs/javis-dev/spec/2026-10-28-obsidian-review-recommendations-bug.md
 */
describe('ObsidianVaultAdapter folder-scoped listings (no whole-vault enumeration)', () => {
  const ALL = [
    'Javis-wiki/Topics/a.md',
    'Javis-wiki/Tasks/t.md',
    'topics/old.md',
    'topics/deep/skip.md',
    'Journal/x.md',
    'Journal/sub/z.md',
    'Journal/c.canvas',
    'Journal2/y.md',
    'loose.md',
  ];

  function tree(paths: readonly string[]) {
    type Node = { path: string; name: string; children?: Node[]; extension?: string };
    const root: Node = { path: '', name: '', children: [] };
    const folders = new Map<string, Node>([['', root]]);
    for (const path of paths) {
      const parts = path.split('/');
      let parent = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const p = parts.slice(0, i + 1).join('/');
        let folder = folders.get(p);
        if (folder === undefined) {
          folder = { path: p, name: parts[i]!, children: [] };
          folders.set(p, folder);
          parent.children!.push(folder);
        }
        parent = folder;
      }
      const name = parts[parts.length - 1]!;
      parent.children!.push({ path, name, extension: name.slice(name.lastIndexOf('.') + 1) });
    }
    const app = {
      vault: {
        getRoot: () => root,
        getFolderByPath: (path: string) => folders.get(path) ?? null,
        getMarkdownFiles: () => {
          throw new Error('getMarkdownFiles must not be called');
        },
      },
      metadataCache: {
        getFileCache: (file: { path: string }) => ({ frontmatter: { javis_rev: `rev:${file.path}` } }),
      },
    };
    return new ObsidianVaultAdapter(app as unknown as App);
  }

  const paths = (notes: readonly { path: string }[]) => notes.map((n) => n.path).sort();

  it('lists only the notes under Javis-wiki/, recursively, with their cached frontmatter', async () => {
    const notes = await tree(ALL).listMarkdownFiles(['Javis-wiki'], { recursive: true });
    expect(paths(notes)).toEqual(['Javis-wiki/Tasks/t.md', 'Javis-wiki/Topics/a.md']);
    expect(notes.find((n) => n.path === 'Javis-wiki/Topics/a.md')?.frontmatter).toEqual({ javis_rev: 'rev:Javis-wiki/Topics/a.md' });
  });

  it('finds the legacy root folders case-insensitively and lists only their direct notes', async () => {
    const adapter = tree(ALL);
    expect(adapter.legacyRootFolders()).toEqual(['topics']);
    expect(paths(await adapter.listMarkdownFiles(adapter.legacyRootFolders(), { recursive: false }))).toEqual(['topics/old.md']);
  });

  it('a missing folder lists nothing', async () => {
    expect(await tree(ALL).listMarkdownFiles(['Nope'], { recursive: true })).toEqual([]);
  });

  it('listNotesIn returns exactly what the old whole-vault filter returned (pinning, HIGH-risk upload path)', async () => {
    const adapter = tree(ALL);
    for (const folders of [['Journal'], ['Journal', 'Journal2'], ['journal'], ['Journal/sub'], ['Javis-wiki', 'topics']]) {
      const got = (await adapter.listNotesIn(folders)).map((n) => n.path).sort();
      expect(got, folders.join(',')).toEqual(notesUnder(ALL, folders).sort());
    }
  });
});
