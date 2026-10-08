#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command, Option } from 'commander';
import { describeDatabase, resolveDatabaseUrl, withDb, type Db } from './core/db.js';
import { explainError, UserError } from './core/errors.js';
import { boxTable, brand, cell, hint, icons, makeStyle, spread } from './core/ui.js';
import { diagnose } from './recorder/doctor.js';
import { toHtml } from './recorder/export/html.js';
import { toMarkdown } from './recorder/export/markdown.js';
import { toSql } from './recorder/export/sql.js';
import { filterRecording, hasFilters, parseOps, parseTime, type Filters } from './recorder/filter.js';
import { createMasker, maskRecording } from './recorder/mask.js';
import { checkRules, parseRules } from './recorder/rules.js';
import { formatRuleResults, tally } from './recorder/rules-report.js';
import * as sessions from './recorder/sessions.js';
import { DEFAULT_MAX_ROWS } from './recorder/snapshot.js';
import { formatTimeline } from './recorder/timeline.js';
import * as trigger from './recorder/trigger.js';
import { formatDateTime } from './recorder/format.js';
import type { Recording } from './recorder/types.js';
import * as claims from './finder/claims.js';
import { checkRecipes, claimFound, find } from './finder/find.js';
import { loadRecipes, pickRecipe, resolveRecipesPath } from './finder/recipes.js';
import { formatChecks, formatClaims, formatFindResult, formatRecipeList, until } from './finder/report.js';

if (existsSync('.env')) process.loadEnvFile('.env');

// `propmaster record show | head` closes the pipe early: stop quietly instead of printing a stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

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
  const answer = await rl.question(` Type ${c.bold(word)} to confirm: `);
  rl.close();
  return answer.trim() === word;
}

const ui = makeStyle();
const c = ui.c;
const i = icons(c);
const say = (...lines: string[]) => console.log(lines.join('\n'));

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

// ---------- sessions (shared with the web app) ----------

const loadRecording = (ctx: Context, id?: string): Promise<Recording> => sessions.load(ctx.db, ctx.identity, id);

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
    say(` ${i.ok} Recorder installed ${c.dim(`· watching ${s.watchedTables} tables (${attached} new)`)}`);
    if (s.excludedTables.length) say(`   ${c.dim(`excluded: ${s.excludedTables.join(', ')}`)}`);
    if (s.outdated) say(`   ${c.yellow('! The recorder is from an older version: pause, resume and flag need an upgrade.')}`, hint(c, 'propmaster install   (recordings are kept)'));
    say(hint(c, 'next: propmaster record start "My test"'));
  }));

program
  .command('uninstall')
  .description('Remove Propmaster from the database: the recorder, its triggers, all recordings and claims')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(run(async ({ db }, opts: { yes?: boolean }) => {
    if (!(await trigger.isInstalled(db)) && !(await claims.claimsExist(db))) {
      say(` ${i.idle} Propmaster is not installed. Nothing to remove.`);
      return;
    }
    if (!opts.yes && !(await confirm('uninstall'))) {
      say(` ${i.warn} Cancelled. Nothing was removed.`, hint(c, 'in scripts, add --yes'));
      return;
    }
    await trigger.uninstall(db);
    say(` ${i.ok} Propmaster removed ${c.dim('· the _propmaster schema, its triggers, recordings and claims are gone')}`);
  }));

program
  .command('doctor')
  .description('Check what your DB user can do, and which mode to use')
  .action(run(async ({ db }) => {
    const report = await diagnose(db);
    const icon = { ok: i.ok, warn: i.warn, fail: i.fail };
    say(` ${brand(c)}  ${c.bold('Doctor')}`, '');
    for (const f of report.findings) say(` ${icon[f.level]} ${f.text}`);
    say('');
    if (report.recommended === 'trigger') say(` ${c.bold('Use trigger mode.')}`, hint(c, 'propmaster install, then propmaster record start "My test"'));
    else if (report.recommended === 'snapshot') say(` ${c.bold('Use snapshot mode.')} ${c.dim('It needs only read access.')}`, hint(c, 'propmaster record start "My test" --snapshot'));
    else say(` ${c.red(c.bold('Neither mode can run with this DB user.'))}`);
    if (report.grants.length) {
      say('', ' For trigger mode, ask a DBA to run:', ...report.grants.map((g) => `   ${c.cyan(g)}`));
    }
  }));

// ---------- record ----------

const record = program.command('record').description('Record database changes per test step');

record
  .command('start')
  .argument('[name]', 'session name', 'Test session')
  .description('Start recording')
  .option('--snapshot', 'compare snapshots instead of using triggers (needs only read access)')
  .option('--auto-steps [seconds]', 'no need to type steps: a quiet gap (default 3 s) ends a step, and each step is named after its changes')
  .option('--exclude <tables>', 'snapshot mode: tables to leave out (comma-separated, patterns allowed)', list)
  .addOption(new Option('--max-rows <n>', 'snapshot mode: skip tables with more rows than this').default(DEFAULT_MAX_ROWS).argParser(Number))
  .action(run(async (ctx, name: string, opts: { snapshot?: boolean; exclude?: string[]; maxRows: number; autoSteps?: boolean | string }) => {
    const autoSteps = opts.autoSteps === undefined || opts.autoSteps === true ? opts.autoSteps : Math.round(Number(opts.autoSteps) * 1000);
    const next = autoSteps
      ? [hint(c, 'just test: each action becomes a step, named after its changes'), hint(c, 'to name the next action yourself: propmaster record step "<name>"'), hint(c, 'when you are done: propmaster record stop')]
      : [hint(c, 'before each test step: propmaster record step "<name>"'), hint(c, 'when you are done:    propmaster record stop')];
    const recording = (id: string, detail: string) => spread(` ${i.rec} ${c.red(c.bold('REC'))}  ${c.bold(`Session #${id}`)} · ${name}`, c.dim(detail), ui.width);
    const s = await sessions.start(ctx.db, ctx.identity, name, { snapshot: opts.snapshot, exclude: opts.exclude, maxRows: opts.maxRows, autoSteps });
    say(recording(s.id, s.mode === 'snapshot' ? `snapshot mode · ${s.tables} tables read` : `${s.tables} tables watched${autoSteps ? ' · auto steps' : ''}`));
    if (s.skipped.length) say(`   ${c.yellow(`! not watched (over ${opts.maxRows} rows): ${s.skipped.join(', ')}`)}`);
    say(...next);
  }));

record
  .command('step')
  .argument('<name>', 'what the tester is about to do, e.g. "Click Place Order"')
  .description('Start a new test step')
  .action(run(async (ctx, name: string) => {
    const seq = await sessions.step(ctx.db, ctx.identity, name);
    say(spread(` ${c.cyan(c.bold(`STEP ${seq}`))}  ${c.bold(name)}`, c.dim('recording'), ui.width));
  }));

record
  .command('pause')
  .description('Pause recording: the session stays open, but changes are not recorded')
  .action(run(async (ctx) => {
    await sessions.pause(ctx.db, ctx.identity);
    say(` ${i.pause} ${c.yellow(c.bold('PAUSED'))}  ${c.dim('changes are not recorded until you resume')}`, hint(c, 'propmaster record resume'));
  }));

record
  .command('resume')
  .description('Resume a paused recording')
  .action(run(async (ctx) => {
    await sessions.resume(ctx.db, ctx.identity);
    say(` ${i.rec} ${c.red(c.bold('REC'))}  ${c.dim('recording again')}`);
  }));

record
  .command('flag')
  .argument('[note...]', 'what looks wrong, e.g. "total shows 0.00"')
  .description('Flag the current step, with an optional note')
  .action(run(async (ctx, note: string[] = []) => {
    const text = note.join(' ');
    await sessions.flag(ctx.db, ctx.identity, text);
    say(` ${i.flag} ${c.yellow(c.bold('Flagged'))} the current step${text ? c.dim(` · ${text}`) : ''}`);
  }));

addFilterOptions(record
  .command('stop')
  .description('Stop recording and show the timeline')
  .option('--mask', 'hide sensitive values in the timeline'))
  .action(run(async (ctx, opts: FilterOpts & { mask?: boolean }) => {
    const rec = await sessions.stop(ctx.db, ctx.identity);
    say(` ${i.stop} Stopped session #${rec.id}`, '');
    printTimeline(rec, opts);
  }));

record
  .command('status')
  .description('Show whether a recording is running')
  .action(run(async (ctx) => {
    const s = await sessions.status(ctx.db, ctx.identity);
    if (s.active) {
      const detail = s.active.mode === 'snapshot' ? 'snapshot mode'
        : `${s.watchedTables} tables watched${s.active.autoSplitMs ? ` · auto steps (${s.active.autoSplitMs / 1000} s gap)` : ''}`;
      const badge = s.active.paused ? `${i.pause} ${c.yellow(c.bold('PAUSED'))}` : `${i.rec} ${c.red(c.bold('REC'))}`;
      // With auto steps, the steps come from the changes so far: show the latest one.
      const last = s.active.autoSplitMs ? (await sessions.load(ctx.db, ctx.identity, s.active.id)).steps.at(-1) : undefined;
      const current = last ? `${c.dim('last step')} ${c.cyan(`STEP ${last.seq}`)} ${last.name}` : `${c.dim('current step')} ${c.cyan(`STEP ${s.active.stepSeq}`)} ${s.active.stepName}`;
      say(spread(` ${badge}  ${c.bold(`Session #${s.active.id}`)} · ${s.active.name}`, c.dim(detail), ui.width), `   ${current}`);
    } else if (!s.installed) say(` ${i.idle} Not recording. The recorder is not installed.`, hint(c, 'propmaster install, or propmaster record start --snapshot'));
    else say(` ${i.idle} Not recording ${c.dim(`· ${s.watchedTables} tables watched`)}`);
    if (s.excludedTables.length) say(`   ${c.dim(`excluded: ${s.excludedTables.join(', ')}`)}`);
    if (s.outdated) say(`   ${c.yellow('! The recorder is from an older version: pause, resume and flag need an upgrade.')}`, hint(c, 'propmaster install   (recordings are kept)'));
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
    const all = await sessions.list(ctx.db, ctx.identity);
    if (all.length === 0) {
      say(` ${i.idle} No sessions recorded yet.`, hint(c, 'propmaster record start "My test"'));
      return;
    }
    say(...boxTable(ui, [
      { header: 'Session' }, { header: 'Started' }, { header: 'Name', flex: true }, { header: 'Changes' }, { header: 'Mode' },
    ], all.map((s) => [
      cell(`#${s.id}`, (t) => c.bold(t)),
      cell(formatDateTime(s.startedAt).slice(0, 16)),
      cell(s.name),
      cell(String(s.changeCount)),
      s.stoppedAt ? cell(s.mode) : [[{ text: s.mode }, { text: '● recording', style: c.red }]],
    ])));
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
    say(` ${i.ok} Wrote ${c.bold(file)}${masked ? c.dim(' · sensitive values masked') : c.yellow(' · not masked')}`);
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
    const target = rec ? `${c.bold(`Session #${rec.id}`)} · ${rec.name}` : c.bold('Whole tables');
    say(` ${brand(c)}  ${target}`, ` ${c.dim(`rule check · ${rules.length} rule${rules.length === 1 ? '' : 's'} from ${file}`)}`, '');

    const results = await checkRules(ctx.db, rec, rules, { allRows: opts.allRows, limit: opts.limit, timeout: opts.timeout });
    console.log(formatRuleResults(results, { allRows: opts.allRows }));
    const t = tally(results);
    if (t.fail || t.error) process.exitCode = 1;
  }));

record
  .command('rename')
  .argument('<session>', 'session id, e.g. 12 or s3')
  .argument('<step>', 'step number, as in the timeline')
  .argument('<name...>', 'the new name, e.g. "Click Place Order"')
  .description('Rename a step, while recording or afterwards')
  .action(run(async (ctx, session: string, step: string, name: string[]) => {
    const id = session.replace(/^#/, '');
    if (!/^\d+$/.test(step)) throw new UserError(`"${step}" is not a step number.`, 'Steps are numbered 0, 1, 2… as in the timeline.');
    await sessions.renameStep(ctx.db, id, Number(step), name.join(' '));
    say(` ${i.ok} Renamed ${c.cyan(`STEP ${step}`)} of session #${id} to ${c.bold(name.join(' ').trim())}`);
  }));

record
  .command('delete')
  .argument('<session>', 'session id, e.g. 12 or s3')
  .description('Delete a stopped session and its changes')
  .action(run(async (ctx, session: string) => {
    const id = session.replace(/^#/, '');
    await sessions.remove(ctx.db, id);
    say(` ${i.ok} Deleted session #${id}`);
  }));

record
  .command('prune')
  .description('Delete stopped trigger-mode sessions older than a given age')
  .requiredOption('--older-than <interval>', 'a Postgres interval, e.g. "7 days" or "12 hours"')
  .action(run(async ({ db }, opts: { olderThan: string }) => {
    const n = await trigger.prune(db, opts.olderThan);
    say(` ${i.ok} Deleted ${n} session${n === 1 ? '' : 's'} ${c.dim(`older than ${opts.olderThan}`)}`);
  }));

record
  .command('exclude')
  .argument('<tables...>', 'tables to stop watching, e.g. sessions audit_log')
  .description('Stop watching busy or irrelevant tables (trigger mode)')
  .action(run(async ({ db }, tables: string[]) => {
    for (const t of tables) await trigger.excludeTable(db, t);
    say(` ${i.ok} No longer watching ${c.bold(tables.join(', '))}`);
  }));

record
  .command('include')
  .argument('<tables...>', 'excluded tables to watch again')
  .description('Watch previously excluded tables again (trigger mode)')
  .action(run(async ({ db }, tables: string[]) => {
    for (const t of tables) await trigger.includeTable(db, t);
    say(` ${i.ok} Watching again ${c.bold(tables.join(', '))}`);
  }));

// ---------- find (Test Data Finder) ----------

const recipesOption = () => new Option('--recipes <path>', 'recipe folder or .sql file (default: $PROPMASTER_RECIPES, or ./recipes)');

function param(value: string, previous: Record<string, string> = {}): Record<string, string> {
  const eq = value.indexOf('=');
  if (eq < 1) throw new UserError(`"${value}" is not a parameter.`, 'Write it as name=value, e.g. -p min_orders=3');
  return { ...previous, [value.slice(0, eq).trim()]: value.slice(eq + 1) };
}

const claimCount = (v: boolean | string | undefined): number | undefined => {
  if (v === undefined || v === false) return undefined;
  if (v === true) return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UserError(`--claim takes a number of rows, not "${v}".`);
  return n;
};

const claimer = (as?: string) => as?.trim() || claims.defaultClaimer();

async function listRecipes(path?: string): Promise<void> {
  const where = resolveRecipesPath(path);
  console.log(formatRecipeList(await loadRecipes(where), where));
}

interface FindOpts {
  recipes?: string;
  param: Record<string, string>;
  limit: number;
  claim?: boolean | string;
  for: string;
  as?: string;
  note?: string;
  timeout: string;
  json?: boolean;
}

program
  .command('find')
  .argument('[recipe...]', 'a recipe id, its name, or words from it (none: list all recipes)')
  .description('Find test data with a recipe, and claim a row so nobody else uses it (exit code 1 if no free row)')
  .addOption(recipesOption())
  .option('-p, --param <name=value>', 'a parameter value (repeatable)', param, {})
  .addOption(new Option('--limit <n>', 'rows to show').default(10).argParser(Number))
  .option('--claim [count]', 'claim the first free row (or this many) for your test')
  .option('--for <duration>', 'how long a claim lasts: 30m, 2h, 1d', '2h')
  .option('--as <name>', 'who is claiming (default: $PROPMASTER_USER, or your OS user name)')
  .option('--note <text>', 'a note on the claim, e.g. the test it is for')
  .option('--timeout <interval>', 'time limit for the query', '30s')
  .option('--json', 'print the result as JSON, for scripts and automated tests')
  .action(async (words: string[], opts: FindOpts) => {
    if (words.length === 0) {
      await listRecipes(opts.recipes);
      return;
    }
    const recipe = pickRecipe(await loadRecipes(resolveRecipesPath(opts.recipes)), words.join(' '));
    const count = claimCount(opts.claim);
    const seconds = claims.parseDuration(opts.for);
    await run(async ({ db }) => {
      const result = await find(db, recipe, { params: opts.param, limit: Math.max(opts.limit, count ?? 0), timeout: opts.timeout });
      const got = count ? await claimFound(db, result, { count, by: claimer(opts.as), note: opts.note, seconds }) : [];
      if (opts.json) {
        const taken = new Set(got.map((g) => g.key));
        console.log(JSON.stringify({
          recipe: result.recipe,
          params: result.params,
          matches: result.matches,
          claimedByOthers: result.claimed,
          claims: got.map((g) => ({ id: g.id, table: g.table, key: g.key, expiresAt: g.expiresAt, row: result.rows.find((r) => r.key === g.key)?.values ?? null })),
          rows: result.rows.filter((r) => !r.claimedBy && !(r.key !== null && taken.has(r.key))).map((r) => r.values),
        }, null, 2));
      } else {
        console.log(formatFindResult(result, got, { me: claimer(opts.as) }));
      }
      if (!got.length && !result.rows.some((r) => !r.claimedBy)) process.exitCode = 1;
    })();
  });

const recipes = program.command('recipes').description('List and check test data recipes');

recipes
  .command('list', { isDefault: true })
  .description('List the recipes (the same as `propmaster find` without a recipe)')
  .addOption(recipesOption())
  .action((opts: { recipes?: string }) => listRecipes(opts.recipes));

recipes
  .command('check')
  .description('Check every recipe still runs and finds rows, e.g. in CI after a migration (exit code 1 if one is broken)')
  .addOption(recipesOption())
  .option('--strict', 'also fail when a recipe finds no rows')
  .option('--timeout <interval>', 'time limit per recipe', '30s')
  .action(async (opts: { recipes?: string; strict?: boolean; timeout: string }) => {
    const where = resolveRecipesPath(opts.recipes);
    const all = await loadRecipes(where);
    await run(async ({ db }) => {
      say(` ${brand(c)}  ${c.bold('Recipe check')}`, ` ${c.dim(`${all.length} recipe${all.length === 1 ? '' : 's'} from ${where}`)}`, '');
      const results = await checkRecipes(db, all, { timeout: opts.timeout });
      console.log(formatChecks(results, { strict: opts.strict }));
      if (results.some((r) => r.status === 'error' || (opts.strict && r.status === 'empty'))) process.exitCode = 1;
    })();
  });

const claimsCmd = program.command('claims').description('See, add, extend and release claims on test data');

claimsCmd
  .command('list', { isDefault: true })
  .description('List current claims')
  .option('--all', 'include expired claims')
  .option('--mine', 'only your claims')
  .option('--as <name>', 'who "you" are (default: $PROPMASTER_USER, or your OS user name)')
  .action(run(async ({ db }, opts: { all?: boolean; mine?: boolean; as?: string }) => {
    const me = claimer(opts.as);
    console.log(formatClaims(await claims.list(db, { includeExpired: opts.all, by: opts.mine ? me : undefined }), me));
  }));

claimsCmd
  .command('add')
  .argument('<table>', 'the table, e.g. customers or billing.invoices')
  .argument('<key>', 'the primary key value of the row, e.g. 318')
  .description('Claim a row you picked yourself')
  .option('--for <duration>', 'how long the claim lasts: 30m, 2h, 1d', '2h')
  .option('--as <name>', 'who is claiming (default: $PROPMASTER_USER, or your OS user name)')
  .option('--note <text>', 'a note, e.g. the test it is for')
  .action(run(async ({ db }, table: string, key: string, opts: { for: string; as?: string; note?: string }) => {
    const got = await claims.claimByKey(db, table, key, { by: claimer(opts.as), note: opts.note, seconds: claims.parseDuration(opts.for) });
    say(` ${i.ok} Claimed ${c.bold(`${table} ${key}`)} ${c.dim(`· claim #${got.id} · until ${until(got.expiresAt)}`)}`, hint(c, `when you are done: propmaster claims release ${got.id}`));
  }));

claimsCmd
  .command('release')
  .argument('[claims...]', 'claim ids, e.g. 12 15')
  .description('Release claims so others can use the rows')
  .option('--mine', 'release all of your claims')
  .option('--as <name>', 'who "you" are (default: $PROPMASTER_USER, or your OS user name)')
  .action(run(async ({ db }, ids: string[], opts: { mine?: boolean; as?: string }) => {
    if (opts.mine) {
      const me = claimer(opts.as);
      const n = await claims.releaseAllBy(db, me);
      say(` ${i.ok} Released ${n} claim${n === 1 ? '' : 's'} ${c.dim(`held by ${me}`)}`);
      return;
    }
    if (ids.length === 0) throw new UserError('Which claims?', 'Give claim ids (see `propmaster claims`), or --mine for all of yours.');
    for (const r of await claims.release(db, ids)) say(` ${i.ok} Released claim #${r.id} ${c.dim(`· ${r.table.replace(/^public\./, '')} ${r.key} · held by ${r.claimedBy}`)}`);
  }));

claimsCmd
  .command('extend')
  .argument('<claim>', 'claim id')
  .description('Keep a claim for longer')
  .option('--for <duration>', 'how long from now: 30m, 2h, 1d', '2h')
  .action(run(async ({ db }, id: string, opts: { for: string }) => {
    const r = await claims.extend(db, id, claims.parseDuration(opts.for));
    say(` ${i.ok} Claim #${r.id} ${c.dim(`· ${r.table.replace(/^public\./, '')} ${r.key}`)} now lasts until ${c.bold(until(r.expiresAt))}`);
  }));

claimsCmd
  .command('clear-expired')
  .description('Delete claims that have run out')
  .action(run(async ({ db }) => {
    const n = await claims.clearExpired(db);
    say(` ${i.ok} Deleted ${n} expired claim${n === 1 ? '' : 's'}`);
  }));

program
  .command('ui')
  .description('Open the Propmaster web app in your browser')
  .addOption(new Option('--port <n>', 'port to listen on (127.0.0.1 only)').default(4400).argParser(Number))
  .option('--no-open', 'do not open the browser')
  .action(async (opts: { port: number; open: boolean }) => {
    const { startUiServer } = await import('./ui/server.js');
    const app = await startUiServer(opts.port).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') throw new UserError(`Port ${opts.port} is already in use.`, `Is the web app already running? Or pick another port: propmaster ui --port ${opts.port + 1}`);
      throw err;
    });
    say(` ${brand(c)}  ${c.bold('Web app running')}`, '', `   ${c.cyan(app.url)}`, '',
      hint(c, 'this link includes a secret token: keep it to yourself'), hint(c, 'press Ctrl+C to stop'));
    if (opts.open) openFile(app.url);
  });

program.parseAsync().catch((err: unknown) => {
  const e = explainError(err);
  if (e instanceof UserError) {
    console.error(` ${i.fail} ${c.red(e.message)}`);
    if (e.hint) console.error(hint(c, e.hint));
  } else {
    console.error(` ${i.fail} ${c.red(e instanceof Error ? e.message : String(e))}`);
    if (process.env.PROPMASTER_DEBUG && e instanceof Error) console.error(e.stack);
  }
  process.exitCode = 1;
});
