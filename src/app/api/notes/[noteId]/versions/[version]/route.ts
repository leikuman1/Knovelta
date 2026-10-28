import { getStore } from '@/lib/store';
import { json, failure } from '@/lib/http';
import { validateLocalRequest } from '@/lib/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ noteId: string; version: string }> };

export async function GET(request: Request, context: Context) {
  try {
    validateLocalRequest(request);
    const { noteId, version } = await context.params;
    return json(getStore().note(noteId, Number(version)));
  } catch (error) { return failure(error); }
}
