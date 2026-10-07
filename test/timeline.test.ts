import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { parseJsonExact } from '../src/core/json.js';
import { formatDuration, formatValue, utcOffset } from '../src/recorder/format.js';
import { formatChange, formatTimeline } from '../src/recorder/timeline.js';
import { change, checkoutRecording, recording, step } from './fixtures.js';

const colors = pc.createColors(false);

describe('formatValue', () => {
  it('writes values like SQL literals', () => {
    expect(formatValue('PENDING')).toBe("'PENDING'");
    expect(formatValue(10)).toBe('10');
    expect(formatValue(null)).toBe('NULL');
    expect(formatValue(true)).toBe('true');
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });

  it('keeps exact numbers as Postgres wrote them', () => {
    const row = parseJsonExact('{"total": 84.50, "big": 9007199254740993}') as Record<string, unknown>;
    expect(formatValue(row.total)).toBe('84.50');
    expect(formatValue(row.big)).toBe('9007199254740993');
  });

  it('shortens long values and keeps them on one line', () => {
    expect(formatValue('x'.repeat(100), 40)).toBe(`'${'x'.repeat(39)}…'`);
    expect(formatValue('line 1\nline 2')).toBe("'line 1\\nline 2'");
  });
});

describe('formatChange', () => {
  it('shows an insert with its key first and other columns after', () => {
    const line = formatChange(change({ newValues: { id: 1043, status: 'PENDING', total: 84.5 }, rowKey: { id: 1043 } }), colors);
    expect(line).toBe("+ INSERT orders id=1043  status='PENDING' total=84.5");
  });

  it('shows only changed columns of an update as old → new', () => {
    const line = formatChange(change({
      op: 'UPDATE', tableName: 'inventory', rowKey: { product_id: 7 },
      oldValues: { stock: 12 }, newValues: { stock: 10 },
    }), colors);
    expect(line).toBe('~ UPDATE inventory product_id=7  stock: 12 → 10');
  });

  it('shows the old values of a deleted row without a primary key', () => {
    const line = formatChange(change({ op: 'DELETE', tableName: 'events', rowKey: null, oldValues: { kind: 'click' } }), colors);
    expect(line).toBe("- DELETE events (no primary key)  kind='click'");
  });

  it('shows a truncate', () => {
    expect(formatChange(change({ op: 'TRUNCATE', rowKey: null }), colors)).toBe('! TRUNCATE orders  (every row removed)');
  });

  it('prefixes non-public schemas', () => {
    const line = formatChange(change({ op: 'DELETE', tableSchema: 'billing', tableName: 'invoices' }), colors);
    expect(line).toBe('- DELETE billing.invoices id=1');
  });
});

describe('formatTimeline', () => {
  it('groups changes by step and hides an empty step 0', () => {
    const text = formatTimeline(checkoutRecording(), { colors });
    expect(text.split('\n')).toEqual([
      'Session #3 · checkout · qa_shop',
      `2026-10-07 10:00:00 → 10:00:09 (9s) · times in ${utcOffset(new Date('2026-10-07T10:00:00'))}`,
      '',
      'Step 1 · Click Place Order · 3 changes',
      '  ~ UPDATE inventory product_id=3  stock: 6 → 4',
      "  + INSERT orders id=1  customer_id=4 status='PENDING' total=84.5 created_at='2026-10-07T05:32:08+00:00'",
      "  + INSERT payments id=1  order_id=1 amount=84.5 method='CARD'",
      '',
      'Step 2 · Open order page · 0 changes',
      '  (no database changes)',
      '',
      'Total: 3 changes across 3 tables',
    ]);
  });

  it('shows a running session, snapshot mode, notes and hidden changes', () => {
    const text = formatTimeline(
      recording([step(0, '(before first step)', [change()])], { stoppedAt: null, mode: 'snapshot', notes: ['Big table skipped.'] }),
      { colors, hidden: 2 });
    expect(text).toContain('· snapshot mode');
    expect(text).toContain('● recording');
    expect(text).toContain('! Big table skipped.');
    expect(text).toContain('Step 0 · (before first step) · 1 change');
    expect(text).toContain('2 changes hidden by filters');
  });
});

describe('very long values', () => {
  const bigText = 'Lorem ipsum dolor sit amet. '.repeat(75); // about 2 KB
  const bigJson = { items: Array.from({ length: 200 }, (_, i) => ({ sku: `SKU-${i}`, qty: i })) };
  const rec = recording([step(1, 'Save a long note', [
    change({ tableName: 'notes', newValues: { id: 1, body: bigText, meta: bigJson } }),
    change({ op: 'UPDATE', tableName: 'notes', oldValues: { body: bigText }, newValues: { body: `${bigText}!` } }),
  ])]);

  it('keep the timeline to one short line per change', () => {
    const lines = formatTimeline(rec, { colors }).split('\n').filter((l) => l.startsWith('  '));
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.length).toBeLessThan(200);
    expect(lines[0]).toContain('…');
  });

  it('keep the full value in the HTML report, for the reader who needs it', async () => {
    const { toHtml } = await import('../src/recorder/export/html.js');
    const html = toHtml(rec, { masked: false });
    expect(html).toContain(bigText.trim());
    expect(html).toContain('SKU-199');
  });
});

describe('formatDuration', () => {
  it.each([[9, '9s'], [75, '1m 15s'], [3725, '1h 2m']])('%i seconds → %s', (s, text) => {
    expect(formatDuration(new Date(0), new Date(s * 1000))).toBe(text);
  });
});
