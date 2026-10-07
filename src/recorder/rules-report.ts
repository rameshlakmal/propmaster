import { boxTable, cell, divider, icons, makeStyle, type Cell, type Colors, type Column } from '../core/ui.js';
import { plural } from './format.js';
import type { RuleResult } from './rules.js';

/** Values as Postgres returned them: numerics stay as written (pg gives them as strings). */
function show(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const short = (table: string) => table.replace(/^public\./, '');

function scopeText(scope: Record<string, number>): string {
  const parts = Object.entries(scope).map(([t, n]) => `${plural(n, 'row')} of ${short(t)}`);
  return parts.length ? parts.join(', ') : 'the whole query';
}

export interface Tally {
  pass: number;
  fail: number;
  skipped: number;
  error: number;
}

export function tally(results: RuleResult[]): Tally {
  const t: Tally = { pass: 0, fail: 0, skipped: 0, error: 0 };
  for (const r of results) t[r.status]++;
  return t;
}

export interface RuleReportOptions {
  colors?: Colors;
  width?: number;
  allRows?: boolean;
}

const COLUMNS: Column[] = [
  { header: ' ' },
  { header: 'Rule', flex: true },
  { header: 'Checked', max: 30 },
  { header: 'Result', max: 16 },
];

/** A table of every rule and its result, then the rows that break each failed rule, then a summary. */
export function formatRuleResults(results: RuleResult[], { colors, width, allRows = false }: RuleReportOptions = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const i = icons(c);
  const checked = (r: RuleResult) => (allRows ? 'whole tables' : scopeText(r.scope));

  const rows: Cell[][] = results.map((r) => {
    switch (r.status) {
      case 'pass':
        return [cell('✔', c.green), cell(r.rule.name), cell(checked(r), c.dim), cell('pass', c.green)];
      case 'fail':
        return [cell('✖', c.red), cell(r.rule.name, (t) => c.bold(t)), cell(checked(r), c.dim), cell(plural(r.violationCount, 'violation'), c.red)];
      case 'skipped':
        return [cell('⊘', c.dim), cell(r.rule.name, c.dim),
          cell(`no ${Object.keys(r.scope).map(short).join(' or ')} rows touched`, c.dim), cell('skipped', c.dim)];
      case 'error':
        return [cell('!', c.yellow), cell(r.rule.name), cell(''), cell('could not run', c.yellow)];
    }
  });
  const lines = boxTable(s, COLUMNS, rows);

  // Details: the rows that break each failed rule, and why a rule could not run.
  for (const r of results) {
    if (r.status === 'fail') {
      lines.push('', ` ${i.fail} ${c.bold(r.rule.name)} ${c.dim('·')} ${c.red(plural(r.violationCount, 'violation'))}`);
      const headers = Object.keys(r.violations[0] ?? {});
      if (headers.length) {
        lines.push(...boxTable(s, headers.map((h) => ({ header: h })), r.violations.map((v) => headers.map((h) => cell(show(v[h]))))));
      }
      const more = r.violationCount - r.violations.length;
      if (more > 0) lines.push(`   ${c.dim(`…and ${more} more`)}`);
    } else if (r.status === 'error') {
      lines.push('', ` ${i.warn} ${c.bold(r.rule.name)} ${c.dim('·')} ${c.yellow(`could not run (line ${r.rule.line}): ${r.error}`)}`);
    }
  }

  const t = tally(results);
  const parts = [c.green(`${t.pass} passed`), t.fail ? c.red(`${t.fail} failed`) : `${t.fail} failed`];
  if (t.skipped) parts.push(c.dim(`${t.skipped} skipped`));
  if (t.error) parts.push(c.yellow(`${t.error} could not run`));
  lines.push('', divider(s), ` ${parts.join(' · ')}`);
  return lines.join('\n');
}
