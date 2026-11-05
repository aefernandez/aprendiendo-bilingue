// One Intl.Segmenter per (locale, granularity). Building a segmenter loads ICU
// data, so reuse them across requests instead of constructing one per call.

type Granularity = 'grapheme' | 'word' | 'sentence';

const cache = new Map<string, Intl.Segmenter>();

export function getSegmenter(locale: string, granularity: Granularity): Intl.Segmenter {
  const key = `${locale}|${granularity}`;
  let segmenter = cache.get(key);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity });
    cache.set(key, segmenter);
  }
  return segmenter;
}
