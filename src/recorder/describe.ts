// Plain-English names for what a group of changes did, e.g. "New order #66 with order item, payment · inventory stock 14 → 12".
// Used for auto steps: built from the changes alone, so the same changes always get the same name.
import { formatValue } from './format.js';
import type { Change, Row } from './types.js';

const MAX_PHRASES = 3;
const MAX_VALUE = 24;

/** "order_items" → "order item", "categories" → "category", "addresses" → "address". */
export function singular(table: string): string {
  const words = table.replace(/_/g, ' ');
  if (/ies$/.test(words)) return words.replace(/ies$/, 'y');
  if (/(ss|us|is)$/.test(words)) return words;
  if (/(sses|uses|xes|ches|shes|zes)$/.test(words)) return words.replace(/es$/, '');
  if (/s$/.test(words)) return words.replace(/s$/, '');
  return words;
}

function pluralWord(word: string, n: number): string {
  if (n === 1) return word;
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, 'ies');
  if (/(s|x|ch|sh|z)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/** "#66" for a single id column, "product_id 3" otherwise, or "" when there is no key. */
function keyText(key: Row | null): string {
  if (!key) return '';
  const entries = Object.entries(key);
  if (entries.length === 1 && /^(id|uuid)$/i.test(entries[0]![0])) return `#${plainValue(entries[0]![1])}`;
  return entries.map(([k, v]) => `${k} ${plainValue(v)}`).join(', ');
}

function plainValue(value: unknown): string {
  const text = formatValue(value, MAX_VALUE);
  return text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1) : text;
}

function label(change: Change): string {
  return change.tableSchema === 'public' ? change.tableName : `${change.tableSchema}.${change.tableName}`;
}

/** One phrase per table and operation, most telling first: inserts, then updates, deletes, truncates. */
function phrases(changes: Change[]): string[] {
  const groups = new Map<string, Change[]>();
  for (const c of changes) {
    const k = `${c.op}\u0000${label(c)}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const ordered = [...groups.values()].sort((a, b) =>
    ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].indexOf(a[0]!.op) - ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].indexOf(b[0]!.op));

  const inserts = ordered.filter((g) => g[0]!.op === 'INSERT');
  const out: string[] = [];

  // The first table inserted into is usually the parent ("order"); the others are its parts ("order item").
  if (inserts.length) {
    const [main, ...parts] = inserts;
    const word = singular(label(main![0]!));
    const head = main!.length === 1
      ? `New ${word}${keyText(main![0]!.rowKey) ? ` ${keyText(main![0]!.rowKey)}` : ''}`
      : `${main!.length} new ${pluralWord(word, main!.length)}`;
    const with_ = parts.map((g) => (g.length === 1 ? singular(label(g[0]!)) : `${g.length} ${pluralWord(singular(label(g[0]!)), g.length)}`));
    out.push(with_.length ? `${head} with ${with_.join(', ')}` : head);
  }

  for (const g of ordered) {
    const first = g[0]!;
    const word = singular(label(first));
    if (first.op === 'UPDATE') {
      const cols = [...new Set(g.flatMap((c) => Object.keys(c.newValues ?? {})))];
      if (g.length === 1 && cols.length === 1) {
        const col = cols[0]!;
        out.push(`${word} ${keyText(first.rowKey)} ${col} ${plainValue(first.oldValues?.[col])} → ${plainValue(first.newValues?.[col])}`.replace(/\s+/g, ' '));
      } else {
        const what = cols.length <= 2 ? cols.join(', ') : `${cols.slice(0, 2).join(', ')} +${cols.length - 2}`;
        out.push(g.length === 1 ? `${word} ${keyText(first.rowKey)} ${what} changed`.replace(/\s+/g, ' ') : `${g.length} ${pluralWord(word, g.length)} ${what} changed`);
      }
    } else if (first.op === 'DELETE') {
      out.push(g.length === 1 ? `${word} ${keyText(first.rowKey)} deleted`.replace(/\s+/g, ' ') : `${g.length} ${pluralWord(word, g.length)} deleted`);
    } else if (first.op === 'TRUNCATE') {
      out.push(`${label(first)} emptied`);
    }
  }
  return out;
}

/** A short name for what these changes did, or "No database changes". */
export function describeChanges(changes: Change[]): string {
  if (changes.length === 0) return 'No database changes';
  const all = phrases(changes);
  const shown = all.slice(0, MAX_PHRASES);
  const more = all.length - shown.length;
  const text = shown.join(' · ') + (more > 0 ? ` · +${more} more` : '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
