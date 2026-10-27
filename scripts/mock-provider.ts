import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Evidence, Note, NoteSummary, ProposalInput, Source } from '../src/lib/types';

export const MOCK_API_KEY = 'e2e-local-no-secret';
export const MOCK_MODEL = 'deterministic-memoagent';

type ToolName = 'search_notes' | 'read_note' | 'read_source' | 'create_change_proposal';
type ToolCall = { id: string; type: 'function'; function: { name: ToolName; arguments: string } };
type Message = { role: string; content?: unknown; tool_calls?: ToolCall[]; tool_call_id?: string };
export type CompletionRequest = { model: string; stream?: boolean; messages: Message[]; tools?: { function: { name: string } }[] };
type Decision = { content: string } | { calls: ToolCall[] };
type ToolResult = { name: ToolName; input: Record<string, unknown>; output: unknown };
export type MockExchange = { request: CompletionRequest; decision: Decision };
type Intent = { action: '记录' | '补充' | '冲突' | '查询' | '不要修改'; topic: string; body: string; sourceId: string; sourceContent: string };

// The fixture language is deliberately small. Decisions use the actual SDK messages
// and tool results; this server has no access to the Store or application APIs.
function intent(messages: Message[]): Intent {
  const user = [...messages].reverse().find(message => message.role === 'user');
  if (typeof user?.content !== 'string') throw new Error('Expected a text user message');
  const source = /^原始输入 sourceId=([\da-f-]+)。以下是用户输入：\n([\s\S]+)$/i.exec(user.content);
  const command = source && /^(记录|补充|冲突|查询|不要修改)\s+([A-Za-z][A-Za-z\d_]*)(?:[：:]\s*|\s*)([\s\S]*)$/.exec(source[2]);
  if (!source || !command) throw new Error('Expected fixture input: 记录/补充/冲突/查询/不要修改 Topic：正文');
  return { action: command[1] as Intent['action'], topic: command[2], body: command[3], sourceId: source[1], sourceContent: source[2] };
}

function toolResults(messages: Message[]): ToolResult[] {
  const calls = new Map<string, ToolCall>();
  const results: ToolResult[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, call);
    if (message.role !== 'tool') continue;
    const call = calls.get(message.tool_call_id ?? '');
    if (!call || typeof message.content !== 'string') throw new Error('Unmatched tool result');
    const output: unknown = JSON.parse(message.content);
    if (output && typeof output === 'object' && 'error' in output) throw new Error(`Tool failed: ${call.function.name}`);
    results.push({ name: call.function.name, input: JSON.parse(call.function.arguments) as Record<string, unknown>, output });
  }
  return results;
}

function call(name: ToolName, input: unknown): ToolCall {
  return { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name, arguments: JSON.stringify(input) } };
}

export function decideCompletion(request: CompletionRequest): Decision {
  const command = intent(request.messages);
  const results = toolResults(request.messages);
  if (command.action === '不要修改') return { content: '已保存原始输入。遵照拒绝修改的意图，本次不创建提案（NOOP）。' };
  if (results.some(result => result.name === 'create_change_proposal')) return { content: '已生成修改提案，请查看 Diff 并批准或拒绝；正文等待用户审批。' };

  const searched = results.find(result => result.name === 'search_notes');
  if (!searched) return { calls: [call('search_notes', { query: command.topic, limit: 5 })] };
  if (!Array.isArray(searched.output)) throw new Error('Expected search_notes array');
  const candidates = searched.output as NoteSummary[];
  const reads = results.filter(result => result.name === 'read_note');
  const pending = candidates.filter(note => !reads.some(result => result.input.noteId === note.id));
  const source = results.find(result => result.name === 'read_source' && result.input.sourceId === command.sourceId)?.output as Source | undefined;
  const calls = pending.map(note => call('read_note', { noteId: note.id }));
  if (command.action !== '查询' && !source) calls.push(call('read_source', { sourceId: command.sourceId }));
  if (calls.length) return { calls };

  const notes = reads.map(result => result.output as Note & { evidence: Evidence[] });
  const target = notes.find(note => note.title === command.topic);
  if (command.action === '查询') {
    if (!target) return { content: '未找到足够依据，当前已批准的知识中没有相关记录。' };
    const evidence = target.evidence[0];
    if (!evidence?.id) throw new Error('read_note did not supply an evidence ID');
    return { content: `根据已批准的笔记 v${target.currentVersion}：\n\n${target.content}\n\n[[${evidence.id}]]` };
  }
  if (!source || source.id !== command.sourceId || source.content !== command.sourceContent) throw new Error('Expected the real current source from read_source');
  const sourceIds = [...new Set([...(target?.sourceIds ?? []), source.id])];
  const conflict = command.action === '冲突' && Boolean(target);
  const proposedContent = target
    ? conflict
      ? `${target.content}\n\n## 尚待确认的分歧\n\n旧观点及来源：${target.sourceIds.join('、')}\n\n新观点：${command.body}\n\n新观点来源：${source.id}\n\n新旧观点均保留，尚待确认。`
      : `${target.content}\n\n## 补充\n\n${command.body}\n\n来源：${source.id}`
    : `# ${command.topic}\n\n${command.body}\n\n来源：${source.id}`;
  const proposal: ProposalInput = {
    action: target ? conflict ? 'FLAG_CONFLICT' : 'UPDATE' : 'CREATE',
    targetNoteId: target?.id ?? null,
    baseVersion: target?.currentVersion ?? null,
    proposedTitle: target?.title ?? command.topic,
    proposedContent,
    sourceIds,
    reason: conflict ? '保留新旧观点及各自来源，分歧尚待确认' : target ? '阅读同主题笔记后补充，并保留原有正文和来源' : '检索后未发现同主题已批准笔记，建议新增',
  };
  return { calls: [call('create_change_proposal', proposal)] };
}

function sendCompletion(response: ServerResponse, request: CompletionRequest, decision: Decision) {
  const common = { id: `chatcmpl-${randomUUID()}`, created: 1_700_000_000, model: request.model };
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
  const finishReason = 'calls' in decision ? 'tool_calls' : 'stop';
  if (!request.stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'content' in decision ? decision.content : null, ...('calls' in decision ? { tool_calls: decision.calls } : {}) }, finish_reason: finishReason }], usage }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  response.flushHeaders();
  const chunk = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: 'assistant', content: '' });
  if ('calls' in decision) {
    decision.calls.forEach((tool, index) => {
      chunk({ tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.function.name, arguments: '' } }] });
      // Split JSON across SSE events, including inside values, to exercise SDK
      // incremental tool-call parsing instead of passing complete tool objects.
      for (let offset = 0; offset < tool.function.arguments.length; offset += 37) {
        chunk({ tool_calls: [{ index, function: { arguments: tool.function.arguments.slice(offset, offset + 37) } }] });
      }
    });
  } else {
    for (let offset = 0; offset < decision.content.length; offset += 23) chunk({ content: decision.content.slice(offset, offset + 23) });
  }
  chunk({}, finishReason);
  response.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [], usage })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function readRequest(request: IncomingMessage): Promise<CompletionRequest> {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const buffer of request) {
    size += buffer.length;
    if (size > 1_000_000) throw new Error('Mock request too large');
    buffers.push(buffer);
  }
  const body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as CompletionRequest;
  if (!Array.isArray(body.messages) || body.model !== MOCK_MODEL) throw new Error('Unexpected completion request');
  return body;
}

export async function startMockProvider(port = 0) {
  const exchanges: MockExchange[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end(); return;
      }
      if (request.headers.authorization !== `Bearer ${MOCK_API_KEY}`) {
        response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Use the local fixture key', type: 'authentication_error' } })); return;
      }
      const body = await readRequest(request);
      const decision = decideCompletion(body);
      if ('calls' in decision && decision.calls.some(tool => !body.tools?.some(available => available.function.name === tool.function.name))) throw new Error('Tool is not offered by the real Agent');
      exchanges.push({ request: body, decision });
      sendCompletion(response, body, decision);
    })().catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Invalid mock request', type: 'invalid_request_error' } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    exchanges,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
