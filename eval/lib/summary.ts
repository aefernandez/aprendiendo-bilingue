// summary.md / summary.json writer. summary.md is meant to be pasted back to
// the team, so keep what suites put in it short (about 40 lines).

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatUsd } from './cost';
import type { RunResult } from './run';

export interface SummaryTable {
  title: string;
  columns: string[];
  rows: (string | number)[][];
}

export interface Summary {
  suite: string;
  runId: string;
  date: string;
  status: string;
  items: { total: number; done: number; errors: number };
  cost: { spentUsd: number; estimateUsd: number; ledgerUsd: number; capUsd: number; pricesStale: boolean };
  tables: SummaryTable[];
  notes: string[];
}

/** The header fields every suite shares, taken from a run result. */
export function summaryFromRun(suite: string, total: number, run: RunResult): Omit<Summary, 'tables' | 'notes'> {
  return {
    suite,
    runId: run.runId ?? '(dry run)',
    date: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    status: run.status,
    items: {
      total,
      done: run.lines.filter((l) => l.status === 'ok').length,
      errors: run.lines.filter((l) => l.status === 'error').length,
    },
    cost: {
      spentUsd: run.spentUsd,
      estimateUsd: run.estimate.usd,
      ledgerUsd: run.ledgerUsd,
      capUsd: run.capUsd,
      pricesStale: run.estimate.stale,
    },
  };
}

const cell = (v: string | number) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderSummary(s: Summary): string {
  const out = [
    `# Eval summary: ${s.suite}`,
    '',
    `- Run: \`${s.runId}\` (${s.date})`,
    `- Status: ${s.status}`,
    `- Items: ${s.items.done}/${s.items.total} done, ${s.items.errors} errors`,
    `- Spend: ${formatUsd(s.cost.spentUsd)} this session (estimate ${formatUsd(s.cost.estimateUsd)}` +
      `${s.cost.pricesStale ? ', price table may be stale' : ''}); ` +
      `eval ledger ${formatUsd(s.cost.ledgerUsd)} of ${formatUsd(s.cost.capUsd)} cap`,
  ];
  for (const t of s.tables) {
    out.push('', `## ${t.title}`, '', `| ${t.columns.map(cell).join(' | ')} |`, `|${t.columns.map(() => '---').join('|')}|`);
    for (const r of t.rows) out.push(`| ${r.map(cell).join(' | ')} |`);
  }
  if (s.notes.length) {
    out.push('', '## Notes', '');
    for (const n of s.notes) out.push(`- ${n}`);
  }
  return out.join('\n') + '\n';
}

export function writeSummary(dir: string, s: Summary): { md: string; json: string } {
  mkdirSync(dir, { recursive: true });
  const md = path.join(dir, 'summary.md');
  const json = path.join(dir, 'summary.json');
  writeFileSync(md, renderSummary(s));
  writeFileSync(json, JSON.stringify(s, null, 2) + '\n');
  return { md, json };
}
