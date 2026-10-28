import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AppError } from './schemas';

export const json = (data: unknown) => NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });

export function failure(error: unknown) {
  const requestId = randomUUID();
  if (error instanceof AppError) return NextResponse.json({ code: error.code, message: error.message, requestId }, { status: error.status });
  if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ code: 'INVALID_INPUT', message: '请求参数不合法', requestId }, { status: 400 });
  console.error(JSON.stringify({ event: 'request_failed', requestId, errorType: error instanceof Error ? error.name : 'unknown' }));
  return NextResponse.json({ code: 'INTERNAL_ERROR', message: '操作失败，请检查本地日志', requestId }, { status: 500 });
}
