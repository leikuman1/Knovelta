import { getStore } from '@/lib/store';
import { failure } from '@/lib/http';
import { AppError, chatSchema } from '@/lib/schemas';
import { validateMutation } from '@/lib/security';
import { runAgent } from '@/lib/agent';
import type { ChatEvent } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    validateMutation(request);
    if (Number(request.headers.get('content-length')) > 100_000) throw new AppError('INPUT_TOO_LARGE', '请求过大', 413);
    const text = await request.text();
    if (text.length > 100_000) throw new AppError('INPUT_TOO_LARGE', '请求过大', 413);
    const input = chatSchema.parse(JSON.parse(text));
    const store = getStore();
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
  } catch (error) { return failure(error); }
}
