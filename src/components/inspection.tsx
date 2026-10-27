"use client";

import { useRef, useState } from "react";
import type { AuditEvent, Evidence, Note, Proposal, ProposalDetail, Source, Version } from "@/lib/types";
import { Markdown } from "./markdown";
import { actionNames } from "./proposal-review";
import { dateLabel, Dialog, ErrorMessage, errorText, Icon, idPath, Loading, postJson, useResource } from "./ui";

export type Inspection = { kind: "source"; sourceId: string } | { kind: "evidence"; evidence: Evidence } | { kind: "history"; noteId: string } | { kind: "audit" };
type InspectionProps = { inspection: Inspection; token: string; blocked: boolean; proposals: Proposal[]; onClose: () => void; onProposal: (id: string) => void; onHistory: (id: string) => void; onRestored: (proposal: ProposalDetail) => void };

export function InspectionDialog(props: InspectionProps) {
  const { inspection, onClose } = props;
  const title = inspection.kind === "source" ? "原始记录" : inspection.kind === "evidence" ? "核对引用来源" : inspection.kind === "history" ? "版本历史" : "操作历史";
  return <Dialog title={title} eyebrow={inspection.kind === "evidence" ? "VERIFIED EVIDENCE" : inspection.kind === "history" ? "VERSION HISTORY" : inspection.kind === "source" ? "ORIGINAL SOURCE" : "ACTIVITY LOG"} onClose={onClose} wide={inspection.kind !== "source"}>
    {inspection.kind === "source" && <SourceView sourceId={inspection.sourceId} />}
    {inspection.kind === "evidence" && <EvidenceView evidence={inspection.evidence} />}
    {inspection.kind === "history" && <HistoryView noteId={inspection.noteId} token={props.token} blocked={props.blocked} proposals={props.proposals} onRestored={props.onRestored} onProposal={props.onProposal} />}
    {inspection.kind === "audit" && <AuditView onHistory={props.onHistory} onProposal={props.onProposal} />}
  </Dialog>;
}

function SourceBody({ source }: { source: Source }) {
  return <section className="source-detail"><dl className="metadata-list"><div><dt>sourceId</dt><dd className="mono break-id">{source.id}</dd></div><div><dt>保存时间</dt><dd>{dateLabel(source.createdAt, true)}</dd></div><div><dt>状态</dt><dd>{source.status === "ready" ? "已保存" : source.status}</dd></div></dl><pre className="raw-content">{source.content}</pre><details className="source-integrity"><summary>记录信息</summary><p className="mono small break-id">requestId: {source.requestId}</p><p className="mono small break-id">SHA-256: {source.contentHash}</p></details></section>;
}

function SourceView({ sourceId }: { sourceId: string }) {
  const [reload, setReload] = useState(0);
  const { data: source, error } = useResource<Source>(`/api/sources/${idPath(sourceId)}`, reload);
  if (error) return <ErrorMessage message={error} onRetry={() => setReload((value) => value + 1)} />;
  return source ? <SourceBody source={source} /> : <Loading label="正在读取原文…" />;
}

function NoteSnapshot({ note, label }: { note: Note; label?: string }) {
  return <article className="snapshot"><div className="snapshot-heading"><p className="eyebrow">{label || "版本快照"}</p><span className="version-chip">v{note.currentVersion}</span></div><h3>{note.title}</h3><p className="mono small muted break-id">noteId: {note.id}</p><Markdown content={note.content} /></article>;
}

function EvidenceView({ evidence }: { evidence: Evidence }) {
  const [reload, setReload] = useState(0);
  const { data: note, error } = useResource<Note>(`/api/notes/${idPath(evidence.noteId)}/versions/${evidence.noteVersion}`, reload);
  return <><div className="evidence-context"><span className="status-badge status-applied">已验证引用</span><p className="small">笔记 v{evidence.noteVersion}{evidence.historical ? "（历史版本）" : ""} · {evidence.kind === "source" ? "原文" : "笔记"}第 {evidence.startLine}–{evidence.endLine} 行</p><blockquote>{evidence.excerpt}</blockquote></div><div className="evidence-columns"><section><h3 className="section-title"><Icon name="book" />引用时的笔记</h3>{error ? <ErrorMessage message={error} onRetry={() => setReload((value) => value + 1)} /> : note ? <NoteSnapshot note={note} label="引用版本" /> : <Loading />}</section><section><h3 className="section-title"><Icon name="file" />对应原文</h3><SourceView sourceId={evidence.sourceId} /></section></div></>;
}

function HistoryView({ noteId, token, blocked, proposals, onRestored, onProposal }: { noteId: string; token: string; blocked: boolean; proposals: Proposal[]; onRestored: (proposal: ProposalDetail) => void; onProposal: (id: string) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [reload, setReload] = useState(0);
  const [snapshotReload, setSnapshotReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState(false);
  const lock = useRef(false);
  const versionsResource = useResource<Version[]>(`/api/notes/${idPath(noteId)}/versions`, reload);
  const currentResource = useResource<Note>(`/api/notes/${idPath(noteId)}`, reload);
  const current = currentResource.data;
  const selectedVersion = selected ?? current?.currentVersion ?? null;
  const snapshotResource = useResource<Note>(selectedVersion === null ? null : `/api/notes/${idPath(noteId)}/versions/${selectedVersion}`, reload + snapshotReload);
  const snapshot = snapshotResource.data;
  const versions = [...(versionsResource.data ?? [])].sort((a, b) => b.version - a.version);
  const version = versions.find((item) => item.version === selectedVersion);
  const proposal = proposals.find((item) => item.id === version?.proposalId);

  async function previewRestore() {
    if (!current || selectedVersion === null || !token || blocked || lock.current) return;
    lock.current = true; setBusy(true); setActionError("");
    try { const result = await postJson<ProposalDetail>(`/api/notes/${idPath(noteId)}/restore`, token, { version: selectedVersion, expectedVersion: current.currentVersion }); onRestored(result); }
    catch (reason) { setActionError(errorText(reason)); }
    finally { setBusy(false); lock.current = false; }
  }
  const error = versionsResource.error || currentResource.error;
  if (error) return <ErrorMessage message={error} onRetry={() => setReload((value) => value + 1)} />;
  if (!current || !versionsResource.data) return <Loading label="正在读取版本历史…" />;
  return <><div className="history-intro"><div><h3>{current.title}</h3><p className="muted small">当前 v{current.currentVersion} · 恢复会新增版本，已有历史继续保留。</p></div><button className="icon-button" aria-label="刷新版本历史" onClick={() => { setReload((value) => value + 1); setSourceId(null); }}><Icon name="refresh" /></button></div><div className="history-layout"><nav className="version-list" aria-label="历史版本">{versions.length === 0 && <p className="muted small">暂无历史版本。</p>}{versions.map((item) => <button className={`version-item ${selectedVersion === item.version ? "selected" : ""}`} key={item.version} onClick={() => { setSelected(item.version); setSourceId(null); setActionError(""); }} aria-label={`查看历史版本 v${item.version}`} aria-pressed={selectedVersion === item.version}><span className="version-node" /><span><strong>v{item.version}{item.version === current.currentVersion && <span className="version-current">当前</span>}</strong><span className="version-title">{item.title}</span><small>{dateLabel(item.createdAt, true)}</small>{item.restoredFromVersion !== null && <small>恢复自 v{item.restoredFromVersion}</small>}</span></button>)}</nav><div className="version-content">{version && <div className="version-toolbar"><span className="small muted">{dateLabel(version.createdAt, true)}</span><button className={`button subtle compact ${compare ? "active" : ""}`} onClick={() => setCompare((value) => !value)} aria-pressed={compare}><Icon name="compare" width="14" height="14" />与当前版比较</button></div>}{proposal && <div className="version-reason"><span className="eyebrow">{actionNames[proposal.action]}</span><p>{proposal.reason}</p><button className="text-button" onClick={() => onProposal(proposal.id)}>查看对应变更 <Icon name="chevron" width="12" height="12" /></button></div>}{snapshotResource.error ? <ErrorMessage message={snapshotResource.error} onRetry={() => setSnapshotReload((value) => value + 1)} /> : snapshot ? <><div className={compare ? "snapshot-comparison" : ""}><NoteSnapshot note={snapshot} label={`选中版本 · v${selectedVersion}`} />{compare && <NoteSnapshot note={current} label={`当前版本 · v${current.currentVersion}`} />}</div><section className="snapshot-sources"><h4>此版本的原始来源 · {snapshot.sourceIds.length}</h4>{snapshot.sourceIds.length === 0 && <p className="muted small">此版本没有关联来源。</p>}{snapshot.sourceIds.map((id) => <button className={`source-pill ${sourceId === id ? "active" : ""}`} key={id} onClick={() => setSourceId(sourceId === id ? null : id)} aria-label={`查看历史原文 ${id}`} aria-expanded={sourceId === id}><Icon name="file" width="13" height="13" /><span>{id}</span><Icon name="chevron" width="12" height="12" /></button>)}{sourceId && <div className="history-source"><SourceView sourceId={sourceId} /></div>}</section></> : <Loading label="正在读取版本快照…" />}{actionError && <ErrorMessage message={actionError} />}{selectedVersion !== null && selectedVersion !== current.currentVersion && <div className="restore-bar"><p className="small muted">先查看恢复 Diff，再批准生成 v{current.currentVersion + 1}。</p><button className="button primary" aria-label={`预览恢复 v${selectedVersion}`} disabled={busy || !token || blocked || !snapshot} onClick={previewRestore}><Icon name="history" width="15" height="15" />{busy ? "正在生成预览…" : `预览恢复 v${selectedVersion}`}</button></div>}</div></div></>;
}

const auditNames: Record<string, string> = { proposal_created: "生成变更提案", proposal_approved: "批准变更", proposal_rejected: "拒绝变更", commit_completed: "变更已提交", note_committed: "笔记已提交", source_saved: "保存原文", recovery_started: "开始恢复", recovery_completed: "恢复完成", version_conflict: "版本冲突", restore_proposed: "生成恢复预览" };
function AuditView({ onHistory, onProposal }: { onHistory: (id: string) => void; onProposal: (id: string) => void }) {
  const [reload, setReload] = useState(0);
  const { data: events, error } = useResource<AuditEvent[]>("/api/history", reload);
  if (error) return <ErrorMessage message={error} onRetry={() => setReload((value) => value + 1)} />;
  if (!events) return <Loading />;
  if (events.length === 0) return <div className="empty-state small-empty"><Icon name="history" width="28" height="28" /><h3>还没有操作历史</h3><p>保存、审批与恢复的记录将在这里出现。</p></div>;
  return <ol className="audit-list">{[...events].sort((a, b) => b.id - a.id).map((event) => <li key={event.id}><span className="audit-icon"><Icon name="history" width="15" height="15" /></span><div className="audit-copy"><div className="audit-heading"><strong>{auditNames[event.eventType] || event.eventType}</strong><time dateTime={event.createdAt}>{dateLabel(event.createdAt, true)}</time></div><p className="small muted">操作者：{event.actor}</p>{event.detail && <pre className="audit-detail">{event.detail}</pre>}<div className="audit-links">{event.noteId && <button className="text-button" onClick={() => onHistory(event.noteId!)}>查看版本与原文 <Icon name="external" width="12" height="12" /></button>}{event.proposalId && <button className="text-button" onClick={() => onProposal(event.proposalId!)}>查看变更 <Icon name="chevron" width="12" height="12" /></button>}</div></div></li>)}</ol>;
}
