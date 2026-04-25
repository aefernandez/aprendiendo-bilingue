import type { Segment, Word } from './types';

const segmenter = new Intl.Segmenter('it', { granularity: 'word' });

export function expandToWords(segments: Segment[]): Word[] {
  return segments.flatMap((segment, phraseIndex): Word[] => {
    if (segment.lang === 'source') {
      return [{
        text: segment.text,
        isWordLike: true,
        lang: 'source' as const,
        phraseIndex,
        phraseText: segment.text,
        phraseTranslation: null,
      }];
    }

    return [...segmenter.segment(segment.text)].map(({ segment: text, isWordLike }) => ({
      text,
      isWordLike: isWordLike ?? false,
      lang: 'target' as const,
      phraseIndex,
      phraseText: segment.text,
      phraseTranslation: segment.translation,
    }));
  });
}
