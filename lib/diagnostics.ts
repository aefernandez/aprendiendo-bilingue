// Diagnostics for the in-app debug console.
//
// The swap engine records what happened during a request (which backend and
// model it called, upstream errors, retries, why it fell back) and the API
// route returns those events alongside the result so the page can show them.
// Every event is also written to the server log, as before.
//
// Turn the console off by setting NEXT_PUBLIC_DEBUG_CONSOLE=false. It is read
// on the server (to stop returning events) and baked into the client bundle
// at build time (to hide the panel), so redeploy after changing it.

export type DebugLevel = 'error' | 'warn' | 'info';

export interface DebugEvent {
  level: DebugLevel;
  source: 'server' | 'client';
  message: string;
  // Extra context: upstream response body, stack trace, request details.
  detail?: string;
  time: string; // ISO timestamp
}

// Upstream bodies can be whole HTML pages; keep what the console shows short.
const MAX_DETAIL_CHARS = 600;

export function debugConsoleEnabled(value: string | undefined = process.env.NEXT_PUBLIC_DEBUG_CONSOLE): boolean {
  return value?.trim().toLowerCase() !== 'false';
}

export function clip(text: string, max = MAX_DETAIL_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}

export class Diagnostics {
  readonly events: DebugEvent[] = [];

  private add(level: DebugLevel, message: string, detail?: string) {
    const event: DebugEvent = { level, source: 'server', message, time: new Date().toISOString() };
    if (detail) event.detail = clip(detail);
    this.events.push(event);
    const log = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    if (detail) log(message, event.detail);
    else log(message);
  }

  error(message: string, detail?: string) {
    this.add('error', message, detail);
  }

  warn(message: string, detail?: string) {
    this.add('warn', message, detail);
  }

  info(message: string, detail?: string) {
    this.add('info', message, detail);
  }
}
