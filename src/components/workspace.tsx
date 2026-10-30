"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import type { ChatEvent, Evidence, Note, NoteSummary, Proposal, ProposalDetail } from "@/lib/types";
import { Answer, Markdown } from "./markdown";
import { InspectionDialog, type Inspection } from "./inspection";
import { ProposalList, ProposalReview } from "./proposal-review";
import { ChatWelcome } from "./chat-welcome";
import { ApiError, assertResponse, dateLabel, ErrorMessage, errorText, getJson, Icon, idPath, Loading, useResource } from "./ui";

type Session = { token: string; configured: boolean; recoveryErrors: string[] };
type Turn = { requestId: string; message: string; answer: string; sourceId?: string; runId?: string; stage: string; state: "running" | "done" | "error"; error: string; citations: Evidence[]; validated: boolean; invalidCitations: boolean; proposalIds: string[] };
type MobilePanel = "notes" | "main" | "review";

export default function Workspace() {
  const [sessionReload, setSessionReload] = useState(0);
  const { data: session, error: sessionError } = useResource<Session>("/api/session", sessionReload);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [query, setQuery] = useState("");
  const [notesLoading, setNotesLoading] = useState(true);
  const [notesError, setNotesError] = useState("");
  const [notesRevision, setNotesRevision] = useState(0);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [noteRevision, setNoteRevision] = useState(0);
  const { data: note, loading: noteLoading, error: noteError } = useResource<Note>(selectedNoteId ? `/api/notes/${idPath(selectedNoteId)}` : null, noteRevision);
  const [proposalRevision, setProposalRevision] = useState(0);
  const { data: proposalItems, loading: proposalLoading, error: proposalError } = useResource<Proposal[]>("/api/proposals", proposalRevision);
  const proposals = [...(proposalItems ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [eventProposalIds, setEventProposalIds] = useState<string[]>([]);
  const [mode, setMode] = useState<"chat" | "note">("chat");
  const [panel, setPanel] = useState<MobilePanel>("main");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [desktopLayout, setDesktopLayout] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<"pending" | "all">("pending");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [notice, setNotice] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const streamController = useRef<AbortController | null>(null);
  const sendLock = useRef(false);
  const followStream = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setNotesLoading(true); setNotesError("");
      getJson<NoteSummary[]>(query.trim() ? `/api/notes?q=${encodeURIComponent(query.trim())}` : "/api/notes", controller.signal).then(setNotes).catch((reason) => { if (!controller.signal.aborted) setNotesError(errorText(reason)); }).finally(() => { if (!controller.signal.aborted) setNotesLoading(false); });
    }, query ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, notesRevision]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1200px)");
    const update = () => setDesktopLayout(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => () => streamController.current?.abort(), []);
  useEffect(() => {
    if (followStream.current && transcript.current) transcript.current.scrollTop = turns.length ? transcript.current.scrollHeight : 0;
  }, [turns, mode]);
  useEffect(() => {
    const element = textarea.current;
    if (element) { element.style.height = "auto"; element.style.height = `${Math.min(element.scrollHeight, 180)}px`; }
  }, [input, mode]);

  const blocked = !!session?.recoveryErrors.length;
  const canSend = !!session?.token && !blocked && !sending;
  const pendingCount = proposals.filter((proposal) => ["pending", "applying", "needs_recovery"].includes(proposal.status)).length;
  const reviewVisible = reviewOpen && (desktopLayout || panel === "review");
  const lastTurn = turns[turns.length - 1];
  function refreshProposals() { setProposalRevision((value) => value + 1); }
  function selectNote(id: string) { setSelectedNoteId(id); setMode("note"); setPanel("main"); }
  function selectProposal(id: string, switchPanel = true) { setSelectedProposalId(id); setReviewOpen(true); if (switchPanel) setPanel("review"); }
  function startDraft(prompt = "") {
    setMode("chat"); setPanel("main");
    if (prompt) setInput((draft) => draft.trim() ? draft : prompt);
    requestAnimationFrame(() => textarea.current?.focus());
  }
  function applied(appliedNote: Note) {
    setSelectedNoteId(appliedNote.id); setMode("note"); setPanel("main"); setNoteRevision((value) => value + 1); setNotesRevision((value) => value + 1); setNotice(`已提交「${appliedNote.title}」· v${appliedNote.currentVersion}`);
    setSessionReload((value) => value + 1);
  }
  function restored(proposal: ProposalDetail) {
    setInspection(null); setEventProposalIds((items) => [...new Set([proposal.id, ...items])]); selectProposal(proposal.id); refreshProposals(); setNotice("恢复预览已生成，请查看 Diff 并批准变更。");
  }
  function patchTurn(requestId: string, patch: Partial<Turn> | ((turn: Turn) => Partial<Turn>)) {
    setTurns((items) => items.map((turn) => turn.requestId === requestId ? { ...turn, ...(typeof patch === "function" ? patch(turn) : patch) } : turn));
  }

  async function runTurn(turn: Turn) {
    if (!session?.token || sendLock.current || blocked) return;
    sendLock.current = true; setSending(true); setSubmitError(""); followStream.current = true;
    const controller = new AbortController(); streamController.current = controller;
    patchTurn(turn.requestId, { answer: "", citations: [], validated: false, invalidCitations: false, error: "", state: "running", stage: turn.sourceId ? "原文已保存，正在重新整理…" : "正在保存原文…" });
    let finished = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": session.token }, body: JSON.stringify({ message: turn.message, requestId: turn.requestId }), signal: controller.signal });
      await assertResponse(response);
      if (!response.body) throw new Error("未收到响应流，请重试。重试将复用本次请求。");
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = "";
      const consume = (line: string) => {
        if (!line.trim() || finished) return;
        let event: ChatEvent;
        try { event = JSON.parse(line) as ChatEvent; } catch { throw new Error("响应流格式异常，请使用本条消息的重试按钮。"); }
        if (event.type === "saved") patchTurn(turn.requestId, { sourceId: event.sourceId, runId: event.runId, stage: "AI 正在处理…" });
        else if (event.type === "status") patchTurn(turn.requestId, { stage: event.message });
        else if (event.type === "text") patchTurn(turn.requestId, (item) => ({ answer: item.answer + event.text }));
        else if (event.type === "proposal") {
          patchTurn(turn.requestId, (item) => ({ proposalIds: [...new Set([...item.proposalIds, event.proposalId])], stage: "变更已生成，等待审批" }));
          setEventProposalIds((items) => [...new Set([event.proposalId, ...items])]); selectProposal(event.proposalId, false); refreshProposals();
        } else if (event.type === "done") {
          finished = true; patchTurn(turn.requestId, { citations: event.citations, validated: true, invalidCitations: event.invalidCitations, state: "done", stage: "处理完成" });
        } else if (event.type === "error") throw new ApiError(event.message, event.code, turn.requestId);
      };
      while (!finished) {
        const chunk = await reader.read();
        if (chunk.done) { buffer += decoder.decode(); if (buffer.trim()) consume(buffer); break; }
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); }
      }
      if (!finished) throw new Error("连接已中断，尚未收到完整结果。请重试本条消息，系统会复用原请求，避免重复保存原文。");
    } catch (reason) {
      if (!controller.signal.aborted) patchTurn(turn.requestId, { state: "error", stage: "处理未完成", error: errorText(reason) });
    } finally {
      if (reader) { try { await reader.cancel(); } catch { /* The stream may have already closed. */ } reader.releaseLock(); }
      if (!controller.signal.aborted) { setSending(false); refreshProposals(); setSessionReload((value) => value + 1); }
      streamController.current = null; sendLock.current = false;
    }
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    const message = input.trim(); if (!message || !canSend || sendLock.current) return;
    let requestId: string;
    try { requestId = crypto.randomUUID(); } catch { setSubmitError("无法生成请求标识，请通过本机 localhost 或安全连接打开应用。"); return; }
    const turn: Turn = { requestId, message, answer: "", stage: "正在保存原文…", state: "running", error: "", citations: [], validated: false, invalidCitations: false, proposalIds: [] };
    setTurns((items) => [...items, turn]); setInput(""); void runTurn(turn);
  }
  function inputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
  }

  return <div className={`app-shell ${reviewOpen ? "review-open" : "review-closed"}`} data-panel={panel}>
    <a className="skip-link" href="#main-content">跳转到主内容</a>
    <header className="app-header"><Link className="brand" href="/" aria-label="Knovelta 首页"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span>Knovelta<span className="brand-period">.</span></span></Link><div className="workspace-label"><span />个人知识工作台</div><div className="header-actions"><span className={`connection-state ${sessionError || blocked ? "connection-warning" : ""}`}><i />{sessionError ? "连接异常" : !session ? "连接中" : blocked ? "需要恢复" : "本地工作空间"}</span><button className="button subtle compact" onClick={() => setInspection({ kind: "audit" })} aria-label="查看操作历史"><Icon name="history" width="16" height="16" /><span>操作历史</span></button><div className="avatar" aria-label="个人工作空间">我</div></div></header>
    <nav className="mobile-navigation" aria-label="工作面板"><button className={panel === "notes" ? "active" : ""} onClick={() => setPanel("notes")} aria-pressed={panel === "notes"}><Icon name="book" />笔记</button><button className={panel === "main" ? "active" : ""} onClick={() => setPanel("main")} aria-pressed={panel === "main"}><Icon name="chat" />{mode === "note" ? "正文 / 对话" : "对话"}</button><button className={panel === "review" ? "active" : ""} onClick={() => setPanel("review")} aria-pressed={panel === "review"}><Icon name="review" />变更{pendingCount > 0 && <span className="count-badge">{pendingCount}</span>}</button></nav>
    <div className="workspace-grid">
      <aside className={`notes-panel panel ${panel === "notes" ? "mobile-visible" : ""}`} aria-label="知识库笔记">
        <div className="notes-heading"><div><h2>知识库 <span>{notesLoading ? "—" : notes.length}</span></h2></div><button className="icon-button new-note-button" aria-label="记录新知识" title="在对话中记录新知识" onClick={() => startDraft()}><Icon name="plus" /></button></div>
        <div className="search-field"><Icon name="search" width="16" height="16" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记…" aria-label="搜索笔记" />{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery("")}><Icon name="close" width="13" height="13" /></button>}</div>
        <div className="notes-list-heading"><span>{query ? "搜索结果" : "全部笔记"}</span><button className="icon-button" aria-label="刷新笔记列表" onClick={() => setNotesRevision((value) => value + 1)}><Icon name="refresh" width="13" height="13" /></button></div>
        <div className="notes-scroll">{notesError && <ErrorMessage message={notesError} onRetry={() => setNotesRevision((value) => value + 1)} />}{notesLoading ? <Loading label="正在读取笔记…" /> : notes.length === 0 ? <div className="notes-empty"><span className="empty-note-icon"><Icon name={query ? "search" : "book"} width="23" height="23" /></span><h3>{query ? "没有找到相关笔记" : "还没有笔记"}</h3><p>{query ? "试试其他关键词，或在对话中提问。" : "在对话中记录内容，批准整理建议后即可在这里查看。"}</p>{query && <button className="text-button" onClick={() => setQuery("")}>查看全部笔记</button>}</div> : <ul className="note-list">{notes.map((item) => <li key={item.id}><button className={`note-item ${selectedNoteId === item.id ? "selected" : ""}`} onClick={() => selectNote(item.id)} aria-label={`打开笔记：${item.title}，v${item.currentVersion}`} aria-current={selectedNoteId === item.id ? "true" : undefined}><div className="note-item-title"><Icon name="file" width="15" height="15" /><strong>{item.title}</strong></div>{item.snippet && <p>{item.snippet}</p>}<div className="note-item-meta"><span>v{item.currentVersion}</span><time dateTime={item.updatedAt}>{dateLabel(item.updatedAt)}</time></div></button></li>)}</ul>}</div>
        <div className="sidebar-footnote"><span className="local-icon"><Icon name="check" width="13" height="13" /></span><div><strong>本地知识库</strong><p>原文留存 · 版本可追溯</p></div></div>
      </aside>
      <main id="main-content" className={`main-panel panel ${panel === "main" ? "mobile-visible" : ""}`}>
        <div className="main-toolbar"><div className="main-tabs" aria-label="主内容视图"><button className={mode === "chat" ? "active" : ""} onClick={() => setMode("chat")} aria-pressed={mode === "chat"}><Icon name="chat" width="16" height="16" />对话</button><button className={mode === "note" ? "active" : ""} onClick={() => setMode("note")} aria-pressed={mode === "note"}><Icon name="book" width="16" height="16" />笔记</button></div><div className="toolbar-actions"><span className="toolbar-caption">{mode === "chat" ? "记录与提问" : note ? `已提交 · v${note.currentVersion}` : "已提交的知识"}</span><button className={`button subtle compact review-toggle ${reviewVisible ? "active" : ""}`} aria-label={reviewVisible ? "收起变更审阅" : "展开变更审阅"} aria-expanded={reviewVisible} aria-controls="review-panel" onClick={() => { setReviewOpen(!reviewVisible); setPanel(reviewVisible ? "main" : "review"); }}><Icon name="review" width="16" height="16" />变更审阅{pendingCount > 0 && <span className="count-badge">{pendingCount}</span>}</button></div></div>
        <div className="workspace-banners">{sessionError && <ErrorMessage message={sessionError} onRetry={() => setSessionReload((value) => value + 1)} />}{session && !session.configured && <div className="inline-notice config-notice"><Icon name="alert" /><span>AI 尚未配置。请在服务端设置模型连接，现有笔记、来源与历史仍可浏览。</span><button className="text-button" onClick={() => setSessionReload((value) => value + 1)}>重新检查</button></div>}{blocked && <div className="inline-notice warning" role="alert"><strong>有写入需要恢复，暂时停止新的写入。</strong>{session?.recoveryErrors.map((message, index) => <p key={index}>{message}</p>)}<button className="text-button" onClick={() => { setSessionReload((value) => value + 1); refreshProposals(); }}>刷新恢复状态</button></div>}{notice && <div className="success-notice" role="status"><Icon name="check" width="16" height="16" /><span>{notice}</span><button className="icon-button" aria-label="关闭通知" onClick={() => setNotice("")}><Icon name="close" width="13" height="13" /></button></div>}</div>
        {mode === "chat" ? <><div className="conversation" ref={transcript} role="log" aria-label="对话记录" aria-live="off" onScroll={() => { const element = transcript.current; if (element) followStream.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
          {turns.length === 0 ? <ChatWelcome onDraft={startDraft} /> : <div className="turn-list">{turns.map((turn, index) => <article className="chat-turn" key={turn.requestId}>
            <div className="user-message"><div className="message-label"><span className="user-avatar">我</span><strong>你</strong><span className="turn-number">{String(index + 1).padStart(2, "0")}</span></div><p>{turn.message}</p><div className="save-state">{turn.sourceId ? <button className="text-button" onClick={() => setInspection({ kind: "source", sourceId: turn.sourceId! })} aria-label={`查看已保存原文 ${turn.sourceId}`}><Icon name="check" width="12" height="12" />原文已保存<Icon name="external" width="11" height="11" /></button> : <span className={turn.state === "error" ? "warning-text" : "muted"}>{turn.state === "error" ? "尚未确认原文保存状态，请用重试确认" : "正在保存原文…"}</span>}</div></div>
            <div className="assistant-message"><div className="message-label"><span className="assistant-avatar" aria-hidden="true">K</span><strong>Knovelta</strong>{turn.state === "running" && <span className="thinking-label"><i />{turn.stage}</span>}{turn.state === "done" && <span className="completion-label">{turn.proposalIds.length ? "待审批或查看变更结果" : "已完成"}</span>}</div>{turn.answer && <Answer content={turn.answer} citations={turn.citations} validated={turn.validated} invalidCitations={turn.invalidCitations} onEvidence={(evidence) => setInspection({ kind: "evidence", evidence })} />}{!turn.answer && turn.state === "running" && <div className="thinking-dots" aria-hidden="true"><span /><span /><span /></div>}{turn.state === "done" && !turn.answer && turn.proposalIds.length === 0 && <p className="muted small">本次处理已完成，没有返回正文或变更提案。</p>}{turn.proposalIds.map((id) => { const proposal = proposals.find((item) => item.id === id); return <button className="chat-proposal-link" key={id} onClick={() => selectProposal(id)}><span className="proposal-link-icon"><Icon name="review" /></span><span><strong>{proposal?.proposedTitle || "变更提案已生成"}</strong><small>查看理由、来源与 Diff</small></span><Icon name="chevron" width="16" height="16" /></button>; })}{turn.error && <div className="chat-error"><ErrorMessage message={turn.error} /><p className="small muted">{turn.sourceId ? "原文已保存，整理未完成。" : "保存结果将在重试时核对。"}重试会沿用原请求标识。</p><button className="button secondary compact" onClick={() => void runTurn(turn)} disabled={!canSend} aria-label="重试本条消息"><Icon name="refresh" width="14" height="14" />重试</button></div>}</div>
          </article>)}</div>}
        </div><div className="composer-area">{sending && <p className="composer-status" role="status"><span className="spinner" />{lastTurn?.stage || "AI 正在处理…"}</p>}{submitError && <ErrorMessage message={submitError} />}<form className="composer" onSubmit={submit}><label className="sr-only" htmlFor="knowledge-input">输入知识或问题</label><textarea ref={textarea} id="knowledge-input" aria-label="输入知识或问题" placeholder="记下新知识，或问问你的知识库…" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={inputKeyDown} rows={2} maxLength={20000} /><div className="composer-bottom"><span>Enter 换行<span className="composer-shortcut"> · Ctrl / ⌘ + Enter 发送</span></span><button className="send-button" type="submit" aria-label="发送" disabled={!canSend || !input.trim()}><Icon name="arrow" width="18" height="18" /></button></div></form><p className="composer-footnote">先保存原文，再整理知识。正文变更始终等待你的批准。</p></div></> : <div className="note-reader">{noteLoading ? <Loading label="正在读取笔记…" /> : noteError ? <ErrorMessage message={noteError} onRetry={() => setNoteRevision((value) => value + 1)} /> : note ? <article className="note-document"><div className="document-kicker"><span><Icon name="file" width="14" height="14" />知识笔记</span><div><button className="icon-button" aria-label="刷新当前笔记" onClick={() => setNoteRevision((value) => value + 1)}><Icon name="refresh" width="15" height="15" /></button><button className="button secondary compact" onClick={() => setInspection({ kind: "history", noteId: note.id })} aria-label="查看笔记版本历史"><Icon name="history" width="14" height="14" />版本历史</button></div></div><h1>{note.title}</h1><div className="document-meta"><span className="version-chip">v{note.currentVersion}</span><span>更新于 {dateLabel(note.updatedAt, true)}</span><span>{note.sourceIds.length} 个原始来源</span></div><Markdown content={note.content} /><section className="document-sources"><div className="document-section-heading"><h3>原始来源</h3><span>保留每一次输入的上下文</span></div>{note.sourceIds.length ? note.sourceIds.map((id, index) => <button className="document-source" key={id} onClick={() => setInspection({ kind: "source", sourceId: id })} aria-label={`查看原文 ${id}`}><span className="source-index">{String(index + 1).padStart(2, "0")}</span><span><strong>原始记录</strong><small className="mono">{id}</small></span><Icon name="external" width="14" height="14" /></button>) : <p className="muted small">此版本没有关联来源。</p>}</section><div className="document-footer"><p className="mono small muted break-id">noteId: {note.id}</p><button className="text-button" onClick={() => startDraft()}><Icon name="chat" width="14" height="14" />继续记录或提问</button></div></article> : <div className="empty-state reader-empty"><span className="empty-illustration"><Icon name="book" width="34" height="34" /></span><p className="eyebrow">A PLACE FOR YOUR KNOWLEDGE</p><h2>每一篇笔记，都有来处</h2><p>从左侧选择笔记，阅读整理后的正文，<br />核对原文，或回到任何一个历史版本。</p><button className="button secondary" onClick={() => { setMode("chat"); setPanel("main"); }}>开始记录 <Icon name="chevron" width="14" height="14" /></button></div>}</div>}
      </main>
      <aside id="review-panel" className={`review-panel panel ${panel === "review" ? "mobile-visible" : ""}`} aria-label="变更审阅">
        <div className="review-panel-heading"><div><p className="eyebrow">确认后，才会写入</p><h2>变更审阅 {pendingCount > 0 && <span className="count-badge">{pendingCount}</span>}</h2></div><button className="button secondary review-close" onClick={() => { setReviewOpen(false); setPanel("main"); }}>返回主内容</button><button className="icon-button" aria-label="刷新变更列表" onClick={refreshProposals}><Icon name="refresh" width="15" height="15" /></button></div>
        <div className="review-scroll">{proposalError && <ErrorMessage message={proposalError} onRetry={refreshProposals} />}{proposalLoading && proposals.length === 0 && eventProposalIds.length === 0 ? <Loading label="正在读取变更…" /> : null}{(proposals.length > 0 || eventProposalIds.length > 0) && <><div className="proposal-filters" aria-label="筛选变更"><button className={reviewFilter === "pending" ? "active" : ""} aria-pressed={reviewFilter === "pending"} onClick={() => setReviewFilter("pending")}>待处理 <span>{pendingCount}</span></button><button className={reviewFilter === "all" ? "active" : ""} aria-pressed={reviewFilter === "all"} onClick={() => setReviewFilter("all")}>全部变更</button></div><ProposalList proposals={reviewFilter === "all" ? proposals : proposals.filter(item => ["pending", "applying", "needs_recovery"].includes(item.status))} eventIds={eventProposalIds.filter(id => !proposals.some(item => item.id === id))} selectedId={selectedProposalId} onSelect={(id) => selectProposal(id)} /></>}{selectedProposalId ? <ProposalReview key={selectedProposalId} proposalId={selectedProposalId} token={session?.token || ""} blocked={blocked} revision={proposalRevision} onApplied={applied} onChanged={refreshProposals} onSource={(sourceId) => setInspection({ kind: "source", sourceId })} onNote={selectNote} /> : <div className="review-empty"><div className="review-empty-art" aria-hidden="true"><div className="paper-sheet"><i /><i /><i /><span><Icon name="check" width="15" height="15" /></span></div></div><p className="eyebrow">每一项建议，都由你确认</p><h3>{proposals.length ? "选择一项变更，看看细节" : "好知识，值得确认"}</h3><p>{proposals.length ? "查看生成理由、真实来源与完整 Diff，再决定是否提交。" : "AI 会提出整理建议。你可以在这里逐一审阅，确认后才写入知识库。"}</p><div className="diff-legend"><span><i className="legend-added" />新增</span><span><i className="legend-removed" />删除</span></div></div>}</div>
        <div className="review-panel-footer"><Icon name="review" width="14" height="14" /><span>未经批准，知识正文不会改变</span></div>
      </aside>
    </div>
    {inspection && <InspectionDialog key={inspection.kind === "source" ? `source-${inspection.sourceId}` : inspection.kind === "history" ? `history-${inspection.noteId}` : inspection.kind === "evidence" ? `evidence-${inspection.evidence.id}` : "audit"} inspection={inspection} token={session?.token || ""} blocked={blocked} proposals={proposals} onClose={() => setInspection(null)} onProposal={(id) => { setInspection(null); selectProposal(id); }} onHistory={(noteId) => setInspection({ kind: "history", noteId })} onRestored={restored} />}
  </div>;
}
