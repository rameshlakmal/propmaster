// Terminal output for the Finder: recipe lists, found rows, claims and recipe checks.
import { boxTable, brand, cell, divider, hint, icons, makeStyle, type Cell, type Colors, type Column } from '../core/ui.js';
import { formatDateTime, formatDuration, plural } from '../recorder/format.js';
import type { ClaimRow } from './claims.js';
import type { FindResult, RecipeCheck } from './find.js';
import type { Recipe } from './recipes.js';

export interface ReportOptions {
  colors?: Colors;
  width?: number;
}

/** Values as Postgres returned them: numerics and dates stay as written. */
export function show(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const matchCount = (n: number, more = false) => more ? `${n}+ matches` : `${n} ${n === 1 ? 'match' : 'matches'}`;
const short = (table: string) => table.replace(/^public\./, '');

/** "until 14:32", or "until 2026-10-09 09:00" when it's not today. */
export function until(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = formatDateTime(d);
  return d.toDateString() === now.toDateString() ? time.slice(11, 16) : time.slice(0, 16);
}

/** "1h 59m left", or "expired". */
export function timeLeft(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return d <= now ? 'expired' : `${formatDuration(now, d)} left`;
}

export function formatRecipeList(recipes: Recipe[], source: string, { colors, width }: ReportOptions = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const columns: Column[] = [{ header: 'Recipe', flex: true }, { header: 'Parameters', max: 34 }, { header: 'Claims', max: 18 }];
  const rows: Cell[][] = recipes.map((r) => {
    const name: Cell = [[{ text: r.name, style: (t) => c.bold(t) }], [{ text: r.id, style: c.cyan }]];
    if (r.tags.length) name.push(r.tags.map((t) => ({ text: `#${t}`, style: c.dim })));
    if (r.description) name.push(cell(r.description, c.dim)[0]!);
    const params: Cell = r.params.length
      ? r.params.map((p) => [{ text: p.default === undefined ? `${p.name} (required)` : `${p.name} = ${p.default}`, style: p.default === undefined ? c.yellow : undefined }])
      : cell('–', c.dim);
    return [name, params, r.claim ? cell(short(r.claim.table)) : cell('–', c.dim)];
  });
  return [
    ` ${brand(c)}  ${c.bold(plural(recipes.length, 'recipe'))} ${c.dim(`in ${source}`)}`, '',
    ...boxTable(s, columns, rows),
    hint(c, 'find data:  propmaster find "<recipe or words>" [-p name=value] [--claim]'),
  ].join('\n');
}

export function formatFindResult(result: FindResult, claimed: ClaimRow[] = [], { colors, width, me, requested }: ReportOptions & { me?: string; requested?: number } = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const i = icons(c);
  const params = Object.entries(result.params).map(([k, v]) => `${k}=${v}`).join(' ');
  const counts = [matchCount(result.matches, result.moreMatches)];
  if (result.claimed) counts.push(`${result.claimed} claimed`);
  counts.push(`${result.ms} ms`);
  const lines = [` ${brand(c)}  ${c.bold(result.recipe.name)}${params ? `  ${c.dim(params)}` : ''}`, ` ${c.dim(counts.join(' · '))}`, ''];

  if (result.rows.length === 0) {
    lines.push(` ${i.idle} No rows match.`, hint(c, 'try other parameter values, or create the data you need'));
    return lines.join('\n');
  }

  const mine = new Set(claimed.map((cl) => cl.key));
  const withStatus = result.claim !== null;
  const columns: Column[] = [...result.columns.map((h) => ({ header: h, max: 40 })), ...(withStatus ? [{ header: 'Claim', max: 28 }] : [])];
  const rows: Cell[][] = result.rows.map((r) => {
    const values = result.columns.map((h) => cell(show(r.values[h]), r.claimedBy ? c.dim : undefined));
    if (!withStatus) return values;
    const status = r.key !== null && mine.has(r.key) ? cell('✔ yours', c.green)
      : me && r.claimedBy?.claimedBy === me ? cell(`you until ${until(r.claimedBy!.expiresAt)}`, c.green)
      : r.claimedBy ? cell(`${r.claimedBy.claimedBy} until ${until(r.claimedBy.expiresAt)}`, c.yellow)
      : cell('free', c.dim);
    return [...values, status];
  });
  lines.push(...boxTable(s, columns, rows));
  const more = result.matches - result.rows.length;
  if (more > 0 || result.moreMatches) lines.push(`   ${c.dim(`…and ${result.moreMatches ? 'many' : more} more (show more with --limit)`)}`);

  if (claimed.length) {
    lines.push('');
    for (const cl of claimed) {
      lines.push(` ${i.ok} Claimed ${c.bold(`${short(cl.table)} ${cl.key}`)} ${c.dim(`· claim #${cl.id} · until ${until(cl.expiresAt)}`)}`);
    }
    if (requested && claimed.length < requested) {
      lines.push(` ${i.warn} ${c.yellow(`Only ${claimed.length} of the ${requested} rows you asked for were free.`)}`);
    }
    lines.push(hint(c, `when you are done: propmaster claims release ${claimed.map((cl) => cl.id).join(' ')}`));
  } else if (withStatus && result.rows.some((r) => !r.claimedBy)) {
    lines.push(hint(c, 'to keep one for your test, run again with --claim'));
  }
  return lines.join('\n');
}

export function formatClaims(claims: ClaimRow[], me: string, { colors, width }: ReportOptions = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const i = icons(c);
  if (claims.length === 0) return ` ${i.idle} No claims right now.\n${hint(c, 'claim a row with: propmaster find "<recipe>" --claim')}`;
  const rows: Cell[][] = claims.map((cl) => [
    cell(`#${cl.id}`, (t) => c.bold(t)),
    cell(`${short(cl.table)} ${cl.key}`),
    cell(cl.claimedBy === me ? `${cl.claimedBy} (you)` : cl.claimedBy, cl.claimedBy === me ? c.green : undefined),
    cell(cl.expired ? 'expired' : `${until(cl.expiresAt)} · ${timeLeft(cl.expiresAt)}`, cl.expired ? c.dim : undefined),
    cell([cl.recipe, cl.note].filter(Boolean).join(' · ') || '–', c.dim),
  ]);
  return [
    ...boxTable(s, [{ header: 'Claim' }, { header: 'Row' }, { header: 'By', max: 20 }, { header: 'Until', max: 30 }, { header: 'Recipe / note', flex: true }], rows),
    hint(c, 'release: propmaster claims release <claim> · all of yours: propmaster claims release --mine'),
  ].join('\n');
}

export function formatChecks(results: RecipeCheck[], { colors, width, strict = false }: ReportOptions & { strict?: boolean } = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const i = icons(c);
  const rows: Cell[][] = results.map((r) => {
    const how = r.how === 'explain' ? 'planned only (needs a parameter)' : r.matches === null ? '' : matchCount(r.matches);
    switch (r.status) {
      case 'ok':
        return [cell('✔', c.green), cell(r.recipe.name), cell(how, c.dim), cell(`${r.ms} ms`, c.dim)];
      case 'empty':
        return [cell(strict ? '✖' : '!', strict ? c.red : c.yellow), cell(r.recipe.name), cell('no matches', strict ? c.red : c.yellow), cell(`${r.ms} ms`, c.dim)];
      case 'error':
        return [cell('✖', c.red), cell(r.recipe.name, (t) => c.bold(t)), cell('broken', c.red), cell(`${r.ms} ms`, c.dim)];
    }
  });
  const lines = boxTable(s, [{ header: ' ' }, { header: 'Recipe', flex: true }, { header: 'Result', max: 34 }, { header: 'Time' }], rows);
  for (const r of results.filter((x) => x.status === 'error')) {
    lines.push('', ` ${i.fail} ${c.bold(r.recipe.name)} ${c.dim(`(${r.recipe.file}, line ${r.recipe.line})`)}`, `   ${c.red(r.error ?? '')}`);
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const empty = results.filter((r) => r.status === 'empty').length;
  const broken = results.filter((r) => r.status === 'error').length;
  const parts = [c.green(`${ok} working`)];
  if (empty) parts.push((strict ? c.red : c.yellow)(`${empty} found nothing`));
  parts.push(broken ? c.red(`${broken} broken`) : '0 broken');
  lines.push('', divider(s), ` ${parts.join(' · ')}`);
  return lines.join('\n');
}
