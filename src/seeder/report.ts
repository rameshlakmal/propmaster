// Terminal output for the Seeder & Cleaner: scenario lists, seeded rows, runs, and clean previews.
import { boxTable, brand, cell, divider, hint, icons, makeStyle, type Cell, type Colors, type Column } from '../core/ui.js';
import { formatDateTime, formatValue, plural } from '../recorder/format.js';
import type { Row } from '../recorder/types.js';
import { describeDiffs, type Action, type CleanResult } from './clean.js';
import type { Run } from './runs.js';
import type { Scenario } from './scenarios.js';
import type { ScenarioCheck, SeedResult } from './seed.js';
import { shortName } from './schema.js';

export interface ReportOptions {
  colors?: Colors;
  width?: number;
}

const keyText = (key: Row | null) => (key ? Object.entries(key).map(([k, v]) => `${k}=${formatValue(v).replace(/^'(.*)'$/, '$1')}`).join(' ') : '–');
const pairs = (row: Row, skip: Set<string>) => Object.entries(row).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k}=${formatValue(v, 40)}`).join(' ');
const when = (iso: string) => formatDateTime(new Date(iso)).slice(0, 16);

export function formatScenarioList(scenarios: Scenario[], source: string, { colors, width }: ReportOptions = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const rows: Cell[][] = scenarios.map((sc) => {
    const name: Cell = [[{ text: sc.name, style: (t) => c.bold(t) }], [{ text: sc.id, style: c.cyan }]];
    if (sc.tags.length) name.push(sc.tags.map((t) => ({ text: `#${t}`, style: c.dim })));
    if (sc.description) name.push(cell(sc.description, c.dim)[0]!);
    const params: Cell = sc.params.length
      ? sc.params.map((p) => [{ text: p.default === undefined ? `${p.name} (required)` : `${p.name} = ${p.default}`, style: p.default === undefined ? c.yellow : undefined }])
      : cell('–', c.dim);
    const tables = [...new Set(sc.seed.map((r) => r.table))];
    return [name, params, cell(tables.join(', '))];
  });
  return [
    ` ${brand(c)}  ${c.bold(plural(scenarios.length, 'scenario'))} ${c.dim(`in ${source}`)}`, '',
    ...boxTable(s, [{ header: 'Scenario', flex: true }, { header: 'Parameters', max: 30 }, { header: 'Starts with', max: 24 }], rows),
    hint(c, 'seed one:  propmaster seed "<scenario>" [-p name=value] [--dry-run]'),
  ].join('\n');
}

export function formatSeedResult(r: SeedResult, { colors, width }: ReportOptions = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const i = icons(c);
  const params = Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ');
  const counts = new Map<string, number>();
  for (const row of r.rows) counts.set(row.table, (counts.get(row.table) ?? 0) + 1);
  const summary = [...counts].map(([t, n]) => `${shortName(t)}: ${n}`).join(', ');

  const lines = [` ${brand(c)}  ${c.bold(r.scenario.name)}${params ? `  ${c.dim(params)}` : ''}`];
  lines.push(r.dryRun
    ? ` ${c.yellow('dry run')} ${c.dim(`· ${plural(r.rows.length, 'row')} · ${r.ms} ms · rolled back, nothing was saved`)}`
    : ` ${c.dim(`run #${r.runId} · ${plural(r.rows.length, 'row')} · ${r.ms} ms`)}`, '');

  const rows: Cell[][] = r.rows.map((row) => {
    const keys = new Set(Object.keys(row.key));
    const tag = row.alias ? ` $as ${row.alias}` : row.auto ? ' (made for a required link)' : '';
    return [
      cell(String(row.seq), c.dim),
      [[{ text: shortName(row.table) }], ...(tag ? [[{ text: tag.trim(), style: c.dim }]] : [])],
      cell(keyText(row.key), (t) => c.bold(t)),
      cell(pairs(row.values, keys), c.dim),
    ];
  });
  lines.push(...boxTable(s, [{ header: '#' }, { header: 'Table', max: 26 }, { header: 'Key', max: 24 }, { header: 'Values', flex: true }], rows));
  lines.push('');
  if (r.dryRun) {
    lines.push(` ${i.ok} Would create ${summary}`, hint(c, `to create it: propmaster seed ${r.scenario.id}${params ? ` ${Object.entries(r.params).map(([k, v]) => `-p ${k}=${v}`).join(' ')}` : ''}`));
  } else {
    lines.push(` ${i.ok} Created ${summary} ${c.dim(`· run #${r.runId}`)}`,
      hint(c, `when you are done: propmaster clean --run ${r.runId}   (a preview; add --apply to delete)`));
  }
  return lines.join('\n');
}

export function formatRuns(list: Run[], me: string, { colors, width, all }: ReportOptions & { all?: boolean } = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const i = icons(c);
  if (list.length === 0) {
    return ` ${i.idle} ${all ? 'Nothing has been seeded yet.' : 'No runs with data left to clean.'}\n${hint(c, all ? 'seed a scenario: propmaster seed "<scenario>"' : 'all runs, cleaned ones too: propmaster runs --all')}`;
  }
  const rows: Cell[][] = list.map((r) => [
    cell(`#${r.id}`, (t) => c.bold(t)),
    [[{ text: r.scenario }], ...(r.note ? [[{ text: r.note, style: c.dim }]] : [])],
    cell(r.createdBy === me ? `${r.createdBy} (you)` : r.createdBy, r.createdBy === me ? c.green : undefined),
    cell(when(r.createdAt)),
    // One table per line, so a long list never squeezes the scenario name.
    Object.keys(r.tables).length ? Object.entries(r.tables).map(([t, n]) => [{ text: `${shortName(t)}: ${n}`, style: c.dim }]) : cell('–', c.dim),
    r.cleanedAt ? cell(`cleaned ${when(r.cleanedAt)}`, c.dim) : cell('has data', c.yellow),
  ]);
  return [
    ...boxTable(s, [{ header: 'Run' }, { header: 'Scenario', flex: true }, { header: 'By', max: 18 }, { header: 'Created' }, { header: 'Rows', max: 24 }, { header: 'Status', max: 22 }], rows),
    hint(c, 'preview a cleanup: propmaster clean --run <run> · yours: propmaster clean --mine'),
  ].join('\n');
}

const VERB: Record<Action['op'], string> = { delete: 'delete', update: 'put back', insert: 're-insert' };

function note(a: Action): string {
  if (a.why === 'dependent') return `not created by it: points at a row being deleted (${a.via})`;
  if (a.op === 'delete' && a.why === 'seeded') return a.changed.length ? `changed since seeding: ${describeDiffs(a.changed)}` : '';
  if (a.op === 'delete') return 'inserted during the session';
  if (a.op === 'update') return describeDiffs(Object.keys(a.set).map((k) => ({ column: k, from: a.current[k], to: a.set[k] })));
  return 'deleted during the session';
}

export function formatCleanResult(result: CleanResult, { colors, width, command }: ReportOptions & { command?: string } = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const i = icons(c);
  const { plan, applied } = result;
  const lines = [` ${brand(c)}  ${c.bold(plan.title)}`,
    ` ${applied ? c.green('cleaned') : c.yellow('preview')} ${c.dim(applied ? '· done in one transaction' : '· nothing has been changed')}`, ''];

  const claimed = new Map(plan.claimed.map((x) => [`${x.table}|${keyText(x.key)}`, x.claim]));
  if (plan.actions.length) {
    const rows: Cell[][] = plan.actions.map((a) => {
      const claim = claimed.get(`${a.table}|${keyText(a.key)}`);
      const text = [note(a), claim ? `claimed by ${claim.claimedBy} (#${claim.id})` : ''].filter(Boolean).join(' · ');
      const style = a.why === 'dependent' || claim ? c.yellow : c.dim;
      return [
        cell(VERB[a.op], a.op === 'delete' ? c.red : c.cyan),
        cell(shortName(a.table)),
        cell(keyText(a.key), (t) => c.bold(t)),
        text ? cell(text, style) : cell('–', c.dim),
      ];
    });
    lines.push(...boxTable(s, [{ header: 'Action' }, { header: 'Table', max: 24 }, { header: 'Row', max: 24 }, { header: 'Note', flex: true }], rows));
  } else {
    lines.push(` ${i.idle} Nothing to change.`);
  }

  if (plan.skipped.length) {
    lines.push('', ` ${c.bold('Left alone')}`);
    for (const sk of plan.skipped) {
      const icon = sk.reason === 'gone' ? i.idle : i.warn;
      lines.push(`   ${icon} ${shortName(sk.table)} ${sk.key ? keyText(sk.key) : ''} ${c.dim(`· ${sk.detail}`)}`.replace(/ {2,}·/, ' ·'));
    }
  }

  const dependents = plan.actions.filter((a) => a.why === 'dependent').length;
  const counts = (['delete', 'update', 'insert'] as const).map((op) => {
    const n = plan.actions.filter((a) => a.op === op).length;
    return n ? `${n} to ${VERB[op]}` : '';
  }).filter(Boolean);
  lines.push('', divider(s), ` ${counts.join(' · ') || 'nothing to change'}${plan.skipped.length ? ` · ${plan.skipped.length} left alone` : ''}`);

  if (applied) {
    if (result.releasedClaims) lines.push(` ${i.ok} Released ${plural(result.releasedClaims, 'claim')} on deleted rows`);
    if (result.backup) lines.push(` ${i.ok} Backup: ${c.bold(result.backup)}`, hint(c, `to undo this clean: propmaster restore "${result.backup}" --apply`));
    return lines.join('\n');
  }
  for (const u of plan.unkeyedDependents) {
    lines.push(` ${i.fail} ${c.red(`${plural(u.count, 'row')} of ${shortName(u.table)} point at rows being deleted (${u.via}), but that table has no primary key: delete or re-point them yourself first.`)}`);
  }
  if (dependents) lines.push(` ${i.warn} ${c.yellow(`${plural(dependents, 'row')} that ${dependents === 1 ? 'was' : 'were'} not created by it point at rows being deleted.`)} ${c.dim('Deleting them needs --include-dependents.')}`);
  if (plan.claimed.length) lines.push(` ${i.warn} ${c.yellow(`${plural(plan.claimed.length, 'row')} ${plan.claimed.length === 1 ? 'is' : 'are'} claimed by someone else.`)} ${c.dim('Cleaning them needs --force.')}`);
  if (plan.actions.length && command) {
    const flags = [dependents ? ' --include-dependents' : '', plan.claimed.length ? ' --force' : ''].join('');
    lines.push(hint(c, `to do it: ${command} --apply${flags}`));
  }
  return lines.join('\n');
}

export function formatBackups(files: { file: string; title: string; createdAt: string; changes: number }[], dir: string, { colors, width }: ReportOptions = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const i = icons(c);
  if (files.length === 0) return ` ${i.idle} No backups in ${dir} yet. ${c.dim('A clean with --apply writes one.')}`;
  const rows: Cell[][] = files.map((f) => [cell(when(f.createdAt)), cell(f.title), cell(String(f.changes), c.dim), cell(f.file, c.dim)]);
  return [
    ` ${brand(c)}  ${c.bold('Backups')} ${c.dim(`in ${dir}`)}`, '',
    ...boxTable(s, [{ header: 'Made' }, { header: 'Of', max: 40 }, { header: 'Rows' } as Column, { header: 'File', flex: true }], rows),
    hint(c, 'preview a restore: propmaster restore "<file>"'),
  ].join('\n');
}

export function formatScenarioChecks(results: ScenarioCheck[], { colors, width }: ReportOptions = {}): string {
  const s = makeStyle({ colors, width });
  const { c } = s;
  const i = icons(c);
  const rows: Cell[][] = results.map((r) => r.status === 'ok'
    ? [cell('✔', c.green), cell(r.scenario.name), cell(plural(r.rows, 'row'), c.dim), cell(`${r.ms} ms`, c.dim)]
    : r.status === 'skipped'
      ? [cell('⊘', c.dim), cell(r.scenario.name), cell(r.error ?? 'skipped', c.dim), cell('–', c.dim)]
      : [cell('✖', c.red), cell(r.scenario.name, (t) => c.bold(t)), cell('broken', c.red), cell(`${r.ms} ms`, c.dim)]);
  const lines = boxTable(s, [{ header: ' ' }, { header: 'Scenario', flex: true }, { header: 'Result', max: 34 }, { header: 'Time' }], rows);
  for (const r of results.filter((x) => x.status === 'error')) {
    lines.push('', ` ${i.fail} ${c.bold(r.scenario.name)} ${c.dim(`(${r.scenario.file})`)}`, `   ${c.red(r.error ?? '')}`);
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const broken = results.filter((r) => r.status === 'error').length;
  lines.push('', divider(s), ` ${[c.green(`${ok} working`), skipped ? c.dim(`${skipped} need a parameter`) : '', broken ? c.red(`${broken} broken`) : '0 broken'].filter(Boolean).join(' · ')}`,
    ` ${c.dim('Each scenario was seeded and rolled back: nothing was saved.')}`);
  return lines.join('\n');
}
