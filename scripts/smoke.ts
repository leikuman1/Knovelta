import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/lib/store';
import { runAgent } from '../src/lib/agent';
import type { ChatEvent } from '../src/lib/types';

const root = mkdtempSync(path.join(tmpdir(), 'knovelta-smoke-'));
const store = new Store(root);
async function run(message: string) {
  const source = store.saveSource(message, randomUUID());
  const run = store.startRun(source);
  const events: ChatEvent[] = [];
  const result = await runAgent(store, source, run.id, event => { events.push(event); if (event.type === 'status') console.info(event.message); });
  store.finishRun(run.id, 'completed', events, result.selectedTools, 0, result.usage);
  const proposal = events.find(e => e.type === 'proposal');
  const answer = events.filter(e => e.type === 'text').map(e => e.text).join('');
  const done = events.find(e => e.type === 'done');
  console.info(JSON.stringify({ answer, citations: done?.type === 'done' ? done.citations.length : 0, proposal: proposal?.type === 'proposal' ? store.proposal(proposal.proposalId).action : null }));
  return events;
}
try {
  console.info(`隔离冒烟数据：${root}`);
  console.info('仅生成提案并查询，不自动批准；真实 UI 审批验收需在浏览器完成。');
  await run('记一下，Checkpointer 用于持久化图状态。');
  await run('我记过哪些关于 Checkpointer 的结论？如果没有获批知识请说明。');
} catch (error) {
  console.error(error instanceof Error ? error.message : '冒烟失败');
  process.exitCode = 1;
} finally { store.close(); }
