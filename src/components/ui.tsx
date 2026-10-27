"use client";

import { useEffect, useRef, useState, type ReactNode, type SVGProps } from "react";

export type IconName = "book" | "chat" | "review" | "search" | "plus" | "arrow" | "close" | "check" | "history" | "file" | "chevron" | "external" | "refresh" | "alert" | "spark" | "compare";

const paths: Record<IconName, ReactNode> = {
  book: <><path d="M4 4.5h6a3 3 0 0 1 3 3V21a4 4 0 0 0-4-2H4z" /><path d="M20 4.5h-4a3 3 0 0 0-3 3V21a4 4 0 0 1 4-2h3z" /></>,
  chat: <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2v-10a9 9 0 0 1 18 0Z" />,
  review: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V2h6v2M9 10h6m-6 5 2 2 4-4" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <><path d="M12 19V5m-6 6 6-6 6 6" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  history: <><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7" /><path d="M12 7v5l3 2" /></>,
  file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8m-8 4h5" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  external: <><path d="M14 4h6v6m0-6L10 14" /><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
  refresh: <><path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6m-4 9a9 9 0 0 0 15 2l3-3m0 6v-6h-6" /></>,
  alert: <><path d="m12 3 10 18H2zM12 9v5" /><path d="M12 17h.01" /></>,
  spark: <><path d="m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3z" /></>,
  compare: <><path d="M9 3v18m6-18v18M3 7l3-3 3 3m6 10 3 3 3-3M6 4v12m12-8v12" /></>,
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

export function dateLabel(value: string, withTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } as const : {}) }).format(date);
}

export function Dialog({ title, eyebrow, children, onClose, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  return <dialog ref={ref} className={`dialog ${wide ? "dialog-wide" : ""}`} aria-labelledby="inspection-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}>
    <header className="dialog-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id="inspection-title">{title}</h2></div><button className="icon-button" aria-label="关闭弹层" onClick={onClose}><Icon name="close" /></button></header>
    <div className="dialog-body">{children}</div>
  </dialog>;
}

export function ErrorMessage({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="error-message" role="alert"><Icon name="alert" /><div><p>{message}</p>{onRetry && <button className="text-button" onClick={onRetry}>重新加载</button>}</div></div>;
}

export function Loading({ label = "正在读取…" }: { label?: string }) {
  return <div className="loading" role="status"><span className="spinner" />{label}</div>;
}

export class ApiError extends Error {
  constructor(message: string, public code: string, public requestId?: string, public status?: number) { super(message); this.name = "ApiError"; }
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}${error.status === 409 ? " 请刷新当前笔记并重新生成提案，旧提案不能覆盖新版本。" : ""}（${error.code}${error.requestId ? ` · 请求 ${error.requestId}` : ""}）`;
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}

export async function assertResponse(response: Response) {
  if (response.ok) return;
  let body: { code?: string; message?: string; requestId?: string } = {};
  try { body = await response.json(); } catch { /* A proxy may return a non-JSON error. */ }
  throw new ApiError(body.message || `请求失败（HTTP ${response.status}）`, body.code || "HTTP_ERROR", body.requestId, response.status);
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal });
  await assertResponse(response);
  return response.json() as Promise<T>;
}

export async function postJson<T>(path: string, token: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": token }, body: JSON.stringify(body) });
  await assertResponse(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return text ? JSON.parse(text) as T : undefined as T;
}

export function useResource<T>(path: string | null, revision = 0) {
  const key = `${path ?? ""}\n${revision}`;
  const [result, setResult] = useState<{ key: string; data: T | null; error: string }>({ key: "", data: null, error: "" });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    getJson<T>(path, controller.signal).then((data) => {
      if (!controller.signal.aborted) setResult({ key, data, error: "" });
    }).catch((reason) => {
      if (!controller.signal.aborted) setResult({ key, data: null, error: errorText(reason) });
    });
    return () => controller.abort();
  }, [path, key]);
  const current = result.key === key;
  return { data: current ? result.data : null, error: current ? result.error : "", loading: !!path && (!current || (!result.data && !result.error)) };
}

export const idPath = (id: string) => encodeURIComponent(id);
