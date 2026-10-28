import { getStore } from '@/lib/store';
import { json, failure } from '@/lib/http';
import { AppError } from '@/lib/schemas';
import { validateMutation } from '@/lib/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ proposalId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    validateMutation(request);
    if (Number(request.headers.get('content-length')) > 100_000) throw new AppError('INPUT_TOO_LARGE', '请求过大', 413);
    const text = await request.text();
    if (text.length > 100_000) throw new AppError('INPUT_TOO_LARGE', '请求过大', 413);
    JSON.parse(text);
    const { proposalId } = await context.params;
    return json(getStore().reject(proposalId));
  } catch (error) { return failure(error); }
}
