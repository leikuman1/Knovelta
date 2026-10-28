export type Action = 'CREATE' | 'UPDATE' | 'FLAG_CONFLICT' | 'RESTORE';
export type ProposalStatus = 'pending' | 'applying' | 'applied' | 'rejected' | 'stale' | 'needs_recovery';
export interface Source { id: string; requestId: string; content: string; createdAt: string; contentHash: string; status: string }
export interface NoteSummary { id: string; title: string; currentVersion: number; updatedAt: string; contentHash: string; snippet?: string }
export interface Note extends NoteSummary { content: string; sourceIds: string[] }
export interface Version { noteId: string; version: number; title: string; contentHash: string; proposalId: string; restoredFromVersion: number | null; createdAt: string }
export interface Dependency { noteId: string; version: number; contentHash: string }
export interface ProposalInput { action: Action; targetNoteId: string | null; baseVersion: number | null; proposedTitle: string; proposedContent: string; sourceIds: string[]; reason: string }
export interface Proposal extends ProposalInput { id: string; runId: string | null; targetNoteId: string; contentHash: string; status: ProposalStatus; createdAt: string; decidedAt: string | null; restoredFromVersion: number | null; dependencies: Dependency[] }
export interface ProposalDetail extends Proposal { beforeContent: string; beforeTitle: string; diff: { value: string; added?: boolean; removed?: boolean }[]; sources: Source[] }
export interface Evidence { id: string; noteId: string; noteVersion: number; sourceId: string; kind: 'note' | 'source'; excerpt: string; startLine: number; endLine: number; historical?: boolean }
export interface AuditEvent { id: number; eventType: string; actor: string; noteId: string | null; proposalId: string | null; operationId: string | null; detail: string; createdAt: string }
export type ChatEvent =
  | { type: 'saved'; sourceId: string; runId: string }
  | { type: 'status'; message: string }
  | { type: 'text'; text: string }
  | { type: 'proposal'; proposalId: string }
  | { type: 'done'; citations: Evidence[]; invalidCitations: boolean }
  | { type: 'error'; message: string; code: string };
