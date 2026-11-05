// Parser for the model's compact reply. See validate.ts for the tuple layout.
//
//   {"i":[[1,1,"come","mangia","v"],[4,5,"bebe","agua","beve acqua","v"]]}
//
// Shape is NOT checked here: items come back as `unknown` and validateItems
// does every positional type check.

export interface ParsedItems {
  items: unknown[];
  /** True when the reply was cut off and only complete inner arrays were salvaged. */
  truncated: boolean;
}

/**
 * Strips `<think>…</think>` and code fences, then tries JSON.parse (accepting
 * `{"i":[…]}` or a bare array). If that fails, a string-aware bracket scanner
 * recovers every complete inner array. Returns null when nothing usable is found
 * (including an unclosed `<think>`).
 */
export function parseItems(content: string): ParsedItems | null {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '');
  text = text.replace(/```(?:json)?/g, '').trim();
  try {
    const v: unknown = JSON.parse(text);
    const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? (v as { i?: unknown }).i : undefined;
    if (Array.isArray(arr)) return { items: arr, truncated: false };
  } catch {
    // fall through to salvage
  }

  const key = text.search(/"i"\s*:\s*\[/);
  const open = key >= 0 ? text.indexOf('[', key) : text.indexOf('[');
  if (open < 0) return null;
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
    if (ch === '"') {
      inStr = true;
    } else if (ch === '[') {
      if (depth === 0) elemStart = k;
      depth++;
    } else if (ch === ']') {
      // Outer array closed but the JSON was otherwise bad (e.g. trailing junk).
      if (depth === 0) return { items, truncated: false };
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
  return items.length ? { items, truncated: true } : null;
}
