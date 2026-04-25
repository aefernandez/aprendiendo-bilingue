import { swap } from '@/lib/swapEngine';
import type { SwapRequest } from '@/lib/types';

export async function POST(request: Request) {
  const body = (await request.json()) as SwapRequest;
  const { text, level } = body;

  if (!text?.trim() || !level) {
    return Response.json({ error: 'Missing text or level' }, { status: 400 });
  }

  const segments = await swap(text.trim(), level);
  return Response.json({ segments });
}
