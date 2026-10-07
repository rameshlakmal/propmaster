import pc from 'picocolors';
import { plural } from './format.js';
import type { RuleResult } from './rules.js';
import type { Row } from './types.js';

type Colors = Pick<typeof pc, 'bold' | 'dim' | 'green' | 'yellow' | 'red'>;

/** Values as Postgres returned them: numerics stay as written (pg gives them as strings). */
function show(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function row(r: Row): string {
  return Object.entries(r).map(([k, v]) => `${k}=${show(v)}`).join(' ');
}

function scopeText(scope: Record<string, number>): string {
  const parts = Object.entries(scope).map(([table, n]) => `${plural(n, 'row')} of ${table.replace(/^public\./, '')}`);
  return parts.length ? `checked ${parts.join(', ')}` : 'checked the whole query';
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

/** One line per rule, the first violating rows under failed rules, and a summary line. */
export function formatRuleResults(results: RuleResult[], { colors: c = pc, allRows = false }: { colors?: Colors; allRows?: boolean } = {}): string {
  const lines: string[] = [];
  for (const r of results) {
    switch (r.status) {
      case 'pass':
        lines.push(`${c.green('✔')} ${r.rule.name}  ${c.dim(allRows ? 'whole tables' : scopeText(r.scope))}`);
        break;
      case 'skipped':
        lines.push(`${c.dim('⊘')} ${r.rule.name}  ${c.dim(`nothing to check: the session touched no ${Object.keys(r.scope).map((t) => t.replace(/^public\./, '')).join(' or ')} rows`)}`);
        break;
      case 'fail': {
        lines.push(`${c.red('✖')} ${c.bold(r.rule.name)}  ${c.red(plural(r.violationCount, 'violation'))} ${c.dim(`· ${allRows ? 'whole tables' : scopeText(r.scope)}`)}`);
        for (const v of r.violations) lines.push(`    ${row(v)}`);
        const more = r.violationCount - r.violations.length;
        if (more > 0) lines.push(c.dim(`    …and ${more} more`));
        break;
      }
      case 'error':
        lines.push(`${c.yellow('!')} ${c.bold(r.rule.name)}  ${c.yellow(`could not run (line ${r.rule.line}): ${r.error}`)}`);
        break;
    }
  }

  const t = tally(results);
  const parts = [`${t.pass} passed`, `${t.fail} failed`];
  if (t.skipped) parts.push(`${t.skipped} skipped`);
  if (t.error) parts.push(`${t.error} could not run`);
  lines.push('', (t.fail || t.error ? c.red : c.green)(parts.join(' · ')));
  return lines.join('\n');
}
