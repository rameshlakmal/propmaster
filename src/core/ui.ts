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

/** A small aligned table with a dim header row. */
export function table(c: Colors, headers: string[], rows: string[][], indent = 1): string[] {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ''))));
  const line = (cells: string[]) => ' '.repeat(indent) + cells.map((cell, i) => (i === cells.length - 1 ? cell : pad(cell, widths[i]!))).join('   ');
  return [c.dim(line(headers)), ...rows.map(line)];
}
