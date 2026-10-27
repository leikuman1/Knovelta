import { randomUUID } from 'node:crypto';
import { AppError } from './schemas';
import type { Store } from './store';
import type { Dependency, Evidence, Note } from './types';

export class EvidenceSession {
  readonly evidence = new Map<string, Evidence>();
  readonly dependencies = new Map<string, Dependency>();
  readonly allowedSources = new Set<string>();
  searched = false;
  constructor(private store: Store, sourceId: string) { this.allowedSources.add(sourceId); }
  readNote(id: string): Note & { evidence: Evidence[] } {
    const note = this.store.note(id);
    this.dependencies.set(id, { noteId: id, version: note.currentVersion, contentHash: note.contentHash });
    const evidence = note.sourceIds.map(sourceId => {
      this.allowedSources.add(sourceId);
      return this.add(note, sourceId, 'note', note.content);
    });
    return { ...note, evidence };
  }
  readSource(id: string) {
    if (!this.allowedSources.has(id)) throw new AppError('FORBIDDEN_SOURCE', '来源不属于本次已读知识', 403);
    const source = this.store.source(id);
    const dep = [...this.dependencies.values()].find(d => this.store.note(d.noteId, d.version).sourceIds.includes(id));
    const evidence = dep ? this.add(this.store.note(dep.noteId, dep.version), id, 'source', source.content) : null;
    return { ...source, evidence };
  }
  private add(note: Note, sourceId: string, kind: 'note' | 'source', content: string) {
    const item: Evidence = { id: randomUUID(), noteId: note.id, noteVersion: note.currentVersion, sourceId, kind, excerpt: content, startLine: 1, endLine: content.split('\n').length };
    this.evidence.set(item.id, item);
    return item;
  }
  validate(answer: string) {
    const citedIds = [...answer.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
    let invalidCitations = false;
    const citations: Evidence[] = [];
    for (const id of new Set(citedIds)) {
      const e = this.evidence.get(id);
      if (!e) { invalidCitations = true; continue; }
      try {
        const note = this.store.note(e.noteId, e.noteVersion);
        const source = this.store.source(e.sourceId);
        const content = e.kind === 'note' ? note.content : source.content;
        if (!note.sourceIds.includes(e.sourceId) || content.split('\n').slice(e.startLine - 1, e.endLine).join('\n') !== e.excerpt) throw new Error('citation mismatch');
        citations.push({ ...e, historical: this.store.note(e.noteId).currentVersion !== e.noteVersion });
      } catch { invalidCitations = true; }
    }
    return { citations, invalidCitations };
  }
}
