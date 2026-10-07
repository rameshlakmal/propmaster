// Shapes of the server's JSON responses (see src/ui/server.ts and src/ui/view.ts).

export interface ApiError {
  message: string;
  hint?: string;
}

export interface Profile {
  name: string;
  url: string;
  display: string;
  rulesFile?: string;
}

export interface Config {
  active: string | null;
  profiles: Profile[];
}

export interface Finding {
  level: 'ok' | 'warn' | 'fail';
  text: string;
}

export interface Doctor {
  findings: Finding[];
  recommended: 'trigger' | 'snapshot' | null;
  grants: string[];
}

export interface ActiveSession {
  id: string;
  name: string;
  mode: 'trigger' | 'snapshot';
  startedAt: string;
  stepSeq: number;
  stepName: string;
  paused: boolean;
}

export interface Status {
  profile: Profile;
  installed: boolean;
  outdated: boolean;
  watchedTables: number;
  excludedTables: string[];
  active: ActiveSession | null;
}

export interface SessionSummary {
  id: string;
  mode: 'trigger' | 'snapshot';
  name: string;
  startedAt: string;
  stoppedAt: string | null;
  changeCount: number;
}

export interface ColumnChange {
  column: string;
  before: string | null;
  after: string | null;
  changed: boolean;
}

export interface Change {
  id: number;
  op: 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';
  table: string;
  key: string | null;
  columns: ColumnChange[];
  dbUser: string | null;
  appName: string | null;
  changedAt: string;
}

export interface Step {
  seq: number;
  name: string;
  startedAt: string;
  changes: Change[];
  markers: Marker[];
}

export interface Marker {
  kind: 'pause' | 'resume' | 'flag';
  note: string | null;
  at: string;
}

export interface Recording {
  id: string;
  mode: string;
  name: string;
  database: string;
  startedAt: string;
  stoppedAt: string | null;
  notes: string[];
  summary: { changes: number; tables: number; byOp: Record<string, number> };
  steps: Step[];
}

export interface RuleResult {
  rule: { name: string; sql: string; line: number };
  status: 'pass' | 'fail' | 'skipped' | 'error';
  scope: Record<string, number>;
  violations: Record<string, unknown>[];
  violationCount: number;
  error?: string;
}

export interface RulesFile {
  path: string;
  content: string;
  rules: { name: string; line: number }[];
  error: string | null;
}
