// Lossless JSON: Postgres numerics and bigints can't always round-trip through a JS number
// (9007199254740993, 84.50). Such numbers are kept as their exact source text with JSON.rawJSON,
// which JSON.stringify writes back unquoted.

declare global {
  interface JSON {
    rawJSON(text: string): RawJSON;
    isRawJSON(value: unknown): value is RawJSON;
  }
}

export interface RawJSON {
  readonly rawJSON: string;
}

type Reviver = (this: unknown, key: string, value: unknown, context: { source?: string }) => unknown;

const keepExactNumbers: Reviver = (_key, value, context) =>
  typeof value === 'number' && context.source !== undefined && String(value) !== context.source
    ? JSON.rawJSON(context.source)
    : value;

export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, keepExactNumbers as Parameters<typeof JSON.parse>[1]);
}

export function isRawNumber(value: unknown): value is RawJSON {
  return JSON.isRawJSON(value);
}
