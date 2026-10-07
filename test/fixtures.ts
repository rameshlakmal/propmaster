import type { Change, Recording, Step } from '../src/recorder/types.js';

let nextId = 1;

export function change(overrides: Partial<Change> = {}): Change {
  return {
    id: nextId++, tableSchema: 'public', tableName: 'orders', op: 'INSERT',
    rowKey: { id: 1 }, oldValues: null, newValues: null,
    changedAt: new Date('2026-10-07T10:00:05'), txid: '700', dbUser: 'app', appName: 'shop-api', clientAddr: '10.0.0.5',
    ...overrides,
  };
}

export function step(seq: number, name: string, changes: Change[] = []): Step {
  return { seq, name, startedAt: new Date('2026-10-07T10:00:00'), changes };
}

export function recording(steps: Step[], overrides: Partial<Recording> = {}): Recording {
  return {
    id: '3', mode: 'trigger', name: 'checkout', database: 'qa_shop', startedBy: 'qa',
    startedAt: new Date('2026-10-07T10:00:00'), stoppedAt: new Date('2026-10-07T10:00:09'),
    steps, columns: {}, notes: [],
    ...overrides,
  };
}

/** The demo checkout: one step that places an order, one that changes nothing. */
export function checkoutRecording(): Recording {
  return recording([
    step(0, '(before first step)'),
    step(1, 'Click Place Order', [
      change({ op: 'UPDATE', tableName: 'inventory', rowKey: { product_id: 3 }, oldValues: { stock: 6 }, newValues: { stock: 4 } }),
      change({ newValues: { id: 1, customer_id: 4, status: 'PENDING', total: 84.5, created_at: '2026-10-07T05:32:08+00:00' } }),
      change({ tableName: 'payments', newValues: { id: 1, order_id: 1, amount: 84.5, method: 'CARD' } }),
    ]),
    step(2, 'Open order page'),
  ], {
    columns: {
      'public.orders': [
        { name: 'id', type: 'integer' }, { name: 'customer_id', type: 'integer' }, { name: 'status', type: 'text' },
        { name: 'total', type: 'numeric(10,2)' }, { name: 'created_at', type: 'timestamp with time zone' },
      ],
    },
  });
}
