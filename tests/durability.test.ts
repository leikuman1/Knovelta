import { afterEach, expect, it, vi } from 'vitest';
import { fstatSync, fsyncSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/lib/store';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync), fsyncSync: vi.fn(fs.fsyncSync) };
});

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (store.db.open) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function make(fault?: ConstructorParameters<typeof Store>[1]) {
  const root = mkdtempSync(path.join(tmpdir(), 'knovelta-durability-')); roots.push(root);
  const store = new Store(root, fault); stores.push(store); return store;
}
function directoryFor(fd: number) {
  if (!fstatSync(fd).isDirectory()) return null;
  const index = vi.mocked(openSync).mock.results.findLastIndex(result => result.type === 'return' && result.value === fd);
  return String(vi.mocked(openSync).mock.calls[index][0]);
}
async function observeSync(onDirectory: (dir: string) => void) {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fsyncSync).mockImplementation(fd => {
    const dir = directoryFor(fd);
    if (dir) onDirectory(dir);
    fs.fsyncSync(fd);
  });
}
function proposal(store: Store, noteId?: string) {
  const source = store.saveSource('持久化内容', randomUUID());
  return store.createProposal({ action: noteId ? 'UPDATE' : 'CREATE', targetNoteId: noteId ?? null, baseVersion: noteId ? 1 : null, proposedTitle: '持久化', proposedContent: noteId ? '更新后的内容' : source.content, sourceIds: [source.id], reason: '测试写入恢复' });
}

it('文件和重命名目录在发布状态前完成同步，Windows 跳过目录同步', async () => {
  const synced: string[] = [];
  await observeSync(dir => synced.push(path.basename(dir)));
  const store = make(point => {
    if (process.platform === 'win32') { expect(synced).toEqual([]); return; }
    if (point === 'source_saved') expect(synced).toContain('raw');
    if (point === 'snapshot_written') expect(synced).toContain('versions');
    if (point === 'after_replace') expect(synced.slice(-2)).toEqual(['wiki', 'staging']);
  });
  const note = store.approve(proposal(store).id, 0);
  rmSync(path.join(store.root, 'wiki', `${note.id}.md`));
  synced.length = 0;
  store.recover();
  expect(store.recoveryErrors).toEqual([]);
  expect(synced).toEqual(process.platform === 'win32' ? [] : ['staging', 'wiki', 'staging']);
});

it.runIf(process.platform !== 'win32')('原文目录同步失败保留待恢复状态，重试时补做同步', async () => {
  const store = make();
  const requestId = randomUUID();
  let fail = true;
  const synced: string[] = [];
  await observeSync(dir => {
    synced.push(path.basename(dir));
    if (fail && path.basename(dir) === 'raw') { fail = false; throw new Error('directory sync failed'); }
  });
  expect(() => store.saveSource('待恢复原文', requestId)).toThrow('directory sync failed');
  expect(store.db.prepare('SELECT status FROM sources WHERE requestId=?').get(requestId)).toEqual({ status: 'pending' });
  synced.length = 0;
  expect(store.saveSource('待恢复原文', requestId).status).toBe('ready');
  expect(synced).toEqual(['raw']);
});

it.runIf(process.platform !== 'win32')('目录同步失败不提交数据库，恢复时为已替换的正文补做同步', async () => {
  const store = make();
  const note = store.approve(proposal(store).id, 0);
  const patch = proposal(store, note.id);
  let fail = true;
  const synced: string[] = [];
  await observeSync(dir => {
    synced.push(path.basename(dir));
    if (fail && path.basename(dir) === 'wiki') { fail = false; throw new Error('directory sync failed'); }
  });
  expect(() => store.approve(patch.id, 1)).toThrow('写入中断');
  expect(store.note(note.id).currentVersion).toBe(1);
  expect(store.proposal(patch.id).status).toBe('needs_recovery');
  synced.length = 0;
  store.recover();
  expect(synced).toEqual(['versions', 'wiki', 'staging', 'wiki', 'staging']);
  expect(store.recoveryErrors).toEqual([]);
  expect(store.note(note.id).currentVersion).toBe(2);
  expect(store.note(note.id).content).toBe(patch.proposedContent);
  expect(store.versions(note.id)).toHaveLength(2);
  store.recover(); expect(store.versions(note.id)).toHaveLength(2);
});
