import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getStore } from '@/lib/store';
import { AppError, approveSchema, chatSchema, restoreSchema } from '@/lib/schemas';
import { issueToken, validateLocalRequest, validateMutation } from '@/lib/security';
import { modelConfigured, runAgent } from '@/lib/agent';
import type { ChatEvent } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ segments: string[] }> };
const json = (data: unknown) => NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
function failure(error: unknown) {
  const requestId = randomUUID();
  if (error instanceof AppError) return NextResponse.json({ code: error.code, message: error.message, requestId }, { status: error.status });
  if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ code: 'INVALID_INPUT', message: '请求参数不合法', requestId }, { status: 400 });
  console.error(JSON.stringify({ event: 'request_failed', requestId, errorType: error instanceof Error ? error.name : 'unknown' }));
  return NextResponse.json({ code: 'INTERNAL_ERROR', message: '操作失败，请检查本地日志', requestId }, { status: 500 });
}
export async function GET(request: Request, context: Context) {
  try {
    validateLocalRequest(request);
    const s = (await context.params).segments;
    const store = getStore();
    if (s.length === 1 && s[0] === 'session') {
      const token = issueToken();
      const response = json({ token, configured: modelConfigured(), recoveryErrors: store.recoveryErrors });
      response.cookies.set('memo_csrf', token, { httpOnly: true, sameSite: 'strict', path: '/', secure: new URL(request.url).protocol === 'https:' });
      return response;
    }
    if (s.length === 1 && s[0] === 'notes') return json(store.notes(new URL(request.url).searchParams.get('q') ?? undefined));
    if (s[0] === 'notes' && s.length === 2) return json(store.note(s[1]));
    if (s[0] === 'notes' && s[2] === 'versions' && s.length === 3) return json(store.versions(s[1]));
    if (s[0] === 'notes' && s[2] === 'versions' && s.length === 4) return json(store.note(s[1], Number(s[3])));
    if (s[0] === 'sources' && s.length === 2) return json(store.source(s[1]));
    if (s[0] === 'proposals' && s.length === 1) return json(store.proposals());
    if (s[0] === 'proposals' && s.length === 2) return json(store.proposalDetail(s[1]));
    if (s[0] === 'search' && s.length === 1) return json(store.search(new URL(request.url).searchParams.get('q') ?? ''));
    if (s[0] === 'history' && s.length === 1) return json(store.history());
    throw new AppError('NOT_FOUND', '接口不存在', 404);
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    validateMutation(request);
    if (Number(request.headers.get('content-length')) > 100_000) throw new AppError('INPUT_TOO_LARGE', '请求过大', 413);
    const text = await request.text();
    if (text.length > 100_000) throw new AppError('INPUT_TOO_LARGE', '请求过大', 413);
    const body = JSON.parse(text);
    const s = (await context.params).segments;
    const store = getStore();
    if (s[0] === 'proposals' && s.length === 3 && s[2] === 'approve') return json(store.approve(s[1], approveSchema.parse(body).expectedVersion));
    if (s[0] === 'proposals' && s.length === 3 && s[2] === 'reject') return json(store.reject(s[1]));
    if (s[0] === 'notes' && s.length === 3 && s[2] === 'restore') {
      const input = restoreSchema.parse(body); return json(store.restore(s[1], input.version, input.expectedVersion));
    }
    if (s.length === 1 && s[0] === 'chat') {
      const input = chatSchema.parse(body);
      const source = store.saveSource(input.message, input.requestId);
      const run = store.startRun(source);
      const events: ChatEvent[] = [];
      const started = Date.now();
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let disconnected = false;
          function emit(event: ChatEvent) {
            events.push(event);
            if (!disconnected) { try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { disconnected = true; } }
          }
          emit({ type: 'saved', sourceId: source.id, runId: run.id });
          try {
            if (run.replay) { for (const event of run.replay) emit(event as ChatEvent); }
            else {
              const result = await runAgent(store, source, run.id, emit, request.signal);
              store.finishRun(run.id, 'completed', events, result.selectedTools, Date.now() - started, result.usage);
              console.info(JSON.stringify({ event: 'agent_completed', runId: run.id, sourceId: source.id, durationMs: Date.now() - started, usage: result.usage }));
            }
          } catch (error) {
            const code = error instanceof AppError ? error.code : 'AGENT_FAILED';
            const message = error instanceof AppError ? error.message : '原文已保存，AI 处理未完成，请重试或检查模型接口';
            emit({ type: 'error', code, message });
            if (run.id) store.finishRun(run.id, 'failed', events, [], Date.now() - started, undefined, code);
            console.error(JSON.stringify({ event: 'agent_failed', runId: run.id, sourceId: source.id, code }));
          } finally { try { controller.close(); } catch { /* 客户端已关闭 */ } }
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Content-Type-Options': 'nosniff' } });
    }
    throw new AppError('NOT_FOUND', '接口不存在', 404);
  } catch (error) { return failure(error); }
}
