import { swap } from '@/lib/swapEngine';
import { parseSwapRequest } from '@/lib/validation';
import { debugConsoleEnabled } from '@/lib/diagnostics';

// The swap engine enforces its own ~14 s deadline (spec: results within 15 s).
// This is a platform-level backstop so a stuck request can't run indefinitely.
export const maxDuration = 20;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const parsed = parseSwapRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const result = await swap(parsed.value.text, parsed.value.level);
  if (!debugConsoleEnabled()) delete result.debug;
  return Response.json(result);
}
