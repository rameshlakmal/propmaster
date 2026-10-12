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
  recipesPath?: string;
  scenariosPath?: string;
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
  autoSplitMs: number | null;
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

export interface SessionPage {
  sessions: SessionSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ColumnChange {
  column: string;
  /** As written in SQL: 'text', 84.50, NULL. */
  before: string | null;
  after: string | null;
  changed: boolean;
  beforeKind: ValueKind | null;
  afterKind: ValueKind | null;
  /** An updated JSON value: the paths inside it that changed. */
  jsonChanges?: { path: string; before: string | null; after: string | null }[];
}

export type ValueKind = 'null' | 'text' | 'number' | 'boolean' | 'timestamp' | 'date' | 'json';

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
  /** Named by Propmaster from its changes (auto steps). */
  auto: boolean;
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
  /** Auto steps: the quiet gap (ms) that ends a step. */
  autoSplitMs: number | null;
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

// ---------- Test Data Finder ----------

export interface RecipeParam {
  name: string;
  type: 'text' | 'int' | 'bigint' | 'numeric' | 'boolean' | 'date' | 'timestamptz' | 'interval';
  default?: string;
  description?: string;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  tags: string[];
  params: RecipeParam[];
  claim?: { table: string; via?: string };
  seed?: string;
  sql: string;
  file: string;
  line: number;
}

export interface RecipesSource {
  path: string;
  recipes: Recipe[];
  error: string | null;
}

export interface ClaimRow {
  id: string;
  table: string;
  key: string;
  claimedBy: string;
  recipe: string | null;
  note: string | null;
  claimedAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface FoundRow {
  values: Record<string, unknown>;
  key: string | null;
  claimedBy: ClaimRow | null;
}

export interface FindResult {
  recipe: { id: string; name: string; file: string; line: number; seed?: string };
  params: Record<string, string>;
  columns: string[];
  rows: FoundRow[];
  matches: number;
  /** More than `matches` rows match: counting stopped there. */
  moreMatches: boolean;
  claimed: number;
  claim: { table: string; keyColumn: string; column: string } | null;
  ms: number;
}

export interface RecipeCheck {
  recipe: { id: string; name: string; file: string; line: number };
  status: 'ok' | 'empty' | 'error';
  how: 'run' | 'explain';
  matches: number | null;
  ms: number;
  error?: string;
}

// ---------- Seeder & Cleaner ----------

export interface Scenario {
  id: string;
  name: string;
  description: string;
  tags: string[];
  params: RecipeParam[];
  file: string;
  /** The tables written at the top of its seed: section. */
  tables: string[];
}

export interface ScenariosSource {
  path: string;
  scenarios: Scenario[];
  error: string | null;
}

export type Row = Record<string, unknown>;

export interface CreatedRow {
  seq: number;
  table: string;
  key: Row;
  values: Row;
  alias?: string;
  auto: boolean;
}

export interface SeedResult {
  scenario: { id: string; name: string; file: string };
  params: Record<string, string>;
  runId: string | null;
  dryRun: boolean;
  rows: CreatedRow[];
  ms: number;
}

export interface ScenarioCheck {
  scenario: { id: string; name: string; file: string };
  status: 'ok' | 'skipped' | 'error';
  rows: number;
  ms: number;
  error?: string;
}

export interface Run {
  id: string;
  scenario: string;
  file: string | null;
  params: Record<string, string>;
  createdBy: string;
  note: string | null;
  createdAt: string;
  cleanedAt: string | null;
  cleanedBy: string | null;
  rows: number;
  tables: Record<string, number>;
}

export interface Diff {
  column: string;
  from: unknown;
  to: unknown;
}

export type CleanAction =
  | { op: 'delete'; table: string; key: Row; row: Row; why: 'seeded' | 'inserted'; changed: Diff[] }
  | { op: 'delete'; table: string; key: Row; row: Row; why: 'dependent'; via: string; depth: number }
  | { op: 'update'; table: string; key: Row; set: Row; current: Row; why: 'updated' }
  | { op: 'insert'; table: string; key: Row; row: Row; why: 'deleted' };

export interface CleanPlan {
  kind: 'run' | 'session' | 'restore' | 'mixed';
  title: string;
  actions: CleanAction[];
  skipped: { table: string; key: Row | null; reason: 'gone' | 'conflict' | 'no-key' | 'truncate'; detail: string }[];
  claimed: { table: string; key: Row; claim: ClaimRow }[];
  unkeyedDependents: { table: string; via: string; count: number }[];
}

export interface CleanResult {
  plan: CleanPlan;
  applied: boolean;
  backup: string | null;
  releasedClaims: number;
}

export interface BackupInfo {
  file: string;
  title: string;
  database: string;
  createdAt: string;
  changes: number;
}
