#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { describeDatabase, resolveDatabaseUrl, withDb, type Db } from './core/db.js';
import { explainError, UserError } from './core/errors.js';
import { diagnose } from './recorder/doctor.js';
import { toHtml } from './recorder/export/html.js';
import { toMarkdown } from './recorder/export/markdown.js';
import { toSql } from './recorder/export/sql.js';
import { filterRecording, hasFilters, parseOps, parseTime, type Filters } from './recorder/filter.js';
import { createMasker, maskRecording } from './recorder/mask.js';
import { checkRules, parseRules } from './recorder/rules.js';
import { formatRuleResults, tally } from './recorder/rules-report.js';
import * as snapshot from './recorder/snapshot.js';
import { formatTimeline } from './recorder/timeline.js';
import * as trigger from './recorder/trigger.js';
import type { Recording, SessionSummary } from './recorder/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const program = new Command()
  .name('propmaster')
  .description('Test-data toolkit for QA engineers')
  .version(version)
  .option('--url <url>', 'Postgres connection string (default: $PROPMASTER_DATABASE_URL)')
  .showHelpAfterError();

interface Context {
  db: Db;
  /** host:port/database, for matching local snapshot sessions to this database. */
  identity: string;
}

/** Wraps a command action so it gets a guarded DB connection after its own arguments. */
function run<A extends unknown[]>(fn: (ctx: Context, ...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return (...args) => {
    const url = resolveDatabaseUrl(program.opts().url);
    return withDb(url, (db) => fn({ db, identity: describeDatabase(url) }, ...args));
  };
}

async function confirm(word: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type ${pc.bold(word)} to confirm: `);
  rl.close();
  return answer.trim() === word;
}

const list = (value: string, previous: string[] = []) => [...previous, ...value.split(',').map((v) => v.trim()).filter(Boolean)];

// ---------- shared options ----------

interface FilterOpts {
  table?: string[];
  exceptTable?: string[];
  user?: string[];
  app?: string[];
  op?: string[];
  since?: string;
  until?: string;
  step?: string[];
}

function addFilterOptions(cmd: Command): Command {
  return cmd
    .option('--table <names>', 'only these tables; patterns like "order_*" or "billing.*" (comma-separated, repeatable)', list)
    .option('--except-table <names>', 'leave out these tables', list)
    .option('--user <names>', 'only changes made by these DB users', list)
    .option('--app <names>', 'only changes from these application_name values', list)
    .option('--op <ops>', 'only these operations: insert, update, delete, truncate', list)
    .option('--since <time>', 'only changes at or after a time: 15m, 2h, 10:30, or an ISO date')
    .option('--until <time>', 'only changes at or before a time')
    .option('--step <numbers>', 'only these step numbers', list);
}

function toFilters(o: FilterOpts): Filters {
  return {
    tables: o.table,
    exceptTables: o.exceptTable,
    users: o.user,
    apps: o.app,
    ops: o.op ? parseOps(o.op) : undefined,
    since: o.since ? parseTime(o.since) : undefined,
    until: o.until ? parseTime(o.until) : undefined,
    steps: o.step?.map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new UserError(`"${s}" is not a step number.`);
      return n;
    }),
  };
}

// ---------- mode routing ----------

/** The snapshot session recording this database, if any. Otherwise commands go to trigger mode. */
async function activeSnapshotFor(identity: string) {
  const active = await snapshot.activeSnapshot();
  return active && active.identity === identity ? active : null;
}

async function loadRecording(ctx: Context, id?: string): Promise<Recording> {
  let rec: Recording | null;
  if (id !== undefined) {
    const clean = id.replace(/^#/, '');
    if (/^s\d+$/.test(clean)) rec = await snapshot.getSnapshotRecording(clean);
    else if (/^\d+$/.test(clean)) rec = await trigger.getRecording(ctx.db, clean);
    else throw new UserError(`"${id}" is not a session id.`, 'Session ids look like 12 (trigger mode) or s3 (snapshot mode). See `propmaster record list`.');
    if (!rec) throw new UserError(`There is no session ${id}.`, 'See `propmaster record list`.');
    return rec;
  }

  const latest = (await allSessions(ctx))[0];
  if (!latest) throw new UserError('No sessions recorded yet.', 'Start one with `propmaster record start "My test"`.');
  return loadRecording(ctx, latest.id);
}

async function allSessions(ctx: Context): Promise<SessionSummary[]> {
  const fromDb = (await trigger.isInstalled(ctx.db)) ? await trigger.listSessions(ctx.db) : [];
  const local = await snapshot.listSnapshots(ctx.identity);
  return [...fromDb, ...local].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

function printTimeline(rec: Recording, o: FilterOpts & { mask?: boolean; maskColumns?: string[] }): void {
  const { rec: shown, hidden } = filterRecording(rec, toFilters(o));
  const view = o.mask ? maskRecording(shown, createMasker({ columns: o.maskColumns })) : shown;
  console.log(formatTimeline(view, { hidden }));
}

// ---------- install ----------

program
  .command('install')
  .description('Install the recorder (the _propmaster schema and its triggers), or upgrade it')
  .action(run(async ({ db }) => {
    const attached = await trigger.install(db);
    const s = await trigger.status(db);
    console.log(`${pc.green('✔')} Recorder installed. Watching ${s.watchedTables} tables (${attached} new).`);
    if (s.excludedTables.length) console.log(pc.dim(`  Excluded: ${s.excludedTables.join(', ')}`));
  }));

program
  .command('uninstall')
  .description('Remove the recorder, its triggers and all recordings stored in the database')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(run(async ({ db }, opts: { yes?: boolean }) => {
    if (!(await trigger.isInstalled(db))) {
      console.log('The recorder is not installed. Nothing to remove.');
      return;
    }
    if (!opts.yes && !(await confirm('uninstall'))) {
      console.log('Cancelled. Nothing was removed. (Use --yes in scripts.)');
      return;
    }
    await trigger.uninstall(db);
    console.log(`${pc.green('✔')} Recorder removed. The _propmaster schema and all its triggers are gone.`);
  }));

program
  .command('doctor')
  .description('Check what your DB user can do, and which mode to use')
  .action(run(async ({ db }) => {
    const report = await diagnose(db);
    const icon = { ok: pc.green('✔'), warn: pc.yellow('!'), fail: pc.red('✖') };
    for (const f of report.findings) console.log(`${icon[f.level]} ${f.text}`);
    console.log('');
    if (report.recommended === 'trigger') console.log(`Use ${pc.bold('trigger mode')}: \`propmaster install\`, then \`propmaster record start\`.`);
    else if (report.recommended === 'snapshot') console.log(`Use ${pc.bold('snapshot mode')}: \`propmaster record start --snapshot\`.`);
    else console.log(pc.red('Neither mode can run with this DB user.'));
    if (report.grants.length) {
      console.log(`\nFor trigger mode, ask a DBA for:\n${report.grants.map((g) => `  ${g}`).join('\n')}`);
    }
  }));

// ---------- record ----------

const record = program.command('record').description('Record database changes per test step');

record
  .command('start')
  .argument('[name]', 'session name', 'Test session')
  .description('Start recording')
  .option('--snapshot', 'compare snapshots instead of using triggers (needs only read access)')
  .option('--exclude <tables>', 'snapshot mode: tables to leave out (comma-separated, patterns allowed)', list)
  .addOption(new Option('--max-rows <n>', 'snapshot mode: skip tables with more rows than this').default(snapshot.DEFAULT_MAX_ROWS).argParser(Number))
  .action(run(async (ctx, name: string, opts: { snapshot?: boolean; exclude?: string[]; maxRows: number }) => {
    const hint = pc.dim('  Mark steps with `propmaster record step "<name>"`, then `propmaster record stop`.');
    const active = await activeSnapshotFor(ctx.identity);
    if (active) throw new UserError(`Snapshot session ${active.id} is already recording.`, 'Stop it first: `propmaster record stop`.');

    if (opts.snapshot) {
      const s = await snapshot.startSnapshot(ctx.db, ctx.identity, name, { exclude: opts.exclude, maxRows: opts.maxRows });
      console.log(`${pc.red('●')} Recording session #${s.id} "${name}" in snapshot mode (${s.tables} tables read)`);
      if (s.skipped.length) console.log(pc.yellow(`  Not watched (over ${opts.maxRows} rows): ${s.skipped.join(', ')}`));
      console.log(hint);
      return;
    }

    if (opts.exclude) throw new UserError('--exclude is for snapshot mode.', 'In trigger mode use `propmaster record exclude <table>`.');
    const id = await trigger.start(ctx.db, name);
    const { watchedTables } = await trigger.status(ctx.db);
    console.log(`${pc.red('●')} Recording session #${id} "${name}" (${watchedTables} tables watched)`);
    console.log(hint);
  }));

record
  .command('step')
  .argument('<name>', 'what the tester is about to do, e.g. "Click Place Order"')
  .description('Start a new test step')
  .action(run(async (ctx, name: string) => {
    const seq = (await activeSnapshotFor(ctx.identity))
      ? await snapshot.stepSnapshot(ctx.db, ctx.identity, name)
      : await trigger.step(ctx.db, name);
    console.log(`${pc.cyan(`Step ${seq}`)} · ${name}`);
  }));

addFilterOptions(record
  .command('stop')
  .description('Stop recording and show the timeline')
  .option('--mask', 'hide sensitive values in the timeline'))
  .action(run(async (ctx, opts: FilterOpts & { mask?: boolean }) => {
    const rec = (await activeSnapshotFor(ctx.identity))
      ? await snapshot.stopSnapshot(ctx.db, ctx.identity)
      : await trigger.getRecording(ctx.db, await trigger.stop(ctx.db));
    console.log(`${pc.green('■')} Stopped.\n`);
    printTimeline(rec!, opts);
  }));

record
  .command('status')
  .description('Show whether a recording is running')
  .action(run(async (ctx) => {
    const snap = await activeSnapshotFor(ctx.identity);
    if (snap) {
      console.log(`${pc.red('●')} Recording session #${snap.id} "${snap.name}" in snapshot mode, step ${snap.stepSeq} · ${snap.stepName}`);
      return;
    }
    const s = await trigger.status(ctx.db);
    if (!s.installed) console.log('Not recording. The recorder is not installed (`propmaster install`, or `record start --snapshot`).');
    else if (!s.active) console.log(`Not recording. ${s.watchedTables} tables are watched.`);
    else console.log(`${pc.red('●')} Recording session #${s.active.id} "${s.active.name}", step ${s.active.stepSeq} · ${s.active.stepName}`);
    if (s.excludedTables.length) console.log(pc.dim(`  Excluded: ${s.excludedTables.join(', ')}`));
  }));

addFilterOptions(record
  .command('show')
  .argument('[session]', 'session id, e.g. 12 or s3 (default: the latest)')
  .description('Show the timeline of a session')
  .option('--mask', 'hide sensitive values')
  .option('--mask-columns <names>', 'extra columns to hide with --mask', list))
  .action(run(async (ctx, session: string | undefined, opts: FilterOpts & { mask?: boolean; maskColumns?: string[] }) => {
    printTimeline(await loadRecording(ctx, session), opts);
  }));

record
  .command('list')
  .description('List recent sessions')
  .action(run(async (ctx) => {
    const sessions = await allSessions(ctx);
    if (sessions.length === 0) console.log('No sessions recorded yet.');
    for (const s of sessions) {
      const state = s.stoppedAt ? '' : pc.red(' ● recording');
      const mode = s.mode === 'snapshot' ? pc.dim(' snapshot') : '';
      console.log(`${`#${s.id}`.padEnd(6)} ${s.startedAt.toLocaleString('en-GB')}  ${s.name}  ${pc.dim(`(${s.changeCount} changes)`)}${mode}${state}`);
    }
  }));

const EXTENSIONS = { html: 'html', md: 'md', sql: 'sql' } as const;
type Format = keyof typeof EXTENSIONS;

interface ExportOpts extends FilterOpts {
  format: Format;
  output?: string;
  mask: boolean;
  maskColumns?: string[];
  open?: boolean;
  strict?: boolean;
  ignoreColumns?: string[];
  includeTimestamps?: boolean;
}

addFilterOptions(record
  .command('export')
  .argument('[session]', 'session id, e.g. 12 or s3 (default: the latest)')
  .description('Export a session as an HTML report, Markdown, or SQL checks')
  .addOption(new Option('-f, --format <format>', 'output format').choices(Object.keys(EXTENSIONS)).default('html'))
  .option('-o, --output <file>', 'where to write it; "-" for standard output (default: propmaster-session-<id>.<ext>)')
  .option('--no-mask', 'do not hide sensitive values (they are hidden by default)')
  .option('--mask-columns <names>', 'extra columns to hide', list)
  .option('--open', 'open the file when done (HTML)')
  .option('--strict', 'SQL: a DO block that raises an error when a check fails, for CI')
  .option('--ignore-columns <names>', 'SQL: leave these columns out of the checks, e.g. generated ids', list)
  .option('--include-timestamps', 'SQL: also check timestamp, date and time columns'))
  .action(run(async (ctx, session: string | undefined, opts: ExportOpts) => {
    const { rec, hidden } = filterRecording(await loadRecording(ctx, session), toFilters(opts));
    const masker = createMasker({ columns: opts.maskColumns });
    const masked = opts.mask;
    const shown = masked ? maskRecording(rec, masker) : rec;

    const content = opts.format === 'html' ? toHtml(shown, { masked, hidden })
      : opts.format === 'md' ? toMarkdown(shown, { masked, hidden })
      : toSql(rec, {
        masker: masked ? masker : undefined,
        strict: opts.strict,
        ignoreColumns: opts.ignoreColumns,
        includeTimestamps: opts.includeTimestamps,
      });

    if (opts.output === '-') {
      process.stdout.write(content);
      return;
    }
    const file = resolve(opts.output ?? `propmaster-session-${rec.id}.${EXTENSIONS[opts.format]}`);
    await writeFile(file, content, 'utf8');
    console.log(`${pc.green('✔')} Wrote ${file}${masked ? '' : pc.yellow(' (not masked)')}`);
    if (opts.open) openFile(file);
  }));

function openFile(file: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : process.platform === 'darwin' ? ['open', [file]]
    : ['xdg-open', [file]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

record
  .command('check')
  .argument('<rules>', 'a .sql file of rules, each starting with "-- rule: <name>"')
  .argument('[session]', 'session id, e.g. 12 or s3 (default: the latest)')
  .description('Check business rules against the rows a session touched (exit code 1 if any rule fails)')
  .option('--all-rows', "let {{table}} mean the whole table, not just the session's rows")
  .addOption(new Option('--limit <n>', 'violating rows to show per rule').default(5).argParser(Number))
  .option('--timeout <interval>', 'time limit per rule', '30s')
  .action(run(async (ctx, file: string, session: string | undefined, opts: { allRows?: boolean; limit: number; timeout: string }) => {
    if (!existsSync(file)) throw new UserError(`Can't find the rules file ${file}.`);
    const rules = parseRules(await readFile(file, 'utf8'), file);
    const rec = opts.allRows && session === undefined ? null : await loadRecording(ctx, session);
    const target = rec ? `session #${rec.id} "${rec.name}"` : 'whole tables';
    console.log(`Checking ${rules.length} rule${rules.length === 1 ? '' : 's'} from ${file} against ${target}\n`);

    const results = await checkRules(ctx.db, rec, rules, { allRows: opts.allRows, limit: opts.limit, timeout: opts.timeout });
    console.log(formatRuleResults(results, { allRows: opts.allRows }));
    const t = tally(results);
    if (t.fail || t.error) process.exitCode = 1;
  }));

record
  .command('delete')
  .argument('<session>', 'session id, e.g. 12 or s3')
  .description('Delete a stopped session and its changes')
  .action(run(async (ctx, session: string) => {
    const id = session.replace(/^#/, '');
    if (/^s\d+$/.test(id)) await snapshot.deleteSnapshot(id);
    else await trigger.deleteSession(ctx.db, id);
    console.log(`${pc.green('✔')} Deleted session #${id}.`);
  }));

record
  .command('prune')
  .description('Delete stopped trigger-mode sessions older than a given age')
  .requiredOption('--older-than <interval>', 'a Postgres interval, e.g. "7 days" or "12 hours"')
  .action(run(async ({ db }, opts: { olderThan: string }) => {
    const n = await trigger.prune(db, opts.olderThan);
    console.log(`${pc.green('✔')} Deleted ${n} session${n === 1 ? '' : 's'} older than ${opts.olderThan}.`);
  }));

record
  .command('exclude')
  .argument('<tables...>', 'tables to stop watching, e.g. sessions audit_log')
  .description('Stop watching busy or irrelevant tables (trigger mode)')
  .action(run(async ({ db }, tables: string[]) => {
    for (const t of tables) await trigger.excludeTable(db, t);
    console.log(`${pc.green('✔')} No longer watching: ${tables.join(', ')}`);
  }));

record
  .command('include')
  .argument('<tables...>', 'excluded tables to watch again')
  .description('Watch previously excluded tables again (trigger mode)')
  .action(run(async ({ db }, tables: string[]) => {
    for (const t of tables) await trigger.includeTable(db, t);
    console.log(`${pc.green('✔')} Watching again: ${tables.join(', ')}`);
  }));

program.parseAsync().catch((err: unknown) => {
  const e = explainError(err);
  if (e instanceof UserError) {
    console.error(pc.red(`✖ ${e.message}`));
    if (e.hint) console.error(pc.dim(`  ${e.hint}`));
  } else {
    console.error(pc.red(`✖ ${e instanceof Error ? e.message : String(e)}`));
    if (process.env.PROPMASTER_DEBUG && e instanceof Error) console.error(e.stack);
  }
  process.exitCode = 1;
});
