import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { parseJsonExact } from '../src/core/json.js';
import { formatDuration, formatValue, utcOffset } from '../src/recorder/format.js';
import { changeRow, formatTimeline } from '../src/recorder/timeline.js';
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

describe('changeRow', () => {
  const text = (cells: ReturnType<typeof changeRow>) => cells.map((cl) => cl.map((para) => para.map((t) => t.text).join(' ')));

  it('puts the operation, table, key and new values of an insert in four cells', () => {
    expect(text(changeRow(change({ newValues: { id: 1043, status: 'PENDING', total: 84.5 }, rowKey: { id: 1043 } }), colors)))
      .toEqual([['insert'], ['orders'], ['id=1043'], ["status='PENDING' total=84.5"]]);
  });

  it('gives each changed column of an update its own line, old → new', () => {
    expect(text(changeRow(change({
      op: 'UPDATE', tableName: 'inventory', rowKey: { product_id: 7 },
      oldValues: { stock: 12, note: 'a' }, newValues: { stock: 10, note: 'b' },
    }), colors))).toEqual([['update'], ['inventory'], ['product_id=7'], ['stock 12 → 10', "note 'a' → 'b'"]]);
  });

  it('shows the old values of a deleted row without a primary key', () => {
    expect(text(changeRow(change({ op: 'DELETE', tableName: 'events', rowKey: null, oldValues: { kind: 'click' } }), colors)))
      .toEqual([['delete'], ['events'], ['(no primary key)'], ["kind='click'"]]);
  });

  it('shows deletes with a key, truncates, and other schemas', () => {
    expect(text(changeRow(change({ op: 'DELETE', tableSchema: 'billing', tableName: 'invoices' }), colors)))
      .toEqual([['delete'], ['billing.invoices'], ['id=1'], ['row removed']]);
    expect(text(changeRow(change({ op: 'TRUNCATE', rowKey: null }), colors))[3]).toEqual(['every row removed']);
  });
});

describe('formatTimeline', () => {
  it('shows a header, a bordered table per step with its count on the right, and a summary', () => {
    expect(formatTimeline(checkoutRecording(), { colors, width: 80 }).split('\n')).toEqual([
      '  PROPMASTER   Session #3 · checkout',
      ` qa_shop · 2026-10-07 10:00:00 → 10:00:09 (9s) · ${utcOffset(new Date('2026-10-07T10:00:00'))}`,
      '',
      ' STEP 1  Click Place Order                                             3 changes',
      ' ┌────────┬───────────┬──────────────┬─────────────────────────────────────────┐',
      ' │ Op     │ Table     │ Row          │ Changes                                 │',
      ' ├────────┼───────────┼──────────────┼─────────────────────────────────────────┤',
      ' │ update │ inventory │ product_id=3 │ stock 6 → 4                             │',
      " │ insert │ orders    │ id=1         │ customer_id=4 status='PENDING'          │",
      ' │        │           │              │ total=84.5                              │',
      " │        │           │              │ created_at='2026-10-07T05:32:08+00:00'  │",
      " │ insert │ payments  │ id=1         │ order_id=1 amount=84.5 method='CARD'    │",
      ' └────────┴───────────┴──────────────┴─────────────────────────────────────────┘',
      '',
      ' STEP 2  Open order page                                               0 changes',
      '   no database changes',
      '',
      ` ${'─'.repeat(78)}`,
      ' 3 changes · 3 tables · 2 inserts · 1 update',
    ]);
  });

  it('lines up the columns of every step', () => {
    const rec = checkoutRecording();
    rec.steps[2]!.changes.push(change({ op: 'UPDATE', tableName: 'x', rowKey: { id: 2 }, oldValues: { a: 1 }, newValues: { a: 2 } }));
    const borders = formatTimeline(rec, { colors, width: 80 }).split('\n').filter((l) => l.startsWith(' ┌'));
    expect(borders).toHaveLength(2);
    expect(borders[0]).toBe(borders[1]);
  });

  it('shows a running session, snapshot mode, notes and hidden changes', () => {
    const text = formatTimeline(
      recording([step(0, '(before first step)', [change()])], { stoppedAt: null, mode: 'snapshot', notes: ['Big table skipped.'] }),
      { colors, width: 80, hidden: 2 });
    expect(text).toContain('· snapshot mode  ● recording');
    expect(text).toContain(' ! Big table skipped.');
    expect(text).toMatch(/ STEP 0 {2}\(before first step\) +1 change/);
    expect(text).toContain('· 2 changes hidden by filters');
  });

  it('stays within the line width, even when narrow', () => {
    for (const width of [60, 80, 120]) {
      for (const line of formatTimeline(checkoutRecording(), { colors, width }).split('\n')) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });
});


describe('very long values', () => {
  const bigText = 'Lorem ipsum dolor sit amet. '.repeat(75); // about 2 KB
  const bigJson = { items: Array.from({ length: 200 }, (_, i) => ({ sku: `SKU-${i}`, qty: i })) };
  const rec = recording([step(1, 'Save a long note', [
    change({ tableName: 'notes', newValues: { id: 1, body: bigText, meta: bigJson } }),
    change({ op: 'UPDATE', tableName: 'notes', oldValues: { body: bigText }, newValues: { body: `${bigText}!` } }),
  ])]);

  it('are shortened in the timeline, which stays within the line width', () => {
    const lines = formatTimeline(rec, { colors, width: 100 }).split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    expect(lines.filter((l) => l.includes('…')).length).toBeGreaterThan(0);
    // JSON keeps its shape over several lines, but a big value stops after 15 of them.
    expect(lines.some((l) => /… \d+ more lines \(record export shows all\)/.test(l))).toBe(true);
    expect(lines.length).toBeLessThan(40);
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
