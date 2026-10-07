import type { Recording, Row } from './types.js';

export const MASK = '••••••';

// Matched as whole words of the column name: "password_hash", "access_token" and "apiKey" match; "author" doesn't.
const SECRET_WORDS = /(^|_)(password|passwd|pwd|secret|token|api_?key|private_?key|salt|otp|pin|ssn|cvv|cvc|iban|card_?number|credit_?card)(_|$)/;
const EMAIL = /^([^@\s])[^@\s]*(@[^@\s]+\.[^@\s]+)$/;

export interface MaskOptions {
  /** Extra columns to hide completely, e.g. ["phone", "date_of_birth"]. */
  columns?: string[];
  /** Partly hide e-mail addresses in any column (default true). */
  emails?: boolean;
}

export interface MaskResult {
  value: unknown;
  masked: boolean;
}

export type Masker = (column: string, value: unknown) => MaskResult;

function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function isSecretColumn(column: string): boolean {
  return SECRET_WORDS.test(snakeCase(column));
}

export function createMasker(options: MaskOptions = {}): Masker {
  const extra = new Set((options.columns ?? []).map((c) => c.toLowerCase()));
  const emails = options.emails ?? true;

  return (column, value) => {
    if (value === null || value === undefined) return { value, masked: false };
    if (extra.has(column.toLowerCase()) || isSecretColumn(column)) return { value: MASK, masked: true };
    if (emails && typeof value === 'string') {
      const m = EMAIL.exec(value);
      if (m) return { value: `${m[1]}***${m[2]}`, masked: true };
    }
    return { value, masked: false };
  };
}

/** Leaves values unchanged. */
export const noMask: Masker = (_column, value) => ({ value, masked: false });

function maskRow(row: Row | null, masker: Masker): Row | null {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).map(([col, value]) => [col, masker(col, value).value]));
}

/** A copy of the recording with sensitive values hidden. */
export function maskRecording(rec: Recording, masker: Masker): Recording {
  return {
    ...rec,
    steps: rec.steps.map((s) => ({
      ...s,
      changes: s.changes.map((c) => ({
        ...c,
        rowKey: maskRow(c.rowKey, masker),
        oldValues: maskRow(c.oldValues, masker),
        newValues: maskRow(c.newValues, masker),
      })),
    })),
  };
}
