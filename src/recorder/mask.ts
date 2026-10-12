import { isRawNumber, parseJsonExact } from '../core/json.js';
import type { Recording, Row } from './types.js';

export const MASK = '••••••';

// Matched as whole words of the column name: "password_hash", "access_token" and "apiKey" match; "author" doesn't.
const SECRET_WORDS = /(^|_)(password|passwd|pwd|secret|token|api_?key|private_?key|salt|otp|pin|ssn|cvv|cvc|iban|card_?number|credit_?card)(_|$)/;
const EMAIL = /^([^@\s])[^@\s]*(@[^@\s]+\.[^@\s]+)$/;
// An address inside longer text ("Sent to dina@example.com, cc ..."): stops at spaces and punctuation.
const EMAIL_IN_TEXT = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

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

  const secret = (name: string) => extra.has(name.toLowerCase()) || isSecretColumn(name);

  // Inside JSON too: {"api_token": "..."} in a settings column is as secret as an api_token column.
  const deep = (value: unknown): MaskResult => {
    if (typeof value === 'string') {
      if (!emails) return { value, masked: false };
      const whole = EMAIL.exec(value);
      if (whole) return { value: `${whole[1]}***${whole[2]}`, masked: true };
      const masked = value.replace(EMAIL_IN_TEXT, (_m, first: string, domain: string) => `${first}***${domain}`);
      return { value: masked, masked: masked !== value };
    }
    if (value === null || typeof value !== 'object' || isRawNumber(value)) return { value, masked: false };
    let masked = false;
    const one = (k: string | null, v: unknown) => {
      if (k !== null && v !== null && v !== undefined && secret(k)) { masked = true; return MASK; }
      const r = deep(v);
      masked ||= r.masked;
      return r.value;
    };
    const out = Array.isArray(value) ? value.map((v) => one(null, v)) : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, one(k, v)]));
    return masked ? { value: out, masked } : { value, masked: false };
  };

  return (column, value) => {
    if (value === null || value === undefined) return { value, masked: false };
    if (secret(column)) return { value: MASK, masked: true };
    // JSON kept as text: mask inside it, and keep it text.
    if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
      try {
        const r = deep(parseJsonExact(value));
        if (r.masked) return { value: JSON.stringify(r.value), masked: true };
      } catch {
        // not JSON after all: treated as plain text below
      }
    }
    return deep(value);
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
