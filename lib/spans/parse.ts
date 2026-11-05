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

/** Nested bracket scanner: every complete inner array of the item list. */
function scanBrackets(text: string): unknown[] {
  const key = text.search(/"i"\s*:\s*\[/);
  const open = key >= 0 ? text.indexOf('[', key) : text.search(/\[\s*\[/);
  if (open < 0) return [];
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
      if (depth === 0) break;
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
  return items;
}

/** Flat per-item salvage: survives broken nesting (e.g. pos written as `["n"` unclosed). */
function scanItems(text: string): unknown[] {
  const out: unknown[] = [];
  for (const m of text.matchAll(ITEM_RE)) {
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

/**
 * Strips `<think>` blocks (any case) and code fences, then:
 * 1. JSON.parse, accepting `{"i":[…]}` or a bare array;
 * 2. else the bracket scanner and the flat per-item regex, keeping whichever
 *    recovers more items;
 * 3. else an explicit empty list (`"i": []` or a bare `[]`) is an empty success.
 * Returns null when nothing usable is found (garbage, or an unclosed `<think>`).
 */
export function parseItems(content: string): ParsedItems | null {
  const text = stripWrappers(content);
  try {
    const v: unknown = JSON.parse(text);
    const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? (v as { i?: unknown }).i : undefined;
    if (Array.isArray(arr)) return { items: arr, truncated: false, method: 'json' };
  } catch {
    // fall through to salvage
  }
  const bracketed = scanBrackets(text);
  const flat = scanItems(text);
  if (flat.length > bracketed.length) return { items: flat, truncated: true, method: 'regex' };
  if (bracketed.length) return { items: bracketed, truncated: true, method: 'brackets' };
  if (/"i"\s*:\s*\[\s*\]/.test(text) || /(?:^|[\s:])\[\s*\](?=\s*$|\s*[.!]?\s*$)/.test(text)) {
    return { items: [], truncated: false, method: 'json' };
  }
  return null;
}
