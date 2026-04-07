import { swap } from '@/lib/swapEngine';
import type { SwapRequest } from '@/lib/types';

// Edge runtime gives us 30s on Vercel Hobby, covering the 15s latency requirement
export const runtime = 'edge';

export async function POST(request: Request) {
  const body = (await request.json()) as SwapRequest;
  const { text, level } = body;

  if (!text?.trim() || !level) {
    return Response.json({ error: 'Missing text or level' }, { status: 400 });
  }

  const segments = await swap(text.trim(), level);
  return Response.json({ segments });
}
