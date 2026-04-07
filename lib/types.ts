export type Level = 1 | 2 | 3;

export interface Segment {
  text: string;
  lang: 'source' | 'target';
  translation: string | null;
  phrase_id?: number; // groups words translated as a unit; null/absent for source segments
}

export interface SwapRequest {
  text: string;
  level: Level;
}
