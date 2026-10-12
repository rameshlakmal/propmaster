import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/core/db.js';
import { startUiServer, type UiServer } from '../src/ui/server.js';
import { connectTest, resetDatabase, TEST_URL } from './helpers.js';

let db: Db;
let app: UiServer;
let dir: string;
let base: string;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Propmaster-Token': app.token, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'propmaster-ui-'));
  process.env.PROPMASTER_UI_CONFIG = join(dir, 'ui.json');
  process.env.PROPMASTER_HOME = join(dir, 'home');
  process.env.PROPMASTER_BACKUPS = join(dir, 'backups');
  db = await connectTest();
  await resetDatabase(db);
  app = await startUiServer(0);
  base = new URL(app.url).origin;
});

afterAll(async () => {
  await app?.close();
  await db?.end();
  delete process.env.PROPMASTER_UI_CONFIG;
  delete process.env.PROPMASTER_HOME;
  delete process.env.PROPMASTER_BACKUPS;
  await rm(dir, { recursive: true, force: true });
});

describe('web app server security', () => {
  it('listens on 127.0.0.1 only', () => {
    expect(app.server.address()).toMatchObject({ address: '127.0.0.1' });
  });

  it('refuses API calls without the token, or with a wrong one', async () => {
    expect((await fetch(`${base}/api/config`)).status).toBe(401);
    expect((await call('GET', '/api/config', undefined, { 'X-Propmaster-Token': 'wrong' })).status).toBe(401);
  });

  it('never accepts the token in the URL', async () => {
    expect((await fetch(`${base}/api/config?token=${app.token}`)).status).toBe(401);
  });

  it('refuses calls from other web pages', async () => {
    expect((await call('GET', '/api/config', undefined, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('GET', '/api/config', undefined, { Origin: base })).status).toBe(200);
  });

  it('refuses requests for another host name (DNS rebinding)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((ok) => {
      const req = request({ host: '127.0.0.1', port: new URL(base).port, path: '/api/config', headers: { Host: 'evil.example', 'X-Propmaster-Token': app.token } },
        (res) => { res.resume(); ok(res.statusCode ?? 0); });
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe('connections', () => {
  it('starts with none, and explains what to do', async () => {
    expect((await call('GET', '/api/config')).data).toEqual({ active: null, profiles: [] });
    const status = await call('GET', '/api/status');
    expect(status.status).toBe(400);
    expect(status.data.error).toMatchObject({ message: 'No database connection yet.', hint: 'Add one on the Setup page.' });
  });

  it('tests a connection without saving it', async () => {
    const res = await call('POST', '/api/connections/test', { url: TEST_URL });
    expect(res.data.doctor.recommended).toBe('trigger');
    expect(res.data.installed).toBe(false);
    expect((await call('GET', '/api/config')).data.profiles).toEqual([]);
  });

  it('refuses production-looking and unreachable connections', async () => {
    const prod = await call('POST', '/api/profiles', { name: 'Live', url: 'postgres://u:p@prod-db:5432/shop' });
    expect(prod.status).toBe(400);
    expect(prod.data.error.message).toMatch(/looks like production/);
    const down = await call('POST', '/api/profiles', { name: 'Down', url: 'postgres://u:p@localhost:1/shop' });
    expect(down.status).toBe(400);
    expect(down.data.error.message).toMatch(/Can't reach Postgres/);
  });

  it('saves a connection and never sends its password back', async () => {
    expect((await call('POST', '/api/profiles', { name: 'Test DB', url: TEST_URL })).status).toBe(200);
    const config = (await call('GET', '/api/config')).data;
    expect(config.active).toBe('Test DB');
    expect(JSON.stringify(config)).not.toContain(':propmaster@');
    expect(config.profiles[0].url).toContain(':****@');
  });
});

describe('recording through the web app', () => {
  let id: string;

  it('installs the recorder and reports status', async () => {
    expect((await call('POST', '/api/install')).data.attached).toBe(6);
    expect((await call('GET', '/api/status')).data).toMatchObject({ installed: true, watchedTables: 6, active: null });
  });

  it('records steps, shows them live, and stops', async () => {
    const started = await call('POST', '/api/record/start', { name: 'UI checkout' });
    expect(started.data).toMatchObject({ mode: 'trigger', tables: 6 });
    id = started.data.id;
    expect((await call('POST', '/api/record/step', { name: 'Click Place Order' })).data).toEqual({ seq: 1 });
    await db.query('SELECT place_order(1, 3, 2)');

    const status = (await call('GET', '/api/status')).data;
    expect(status.active).toMatchObject({ id, name: 'UI checkout', mode: 'trigger', stepSeq: 1, stepName: 'Click Place Order' });

    const live = (await call('GET', `/api/sessions/${id}`)).data;
    const step = live.steps.find((s: { seq: number }) => s.seq === 1);
    expect(step.changes.map((c: { op: string; table: string }) => `${c.op} ${c.table}`)).toEqual([
      'UPDATE inventory', 'INSERT orders', 'INSERT order_items', 'INSERT payments',
    ]);
    const total = step.changes[1].columns.find((c: { column: string }) => c.column === 'total');
    expect(total).toEqual({ column: 'total', before: null, after: '84.50', changed: false, beforeKind: null, afterKind: 'number' }); // exact value, formatted on the server

    // Pause, flag and resume: the markers come back with the step, and paused shows in status.
    expect((await call('POST', '/api/record/pause')).data).toEqual({ ok: true });
    expect((await call('GET', '/api/status')).data.active.paused).toBe(true);
    expect((await call('POST', '/api/record/pause')).data.error.message).toBe('The recording is already paused.');
    expect((await call('POST', '/api/record/resume')).data).toEqual({ ok: true });
    expect((await call('POST', '/api/record/flag', { note: 'total looks right' })).data).toEqual({ ok: true });
    expect((await call('POST', '/api/record/flag', { note: 5 })).status).toBe(400);
    const marked = (await call('GET', `/api/sessions/${id}`)).data.steps.find((s: { seq: number }) => s.seq === 1);
    expect(marked.markers.map((m: { kind: string; note: string | null }) => [m.kind, m.note])).toEqual([
      ['pause', null], ['resume', null], ['flag', 'total looks right'],
    ]);

    const stopped = (await call('POST', '/api/record/stop')).data;
    expect(stopped.stoppedAt).not.toBeNull();
    expect(stopped.summary).toMatchObject({ changes: 4, tables: 4 });
    expect((await call('GET', '/api/status')).data.active).toBeNull();
  });

  it('lists sessions and explains a missing one', async () => {
    expect((await call('GET', '/api/sessions')).data).toMatchObject({ total: 1, page: 1, pageSize: 20, sessions: [{ id, name: 'UI checkout', changeCount: 4 }] });
    const missing = await call('GET', '/api/sessions/999');
    expect(missing.status).toBe(400);
    expect(missing.data.error.message).toBe('There is no session 999.');
  });

  it('downloads exports, masked by default', async () => {
    const html = await call('GET', `/api/sessions/${id}/export?format=html`);
    expect(html.headers.get('content-disposition')).toBe(`attachment; filename="propmaster-session-${id}.html"`);
    expect(html.data).toContain('<title>UI checkout · Propmaster</title>');
    expect(html.data).toContain('Sensitive values are masked.');
    const sql = await call('GET', `/api/sessions/${id}/export?format=sql`);
    expect(sql.data).toContain('AS checks (step, check_name, pass)');
    expect((await call('GET', `/api/sessions/${id}/export?format=pdf`)).status).toBe(400);
  });

  it('opens, saves and runs a rules file', async () => {
    const file = join(dir, 'rules.sql');
    const content = '-- rule: Payment matches the order total\nSELECT p.order_id FROM {{payments}} p JOIN orders o ON o.id = p.order_id WHERE p.amount <> o.total\n';
    expect((await call('PUT', '/api/rules', { path: file, content })).status).toBe(200);
    const opened = (await call('GET', '/api/rules')).data;
    expect(opened.rules).toEqual([{ name: 'Payment matches the order total', line: 1 }]);
    const run = (await call('POST', '/api/rules/check', { sessionId: id })).data;
    expect(run.results.map((r: { status: string }) => r.status)).toEqual(['pass']);

    // Pasted with quotes, as Windows' "Copy as path" gives it.
    expect((await call('PUT', '/api/rules', { path: `  "${file}" ` })).data).toEqual({ ok: true, path: file });

    const bad = await call('PUT', '/api/rules', { path: file, content: 'SELECT 1' });
    expect(bad.status).toBe(400); // never saves a file the checker can't read
    expect((await call('PUT', '/api/rules', { path: join(dir, 'notes.txt'), content })).status).toBe(400);
  });

  it('renames a step', async () => {
    expect((await call('PUT', `/api/sessions/${id}/steps/1`, { name: 'Place the order' })).data).toEqual({ ok: true });
    expect((await call('GET', `/api/sessions/${id}`)).data.steps.find((s: { seq: number }) => s.seq === 1).name).toBe('Place the order');
    expect((await call('PUT', `/api/sessions/${id}/steps/1`, { name: '' })).status).toBe(400);
    expect((await call('PUT', `/api/sessions/${id}/steps/9`, { name: 'x' })).data.error.message).toBe(`Session ${id} has no step 9.`);
  });

  it('deletes a stopped session', async () => {
    expect((await call('DELETE', `/api/sessions/${id}`)).data).toEqual({ ok: true });
    expect((await call('GET', '/api/sessions')).data).toMatchObject({ total: 0, sessions: [] });
  });
});

describe('finding data through the web app', () => {
  it('asks for a recipe folder first, and accepts a path pasted with quotes', async () => {
    expect((await call('GET', '/api/recipes')).data).toEqual({ path: '', recipes: [], error: null });
    expect((await call('POST', '/api/find', { recipe: 'x' })).data.error.message).toBe('Choose a recipe folder first.');
    expect((await call('PUT', '/api/recipes', { path: join(dir, 'missing') })).data.error.message).toMatch(/^Can't find /);
    const set = await call('PUT', '/api/recipes', { path: `"${join(process.cwd(), 'demo', 'recipes')}"` });
    expect(set.data).toEqual({ ok: true, path: join(process.cwd(), 'demo', 'recipes') });
    const list = (await call('GET', '/api/recipes')).data;
    expect(list.recipes).toHaveLength(6);
    expect((await call('GET', '/api/config')).data.profiles[0].recipesPath).toBe(join(process.cwd(), 'demo', 'recipes'));
  });

  it('finds rows, claims a picked one or the first free one, and releases them', async () => {
    const found = (await call('POST', '/api/find', { recipe: 'product-in-a-price-range', params: { min_price: '20', max_price: '' } })).data;
    expect(found.result.rows.map((r: { key: string }) => r.key)).toEqual(['2', '3']);
    expect(found.result.params).toEqual({ min_price: '20', max_price: '1000000' });

    const picked = (await call('POST', '/api/find/claim', { recipe: 'product-in-a-price-range', params: { min_price: '20' }, key: '3', duration: '30m', note: 'TC-1' })).data;
    expect(picked.claims).toMatchObject([{ key: '3', claimedBy: found.me, note: 'TC-1' }]);
    expect(picked.result.rows.map((r: { key: string; claimedBy: unknown }) => [r.key, r.claimedBy !== null])).toEqual([['2', false], ['3', true]]);

    const again = await call('POST', '/api/find/claim', { recipe: 'product-in-a-price-range', params: { min_price: '20' }, key: '3' });
    expect(again.data.error.message).toMatch(/^products 3 is already claimed by you \(claim #\d+\)\.$/);
    const first = (await call('POST', '/api/find/claim', { recipe: 'product-in-a-price-range', params: { min_price: '20' } })).data;
    expect(first.claims[0].key).toBe('2');

    const claims = (await call('GET', '/api/claims')).data.claims;
    expect(claims.map((c: { key: string }) => c.key).sort()).toEqual(['2', '3']);
    expect((await call('POST', `/api/claims/${claims[0].id}/extend`, { duration: '1d' })).data.claim.id).toBe(claims[0].id);
    expect((await call('POST', `/api/claims/${claims[0].id}/release`)).data.released).toHaveLength(1);
    expect((await call('POST', '/api/claims/release-mine')).data.released).toBe(1);
    expect((await call('GET', '/api/claims')).data.claims).toEqual([]);
  });

  it("claims under a saved name, and releases another tester's claim only when forced", async () => {
    const fallback = (await call('GET', '/api/claimer')).data.fallback;
    expect((await call('PUT', '/api/claimer', { name: '  ana ' })).data).toEqual({ me: 'ana' });
    expect((await call('GET', '/api/claimer')).data).toEqual({ me: 'ana', saved: 'ana', fallback });
    const anas = (await call('POST', '/api/find/claim', { recipe: 'product-in-a-price-range' })).data.claims[0];
    expect(anas.claimedBy).toBe('ana');

    await call('PUT', '/api/claimer', { name: 'ben' });
    const refused = await call('POST', `/api/claims/${anas.id}/release`);
    expect(refused.data.error.message).toBe(`Claim #${anas.id} (products ${anas.key}) is ana's, not yours.`);
    expect((await call('POST', `/api/claims/${anas.id}/extend`, { duration: '1h' })).status).toBe(400);
    expect((await call('POST', `/api/claims/${anas.id}/release`, { force: true })).data.released).toHaveLength(1);

    expect((await call('PUT', '/api/claimer', { name: '' })).data).toEqual({ me: fallback });
    expect((await call('PUT', '/api/claimer', { name: 7 })).status).toBe(400);
  });

  it('checks every recipe', async () => {
    const { results } = (await call('POST', '/api/recipes/check')).data;
    expect(results).toHaveLength(6);
    expect(results.filter((r: { status: string }) => r.status === 'error')).toEqual([]);
  });

  it('rejects bad input clearly', async () => {
    expect((await call('POST', '/api/find', { recipe: 'nope' })).data.error.message).toMatch(/^There is no recipe "nope"/);
    expect((await call('POST', '/api/find', { recipe: 'product-low-on-stock', params: { max_stock: 'lots' } })).data.error.message).toBe(':max_stock must be a whole number, not "lots".');
    expect((await call('POST', '/api/find', { recipe: 'product-low-on-stock', params: ['x'] })).data.error.message).toBe('"params" must be an object.');
    expect((await call('POST', '/api/find/claim', { recipe: 'product-low-on-stock', duration: 'forever' })).data.error.message).toBe('"forever" is not a duration.');
  });
});

describe('seeding and cleaning through the web app', () => {
  const demo = join(process.cwd(), 'demo', 'scenarios');

  it('asks for a scenario folder first, then lists and checks the scenarios', async () => {
    expect((await call('GET', '/api/scenarios')).data).toEqual({ path: '', scenarios: [], error: null });
    expect((await call('POST', '/api/seed', { scenario: 'x' })).data.error.message).toBe('Choose a scenario folder first.');
    expect((await call('PUT', '/api/scenarios', { path: `"${demo}"` })).data).toEqual({ ok: true, path: demo });
    const { scenarios } = (await call('GET', '/api/scenarios')).data;
    expect(scenarios.map((s: { id: string }) => s.id)).toEqual(['low-stock-product', 'new-customer', 'two-orders', 'underpaid-order']);
    expect(scenarios[2]).toEqual({
      id: 'two-orders', name: 'Customer with two orders', description: expect.any(String), tags: ['orders', 'customers'],
      params: [{ name: 'status', type: 'text', default: 'PAID', description: 'Status of the first order' }], file: 'two-orders.yml', tables: ['customers'],
    });
    const { results } = (await call('POST', '/api/scenarios/check')).data;
    expect(results.map((r: { status: string }) => r.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  it('seeds (or dry-runs) a scenario, lists the run, previews the clean and does it', async () => {
    await call('PUT', '/api/claimer', { name: 'ana' });
    const dry = (await call('POST', '/api/seed', { scenario: 'two-orders', dryRun: true, params: { status: 'PENDING' } })).data;
    expect(dry).toMatchObject({ runId: null, dryRun: true, params: { status: 'PENDING' } });
    expect(dry.rows).toHaveLength(9);

    const r = (await call('POST', '/api/seed', { scenario: 'two-orders', note: 'TC-9' })).data;
    expect(r.runId).toMatch(/^\d+$/);
    const runs = (await call('GET', '/api/runs')).data;
    expect(runs).toMatchObject({ me: 'ana', runs: [{ id: r.runId, scenario: 'Customer with two orders', createdBy: 'ana', note: 'TC-9', rows: 9 }] });

    const preview = (await call('POST', '/api/clean', { runIds: [r.runId] })).data;
    expect(preview).toMatchObject({ applied: false, backup: null, plan: { kind: 'run', title: `Run #${r.runId} · Customer with two orders` } });
    expect(preview.plan.actions).toHaveLength(9);
    const done = (await call('POST', '/api/clean', { runIds: [r.runId], apply: true })).data;
    expect(done.applied).toBe(true);
    expect((await call('GET', '/api/runs')).data.runs).toEqual([]);

    // The backup is listed for this database, and restoring it is previewed first.
    const { backups } = (await call('GET', '/api/backups')).data;
    expect(backups[0]).toMatchObject({ file: done.backup, changes: 9 });
    expect((await call('POST', '/api/restore', { file: done.backup })).data.plan.actions).toHaveLength(9);
    expect((await call('POST', '/api/restore', { file: done.backup, apply: true })).data.applied).toBe(true);
    // Only files from the backup folder can be named.
    expect((await call('POST', '/api/restore', { file: join(dir, '..', 'elsewhere.json') })).data.error.message).toMatch(/^Can't find the backup .*elsewhere\.json\.$/);
    await call('PUT', '/api/claimer', { name: '' });
  });

  it('undoes a recorded session', async () => {
    await call('POST', '/api/record/start', { name: 'Web undo' });
    await db.query("UPDATE customers SET name = 'Changed' WHERE id = 2");
    const stopped = (await call('POST', '/api/record/stop')).data;
    const preview = (await call('POST', '/api/clean', { sessionId: stopped.id })).data;
    expect(preview.plan.actions).toMatchObject([{ op: 'update', table: 'public.customers', key: { id: 2 }, set: { name: 'Bob Checker' } }]);
    await call('POST', '/api/clean', { sessionId: stopped.id, apply: true });
    expect((await db.query('SELECT name FROM customers WHERE id = 2')).rows[0].name).toBe('Bob Checker');
  });

  it('creates data for a recipe that finds none', async () => {
    const r = (await call('POST', '/api/find/seed', { recipe: 'order-whose-payment-doesn-t-match-its-total' })).data;
    expect(r.seeded).toMatchObject({ scenario: 'Underpaid order', rows: 4 });
    expect(r.result.rows).toHaveLength(1);
    expect((await call('POST', '/api/find/seed', { recipe: 'product-in-a-price-range' })).data.error.message).toBe('"Product in a price range" doesn\'t say how to create its data.');
  });

  it('rejects bad input clearly', async () => {
    expect((await call('POST', '/api/seed', { scenario: 'nope' })).data.error.message).toMatch(/^There is no scenario "nope"/);
    expect((await call('POST', '/api/seed', { scenario: 'low-stock-product', params: { stock: 'few' } })).data.error.message).toBe(':stock must be a whole number, not "few".');
    expect((await call('POST', '/api/clean', {})).data.error.message).toBe('Nothing to clean.');
    expect((await call('POST', '/api/clean', { runIds: '7' })).data.error.message).toBe('"runIds" must be a list of run ids.');
    expect((await call('POST', '/api/clean', { runIds: ['999'] })).data.error.message).toBe('There is no seed run #999.');
  });
});

describe('settings file', () => {
  it('reports a broken file instead of treating it as empty (and losing connections)', async () => {
    await writeFile(process.env.PROPMASTER_UI_CONFIG!, '{ "profiles": [ broken');
    const res = await call('GET', '/api/config');
    expect(res.status).toBe(400);
    expect(res.data.error.message).toMatch(/Can't read the settings file/);
  });
});
