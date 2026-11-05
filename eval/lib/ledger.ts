// Shared spend ledger: eval/results/spend.jsonl.
//
// Every eval process appends one line per finished item with the money it
// spent. Appends are small single writes (O_APPEND), so two processes don't
// clobber each other, and every check re-reads the file, so the EVAL_MAX_USD
// cap holds across suites and across runs. The cap is cumulative: to allow
// more spend, raise EVAL_MAX_USD or move spend.jsonl aside.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Env } from './guard';

export const DEFAULT_MAX_USD = 2;

export interface LedgerEntry {
  ts: string;
  runId: string;
  key: string;
  usd: number;
}

export function readCap(env: Env = process.env): number {
  const raw = env.EVAL_MAX_USD?.trim();
  if (!raw) return DEFAULT_MAX_USD;
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap < 0) throw new Error(`EVAL_MAX_USD must be a non-negative number, got "${raw}"`);
  return cap;
}

export class SpendLedger {
  constructor(readonly file: string) {}

  entries(): LedgerEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEntry];
        } catch {
          return []; // a torn last line from a killed process
        }
      });
  }

  spent(): number {
    return this.entries().reduce((sum, e) => sum + (Number.isFinite(e.usd) ? e.usd : 0), 0);
  }

  record(entry: Omit<LedgerEntry, 'ts'>): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  }
}
