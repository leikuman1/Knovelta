"use client";

import ReactMarkdown from "react-markdown";
import type { Evidence } from "@/lib/types";
import { Icon } from "./ui";

export function Markdown({ content, allowLinks = true }: { content: string; allowLinks?: boolean }) {
  return <div className="markdown"><ReactMarkdown skipHtml urlTransform={(url) => /^https?:\/\//i.test(url) || /^mailto:/i.test(url) ? url : ""} components={{
    a: ({ href, children }) => allowLinks && href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}<span className="sr-only">（在新窗口打开）</span></a> : <span>{children}</span>,
    img: ({ alt }) => <span className="image-placeholder">[图片{alt ? `：${alt}` : ""}]</span>,
  }}>{content}</ReactMarkdown></div>;
}

export function Answer({ content, citations, validated, invalidCitations, onEvidence }: { content: string; citations: Evidence[]; validated: boolean; invalidCitations: boolean; onEvidence: (evidence: Evidence) => void }) {
  const unique = citations.filter((item, index, items) => items.findIndex((other) => other.id === item.id) === index);
  const text = content.replace(/\[\[([^\]\r\n]+)\]\]/g, (marker: string, id: string) => {
    if (!validated) return marker;
    const index = unique.findIndex((item) => item.id === id);
    return index >= 0 ? `〔${index + 1}〕` : `${marker}（未验证）`;
  });
  return <><Markdown content={text} allowLinks={false} />
    {validated && invalidCitations && <p className="evidence-warning"><Icon name="alert" />部分引用未通过验证，回答依据可能不足，请核对来源或重试。</p>}
    {validated && unique.length > 0 && <div className="citation-list" aria-label="已验证来源"><p className="eyebrow">已验证来源 · {unique.length}</p>{unique.map((evidence, index) => <button className="citation-card" key={evidence.id} onClick={() => onEvidence(evidence)} aria-label={`查看引用 ${index + 1}：笔记 ${evidence.noteId} v${evidence.noteVersion} 与原文`}>
      <span className="citation-number">{index + 1}</span><span className="citation-content"><strong>{evidence.kind === "source" ? "原始记录" : "笔记证据"} <span className="version-chip">v{evidence.noteVersion}</span>{evidence.historical && <span className="muted"> · 历史版本</span>}</strong><span className="citation-excerpt">{evidence.excerpt}</span><span className="citation-meta">noteId: {evidence.noteId} · version: {evidence.noteVersion}<br />source: {evidence.sourceId} · 第 {evidence.startLine}–{evidence.endLine} 行</span></span><Icon name="external" />
    </button>)}</div>}
  </>;
}
