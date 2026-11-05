'use client';

// Development console pinned to the bottom of the page.
//
// It collects:
//   - the server's diagnostics for each /api/swap request (backend, model,
//     upstream errors, retries, fallbacks), passed in via logDebug()
//   - failed requests and exceptions in the page itself
//   - uncaught errors, unhandled promise rejections, and console.error/warn
//
// It opens itself when an error arrives so problems are obvious.
// Hide it with NEXT_PUBLIC_DEBUG_CONSOLE=false (then redeploy).

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { clip, debugConsoleEnabled, type DebugEvent, type DebugLevel } from '@/lib/diagnostics';

export const DEBUG_CONSOLE_ENABLED = debugConsoleEnabled();

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MAX_EVENTS = 200;
let events: DebugEvent[] = [];
// Hidden by the user with the close button. The next new error shows the
// console again, so a hidden console never hides a fresh problem.
let hidden = false;
const listeners = new Set<() => void>();

function emit() {
  // Defer so logging from inside a React render (console.error from React
  // itself, for example) doesn't update this component mid-render.
  queueMicrotask(() => listeners.forEach((l) => l()));
}

export function logDebug(input: DebugEvent | DebugEvent[]) {
  if (!DEBUG_CONSOLE_ENABLED) return;
  const added = Array.isArray(input) ? input : [input];
  if (added.length === 0) return;
  events = [...events, ...added].slice(-MAX_EVENTS);
  if (added.some((e) => e.level === 'error')) hidden = false;
  emit();
}

function hideConsole() {
  hidden = true;
  emit();
}

export function clientEvent(level: DebugLevel, message: string, detail?: string): DebugEvent {
  const event: DebugEvent = { level, source: 'client', message, time: new Date().toISOString() };
  if (detail) event.detail = clip(detail);
  return event;
}

function clearEvents() {
  events = [];
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => events;
const EMPTY: DebugEvent[] = [];
const getServerSnapshot = () => EMPTY;

const getShown = () => DEBUG_CONSOLE_ENABLED && !hidden;
const getServerShown = () => DEBUG_CONSOLE_ENABLED;

// Whether the console bar is on screen, so the page can leave room for it.
export function useDebugConsoleShown(): boolean {
  return useSyncExternalStore(subscribe, getShown, getServerShown);
}

// ---------------------------------------------------------------------------
// Global capture
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let captureInstalled = false;

function installCapture() {
  if (captureInstalled || typeof window === 'undefined') return;
  captureInstalled = true;

  window.addEventListener('error', (e) => {
    logDebug(clientEvent('error', e.message || 'Uncaught error', describe(e.error ?? `${e.filename}:${e.lineno}`)));
  });
  window.addEventListener('unhandledrejection', (e) => {
    logDebug(clientEvent('error', 'Unhandled promise rejection', describe(e.reason)));
  });

  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const [first, ...rest] = args;
      logDebug(clientEvent(level, clip(describe(first), 200), rest.length ? rest.map(describe).join(' ') : undefined));
    };
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const LEVEL_STYLE: Record<DebugLevel, string> = {
  error: 'text-red-300',
  warn: 'text-yellow-200',
  info: 'text-gray-300',
};

const LEVEL_TAG: Record<DebugLevel, string> = { error: 'ERR', warn: 'WRN', info: 'INF' };

function formatTime(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour12: false });
}

function asText(list: DebugEvent[]) {
  return list
    .map((e) => `${e.time} [${e.level}] ${e.source}: ${e.message}${e.detail ? `\n    ${e.detail}` : ''}`)
    .join('\n');
}

export default function DebugConsole() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const shown = useDebugConsoleShown();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const seenErrors = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(installCapture, []);

  const errorCount = list.filter((e) => e.level === 'error').length;
  const warnCount = list.filter((e) => e.level === 'warn').length;

  // Pop open when a new error arrives.
  useEffect(() => {
    if (errorCount > seenErrors.current) setOpen(true);
    seenErrors.current = errorCount;
  }, [errorCount]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [open, list.length]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(asText(list));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; the text is still selectable in the panel.
    }
  }

  // Stays mounted while hidden so it still notices the next error.
  if (!shown) return null;

  return (
    <section
      aria-label="Debug console"
      className="fixed bottom-0 left-0 right-0 z-50 bg-gray-950 text-gray-100 font-mono text-xs border-t border-gray-700"
    >
      <div className="flex h-10 items-center gap-3 px-4">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-3 text-left"
        >
          <span aria-hidden>{open ? '▾' : '▸'}</span>
          <span className="font-semibold">Console</span>
          {errorCount > 0 && (
            <span className="whitespace-nowrap rounded bg-red-600 px-1.5 py-0.5 text-white">
              {errorCount} error{errorCount === 1 ? '' : 's'}
            </span>
          )}
          {warnCount > 0 && (
            <span className="whitespace-nowrap rounded bg-yellow-500 px-1.5 py-0.5 text-gray-950">
              {warnCount} warning{warnCount === 1 ? '' : 's'}
            </span>
          )}
          {list.length === 0 && <span className="text-gray-400">No messages</span>}
        </button>
        {list.length > 0 && (
          <>
            <button onClick={copy} className="text-gray-300 hover:text-white">
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={clearEvents} className="text-gray-300 hover:text-white">
              Clear
            </button>
          </>
        )}
        <button
          onClick={hideConsole}
          aria-label="Hide console until the next error"
          title="Hide until the next error"
          className="-mr-2 px-2 text-base leading-none text-gray-300 hover:text-white"
        >
          ×
        </button>
      </div>

      {open && (
        <div className="max-h-[40vh] overflow-y-auto border-t border-gray-800 px-4 py-2" role="log">
          {list.length === 0 && <p className="py-2 text-gray-400">Nothing logged yet.</p>}
          {list.map((e, i) => (
            <div key={i} className="border-b border-gray-900 py-1.5 last:border-0">
              <div className={`flex gap-2 ${LEVEL_STYLE[e.level]}`}>
                <span className="shrink-0 text-gray-500">{formatTime(e.time)}</span>
                <span className="shrink-0">{LEVEL_TAG[e.level]}</span>
                <span className="shrink-0 text-gray-500">{e.source}</span>
                <span className="break-words min-w-0">{e.message}</span>
              </div>
              {e.detail && (
                <pre className="mt-1 ml-4 whitespace-pre-wrap break-all text-gray-400">{e.detail}</pre>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </section>
  );
}
