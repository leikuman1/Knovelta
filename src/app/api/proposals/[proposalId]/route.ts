import { getStore } from '@/lib/store';
import { json, failure } from '@/lib/http';
import { validateLocalRequest } from '@/lib/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ proposalId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    validateLocalRequest(request);
    const { proposalId } = await context.params;
    return json(getStore().proposalDetail(proposalId));
  } catch (error) { return failure(error); }
}
