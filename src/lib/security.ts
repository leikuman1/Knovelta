import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './schemas';

const runtime = globalThis as typeof globalThis & { csrfSecret?: string };
const secret = runtime.csrfSecret ??= randomBytes(32).toString('hex');
function signed(nonce: string) { return `${nonce}.${createHmac('sha256', secret).update(nonce).digest('hex')}`; }
export function issueToken() { return signed(randomBytes(24).toString('hex')); }
function localTarget(request: Request) {
  const url = new URL(request.url);
  return new URL(`${url.protocol}//${request.headers.get('host') || url.host}`);
}
export function validateLocalRequest(request: Request) {
  const target = localTarget(request);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new AppError('INVALID_HOST', '仅接受本机访问', 403);
  const origin = request.headers.get('origin');
  if ((origin && origin !== target.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new AppError('CROSS_SITE', '拒绝跨站访问', 403);
}
export function validateMutation(request: Request) {
  validateLocalRequest(request);
  const target = localTarget(request);
  if (request.headers.get('origin') !== target.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new AppError('CROSS_SITE', '拒绝跨站写入请求', 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('CONTENT_TYPE', '需要 JSON 请求', 415);
  const token = request.headers.get('x-csrf-token') ?? '';
  const cookie = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('memo_csrf='))?.slice('memo_csrf='.length) ?? '';
  const nonce = token.split('.')[0];
  const expected = nonce ? signed(nonce) : '';
  if (!token || token !== cookie || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) throw new AppError('CSRF', '操作验证已过期，请刷新页面', 403);
}
