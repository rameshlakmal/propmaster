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
    expect(total).toEqual({ column: 'total', before: null, after: '84.50', changed: false }); // exact value, formatted on the server

    const stopped = (await call('POST', '/api/record/stop')).data;
    expect(stopped.stoppedAt).not.toBeNull();
    expect(stopped.summary).toMatchObject({ changes: 4, tables: 4 });
    expect((await call('GET', '/api/status')).data.active).toBeNull();
  });

  it('lists sessions and explains a missing one', async () => {
    expect((await call('GET', '/api/sessions')).data[0]).toMatchObject({ id, name: 'UI checkout', changeCount: 4 });
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

    const bad = await call('PUT', '/api/rules', { path: file, content: 'SELECT 1' });
    expect(bad.status).toBe(400); // never saves a file the checker can't read
    expect((await call('PUT', '/api/rules', { path: join(dir, 'notes.txt'), content })).status).toBe(400);
  });

  it('deletes a stopped session', async () => {
    expect((await call('DELETE', `/api/sessions/${id}`)).data).toEqual({ ok: true });
    expect((await call('GET', '/api/sessions')).data).toEqual([]);
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
