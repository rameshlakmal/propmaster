import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { boxTable, cell, colorEnabled, pad, spread, table, visibleLength, wrapItems } from '../src/core/ui.js';

const colored = pc.createColors(true);
const plain = pc.createColors(false);

describe('colour', () => {
  const tty = { isTTY: true } as NodeJS.WriteStream;
  const pipe = { isTTY: false } as NodeJS.WriteStream;

  it('is on for a terminal and off when piped to a file', () => {
    expect(colorEnabled({}, tty)).toBe(true);
    expect(colorEnabled({}, pipe)).toBe(false);
  });

  it('follows NO_COLOR and FORCE_COLOR', () => {
    expect(colorEnabled({ NO_COLOR: '1' }, tty)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: '1' }, pipe)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: '0' }, pipe)).toBe(false);
  });
});

describe('layout helpers', () => {
  it('measure and pad text the way it looks on screen, ignoring colour codes', () => {
    expect(visibleLength(colored.red('abc'))).toBe(3);
    expect(visibleLength(pad(colored.bold('ab'), 5))).toBe(5);
  });

  it('align the right part to the line width, or keep two spaces when it does not fit', () => {
    expect(spread(' left', colored.dim('right'), 20).replace(/\x1b\[[0-9;]*m/g, '')).toBe(' left          right');
    expect(spread('a long left part', 'right part', 20)).toBe('a long left part  right part');
  });

  it('wrap items under an indent', () => {
    expect(wrapItems(['alpha=1', 'beta=2', 'gamma=3', 'delta=4'], 4, 24)).toEqual(['    alpha=1 beta=2', '    gamma=3 delta=4']);
  });

  it('build aligned tables', () => {
    expect(table(plain, ['id', 'amount'], [['7', '84.50'], ['12', '9.00']], 2)).toEqual([
      '  id   amount',
      '  7    84.50',
      '  12   9.00',
    ]);
  });
});

describe('boxTable', () => {
  const style = (width: number, colors = plain) => ({ c: colors, width });
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('draws a header, rows and borders, sized to the content', () => {
    expect(boxTable(style(80), [{ header: 'Op' }, { header: 'Table' }], [[cell('insert'), cell('orders')]])).toEqual([
      ' ┌────────┬────────┐',
      ' │ Op     │ Table  │',
      ' ├────────┼────────┤',
      ' │ insert │ orders │',
      ' └────────┴────────┘',
    ]);
  });

  it('fills the width with the flex column and wraps text between words', () => {
    const out = boxTable(style(40), [{ header: 'Id' }, { header: 'Note', flex: true }],
      [[cell('1'), cell('one two three four five six seven eight nine ten')]]);
    for (const line of out) expect(line.length).toBe(40);
    expect(out[3]).toBe(' │ 1  │ one two three four five six    │');
    expect(out[4]).toBe(' │    │ seven eight nine ten           │');
  });

  it('shortens a value that is longer than its column, instead of cutting it across lines', () => {
    const out = boxTable(style(30), [{ header: 'Changes', flex: true }], [[[[{ text: `note='${'x'.repeat(60)}'`, shorten: true }]]]]);
    expect(out).toHaveLength(5);
    expect(out[3]).toMatch(/│ note='x+… │$/);
  });

  it('keeps the borders aligned when cells are coloured', () => {
    const out = boxTable(style(80, colored), [{ header: 'Op' }], [[cell('insert', colored.green)], [cell('delete', colored.red)]]);
    const widths = out.map((l) => strip(l).length);
    expect(new Set(widths).size).toBe(1);
  });
});
