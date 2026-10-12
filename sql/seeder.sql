-- Propmaster Seeder & Cleaner: seed runs and the rows they created.
-- Every row a scenario inserts is listed here, by primary key, in the same transaction as the insert, so
-- cleanup can delete exactly those rows and nothing else. Created on the first seed; safe to run more than once.
-- Removed with the rest of Propmaster: `propmaster uninstall` (DROP SCHEMA _propmaster CASCADE). That
-- removes the tracking only, never the seeded rows themselves.

CREATE SCHEMA IF NOT EXISTS _propmaster;
COMMENT ON SCHEMA _propmaster IS 'Propmaster test-data toolkit. Remove it with: propmaster uninstall';

CREATE TABLE IF NOT EXISTS _propmaster.seed_runs (
  id          bigserial PRIMARY KEY,
  scenario    text NOT NULL,
  file        text,
  params      jsonb NOT NULL DEFAULT '{}',
  -- The tester (their OS user unless they say otherwise), not the shared DB user.
  created_by  text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  cleaned_at  timestamptz,
  cleaned_by  text
);

CREATE TABLE IF NOT EXISTS _propmaster.seeded_rows (
  run_id          bigint NOT NULL REFERENCES _propmaster.seed_runs (id) ON DELETE CASCADE,
  -- Order of creation: parents before children, so cleanup deletes in reverse.
  seq             int NOT NULL,
  table_schema    text NOT NULL,
  table_name      text NOT NULL,
  -- The primary key, e.g. {"id": 57}.
  row_key         jsonb NOT NULL,
  -- The whole row as inserted, to show what a test changed since.
  created_values  jsonb NOT NULL,
  -- The scenario's name for the row ($as), if any.
  alias           text,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS seeded_rows_table_idx ON _propmaster.seeded_rows (table_schema, table_name);
