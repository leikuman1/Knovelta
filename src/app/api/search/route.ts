import { getStore } from '@/lib/store';
import { json, failure } from '@/lib/http';
import { validateLocalRequest } from '@/lib/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    validateLocalRequest(request);
    return json(getStore().search(new URL(request.url).searchParams.get('q') ?? ''));
  } catch (error) { return failure(error); }
}
