import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/core/db.js';
import { connectTest, ensureRole, resetDatabase, TEST_URL, urlAs } from './helpers.js';

const exec = promisify(execFile);

let db: Db;
let home: string;

interface Result {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI as a separate process, like a tester would. */
async function cli(args: string[], url: string | null = TEST_URL): Promise<Result> {
  const env = { ...process.env, NO_COLOR: '1', PROPMASTER_HOME: home, PROPMASTER_DATABASE_URL: '' };
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...(url ? ['--url', url] : []), ...args], { env });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, out: err.stdout, err: err.stderr };
  }
}

beforeAll(async () => {
  db = await connectTest();
  await resetDatabase(db);
  await ensureRole(db, 'propmaster_reader');
  home = await mkdtemp(join(tmpdir(), 'propmaster-cli-'));
});

afterAll(async () => {
  await db?.end();
  await rm(home, { recursive: true, force: true });
});

describe('propmaster CLI', () => {
  it('records a checkout from install to export, then uninstalls', async () => {
    expect((await cli(['install'])).out).toContain(' ✔ Recorder installed · watching 6 tables (6 new)');
    expect((await cli(['record', 'start', 'CLI checkout'])).out).toMatch(/ ● REC {2}Session #\d+ · CLI checkout +6 tables watched/);
    expect((await cli(['record', 'step', 'Click Place Order'])).out).toMatch(/ STEP 1 {2}Click Place Order +recording/);
    await db.query('SELECT place_order(1, 3, 2)');
    expect((await cli(['record', 'status'])).out).toContain('current step STEP 1 Click Place Order');

    const stop = await cli(['record', 'stop']);
    expect(stop.code).toBe(0);
    expect(stop.out).toMatch(/ STEP 1 {2}Click Place Order +4 changes/);
    expect(stop.out).toMatch(/│ update +│ inventory +│ product_id=3 +│ stock 6 → 4 +│/);
    expect(stop.out).toContain('total=84.50');
    expect(stop.out).toContain(' 4 changes · 4 tables · 3 inserts · 1 update');

    const filtered = await cli(['record', 'show', '--table', 'orders,payments', '--op', 'insert']);
    expect(filtered.out).toContain('2 changes hidden by filters');
    expect(filtered.out).not.toContain('│ update');

    expect((await cli(['record', 'list'])).out).toMatch(/│ #\d+ +│ \d{4}-\d\d-\d\d \d\d:\d\d │ CLI checkout +│ 4 +│ trigger +│/);

    const html = join(home, 'report.html');
    expect((await cli(['record', 'export', '-o', html])).out).toContain(`✔ Wrote ${html}`);
    expect(await readFile(html, 'utf8')).toContain('<title>CLI checkout · Propmaster</title>');

    const md = await cli(['record', 'export', '--format', 'md', '-o', '-']);
    expect(md.out).toContain('| UPDATE | inventory | product_id=3 | stock: 6 → **4** |');

    const sql = await cli(['record', 'export', '--format', 'sql', '-o', '-']);
    const { rows } = await db.query(sql.out);
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.pass)).toBe(true);

    expect((await cli(['uninstall'])).out).toContain('Cancelled. Nothing was removed.'); // no TTY, no --yes
    expect((await cli(['uninstall', '--yes'])).out).toContain(' ✔ Recorder removed');
  });

  it('records in snapshot mode as a read-only user', async () => {
    await resetDatabase(db);
    await db.query('GRANT USAGE ON SCHEMA public TO propmaster_reader');
    await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO propmaster_reader');
    const reader = urlAs('propmaster_reader');

    expect((await cli(['doctor'], reader)).out).toContain('Use snapshot mode');
    expect((await cli(['record', 'start', 'RO', '--snapshot'], reader)).out).toMatch(/ ● REC {2}Session #s\d+ · RO +snapshot mode · 6 tables read/);
    expect((await cli(['record', 'status'], reader)).out).toMatch(/snapshot mode\n +current step STEP 0 /);
    await cli(['record', 'step', 'Order'], reader);
    await db.query('SELECT place_order(2, 2, 1)');
    const stop = await cli(['record', 'stop'], reader);
    expect(stop.out).toContain('snapshot mode');
    expect(stop.out).toMatch(/ STEP 1 {2}Order +4 changes/);
    expect((await cli(['record', 'list'], reader)).out).toMatch(/│ #s\d+ +│ [\d :-]+│ RO +│ 4 +│ snapshot +│/);
  });

  it('survives being killed in the middle of a snapshot step', async () => {
    await resetDatabase(db);
    await db.query('GRANT USAGE ON SCHEMA public TO propmaster_reader');
    await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO propmaster_reader');
    const reader = urlAs('propmaster_reader');
    await cli(['record', 'start', 'Interrupted', '--snapshot'], reader);

    // Kill a step while it reads tables and writes files; wherever it stops, the session must stay usable.
    const env = { ...process.env, NO_COLOR: '1', PROPMASTER_HOME: home, PROPMASTER_DATABASE_URL: '' };
    // Several kill moments, from Node still starting up to the step writing its files.
    for (const delay of [300, 600, 900, 1200, 1500]) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--url', reader, 'record', 'step', `Killed at ${delay} ms`], { env });
      const exited = new Promise((r) => child.on('exit', r)); // listen first: it may finish before the kill
      await new Promise((r) => setTimeout(r, delay));
      child.kill('SIGKILL');
      await exited;
      expect((await cli(['record', 'status'], reader)).out).toMatch(/Session #s\d+ · Interrupted +snapshot mode/);
    }
    await db.query('SELECT place_order(1, 1, 1)');
    const stop = await cli(['record', 'stop'], reader);
    expect(stop.code).toBe(0);
    expect(stop.out).toMatch(/│ insert +│ orders +│/);
    expect((await cli(['record', 'list'], reader)).out).toContain('Interrupted');
  });

  it('checks business rules and fails the run when one breaks', async () => {
    await resetDatabase(db);
    await cli(['install']);
    await cli(['record', 'start', 'Discount check']);
    await db.query('SELECT place_order(1, 3, 2)');
    await cli(['record', 'stop']);

    const failed = await cli(['record', 'check', 'demo/rules.sql']);
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/Session #\d+ · Discount check\n rule check · 4 rules from demo\/rules.sql/);
    expect(failed.out).toMatch(/│ ✖ │ Order total is the items' price,.*│ 1 row of orders +│ 1 violation +│/);
    expect(failed.out).toMatch(/│ order_id │ total │ expected │\n ├[─┼]+┤\n │ 1 +│ 84\.50 │ 76\.05 +│/);
    expect(failed.out).toMatch(/│ ✔ │ Payment amount matches the order total +│ 1 row of payments +│ pass +│/);
    expect(failed.out).toContain('3 passed · 1 failed');

    const passed = await cli(['record', 'check', 'demo/rules.sql', '--all-rows']);
    expect(passed.out).toContain('Whole tables');

    const missing = await cli(['record', 'check', 'nope.sql']);
    expect(missing.err).toContain("Can't find the rules file nope.sql.");
    await cli(['uninstall', '--yes']);
  });

  it('explains mistakes and exits with code 1', async () => {
    const noUrl = await cli(['record', 'status'], null);
    expect(noUrl.code).toBe(1);
    expect(noUrl.err).toContain('✖ No database given.');
    expect(noUrl.err).toContain('Pass --url or set PROPMASTER_DATABASE_URL');

    expect((await cli(['record', 'status'], 'postgres://u:p@prod-db:5432/shop')).err).toContain('looks like production');
    expect((await cli(['record', 'status'], 'postgres://u:p@localhost:1/shop')).err).toMatch(/Can't reach Postgres.*\n.*npm run db:up/);
    expect((await cli(['record', 'start'])).err).toContain('✖ The recorder is not installed in this database.');
    expect((await cli(['record', 'show', 'abc'])).err).toContain('"abc" is not a session id.');
    expect((await cli(['record', 'show', '--since', 'soon'])).err).toContain("Can't read the time \"soon\"");
    expect((await cli(['record', 'export', '--format', 'pdf'])).err).toMatch(/Allowed choices are html, md, sql/);
  });

  it('prints its version', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
    expect((await cli(['--version'], null)).out.trim()).toBe(pkg.version);
  });
});
