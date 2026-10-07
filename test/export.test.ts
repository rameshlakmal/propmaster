import { describe, expect, it } from 'vitest';
import { parseJsonExact } from '../src/core/json.js';
import { escapeHtml, toHtml } from '../src/recorder/export/html.js';
import { toMarkdown } from '../src/recorder/export/markdown.js';
import { quoteIdent, quoteLiteral, toSql } from '../src/recorder/export/sql.js';
import { createMasker } from '../src/recorder/mask.js';
import type { Row } from '../src/recorder/types.js';
import { change, checkoutRecording, recording, step } from './fixtures.js';

describe('Markdown export', () => {
  it('has a summary table and one table per step', () => {
    const md = toMarkdown(checkoutRecording(), { masked: true });
    expect(md).toContain('# Propmaster recording: checkout');
    expect(md).toContain('| Changes | 3 changes across 3 tables (2 inserts, 1 update) |');
    expect(md).toContain('## Step 1 · Click Place Order (3 changes)');
    expect(md).toContain('| UPDATE | inventory | product_id=3 | stock: 6 → **4** |');
    expect(md).toContain('## Step 2 · Open order page (0 changes)\n\n_No database changes._');
    expect(md).toContain('Sensitive values are masked.');
  });

  it('escapes pipes and HTML in values', () => {
    const md = toMarkdown(recording([step(1, 'x', [change({ newValues: { id: 1, note: 'a | b <script>' } })])]), { masked: false });
    expect(md).toContain("note='a \\| b &lt;script>'");
    expect(md).toContain('**Values are not masked.**');
  });
});

describe('HTML export', () => {
  it('escapes everything that comes from the database', () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
    const html = toHtml(recording([step(1, '<b>step</b>', [
      change({ tableName: '<t>', newValues: { id: 1, note: '</script><script>alert(1)</script>' } }),
    ])], { name: '"><svg onload=alert(1)>' }), { masked: true });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('<svg onload');
    expect(html).not.toContain('<b>step</b>');
    expect(html.match(/<script>/g)).toHaveLength(1); // only the page's own filter script
  });

  it('is a self-contained page with the steps, changes and highlighted updates', () => {
    const html = toHtml(checkoutRecording(), { masked: true, hidden: 2 });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<link|src="http/); // nothing loaded from outside
    expect(html).toContain('<title>checkout · Propmaster</title>');
    expect(html).toContain('Click Place Order');
    expect(html).toContain('data-op="UPDATE"');
    expect(html).toContain('<tr class="changed">');
    expect(html).toContain('2 changes hidden by filters');
    expect(html).toContain('data-filter-op="INSERT" aria-pressed="true">insert · 2</button>');
  });
});

describe('SQL export', () => {
  it('quotes identifiers and literals', () => {
    expect(quoteIdent('Order "Lines"')).toBe('"Order ""Lines"""');
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });

  it('checks the final state of each row, leaving out timestamps', () => {
    const sql = toSql(checkoutRecording());
    expect(sql).toContain('-- Left out of the checks: created_at (timestamp with time zone).');
    expect(sql).toContain(`(1, 'public.inventory product_id=3 was updated with stock', EXISTS (SELECT 1 FROM "public"."inventory" t WHERE to_jsonb(t.*) @> '{"product_id":3,"stock":4}'::jsonb))`);
    expect(sql).toContain(`'{"id":1,"customer_id":4,"status":"PENDING","total":84.5}'::jsonb`);
    expect(sql).toContain(' AS checks (step, check_name, pass)');
  });

  it('folds several changes to one row into its end state', () => {
    const rec = recording([
      step(1, 'create', [change({ rowKey: { id: 7 }, newValues: { id: 7, status: 'PENDING', note: 'a' } })]),
      step(2, 'pay', [change({ op: 'UPDATE', rowKey: { id: 7 }, oldValues: { status: 'PENDING' }, newValues: { status: 'PAID' } })]),
      step(3, 'renumber', [change({ op: 'UPDATE', rowKey: { id: 7 }, oldValues: { id: 7 }, newValues: { id: 8 } })]),
    ]);
    const sql = toSql(rec);
    expect(sql).toContain(`(3, 'public.orders id=8 was inserted with status, note', EXISTS (SELECT 1 FROM "public"."orders" t WHERE to_jsonb(t.*) @> '{"id":8,"status":"PAID","note":"a"}'::jsonb))`);
    expect(sql).toContain('-- 1 checks from 3 recorded changes.');
  });

  it('checks deleted rows are gone, including rows added and removed in the session', () => {
    const rec = recording([step(1, 'x', [
      change({ op: 'DELETE', rowKey: { id: 2 }, oldValues: { id: 2, status: 'PAID' } }),
      change({ rowKey: { id: 9 }, newValues: { id: 9, status: 'PENDING' } }),
      change({ op: 'DELETE', rowKey: { id: 9 }, oldValues: { id: 9, status: 'PENDING' } }),
    ])]);
    const sql = toSql(rec);
    expect(sql).toContain(`'public.orders id=2 was deleted', NOT EXISTS (SELECT 1 FROM "public"."orders" t WHERE to_jsonb(t.*) @> '{"id":2}'::jsonb)`);
    expect(sql).toContain(`'public.orders id=9 was added and removed again', NOT EXISTS`);
  });

  it('can ignore generated ids so checks survive a re-run', () => {
    const sql = toSql(checkoutRecording(), { ignoreColumns: ['id', 'order_id'] });
    expect(sql).toContain(`'{"customer_id":4,"status":"PENDING","total":84.5}'::jsonb`);
    expect(sql).toContain(`'{"amount":84.5,"method":"CARD"}'::jsonb`);
  });

  it('leaves masked columns out of the checks', () => {
    const rec = recording([step(1, 'signup', [change({ tableName: 'users', newValues: { id: 1, email: 'd@x.io', password: 'p', name: 'D' } })])]);
    const sql = toSql(rec, { masker: createMasker() });
    expect(sql).toContain(`'{"id":1,"name":"D"}'::jsonb`);
    expect(sql).toContain('-- Left out of the checks: email (masked), password (masked).');
  });

  it('keeps exact numbers in the JSON it compares with', () => {
    const newValues = parseJsonExact('{"id": 9007199254740993, "total": 84.50}') as Row;
    const sql = toSql(recording([step(1, 'x', [change({ rowKey: { id: newValues.id }, newValues })])]));
    expect(sql).toContain(`'{"id":9007199254740993,"total":84.50}'::jsonb`);
  });

  it('handles truncate, rows without a key, and nothing to check', () => {
    const rec = recording([step(1, 'x', [
      change({ tableName: 'logs', op: 'TRUNCATE', rowKey: null }),
      change({ tableName: 'views', rowKey: null, newValues: { path: '/cart' } }),
      change({ tableName: 'views', op: 'DELETE', rowKey: null, oldValues: { path: '/home' } }),
    ])]);
    const sql = toSql(rec);
    expect(sql).toContain(`'public.logs is empty (truncated)', NOT EXISTS (SELECT 1 FROM "public"."logs")`);
    expect(sql).toContain(`'public.views row was inserted with path', EXISTS (SELECT 1 FROM "public"."views" t WHERE to_jsonb(t.*) @> '{"path":"/cart"}'::jsonb)`);
    expect(sql).toContain('-- Not checked: DELETE on public.views (no primary key');

    expect(toSql(recording([step(1, 'x')]))).toContain('-- Nothing to check.');
  });

  it('has a strict form for CI', () => {
    const sql = toSql(checkoutRecording(), { strict: true });
    expect(sql).toContain('DO $propmaster_checks$');
    expect(sql).toContain("RAISE EXCEPTION E'Propmaster checks failed:\\n%', v_failed;");
    expect(sql).toContain("RAISE NOTICE 'All 3 Propmaster checks passed.';");
    expect(sql.trimEnd().endsWith('$propmaster_checks$;')).toBe(true);
  });
});
