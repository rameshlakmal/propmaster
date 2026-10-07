import { divider, icons, makeStyle, spread, table, type Colors } from '../core/ui.js';
import { plural } from './format.js';
import type { RuleResult } from './rules.js';

/** Values as Postgres returned them: numerics stay as written (pg gives them as strings). */
function show(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function scopeText(scope: Record<string, number>): string {
  const parts = Object.entries(scope).map(([t, n]) => `${plural(n, 'row')} of ${t.replace(/^public\./, '')}`);
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

/** One line per rule (what it checked on the right), the rows that break failed rules, and a summary. */
export function formatRuleResults(results: RuleResult[], { colors, width, allRows = false }: RuleReportOptions = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const i = icons(c);
  const lines: string[] = [];
  const checked = (r: RuleResult) => (allRows ? 'whole tables' : scopeText(r.scope));

  for (const r of results) {
    switch (r.status) {
      case 'pass':
        lines.push(spread(` ${i.ok} ${r.rule.name}`, c.dim(checked(r)), s.width));
        break;
      case 'skipped': {
        const tables = Object.keys(r.scope).map((t) => t.replace(/^public\./, '')).join(' or ');
        lines.push(spread(` ${i.skip} ${c.dim(r.rule.name)}`, c.dim('nothing to check'), s.width));
        lines.push(`     ${c.dim(`the session touched no ${tables} rows`)}`);
        break;
      }
      case 'fail': {
        lines.push(spread(` ${i.fail} ${c.bold(r.rule.name)}`, `${c.red(plural(r.violationCount, 'violation'))} ${c.dim(`in ${checked(r)}`)}`, s.width));
        const headers = Object.keys(r.violations[0] ?? {});
        if (headers.length) lines.push(...table(c, headers, r.violations.map((v) => headers.map((h) => show(v[h]))), 5));
        const more = r.violationCount - r.violations.length;
        if (more > 0) lines.push(`     ${c.dim(`…and ${more} more`)}`);
        break;
      }
      case 'error':
        lines.push(` ${i.warn} ${c.bold(r.rule.name)}`);
        lines.push(`     ${c.yellow(`could not run (line ${r.rule.line}): ${r.error}`)}`);
        break;
    }
  }

  const t = tally(results);
  const parts = [c.green(`${t.pass} passed`), t.fail ? c.red(`${t.fail} failed`) : `${t.fail} failed`];
  if (t.skipped) parts.push(c.dim(`${t.skipped} skipped`));
  if (t.error) parts.push(c.yellow(`${t.error} could not run`));
  lines.push('', divider(s), ` ${parts.join(' · ')}`);
  return lines.join('\n');
}
