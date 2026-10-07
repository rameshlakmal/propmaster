import { describe, expect, it } from 'vitest';
import { toHtml } from '../src/recorder/export/html.js';
import { toMarkdown } from '../src/recorder/export/markdown.js';
import { jsonOf, prettyJson } from '../src/recorder/format.js';
import { formatTimeline } from '../src/recorder/timeline.js';
import { change, recording, step } from './fixtures.js';

const event = change({
  tableName: 'event', rowKey: { id: 7 },
  newValues: { id: 7, name: 'order_placed', data: { orderId: 66, items: [{ sku: 'A1', qty: 2 }], total: JSON.rawJSON('84.50') } },
});
const cartUpdate = change({
  op: 'UPDATE', tableName: 'cart', rowKey: { id: 3 },
  oldValues: { packages: '[{"name":"Box","goodsWeight":1000}]', shipping: { method: 'post' } },
  newValues: { packages: '[{"name":"Box","goodsWeight":500}]', shipping: { method: 'courier', eta: { days: 2 } } },
});
const rec = recording([step(1, 'Place order', [event, cartUpdate])]);

describe('JSON written over several lines', () => {
  it('recognises JSON in jsonb values and in text, and nothing else', () => {
    expect(jsonOf({ a: 1 })).toEqual({ a: 1 });
    expect(jsonOf(' [1, 2] ')).toEqual([1, 2]);
    expect([jsonOf('{oops'), jsonOf('plain'), jsonOf(5), jsonOf(null), jsonOf(JSON.rawJSON('84.50'))]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(prettyJson({ total: JSON.rawJSON('84.50'), n: [1] })).toBe('{\n  "total": 84.50,\n  "n": [\n    1\n  ]\n}');
  });

  it('prints JSON line by line in the terminal timeline, and changed paths for updates', () => {
    const out = formatTimeline(rec, { width: 110 });
    expect(out).toContain("name='order_placed'");
    expect(out).toMatch(/│ data= +│/);
    expect(out).toMatch(/│ {3}"orderId": 66, +│/); // indentation kept inside the cell
    expect(out).toMatch(/│ {5}\{ +│/);
    expect(out).toMatch(/│ {3}"total": 84\.50 +│/);
    expect(out).toMatch(/packages\[0\]\.goodsWeight 1000 → 500/);
    expect(out).toMatch(/shipping\.method "post" → "courier"/);
    expect(out).toMatch(/shipping\.eta added +│\n.*│ \{ +│\n.*│ {3}"days": 2 +│/);
  });

  it('shows at most 15 lines of one value in the terminal', () => {
    const big = recording([step(1, 'Big', [change({ tableName: 'event', rowKey: { id: 1 }, newValues: { id: 1, data: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])) } })])]);
    const out = formatTimeline(big, { width: 110 });
    expect(out).toContain('"k12": 12');
    expect(out).not.toContain('"k14": 14');
    expect(out).toContain('… 17 more lines (record export shows all)');
  });

  it('puts JSON in indented blocks in the HTML report', () => {
    const html = toHtml(rec, { masked: false });
    expect(html).toContain('<td class="after json"><pre class="json" tabindex="0" aria-label="after value, JSON">{\n  &quot;orderId&quot;: 66,');
    expect(html).toContain('<td class="before json"><pre class="json"');
  });

  it('puts JSON in code blocks below the step table in Markdown', () => {
    const md = toMarkdown(rec, { masked: false });
    expect(md).toContain("| INSERT | event | id=7 | name='order_placed'<br>data: JSON below |");
    expect(md).toContain('packages[0].goodsWeight: 1000 → **500**');
    expect(md).toContain('**event id=7 · data**\n\n```json\n{\n  "orderId": 66,\n  "items": [\n    {\n      "sku": "A1",');
    expect(md).toContain('**cart id=3 · shipping.eta (added)**\n\n```json\n{\n  "days": 2\n}\n```');
  });
});
