// Parser for the model's compact substring reply:
//
//   {"i":[["source phrase","translation","pos"], …]}
//
// Items come back as `unknown`; validateItems does every type check.

export type ParseMethod = 'json' | 'brackets' | 'regex';

export interface ParsedItems {
  items: unknown[];
  /** True when the reply was not valid JSON and items were salvaged. */
  truncated: boolean;
  method: ParseMethod;
}

const STR = String.raw`"(?:[^"\\]|\\.)*"`;
// One item: ["src","tgt"(, "pos" | , ["pos"…)?. Tolerates a missing "]" anywhere.
const ITEM_RE = new RegExp(String.raw`\[\s*(${STR})\s*,\s*(${STR})(?:\s*,\s*\[?\s*(${STR}))?`, 'g');

function stripWrappers(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
}

/**
 * Nested bracket scanner over the item list that opens at `open`: every
 * complete inner array, plus where the list closed (or the text ended).
 */
function scanBrackets(text: string, open: number): { items: unknown[]; close: number } {
  const items: unknown[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let elemStart = -1;
  for (let k = open + 1; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') {
      if (depth === 0) elemStart = k;
      depth++;
    } else if (ch === ']') {
      if (depth === 0) return { items, close: k };
      depth--;
      if (depth === 0 && elemStart >= 0) {
        try {
          items.push(JSON.parse(text.slice(elemStart, k + 1)));
        } catch {
          // skip a malformed element
        }
        elemStart = -1;
      }
    }
  }
  return { items, close: text.length };
}

/** Flat per-item salvage: survives broken nesting (e.g. pos written as `["n"` unclosed). */
function scanItems(region: string): unknown[] {
  const out: unknown[] = [];
  for (const m of region.matchAll(ITEM_RE)) {
    try {
      const item: unknown[] = [JSON.parse(m[1]), JSON.parse(m[2])];
      if (m[3] !== undefined) item.push(JSON.parse(m[3]));
      out.push(item);
    } catch {
      // skip
    }
  }
  return out;
}

const isTuple = (v: unknown[]) => v.length >= 2 && v.every(x => !Array.isArray(x) || x.length <= 1) && typeof v[0] === 'string' && typeof v[1] === 'string';

/**
 * Strips `<think>` blocks (any case) and code fences, then:
 * 1. JSON.parse, accepting `{"i":[…]}`, a bare list, or a single bare tuple;
 * 2. an explicit `"i": []` anywhere is an empty success;
 * 3. else salvage, only inside the item list (after `"i":[`, or from the first
 *    `[[` when there is no key) and only up to where that list closes: the
 *    bracket scanner and the flat per-item regex, keeping whichever recovers
 *    more. Echoed prose (`Example: ["El perro","The dog","n"]`) and other keys
 *    never become items;
 * 4. a bare `[]` is an empty success only when it is the whole reply.
 * Returns null otherwise (garbage, a refusal like "I cannot do that []", or an
 * unclosed `<think>`) so the chunk can be retried.
 */
export function parseItems(content: string): ParsedItems | null {
  const text = stripWrappers(content);
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v) && isTuple(v)) return { items: [v], truncated: false, method: 'json' };
    const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? (v as { i?: unknown }).i : undefined;
    if (Array.isArray(arr)) return { items: arr, truncated: false, method: 'json' };
  } catch {
    // fall through to salvage
  }
  if (/"i"\s*:\s*\[\s*\]/.test(text)) return { items: [], truncated: false, method: 'json' };
  const key = text.search(/"i"\s*:\s*\[/);
  const open = key >= 0 ? text.indexOf('[', key) : text.search(/\[\s*\[/);
  if (open < 0) return null;
  const { items: bracketed, close } = scanBrackets(text, open);
  const flat = scanItems(text.slice(open, close + 1));
  if (flat.length > bracketed.length) return { items: flat, truncated: true, method: 'regex' };
  if (bracketed.length) return { items: bracketed, truncated: true, method: 'brackets' };
  return null;
}
