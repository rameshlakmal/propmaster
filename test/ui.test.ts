import pc from 'picocolors';
import { describe, expect, it } from 'vitest';
import { colorEnabled, pad, spread, table, visibleLength, wrapItems } from '../src/core/ui.js';

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
