import type { Segment, Span, Word } from './types';

const segmenter = new Intl.Segmenter('it', { granularity: 'word' });

export function reconstructSegments(
  original: string,
  spans: Span[],
  translations: string[],
): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  for (let i = 0; i < spans.length; i++) {
    const { start, end, text: sourceText } = spans[i];
    if (cursor < start) {
      segments.push({ text: original.slice(cursor, start), lang: 'source', translation: null });
    }
    segments.push({ text: translations[i], lang: 'target', translation: sourceText });
    cursor = end;
  }

  if (cursor < original.length) {
    segments.push({ text: original.slice(cursor), lang: 'source', translation: null });
  }

  return segments.filter(s => s.text.trim().length > 0);
}

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
