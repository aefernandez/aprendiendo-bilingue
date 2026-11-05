import type { DebugEvent } from './diagnostics';

export type Level = 1 | 2 | 3;

export interface Segment {
  text: string;
  lang: 'source' | 'target';
  translation: string | null;
}

export interface Word {
  text: string;
  isWordLike: boolean;
  lang: 'source' | 'target';
  phraseIndex: number;
  phraseText: string;
  phraseTranslation: string | null;
}

export interface Span {
  start: number;
  end: number;
  text: string;
}

export interface SwapResult {
  segments: Segment[];
  // True when the engine fell back to the original text (LLM slow, down, or
  // returned something unusable). The UI should say so instead of implying
  // the text was mixed.
  degraded: boolean;
  // True when some chunks of a long text couldn't be translated in time and
  // are shown as original text. Present only when true; never set together
  // with `degraded` (that's when every chunk failed).
  partial?: boolean;
  // What happened during the request, for the in-app debug console. Omitted
  // from API responses when NEXT_PUBLIC_DEBUG_CONSOLE=false.
  debug?: DebugEvent[];
}

export interface SwapRequest {
  text: string;
  level: Level;
}
