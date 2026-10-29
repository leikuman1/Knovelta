import { test, expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { AuditEvent, ChatEvent, Evidence, Note, NoteSummary, Proposal, ProposalDetail, Source, Version } from '../../src/lib/types';

const origin = 'http://127.0.0.1:3100';
const firstFact = 'Checkpointer 用于持久化图状态。';
const secondFact = 'thread_id 标识会话。';

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}
async function get<T>(request: APIRequestContext, url: string) {
  return json<T>(await request.get(url));
}
function parseEvents(text: string): ChatEvent[] {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as ChatEvent);
}
function completed(events: ChatEvent[]) {
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  const savedEvents = events.filter(event => event.type === 'saved');
  expect(savedEvents.length).toBeGreaterThan(0);
  expect(new Set(savedEvents.map(event => event.sourceId)).size).toBe(1);
  const done = events.find(event => event.type === 'done');
  expect(done).toBeDefined();
  if (!done || done.type !== 'done') throw new Error('Missing done event');
  expect(done.invalidCitations).toBe(false);
  return done;
}
function saved(events: ChatEvent[]) {
  const event = events.find(event => event.type === 'saved');
  if (!event || event.type !== 'saved') throw new Error('Missing source');
  return event;
}
async function detail(request: APIRequestContext, events: ChatEvent[]) {
  const event = events.find(event => event.type === 'proposal');
  if (!event || event.type !== 'proposal') throw new Error('Missing pending proposal');
  return get<ProposalDetail>(request, `/api/proposals/${event.proposalId}`);
}
type CapturedChatResponse = { status: number; body: string; error?: string };
type CaptureWindow = Window & { __e2eChatResponse: Promise<CapturedChatResponse> };

async function send(page: Page, message: string) {
  await page.getByRole('main').getByRole('button', { name: '对话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入知识或问题', exact: true }).fill(message);
  await page.evaluate(() => {
    const originalFetch = window.fetch;
    (window as unknown as CaptureWindow).__e2eChatResponse = new Promise<CapturedChatResponse>(resolve => {
      window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (new URL(url, location.href).pathname !== '/api/chat' || method.toUpperCase() !== 'POST') {
          return originalFetch.call(window, input, init);
        }
        window.fetch = originalFetch;
        try {
          const response = await originalFetch.call(window, input, init);
          // The UI cancels its reader after the terminal NDJSON event. CDP may
          // then discard the response body. Observe a real fetch clone in the
          // browser while leaving the original response with the UI.
          void response.clone().text().then(
            body => resolve({ status: response.status, body }),
            error => resolve({ status: response.status, body: '', error: String(error) }),
          );
          return response;
        } catch (error) {
          resolve({ status: 0, body: '', error: String(error) });
          throw error;
        }
      };
    });
  });
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const response = await page.evaluate(() => (window as unknown as CaptureWindow).__e2eChatResponse);
  expect(response.error).toBeUndefined();
  expect(response.status).toBe(200);
  const events = parseEvents(response.body);
  completed(events);
  return events;
}
async function decide(page: Page, proposal: Proposal, action: 'approve' | 'reject') {
  const responsePromise = page.waitForResponse(response => response.url() === `${origin}/api/proposals/${proposal.id}/${action}` && response.request().method() === 'POST');
  await page.getByRole('button', { name: action === 'approve' ? '批准变更' : '拒绝变更', exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(200);
}
async function api(request: APIRequestContext) {
  const session = await get<{ token: string; configured: boolean; recoveryErrors: string[] }>(request, '/api/session');
  expect(session).toMatchObject({ configured: true, recoveryErrors: [] });
  const headers = { origin, 'x-csrf-token': session.token };
  return {
    token: session.token,
    post: (url: string, data: unknown) => request.post(url, { headers, data }),
    chat: async (message: string, requestId = randomUUID()) => {
      const response = await request.post('/api/chat', { headers, data: { message, requestId } });
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('application/x-ndjson');
      const events = parseEvents(await response.text());
      completed(events);
      return { events, requestId, proposal: events.some(event => event.type === 'proposal') ? await detail(request, events) : undefined };
    },
  };
}
async function openNote(page: Page, topic: string, version: number) {
  await page.getByRole('button', { name: `打开笔记：${topic}，v${version}`, exact: true }).click();
  await expect(page.getByRole('main').locator('.note-document > h1')).toHaveText(topic);
}
async function verifyEvidence(request: APIRequestContext, evidence: Evidence, note: Note) {
  expect(evidence).toMatchObject({ noteId: note.id, noteVersion: note.currentVersion, kind: 'note', excerpt: note.content, historical: false });
  expect(note.sourceIds).toContain(evidence.sourceId);
  const snapshot = await get<Note>(request, `/api/notes/${evidence.noteId}/versions/${evidence.noteVersion}`);
  const source = await get<Source>(request, `/api/sources/${evidence.sourceId}`);
  expect(snapshot.content.split('\n').slice(evidence.startLine - 1, evidence.endLine).join('\n')).toBe(evidence.excerpt);
  expect(source.id).toBe(evidence.sourceId);
  return source;
}

test('浏览器：新增、批准 v1、补充、批准 v2、真实引用、恢复 v1 为 v3', async ({ page }) => {
  const topic = 'BrowserLifecycle';
  await page.goto('/');
  expect(await get<NoteSummary[]>(page.request, '/api/notes')).toEqual([]);
  await expect(page.getByRole('complementary', { name: '变更审阅', exact: true })).toBeHidden();
  await page.getByRole('button', { name: '记下一个发现', exact: false }).click();
  await expect(page.getByRole('textbox', { name: '输入知识或问题' })).toHaveValue('帮我记一下：');
  await expect(page.getByRole('textbox', { name: '输入知识或问题' })).toBeFocused();
  await page.getByRole('button', { name: '查看操作历史' }).click();
  await expect(page.getByRole('dialog', { name: '操作历史' })).toBeVisible();
  await page.getByRole('button', { name: '关闭弹层' }).click();
  await expect(page.getByRole('button', { name: '查看操作历史' })).toBeFocused();
  await page.getByRole('button', { name: '展开变更审阅', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '变更审阅', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '收起变更审阅', exact: true }).click();
  const firstInput = `记录 ${topic}：${firstFact}`;
  const createdEvents = await send(page, firstInput);
  const create = await detail(page.request, createdEvents);
  expect(create).toMatchObject({ action: 'CREATE', baseVersion: null, status: 'pending' });
  expect(create.sourceIds).toEqual([saved(createdEvents).sourceId]);
  expect(await get<NoteSummary[]>(page.request, '/api/notes')).toEqual([]);
  await expect(page.getByLabel('标题与正文变更')).toContainText(firstFact);
  await expect(page.getByRole('button', { name: '批准变更', exact: true })).toBeEnabled();
  await decide(page, create, 'approve');
  const v1 = await get<Note>(page.request, `/api/notes/${create.targetNoteId}`);
  expect(v1.currentVersion).toBe(1);
  await openNote(page, topic, 1);
  await expect(page.getByRole('main')).toContainText(firstFact);

  const secondInput = `补充 ${topic}：${secondFact}`;
  const updatedEvents = await send(page, secondInput);
  const update = await detail(page.request, updatedEvents);
  expect(update).toMatchObject({ action: 'UPDATE', targetNoteId: v1.id, baseVersion: 1, beforeContent: v1.content, status: 'pending' });
  expect(update.sourceIds).toEqual(expect.arrayContaining([...v1.sourceIds, saved(updatedEvents).sourceId]));
  expect(await get<Note>(page.request, `/api/notes/${v1.id}`)).toEqual(v1);
  await expect(page.getByLabel('标题与正文变更')).toContainText(secondFact);
  await decide(page, update, 'approve');
  const v2 = await get<Note>(page.request, `/api/notes/${v1.id}`);
  expect(v2.currentVersion).toBe(2);
  expect(v2.content).toContain(v1.content);
  expect(v2.content).toContain(secondFact);
  expect(await get<NoteSummary[]>(page.request, '/api/notes')).toHaveLength(1);
  await openNote(page, topic, 2);

  const answerEvents = await send(page, `查询 ${topic}：当前已批准的知识是什么？`);
  const answer = completed(answerEvents);
  expect(answerEvents.some(event => event.type === 'proposal')).toBe(false);
  expect(answer.citations).toHaveLength(1);
  const evidence = answer.citations[0];
  const source = await verifyEvidence(page.request, evidence, v2);
  expect([firstInput, secondInput]).toContain(source.content);
  await page.getByRole('button', { name: `查看引用 1：笔记 ${v1.id} v2 与原文`, exact: true }).click();
  const evidenceDialog = page.getByRole('dialog', { name: '核对引用来源' });
  await expect(evidenceDialog).toBeVisible();
  await expect(evidenceDialog).toContainText(v1.id);
  await expect(evidenceDialog).toContainText(source.id);
  await expect(evidenceDialog.locator('pre.raw-content')).toHaveText(source.content);
  await expect(evidenceDialog.locator('blockquote')).toContainText(secondFact);
  await evidenceDialog.getByRole('button', { name: '关闭弹层' }).click();

  await openNote(page, topic, 2);
  await page.getByRole('button', { name: '查看笔记版本历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '版本历史' });
  await history.getByRole('button', { name: '查看历史版本 v1', exact: true }).click();
  await expect(history.getByRole('button', { name: '预览恢复 v1', exact: true })).toBeEnabled();
  await history.getByRole('button', { name: `查看历史原文 ${v1.sourceIds[0]}`, exact: true }).click();
  await expect(history.locator('pre.raw-content')).toHaveText(firstInput);
  const restoreResponse = page.waitForResponse(response => response.url() === `${origin}/api/notes/${v1.id}/restore` && response.request().method() === 'POST');
  await history.getByRole('button', { name: '预览恢复 v1', exact: true }).click();
  const response = await restoreResponse;
  expect(response.status()).toBe(200);
  const restore = await response.json() as ProposalDetail;
  expect(restore).toMatchObject({ action: 'RESTORE', targetNoteId: v1.id, baseVersion: 2, restoredFromVersion: 1, proposedContent: v1.content });
  expect((await get<Note>(page.request, `/api/notes/${v1.id}`)).currentVersion).toBe(2);
  await expect(page.getByLabel('标题与正文变更')).toContainText(secondFact);
  await decide(page, restore, 'approve');
  const v3 = await get<Note>(page.request, `/api/notes/${v1.id}`);
  expect(v3).toMatchObject({ currentVersion: 3, content: v1.content, sourceIds: v1.sourceIds });
  await openNote(page, topic, 3);
  await expect(page.getByRole('main')).toContainText(firstFact);
  await expect(page.getByRole('main')).not.toContainText(secondFact);
  const versions = await get<Version[]>(page.request, `/api/notes/${v1.id}/versions`);
  expect(versions.map(version => [version.version, version.restoredFromVersion])).toEqual([[3, 1], [2, null], [1, null]]);
  expect(await get<NoteSummary[]>(page.request, '/api/search?q=thread_id')).toEqual([]);
  const audit = await get<AuditEvent[]>(page.request, '/api/history');
  expect(audit.filter(event => event.noteId === v1.id && event.eventType === 'note_committed')).toHaveLength(3);
});

test('浏览器拒绝提案及明确拒绝修改意图均不改正文、索引和版本', async ({ page, request }) => {
  const topic = 'BrowserRejection';
  const client = await api(request);
  const seed = await client.chat(`记录 ${topic}：${firstFact}`);
  expect(seed.proposal).toBeDefined();
  const v1 = await json<Note>(await client.post(`/api/proposals/${seed.proposal!.id}/approve`, { expectedVersion: 0 }));
  await page.goto('/');
  const events = await send(page, `补充 ${topic}：browser_rejected_token 不能进入知识。`);
  const pending = await detail(page.request, events);
  await expect(page.getByLabel('标题与正文变更')).toContainText('browser_rejected_token');
  await decide(page, pending, 'reject');
  expect((await get<ProposalDetail>(page.request, `/api/proposals/${pending.id}`)).status).toBe('rejected');
  expect(await get<Note>(page.request, `/api/notes/${v1.id}`)).toEqual(v1);
  expect(await get<Version[]>(page.request, `/api/notes/${v1.id}/versions`)).toHaveLength(1);
  expect(await get<NoteSummary[]>(page.request, '/api/search?q=browser_rejected_token')).toEqual([]);
  expect((await get<Source>(page.request, `/api/sources/${saved(events).sourceId}`)).content).toContain('browser_rejected_token');
  const before = await get<Proposal[]>(page.request, '/api/proposals');
  const noop = await send(page, `不要修改 ${topic}：只保存输入，不生成变更。`);
  expect(noop.some(event => event.type === 'proposal')).toBe(false);
  await expect(page.getByRole('log', { name: '对话记录' })).toContainText('NOOP');
  expect(await get<Proposal[]>(page.request, '/api/proposals')).toEqual(before);
  expect(await get<Note>(page.request, `/api/notes/${v1.id}`)).toEqual(v1);
});

test('冲突内容保留双方来源，浏览器批准旧提案得到版本冲突且不覆盖新版本', async ({ page, request }) => {
  const topic = 'BrowserConflict';
  const client = await api(request);
  const seed = await client.chat(`记录 ${topic}：${firstFact}`);
  const v1 = await json<Note>(await client.post(`/api/proposals/${seed.proposal!.id}/approve`, { expectedVersion: 0 }));
  await page.goto('/');
  const conflictEvents = await send(page, `冲突 ${topic}：Checkpointer 不用于持久化图状态。`);
  const conflict = await detail(page.request, conflictEvents);
  expect(conflict).toMatchObject({ action: 'FLAG_CONFLICT', targetNoteId: v1.id, baseVersion: 1 });
  expect(conflict.proposedContent).toContain(firstFact);
  expect(conflict.proposedContent).toContain('Checkpointer 不用于持久化图状态。');
  expect(conflict.proposedContent).toContain('尚待确认');
  for (const sourceId of [saved(seed.events).sourceId, saved(conflictEvents).sourceId]) {
    expect(conflict.sourceIds).toContain(sourceId);
    expect(conflict.proposedContent).toContain(sourceId);
  }
  await expect(page.getByLabel('标题与正文变更')).toContainText('尚待确认');
  const competing = await client.chat(`补充 ${topic}：winning_browser_token 保留并发获批内容。`);
  const winner = await json<Note>(await client.post(`/api/proposals/${competing.proposal!.id}/approve`, { expectedVersion: 1 }));
  const responsePromise = page.waitForResponse(response => response.url() === `${origin}/api/proposals/${conflict.id}/approve`);
  await page.getByRole('button', { name: '批准变更', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
  await expect(page.getByRole('complementary', { name: '变更审阅', exact: true }).getByRole('alert')).toContainText('VERSION_CONFLICT');
  expect(await get<Note>(request, `/api/notes/${v1.id}`)).toEqual(winner);
  expect(await get<Version[]>(request, `/api/notes/${v1.id}/versions`)).toHaveLength(2);
  expect((await get<Proposal>(request, `/api/proposals/${conflict.id}`)).status).toBe('pending');
});

test('API 拒绝跨站、缺失或伪造 CSRF、非法版本及模型直接写入入口', async ({ request }) => {
  const client = await api(request);
  const seed = await client.chat('记录 ApiBoundary：API 边界必须受控。');
  const v1 = await json<Note>(await client.post(`/api/proposals/${seed.proposal!.id}/approve`, { expectedVersion: 0 }));
  const update = await client.chat('补充 ApiBoundary：pending_boundary_token 尚未批准。');
  const proposal = update.proposal!;
  const endpoints = [
    { url: '/api/chat', data: { message: '记录 CrossSiteTopic：不允许写入。', requestId: randomUUID() } },
    { url: `/api/proposals/${proposal.id}/approve`, data: { expectedVersion: 1 } },
    { url: `/api/proposals/${proposal.id}/reject`, data: {} },
    { url: `/api/notes/${v1.id}/restore`, data: { version: 1, expectedVersion: 1 } },
  ];
  const beforeProposals = await get<Proposal[]>(request, '/api/proposals');
  const beforeHistory = await get<AuditEvent[]>(request, '/api/history');
  const crossSiteHeaders: Record<string, string>[] = [
    { origin: 'https://attacker.example', 'x-csrf-token': client.token },
    { origin, 'sec-fetch-site': 'cross-site', 'x-csrf-token': client.token },
    { 'x-csrf-token': client.token },
  ];
  for (const endpoint of endpoints) {
    for (const headers of crossSiteHeaders) {
      const response = await request.post(endpoint.url, { headers, data: endpoint.data });
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'CROSS_SITE' });
    }
  }
  const invalidCsrfHeaders: Record<string, string>[] = [{ origin }, { origin, 'x-csrf-token': 'forged-test-token' }];
  for (const headers of invalidCsrfHeaders) {
    const response = await request.post(`/api/proposals/${proposal.id}/approve`, { headers, data: { expectedVersion: 1 } });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'CSRF' });
  }
  for (const endpoint of endpoints) {
    const headers = { origin, 'x-csrf-token': client.token, 'content-type': 'application/json' };
    const invalidJson = await request.post(endpoint.url, { headers, data: Buffer.from('{') });
    expect(invalidJson.status()).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ code: 'INVALID_INPUT' });
    const oversized = await request.post(endpoint.url, { headers, data: Buffer.from(JSON.stringify({ message: 'x'.repeat(100_001) })) });
    expect(oversized.status()).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: 'INPUT_TOO_LARGE' });
  }
  const contentType = await request.post('/api/chat', { headers: { origin, 'x-csrf-token': client.token, 'content-type': 'text/plain' }, data: 'not json' });
  expect(contentType.status()).toBe(415);
  expect(await contentType.json()).toMatchObject({ code: 'CONTENT_TYPE' });
  const wrongVersion = await client.post(`/api/proposals/${proposal.id}/approve`, { expectedVersion: 0 });
  expect(wrongVersion.status()).toBe(409);
  expect(await wrongVersion.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
  const wrongRestore = await client.post(`/api/notes/${v1.id}/restore`, { version: 1, expectedVersion: 2 });
  expect(wrongRestore.status()).toBe(409);
  expect(await wrongRestore.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
  const directWrite = await client.post('/api/proposals', { action: 'CREATE', proposedTitle: 'Forbidden', proposedContent: '禁止绕过 Agent 与审批。' });
  expect(directWrite.status()).toBe(405);
  const unknownRoute = await request.get('/api/unknown-route');
  expect(unknownRoute.status()).toBe(404);
  const invalidId = await request.get('/api/sources/not-a-trusted-uuid');
  expect(invalidId.status()).toBe(400);
  expect(await invalidId.json()).toMatchObject({ code: 'INVALID_ID' });
  expect(await get<Note>(request, `/api/notes/${v1.id}`)).toEqual(v1);
  expect(await get<Version[]>(request, `/api/notes/${v1.id}/versions`)).toHaveLength(1);
  expect(await get<Proposal[]>(request, '/api/proposals')).toEqual(beforeProposals);
  expect(await get<AuditEvent[]>(request, '/api/history')).toEqual(beforeHistory);
  expect(await get<NoteSummary[]>(request, '/api/search?q=pending_boundary_token')).toEqual([]);
});

test('API 查询无证据不编造引用，同 requestId 重放不重复提案或原文', async ({ request }) => {
  const client = await api(request);
  const missing = await client.chat('查询 MissingBrowserTopic：有什么依据？');
  expect(missing.proposal).toBeUndefined();
  expect(completed(missing.events).citations).toEqual([]);
  expect(missing.events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain('未找到足够依据');
  const message = '记录 ApiReplayTopic：重放请求保持同一来源。';
  const first = await client.chat(message);
  const replay = await client.chat(message, first.requestId);
  expect(saved(replay.events).sourceId).toBe(saved(first.events).sourceId);
  expect(replay.proposal?.id).toBe(first.proposal?.id);
  const proposals = await get<Proposal[]>(request, '/api/proposals');
  expect(proposals.filter(proposal => proposal.proposedTitle === 'ApiReplayTopic')).toHaveLength(1);
  const reused = await client.post('/api/chat', { message: '不同输入不能使用旧请求 ID', requestId: first.requestId });
  expect(reused.status()).toBe(409);
  expect(await reused.json()).toMatchObject({ code: 'REQUEST_CONFLICT' });
});
