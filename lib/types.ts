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
}

export interface SwapRequest {
  text: string;
  level: Level;
}
