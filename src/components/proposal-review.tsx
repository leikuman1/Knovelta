"use client";

import { useRef, useState } from "react";
import type { Note, Proposal, ProposalDetail, ProposalStatus } from "@/lib/types";
import { Markdown } from "./markdown";
import { dateLabel, ErrorMessage, errorText, Icon, idPath, Loading, postJson, useResource } from "./ui";

export const statusNames: Record<ProposalStatus, string> = { pending: "待审批", applying: "正在提交", applied: "已提交", rejected: "已拒绝", stale: "提案过期", needs_recovery: "需要恢复" };
export const actionNames = { CREATE: "新增笔记", UPDATE: "更新笔记", FLAG_CONFLICT: "保留分歧", RESTORE: "恢复版本" };

export function ProposalList({ proposals, eventIds, selectedId, onSelect }: { proposals: Proposal[]; eventIds: string[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const missing = eventIds.filter((id) => !proposals.some((proposal) => proposal.id === id));
  return <div className="proposal-list" aria-label="变更提案列表">{missing.map((id) => <button key={id} className={`proposal-item ${selectedId === id ? "selected" : ""}`} onClick={() => onSelect(id)}><Icon name="review" /><span><strong>查看本次变更</strong><small className="mono">{id}</small></span><Icon name="chevron" /></button>)}{proposals.map((proposal) => <button key={proposal.id} className={`proposal-item ${selectedId === proposal.id ? "selected" : ""}`} onClick={() => onSelect(proposal.id)} aria-label={`查看提案：${proposal.proposedTitle}，${statusNames[proposal.status]}`}><span className={`proposal-symbol action-${proposal.action.toLowerCase()}`}><Icon name={proposal.action === "CREATE" ? "plus" : proposal.action === "RESTORE" ? "history" : "review"} /></span><span className="proposal-item-copy"><strong>{proposal.proposedTitle}</strong><small>{actionNames[proposal.action]} · {dateLabel(proposal.createdAt)}</small></span><span className={`status-badge status-${proposal.status}`}>{statusNames[proposal.status]}</span></button>)}</div>;
}

export function ProposalReview({ proposalId, token, blocked, revision, onApplied, onChanged, onSource, onNote }: { proposalId: string; token: string; blocked: boolean; revision: number; onApplied: (note: Note) => void; onChanged: () => void; onSource: (id: string) => void; onNote: (id: string) => void }) {
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [tab, setTab] = useState<"diff" | "preview">("diff");
  const [reload, setReload] = useState(0);
  const { data: detail, loading, error } = useResource<ProposalDetail>(`/api/proposals/${idPath(proposalId)}`, revision + reload);
  const actionLock = useRef(false);

  async function decide(action: "approve" | "reject") {
    if (!detail || !token || blocked || actionLock.current || detail.status !== "pending") return;
    actionLock.current = true; setBusy(action); setActionError("");
    try {
      if (action === "approve") {
        const note = await postJson<Note>(`/api/proposals/${idPath(detail.id)}/approve`, token, { expectedVersion: detail.baseVersion ?? 0 });
        onApplied(note);
      } else {
        await postJson(`/api/proposals/${idPath(detail.id)}/reject`, token, {});
        setReload((value) => value + 1);
      }
      onChanged();
    } catch (reason) {
      setActionError(errorText(reason));
      // Reconcile with server state after a conflict or an interrupted commit.
      setReload((value) => value + 1);
      onChanged();
    } finally { setBusy(null); actionLock.current = false; }
  }

  if (loading) return <Loading label="正在读取变更详情…" />;
  if (error) return <ErrorMessage message={error} onRetry={() => setReload((value) => value + 1)} />;
  if (!detail) return null;
  const ready = detail.status === "pending" && !busy && !!token && !blocked;
  return <article className="review-detail">
    <div className="review-summary"><div className="review-label-row"><span className="action-label">{actionNames[detail.action]}</span><span className={`status-badge status-${detail.status}`}>{statusNames[detail.status]}</span></div><h3>{detail.proposedTitle}</h3><p className="review-reason">{detail.reason}</p><dl className="metadata-list"><div><dt>目标笔记</dt><dd>{detail.action === "CREATE" ? <span className="break-id">{detail.targetNoteId}</span> : <button className="text-button break-id" onClick={() => onNote(detail.targetNoteId)}>{detail.targetNoteId}<Icon name="external" width="12" height="12" /></button>}</dd></div><div><dt>基础版本</dt><dd>{detail.baseVersion === null ? "新建 · v0 → v1" : `v${detail.baseVersion} → v${detail.baseVersion + 1}`}</dd></div>{detail.restoredFromVersion !== null && <div><dt>恢复自</dt><dd>历史版本 v{detail.restoredFromVersion}</dd></div>}<div><dt>创建时间</dt><dd>{dateLabel(detail.createdAt, true)}</dd></div></dl></div>
    {detail.status === "stale" && <div className="inline-notice warning">笔记已更新，此提案不能覆盖新版本。请查看当前笔记并在对话中重新提出修改。</div>}
    {detail.status === "needs_recovery" && <div className="inline-notice warning">写入尚待恢复。请完成后端恢复检查，再刷新确认提交结果。</div>}
    {detail.status === "applying" && <div className="inline-notice">提交处理中，请刷新查看最终结果。</div>}
    <div className="review-tabs" role="tablist" aria-label="变更视图"><button role="tab" aria-selected={tab === "diff"} onClick={() => setTab("diff")}>变更 Diff</button><button role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>正文预览</button><button className="icon-button" aria-label="刷新提案详情" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" width="14" height="14" /></button></div>
    {tab === "diff" ? <div className="diff-view" aria-label="标题与正文变更"><div className="diff-file-header"><Icon name="file" width="14" height="14" /> 标题</div>{detail.beforeTitle === detail.proposedTitle ? <div className="diff-line"><span aria-hidden="true"> </span><code>{detail.proposedTitle}</code></div> : <>{detail.beforeTitle && <div className="diff-line removed"><span aria-label="删除">−</span><code>{detail.beforeTitle}</code></div>}<div className="diff-line added"><span aria-label="新增">+</span><code>{detail.proposedTitle}</code></div></>}<div className="diff-file-header"><Icon name="file" width="14" height="14" /> 正文</div>{detail.diff.length === 0 && <p className="diff-unchanged">正文没有变化</p>}{detail.diff.map((part, partIndex) => {
      const lines = part.value.split("\n"); if (lines[lines.length - 1] === "") lines.pop();
      return lines.map((line, lineIndex) => <div className={`diff-line ${part.added ? "added" : part.removed ? "removed" : ""}`} key={`${partIndex}-${lineIndex}`}><span aria-label={part.added ? "新增" : part.removed ? "删除" : "未修改"}>{part.added ? "+" : part.removed ? "−" : " "}</span><code>{line || " "}</code></div>);
    })}</div> : <div className="proposal-preview"><h4>{detail.proposedTitle}</h4><Markdown content={detail.proposedContent} /></div>}
    <section className="review-sources"><h4>原始来源 <span>{detail.sourceIds.length}</span></h4>{detail.sourceIds.length === 0 && <p className="muted small">未提供来源。</p>}{detail.sourceIds.map((id, index) => { const source = detail.sources.find((item) => item.id === id); return <button className="source-row" key={id} onClick={() => onSource(id)} aria-label={`查看原文 ${id}`}><span className="source-index">{String(index + 1).padStart(2, "0")}</span><span><strong>{source?.content.slice(0, 64) || id}</strong><small>{source ? dateLabel(source.createdAt, true) : id}</small></span><Icon name="external" width="14" height="14" /></button>; })}</section>
    {detail.dependencies.length > 0 && <details className="dependency-list"><summary>依赖的笔记版本 · {detail.dependencies.length}</summary>{detail.dependencies.map((item) => <p className="mono small break-id" key={`${item.noteId}-${item.version}`}>{item.noteId} · v{item.version}</p>)}</details>}
    <footer className="review-actions">{actionError && <ErrorMessage message={actionError} />}{detail.status === "pending" ? <><p>确认后将提交为新版本，原文与历史会保留。</p><div className="review-action-buttons"><button className="button secondary" onClick={() => decide("reject")} disabled={!ready} aria-label="拒绝变更"><Icon name="close" width="15" height="15" />{busy === "reject" ? "拒绝中…" : "拒绝变更"}</button><button className="button primary" onClick={() => decide("approve")} disabled={!ready} aria-label="批准变更"><Icon name="check" width="15" height="15" />{busy === "approve" ? "提交中…" : "批准变更"}</button></div>{blocked && <p className="warning-text">恢复检查存在异常，暂时无法审批。</p>}</> : <p className="decision-result"><Icon name={detail.status === "applied" ? "check" : "review"} />{statusNames[detail.status]}{detail.status === "applied" && <button className="text-button" onClick={() => onNote(detail.targetNoteId)}>查看笔记 <Icon name="chevron" width="12" height="12" /></button>}</p>}</footer>
  </article>;
}
