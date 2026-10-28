import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { diffLines } from 'diff';
import { AppError, proposalSchema, requireId } from './schemas';
import { indexText, matchQuery } from './search';
import type { AuditEvent, Dependency, Note, NoteSummary, Proposal, ProposalDetail, ProposalInput, Source, Version } from './types';

export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();
function syncDirectory(dir: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
type Operation = { id: string; proposalId: string; noteId: string; fromVersion: number; toVersion: number; beforeHash: string | null; afterHash: string; state: string };
type ProposalRow = Omit<Proposal, 'sourceIds' | 'dependencies'> & { sourceIds: string; dependencies: string };
export type FaultPoint = 'source_saved' | 'prepared' | 'snapshot_written' | 'before_replace' | 'after_replace' | 'before_db_commit' | 'after_db_commit';

export class Store {
  readonly db: Database.Database;
  readonly root: string;
  recoveryErrors: string[] = [];
  constructor(root: string, private fault?: (point: FaultPoint) => void) {
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true });
    for (const dir of ['raw', 'wiki', 'versions', 'staging']) {
      mkdirSync(path.join(/* turbopackIgnore: true */ this.root, dir), { recursive: true });
      if (lstatSync(path.join(/* turbopackIgnore: true */ this.root, dir)).isSymbolicLink()) throw new AppError('UNSAFE_PATH', '数据目录不能是符号链接');
    }
    syncDirectory(this.root);
    this.db = new Database(path.join(this.root, 'memoagent.sqlite'));
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
    if (!this.db.prepare('SELECT version FROM schema_migrations WHERE version=1').get()) {
      this.db.transaction(() => this.db.exec(readFileSync(path.join(process.cwd(), 'migrations/001_initial.sql'), 'utf8')))();
    }
    this.recover();
  }
  close() { this.db.close(); }
  private file(kind: 'raw' | 'wiki' | 'versions' | 'staging', id: string, version?: number) {
    requireId(id);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new AppError('INVALID_VERSION', '无效版本');
    const target = path.join(this.root, kind, `${id}${version === undefined ? '' : `-v${version}`}.md`);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new AppError('UNSAFE_PATH', '拒绝读取符号链接');
    return target;
  }
  private read(file: string) { return existsSync(file) ? readFileSync(file, 'utf8') : null; }
  private durableCreate(file: string, content: string) {
    if (existsSync(file)) {
      if (hash(readFileSync(file, 'utf8')) !== hash(content)) throw new AppError('FILE_CONFLICT', '文件内容与预期不一致', 409);
    } else {
      const fd = openSync(file, 'wx');
      try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    }
    syncDirectory(path.dirname(file));
  }
  private audit(eventType: string, actor: string, detail: unknown, noteId: string | null = null, proposalId: string | null = null, operationId: string | null = null) {
    this.db.prepare('INSERT INTO audit_events(eventType,actor,detail,noteId,proposalId,operationId,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(eventType, actor, JSON.stringify(detail), noteId, proposalId, operationId, now());
  }
  saveSource(content: string, requestId: string): Source {
    requireId(requestId);
    if (!content.trim() || content.length > 20_000) throw new AppError('INVALID_INPUT', '输入须为 1–20000 字符');
    let row = this.db.prepare('SELECT * FROM sources WHERE requestId=?').get(requestId) as Omit<Source, 'content'> | undefined;
    if (row && row.contentHash !== hash(content)) throw new AppError('REQUEST_CONFLICT', '同一请求 ID 不能用于不同内容', 409);
    if (!row) {
      const id = randomUUID();
      this.db.prepare('INSERT INTO sources(id,requestId,rawPath,createdAt,contentHash,status) VALUES (?,?,?,?,?,?)')
        .run(id, requestId, `raw/${id}.md`, now(), hash(content), 'pending');
      row = this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as Omit<Source, 'content'>;
    }
    this.durableCreate(this.file('raw', row.id), content);
    this.fault?.('source_saved');
    this.db.prepare("UPDATE sources SET status='ready' WHERE id=?").run(row.id);
    return this.source(row.id);
  }
  source(id: string): Source {
    requireId(id);
    const row = this.db.prepare('SELECT * FROM sources WHERE id=?').get(id) as Omit<Source, 'content'> | undefined;
    if (!row) throw new AppError('NOT_FOUND', '原始记录不存在', 404);
    const content = this.read(this.file('raw', id));
    if (row.status !== 'ready' || content === null || hash(content) !== row.contentHash) throw new AppError('SOURCE_UNAVAILABLE', '原始记录未完整保存或已损坏', 503);
    return { ...row, content };
  }
  notes(query?: string): NoteSummary[] {
    if (query !== undefined) return this.search(query);
    return this.db.prepare('SELECT id,title,currentVersion,updatedAt,contentHash FROM notes ORDER BY updatedAt DESC').all() as NoteSummary[];
  }
  note(id: string, version?: number): Note {
    requireId(id);
    const row = this.db.prepare('SELECT id,title,currentVersion,updatedAt,contentHash FROM notes WHERE id=?').get(id) as NoteSummary | undefined;
    if (!row) throw new AppError('NOT_FOUND', '笔记不存在', 404);
    const v = version ?? row.currentVersion;
    if (!Number.isSafeInteger(v) || v < 1) throw new AppError('INVALID_VERSION', '无效版本');
    const meta = this.db.prepare('SELECT * FROM note_versions WHERE noteId=? AND version=?').get(id, v) as Version | undefined;
    if (!meta) throw new AppError('NOT_FOUND', '历史版本不存在', 404);
    const content = this.read(this.file('versions', id, v));
    if (content === null || hash(content) !== meta.contentHash) throw new AppError('SNAPSHOT_CORRUPT', '已提交快照缺失或损坏，请恢复数据', 503);
    const sourceIds = (this.db.prepare('SELECT sourceId FROM note_version_sources WHERE noteId=? AND version=? ORDER BY sourceId').all(id, v) as { sourceId: string }[]).map(s => s.sourceId);
    return { ...row, title: meta.title, currentVersion: v, contentHash: meta.contentHash, updatedAt: meta.createdAt, content, sourceIds };
  }
  versions(id: string): Version[] {
    this.note(id);
    return this.db.prepare('SELECT noteId,version,title,contentHash,proposalId,restoredFromVersion,createdAt FROM note_versions WHERE noteId=? ORDER BY version DESC').all(id) as Version[];
  }
  search(query: string, limit = 5): NoteSummary[] {
    if (query.length > 1000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new AppError('INVALID_QUERY', '检索参数超出范围');
    const match = matchQuery(query);
    if (!match) return [];
    const rows = this.db.prepare(`SELECT n.id,n.title,n.currentVersion,n.updatedAt,n.contentHash FROM notes_fts f JOIN notes n ON n.id=f.noteId WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts,0,3,1) LIMIT ?`).all(match, limit) as NoteSummary[];
    return rows.map(row => ({ ...row, snippet: this.note(row.id).content.slice(0, 240) }));
  }
  proposals(): Proposal[] {
    return (this.db.prepare('SELECT * FROM change_proposals ORDER BY createdAt DESC').all() as ProposalRow[]).map(row => this.parseProposal(row));
  }
  private parseProposal(row: ProposalRow): Proposal { return { ...row, sourceIds: JSON.parse(row.sourceIds), dependencies: JSON.parse(row.dependencies) }; }
  proposal(id: string): Proposal {
    requireId(id);
    const row = this.db.prepare('SELECT * FROM change_proposals WHERE id=?').get(id) as ProposalRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', '提案不存在', 404);
    return this.parseProposal(row);
  }
  proposalDetail(id: string): ProposalDetail {
    const p = this.proposal(id);
    const before = p.baseVersion ? this.note(p.targetNoteId, p.baseVersion) : null;
    return { ...p, beforeContent: before?.content ?? '', beforeTitle: before?.title ?? '', diff: diffLines(before?.content ?? '', p.proposedContent), sources: p.sourceIds.map(id => this.source(id)) };
  }
  createProposal(input: ProposalInput, runId: string | null = null, dependencies: Dependency[] = []): Proposal {
    if (input.action === 'RESTORE') throw new AppError('FORBIDDEN', '模型不能创建恢复操作', 403);
    const parsed = proposalSchema.parse(input);
    for (const id of parsed.sourceIds) this.source(id);
    if (parsed.targetNoteId) {
      const note = this.note(parsed.targetNoteId);
      if (note.currentVersion !== parsed.baseVersion) throw new AppError('VERSION_CONFLICT', '笔记已更新，请重新生成提案', 409);
    }
    return this.insertProposal(parsed, runId, dependencies, null);
  }
  private insertProposal(input: ProposalInput, runId: string | null, dependencies: Dependency[], restoredFromVersion: number | null) {
    const id = randomUUID();
    const target = input.targetNoteId ?? randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO change_proposals(id,runId,action,targetNoteId,baseVersion,proposedTitle,proposedContent,sourceIds,dependencies,contentHash,reason,status,restoredFromVersion,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, runId, input.action, target, input.baseVersion, input.proposedTitle, input.proposedContent, JSON.stringify([...new Set(input.sourceIds)]), JSON.stringify(dependencies), hash(input.proposedContent), input.reason, 'pending', restoredFromVersion, now());
      this.audit('proposal_created', runId ? 'agent' : 'system', { action: input.action }, target, id);
    })();
    return this.proposal(id);
  }
  restore(id: string, version: number, expectedVersion: number) {
    const current = this.note(id);
    if (current.currentVersion !== expectedVersion) throw new AppError('VERSION_CONFLICT', '当前版本已变化，请重新预览恢复', 409);
    const historical = this.note(id, version);
    const p = this.insertProposal({ action: 'RESTORE', targetNoteId: id, baseVersion: expectedVersion, proposedTitle: historical.title, proposedContent: historical.content, sourceIds: historical.sourceIds, reason: `恢复历史版本 v${version}，生成新的审计版本` }, null, [], version);
    return this.proposalDetail(p.id);
  }
  reject(id: string) {
    this.db.transaction(() => {
      const p = this.proposal(id);
      if (p.status === 'rejected') return;
      if (p.status !== 'pending') throw new AppError('PROPOSAL_STATE', '该提案已处理，不能拒绝', 409);
      this.db.prepare("UPDATE change_proposals SET status='rejected',decidedAt=? WHERE id=?").run(now(), id);
      this.audit('proposal_rejected', 'user', {}, p.targetNoteId, id);
    })();
    return this.proposal(id);
  }
  approve(id: string, expectedVersion: number): Note {
    let operation: Operation | undefined;
    this.db.transaction(() => {
      const p = this.proposal(id);
      if (p.status === 'applied') return;
      if (p.status !== 'pending') throw new AppError('PROPOSAL_STATE', '提案不能提交，请检查状态或恢复', 409);
      if (this.recoveryErrors.length || this.db.prepare("SELECT id FROM write_operations WHERE state IN ('prepared','file_replaced','needs_recovery')").get()) throw new AppError('RECOVERY_REQUIRED', '有未恢复的写入，暂停提交', 503);
      const row = this.db.prepare('SELECT currentVersion,contentHash FROM notes WHERE id=?').get(p.targetNoteId) as { currentVersion: number; contentHash: string } | undefined;
      const currentVersion = row?.currentVersion ?? 0;
      if (expectedVersion !== (p.baseVersion ?? 0) || currentVersion !== expectedVersion) throw new AppError('VERSION_CONFLICT', '笔记版本已变化，请重新生成并审批', 409);
      for (const dep of p.dependencies) {
        const note = this.note(dep.noteId);
        if (note.currentVersion !== dep.version || note.contentHash !== dep.contentHash) throw new AppError('VERSION_CONFLICT', '依赖证据已变化，请重新生成提案', 409);
      }
      for (const sid of p.sourceIds) this.source(sid);
      const fileContent = this.read(this.file('wiki', p.targetNoteId));
      if (row ? fileContent === null || hash(fileContent) !== row.contentHash : fileContent !== null) throw new AppError('EXTERNAL_CONFLICT', '正文被外部修改，请先检查并恢复', 409);
      operation = { id: randomUUID(), proposalId: id, noteId: p.targetNoteId, fromVersion: currentVersion, toVersion: currentVersion + 1, beforeHash: row?.contentHash ?? null, afterHash: p.contentHash, state: 'prepared' };
      this.db.prepare('INSERT INTO write_operations(id,proposalId,noteId,fromVersion,toVersion,beforeHash,afterHash,state,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(operation.id, id, p.targetNoteId, currentVersion, currentVersion + 1, operation.beforeHash, operation.afterHash, 'prepared', now());
      this.db.prepare("UPDATE change_proposals SET status='applying',decidedAt=? WHERE id=?").run(now(), id);
      this.audit('proposal_approved', 'user', { contentHash: p.contentHash, expectedVersion }, p.targetNoteId, id, operation.id);
    })();
    if (!operation) return this.note(this.proposal(id).targetNoteId);
    try {
      this.fault?.('prepared');
      this.completeOperation(operation);
    } catch (error) {
      const committed = this.db.prepare('SELECT state FROM write_operations WHERE id=?').get(operation.id) as { state: string };
      if (committed.state === 'committed') return this.note(operation.noteId);
      this.db.prepare("UPDATE write_operations SET state='needs_recovery',error=? WHERE id=?").run(error instanceof Error ? error.message : 'write failed', operation.id);
      this.db.prepare("UPDATE change_proposals SET status='needs_recovery' WHERE id=?").run(id);
      throw new AppError('RECOVERY_REQUIRED', '写入中断，已保留操作记录；请执行恢复后重试', 503);
    }
    return this.note(operation.noteId);
  }
  private completeOperation(op: Operation) {
    const p = this.proposal(op.proposalId);
    if (hash(p.proposedContent) !== op.afterHash) throw new Error('提案哈希不匹配');
    const approval = this.db.prepare("SELECT id FROM audit_events WHERE operationId=? AND eventType='proposal_approved'").get(op.id);
    if (!approval) throw new Error('缺少用户批准记录');
    const current = this.db.prepare('SELECT currentVersion FROM notes WHERE id=?').get(op.noteId) as { currentVersion: number } | undefined;
    if ((current?.currentVersion ?? 0) !== op.fromVersion) throw new Error('恢复基础版本不匹配');
    if (op.fromVersion) this.note(op.noteId, op.fromVersion);
    this.durableCreate(this.file('versions', op.noteId, op.toVersion), p.proposedContent);
    this.fault?.('snapshot_written');
    const wiki = this.file('wiki', op.noteId);
    const actual = this.read(wiki);
    const actualHash = actual === null ? null : hash(actual);
    if (actualHash !== op.afterHash) {
      if (actualHash !== op.beforeHash) throw new Error('正文不匹配已知前后版本，保留现场');
      const staging = this.file('staging', op.id);
      this.durableCreate(staging, p.proposedContent);
      this.fault?.('before_replace');
      renameSync(staging, wiki);
    }
    syncDirectory(path.join(this.root, 'wiki'));
    syncDirectory(path.join(this.root, 'staging'));
    this.fault?.('after_replace');
    this.db.prepare("UPDATE write_operations SET state='file_replaced' WHERE id=?").run(op.id);
    this.db.transaction(() => {
      const timestamp = now();
      this.db.prepare(`INSERT INTO notes(id,title,wikiPath,currentVersion,contentHash,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,currentVersion=excluded.currentVersion,contentHash=excluded.contentHash,updatedAt=excluded.updatedAt`)
        .run(op.noteId, p.proposedTitle, `wiki/${op.noteId}.md`, op.toVersion, op.afterHash, timestamp, timestamp);
      this.db.prepare('INSERT INTO note_versions(noteId,version,title,contentHash,snapshotPath,createdAt,proposalId,restoredFromVersion) VALUES (?,?,?,?,?,?,?,?)')
        .run(op.noteId, op.toVersion, p.proposedTitle, op.afterHash, `versions/${op.noteId}-v${op.toVersion}.md`, timestamp, p.id, p.restoredFromVersion);
      this.db.prepare('DELETE FROM note_sources WHERE noteId=?').run(op.noteId);
      for (const sid of p.sourceIds) {
        this.db.prepare('INSERT INTO note_sources VALUES (?,?)').run(op.noteId, sid);
        this.db.prepare('INSERT INTO note_version_sources VALUES (?,?,?)').run(op.noteId, op.toVersion, sid);
      }
      this.db.prepare('DELETE FROM notes_fts WHERE noteId=?').run(op.noteId);
      this.db.prepare('INSERT INTO notes_fts(noteId,title,content) VALUES (?,?,?)').run(op.noteId, indexText(p.proposedTitle), indexText(p.proposedContent));
      this.db.prepare("UPDATE change_proposals SET status='applied' WHERE id=?").run(p.id);
      this.db.prepare("UPDATE write_operations SET state='committed',error=NULL WHERE id=?").run(op.id);
      this.audit('note_committed', 'system', { version: op.toVersion, restoredFromVersion: p.restoredFromVersion }, op.noteId, p.id, op.id);
      this.fault?.('before_db_commit');
    })();
    this.fault?.('after_db_commit');
  }
  recover() {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.recoverLocked(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private recoverLocked() {
    this.recoveryErrors = [];
    const pending = this.db.prepare("SELECT id,contentHash FROM sources WHERE status!='ready'").all() as { id: string; contentHash: string }[];
    for (const row of pending) {
      const text = this.read(this.file('raw', row.id));
      const ready = text !== null && hash(text) === row.contentHash;
      if (ready) syncDirectory(path.join(this.root, 'raw'));
      this.db.prepare('UPDATE sources SET status=? WHERE id=?').run(ready ? 'ready' : 'failed', row.id);
    }
    const ops = this.db.prepare("SELECT * FROM write_operations WHERE state IN ('prepared','file_replaced','needs_recovery') ORDER BY createdAt").all() as Operation[];
    for (const op of ops) {
      try {
        this.completeOperation(op);
        this.audit('recovery_completed', 'system', {}, op.noteId, op.proposalId, op.id);
      } catch {
        const message = `操作 ${op.id} 需要人工恢复，异常文件已保留`;
        this.recoveryErrors.push(message);
        this.db.prepare("UPDATE write_operations SET state='needs_recovery' WHERE id=?").run(op.id);
        this.db.prepare("UPDATE change_proposals SET status='needs_recovery' WHERE id=?").run(op.proposalId);
      }
    }
    for (const note of this.notes()) {
      try {
        const snapshot = this.note(note.id);
        const wiki = this.file('wiki', note.id);
        const actual = this.read(wiki);
        if (actual === null) {
          const staged = this.file('staging', randomUUID());
          this.durableCreate(staged, snapshot.content);
          renameSync(staged, wiki);
          syncDirectory(path.dirname(wiki));
          syncDirectory(path.dirname(staged));
          this.audit('wiki_restored', 'system', {}, note.id);
        } else if (hash(actual) !== note.contentHash) {
          this.recoveryErrors.push(`笔记 ${note.id} 存在外部修改，暂停提交并保留现场`);
        } else {
          syncDirectory(path.dirname(wiki));
          syncDirectory(path.join(this.root, 'staging'));
        }
      } catch { this.recoveryErrors.push(`笔记 ${note.id} 快照异常，暂停提交`); }
    }
    this.db.prepare("UPDATE agent_runs SET status='interrupted',errorCode='PROCESS_RESTART' WHERE status='running'").run();
  }
  history(): AuditEvent[] { return this.db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT 200').all() as AuditEvent[]; }
  startRun(source: Source) {
    const running = this.db.prepare("SELECT id FROM agent_runs WHERE requestId=? AND status='running'").get(source.requestId);
    if (running) throw new AppError('RUN_ACTIVE', '该请求正在处理', 409);
    const completed = this.db.prepare("SELECT result FROM agent_runs WHERE requestId=? AND status='completed' ORDER BY createdAt DESC LIMIT 1").get(source.requestId) as { result: string } | undefined;
    if (completed) return { replay: JSON.parse(completed.result) as unknown[], id: '' };
    const pendingProposal = this.db.prepare("SELECT p.id FROM change_proposals p JOIN agent_runs r ON r.id=p.runId WHERE r.requestId=? AND p.status IN ('pending','applying','applied','needs_recovery') LIMIT 1").get(source.requestId) as { id: string } | undefined;
    if (pendingProposal) return { replay: [{ type: 'proposal', proposalId: pendingProposal.id }, { type: 'done', citations: [], invalidCitations: false }], id: '' };
    const id = randomUUID();
    this.db.prepare("INSERT INTO agent_runs(id,requestId,sourceId,status,createdAt) VALUES (?,?,?,'running',?)").run(id, source.requestId, source.id, now());
    return { id, replay: null };
  }
  finishRun(id: string, status: string, result: unknown[], tools: string[], durationMs: number, usage?: unknown, errorCode?: string) {
    this.db.prepare('UPDATE agent_runs SET status=?,result=?,selectedTools=?,durationMs=?,usage=?,errorCode=? WHERE id=?')
      .run(status, JSON.stringify(result), JSON.stringify(tools), durationMs, usage ? JSON.stringify(usage) : null, errorCode ?? null, id);
  }
}

export function dataDirectory() {
  return path.resolve(process.env.MEMOAGENT_DATA_DIR || './workspace');
}
const globalStore = globalThis as typeof globalThis & { memoStore?: Store };
export function getStore() {
  return globalStore.memoStore ??= new Store(dataDirectory());
}
