import { describe, expect, it } from 'vitest';
import { bursts, splitSteps } from '../src/recorder/autosteps.js';
import { describeChanges, singular } from '../src/recorder/describe.js';
import { jsonChanges, toView, valueKind } from '../src/ui/view.js';
import { change, recording, step } from './fixtures.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 7, 10, 0, s));

describe('naming a group of changes', () => {
  it('turns table names into words', () => {
    expect(['orders', 'order_items', 'categories', 'addresses', 'status', 'statuses', 'boxes', 'inventory'].map(singular))
      .toEqual(['order', 'order item', 'category', 'address', 'status', 'status', 'box', 'inventory']);
  });

  it('names a checkout after the new order and its parts, then the stock update', () => {
    expect(describeChanges([
      change({ tableName: 'orders', rowKey: { id: 66 }, newValues: { id: 66 } }),
      change({ tableName: 'order_items', rowKey: { id: 70 }, newValues: { id: 70 } }),
      change({ tableName: 'payments', rowKey: { id: 12 }, newValues: { id: 12 } }),
      change({ op: 'UPDATE', tableName: 'inventory', rowKey: { product_id: 3 }, oldValues: { stock: 14 }, newValues: { stock: 12 } }),
    ])).toBe('New order #66 with order item, payment · inventory product_id 3 stock 14 → 12');
  });

  it('says what changed in an update, and counts many rows', () => {
    expect(describeChanges([change({ op: 'UPDATE', rowKey: { id: 66 }, oldValues: { status: 'PENDING' }, newValues: { status: 'CANCELLED' } })]))
      .toBe('Order #66 status PENDING → CANCELLED');
    expect(describeChanges([1, 2, 3].map((id) => change({ op: 'UPDATE', tableName: 'products', rowKey: { id }, oldValues: { price: 1, stock: 2, name: 'a' }, newValues: { price: 2, stock: 3, name: 'b' } }))))
      .toBe('3 products price, stock +1 changed');
  });

  it('names deletes, truncates and steps with nothing', () => {
    expect(describeChanges([change({ op: 'DELETE', tableName: 'carts', rowKey: { id: 4 }, oldValues: { id: 4 } })])).toBe('Cart #4 deleted');
    expect(describeChanges([change({ op: 'TRUNCATE', tableName: 'sessions', rowKey: null })])).toBe('Sessions emptied');
    expect(describeChanges([])).toBe('No database changes');
  });

  it('keeps long names short', () => {
    const many = ['a_logs', 'b_logs', 'c_logs', 'd_logs'].map((t) => change({ op: 'DELETE', tableName: t, rowKey: null }));
    expect(describeChanges(many)).toBe('A log deleted · b log deleted · c log deleted · +1 more');
  });
});

describe('splitting a session into steps at quiet gaps', () => {
  it('starts a new burst only after more than the gap', () => {
    const cs = [change({ changedAt: at(1) }), change({ changedAt: at(3) }), change({ changedAt: at(7) }), change({ changedAt: at(7) })];
    expect(bursts(cs, 3000).map((b) => b.length)).toEqual([2, 2]);
    expect(bursts(cs, 1000).map((b) => b.length)).toEqual([1, 1, 2]);
  });

  it('turns the untyped part of a session into named steps', () => {
    const rec = splitSteps(recording([step(0, '(before first step)', [
      change({ tableName: 'customers', rowKey: { id: 9 }, newValues: { id: 9 }, changedAt: at(2) }),
      change({ op: 'UPDATE', rowKey: { id: 1 }, oldValues: { status: 'PENDING' }, newValues: { status: 'PAID' }, changedAt: at(10) }),
    ])]), 3000);
    expect(rec.steps.map((s) => [s.seq, s.name, s.auto, s.changes.length])).toEqual([
      [1, 'New customer #9', true, 1],
      [2, 'Order #1 status PENDING → PAID', true, 1],
    ]);
    expect(rec.steps[1]!.startedAt).toEqual(at(10));
  });

  it('gives a typed name to the next action only, and keeps empty typed steps', () => {
    const typed = { ...step(1, 'Click Place Order', [
      change({ tableName: 'orders', rowKey: { id: 5 }, newValues: { id: 5 }, changedAt: at(20) }),
      change({ op: 'DELETE', tableName: 'carts', rowKey: { id: 2 }, oldValues: { id: 2 }, changedAt: at(30) }),
    ]), startedAt: at(18) };
    const rec = splitSteps(recording([step(0, '(before first step)'), typed, { ...step(2, 'Open my account'), startedAt: at(40) }]), 3000);
    expect(rec.steps.map((s) => [s.seq, s.name, s.auto])).toEqual([
      [1, 'Click Place Order', false],
      [2, 'Cart #2 deleted', true],
      [3, 'Open my account', false],
    ]);
  });

  it('keeps an empty session as the placeholder, and puts markers on the step they happened in', () => {
    expect(splitSteps(recording([step(0, '(before first step)')]), 3000).steps.map((s) => [s.seq, s.name])).toEqual([[0, '(before first step)']]);

    const rec = splitSteps(recording([{
      ...step(0, '(before first step)', [change({ changedAt: at(5) }), change({ changedAt: at(20) })]),
      markers: [{ kind: 'flag', note: 'early', at: at(1) }, { kind: 'flag', note: 'second action', at: at(21) }],
    }]), 3000);
    expect(rec.steps.map((s) => (s.markers ?? []).map((m) => m.note))).toEqual([['early'], ['second action']]);
  });
});

describe('value kinds for the web app', () => {
  it('tells times, dates, numbers, text and JSON apart', () => {
    expect([null, 84.5, true, '2026-10-07T15:25:00.612029+00:00', '2026-10-07 15:25:00', '2026-10-07', 'PENDING', { a: 1 }].map(valueKind))
      .toEqual(['null', 'number', 'boolean', 'timestamp', 'timestamp', 'date', 'text', 'json']);
  });

  it('keeps the structure of JSON, from jsonb columns and from text that holds JSON, with exact numbers', () => {
    expect(['{"a": 1}', '[1, 2]', '{not json', '[draft]', '"quoted"'].map(valueKind)).toEqual(['json', 'json', 'text', 'text', 'text']);
    const view = toView(recording([step(1, 'Save settings', [change({
      tableName: 'settings', rowKey: { id: 1 },
      newValues: { id: 1, data: { theme: { dark: true }, ids: [1, 2], price: JSON.rawJSON('84.50') }, raw: '{"a":[1]}' },
    })])]));
    const columns = view.steps[0]!.changes[0]!.columns;
    expect(columns.find((c) => c.column === 'data')).toMatchObject({
      afterKind: 'json',
      after: `{
  "theme": {
    "dark": true
  },
  "ids": [
    1,
    2
  ],
  "price": 84.50
}`,
    });
    expect(columns.find((c) => c.column === 'raw')).toMatchObject({ afterKind: 'json', after: `{
  "a": [
    1
  ]
}` });
  });
});

describe('what changed inside JSON', () => {
  it('lists each changed path, including added and removed keys and array items', () => {
    expect(jsonChanges(
      { packages: [{ name: 'Box', goodsWeight: 1000 }], tags: ['a'], 'odd key': 1, gone: true },
      { packages: [{ name: 'Box', goodsWeight: 500 }], tags: ['a', 'b'], 'odd key': 2, added: null },
    )).toEqual([
      { path: 'packages[0].goodsWeight', before: '1000', after: '500' },
      { path: 'tags[1]', before: null, after: '"b"' },
      { path: '["odd key"]', before: '1', after: '2' },
      { path: 'gone', before: 'true', after: null },
      { path: 'added', before: null, after: 'null' },
    ]);
    expect(jsonChanges([1], { a: 1 })).toEqual([{ path: '(whole value)', before: '[1]', after: '{"a":1}' }]);
    expect(jsonChanges({ price: JSON.rawJSON('84.50') }, { price: JSON.rawJSON('84.50') })).toEqual([]);
  });

  it('comes with updated JSON columns in the web view', () => {
    const view = toView(recording([step(1, 'Ship', [change({
      op: 'UPDATE', tableName: 'cart', rowKey: { id: 3 },
      oldValues: { packages: [{ w: 1000 }] }, newValues: { packages: [{ w: 500 }] },
    })])]));
    expect(view.steps[0]!.changes[0]!.columns[0]!.jsonChanges).toEqual([{ path: '[0].w', before: '1000', after: '500' }]);
  });
});
