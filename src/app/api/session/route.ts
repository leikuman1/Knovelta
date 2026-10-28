import { getStore } from '@/lib/store';
import { json, failure } from '@/lib/http';
import { issueToken, validateLocalRequest } from '@/lib/security';
import { modelConfigured } from '@/lib/agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    validateLocalRequest(request);
    const store = getStore();
    const token = issueToken();
    const response = json({ token, configured: modelConfigured(), recoveryErrors: store.recoveryErrors });
    response.cookies.set('memo_csrf', token, { httpOnly: true, sameSite: 'strict', path: '/', secure: new URL(request.url).protocol === 'https:' });
    return response;
  } catch (error) { return failure(error); }
}
