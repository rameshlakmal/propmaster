// Shared terminal styling, so every command looks the same: a one-space margin, the PROPMASTER badge,
// bold headings with counts aligned on the right, aligned columns, and secondary details dimmed.
// Colours switch off by themselves when output isn't a terminal (or NO_COLOR is set).
import pc from 'picocolors';

export type Colors = ReturnType<typeof pc.createColors>;

export interface Style {
  c: Colors;
  /** Line width to align and wrap to. */
  width: number;
}

/**
 * Colour only for a real terminal, so `propmaster record show > out.txt` writes plain text.
 * (picocolors on its own turns colour on for every Windows process, piped or not.) NO_COLOR and FORCE_COLOR win.
 */
export function colorEnabled(env = process.env, stdout = process.stdout): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return Boolean(stdout.isTTY);
}

const defaultColors = pc.createColors(colorEnabled());

export function makeStyle(options: { colors?: Colors; width?: number } = {}): Style {
  const columns = process.stdout.columns || Number(process.env.COLUMNS) || 100;
  return { c: options.colors ?? defaultColors, width: options.width ?? Math.min(Math.max(columns, 60), 120) };
}

const ANSI = /\x1b\[[0-9;]*m/g;

/** Length as shown on screen, ignoring colour codes. */
export function visibleLength(text: string): number {
  return text.replace(ANSI, '').length;
}

export function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

/** Left and right text on one line, the right part aligned to the line width. */
export function spread(left: string, right: string, width: number): string {
  const gap = width - visibleLength(left) - visibleLength(right);
  return gap >= 2 ? left + ' '.repeat(gap) + right : `${left}  ${right}`;
}

export function brand(c: Colors): string {
  return c.bgCyan(c.black(c.bold(' PROPMASTER ')));
}

export function divider(s: Style): string {
  return ` ${s.c.dim('─'.repeat(Math.max(10, s.width - 2)))}`;
}

/** A next-step hint: "   → propmaster record stop". */
export function hint(c: Colors, text: string): string {
  return `   ${c.dim(`→ ${text}`)}`;
}

export const icons = (c: Colors) => ({
  ok: c.green('✔'),
  warn: c.yellow('!'),
  fail: c.red('✖'),
  skip: c.dim('⊘'),
  rec: c.red('●'),
  idle: c.dim('○'),
  stop: c.green('■'),
  pause: c.yellow('‖'),
  flag: c.yellow('⚑'),
});

/** Puts space-separated items on as few lines as fit, every line indented. Long items get a line of their own. */
export function wrapItems(items: string[], indent: number, width: number): string[] {
  const lines: string[] = [];
  const room = Math.max(20, width - indent);
  let line = '';
  for (const item of items) {
    if (line && visibleLength(line) + 1 + visibleLength(item) > room) {
      lines.push(line);
      line = item;
    } else {
      line = line ? `${line} ${item}` : item;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => ' '.repeat(indent) + l);
}

// ---------- bordered tables ----------

/** A piece of cell text and how to colour it. Wrapping works on the plain text, colour is added after. */
export interface Token {
  text: string;
  style?: (s: string) => string;
  /** Too long for a whole line: shorten it with "…" instead of cutting it across lines. */
  shorten?: boolean;
}

/** A cell is a list of paragraphs; each paragraph is tokens joined by spaces, wrapped to the column width. */
export type Cell = Token[][];

/** A cell of ordinary text: it wraps between words. */
export const cell = (text: string, style?: (s: string) => string): Cell =>
  [text.trim() ? text.split(/ +/).filter(Boolean).map((word) => ({ text: word, style })) : [{ text, style }]];

export interface Column {
  header: string;
  /** Widest the column may get before it wraps. */
  max?: number;
  /** The column that takes the width left over (and wraps). One per table. */
  flex?: boolean;
}

/** Greedy word wrap of tokens; a token longer than the line is cut into pieces. */
function wrapTokens(tokens: Token[], width: number): Token[][] {
  const lines: Token[][] = [];
  let line: Token[] = [];
  let used = 0;
  for (const token of tokens) {
    let rest = token.shorten && token.text.length > width ? `${token.text.slice(0, width - 1)}…` : token.text;
    while (rest.length > 0) {
      const gap = line.length ? 1 : 0;
      const room = width - used - gap;
      if (rest.length <= room) {
        line.push({ ...token, text: rest });
        used += gap + rest.length;
        rest = '';
      } else if (line.length) {
        // Start a new line: a value is only ever cut when it is longer than a whole line.
        lines.push(line);
        line = [];
        used = 0;
      } else {
        line.push({ ...token, text: rest.slice(0, width) });
        lines.push(line);
        line = [];
        used = 0;
        rest = rest.slice(width);
      }
    }
  }
  if (line.length || lines.length === 0) lines.push(line);
  return lines;
}

const plainWidth = (paragraph: Token[]) => paragraph.reduce((n, t, i) => n + t.text.length + (i ? 1 : 0), 0);
const render = (line: Token[]) => line.map((t) => (t.style ? t.style(t.text) : t.text)).join(' ');

/** A table with box-drawing borders that fits the given width; the flex column (or the widest) wraps. */
export interface BoxOptions {
  header?: boolean;
  /** Rows to size the columns by, when several tables should line up (default: this table's rows). */
  measure?: Cell[][];
}

export function boxTable(s: Style, columns: Column[], rows: Cell[][], { header = true, measure = rows }: BoxOptions = {}): string[] {
  const { c } = s;
  const natural = columns.map((col, i) => Math.min(
    col.max ?? Infinity,
    Math.max(col.header.length, ...measure.map((r) => Math.max(0, ...(r[i] ?? []).map(plainWidth)))),
  ));

  // Each column costs its width plus 3 (space, content, space, border); the line has a margin and one more border.
  const budget = s.width - 2 - columns.length * 3;
  const widths = [...natural];
  let flex = columns.findIndex((col) => col.flex);
  if (flex === -1) flex = widths.indexOf(Math.max(...widths));
  const others = widths.reduce((n, w, i) => (i === flex ? n : n + w), 0);
  widths[flex] = columns[flex]!.flex
    ? Math.max(12, budget - others)
    : Math.min(widths[flex]!, Math.max(8, budget - others)); // only ever shrinks to fit, never grows

  const border = (l: string, m: string, r: string) => ` ${c.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r)}`;
  const bar = c.dim('│');
  const lines: string[] = [border('┌', '┬', '┐')];

  const emit = (cells: Cell[]) => {
    const wrapped = cells.map((cl, i) => cl.flatMap((para) => wrapTokens(para, widths[i]!)));
    const height = Math.max(1, ...wrapped.map((w) => w.length));
    for (let n = 0; n < height; n++) {
      const parts = wrapped.map((w, i) => {
        const line = w[n] ?? [];
        return ` ${render(line)}${' '.repeat(Math.max(0, widths[i]! - plainWidth(line)))} `;
      });
      lines.push(` ${bar}${parts.join(bar)}${bar}`);
    }
  };

  if (header) {
    emit(columns.map((col) => cell(col.header, (t) => c.bold(t))));
    lines.push(border('├', '┼', '┤'));
  }
  for (const row of rows) emit(row);
  lines.push(border('└', '┴', '┘'));
  return lines;
}

/** A small aligned table with a dim header row. */
export function table(c: Colors, headers: string[], rows: string[][], indent = 1): string[] {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))));
  const line = (cells: string[]) => ' '.repeat(indent) + cells.map((cell, i) => (i === cells.length - 1 ? cell : pad(cell, widths[i]!))).join('   ');
  return [c.dim(line(headers)), ...rows.map(line)];
}
