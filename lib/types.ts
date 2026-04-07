export type Level = 1 | 2 | 3;

export interface Segment {
  text: string;
  lang: 'source' | 'target';
  translation: string | null;
}

export interface SwapRequest {
  text: string;
  level: Level;
}
