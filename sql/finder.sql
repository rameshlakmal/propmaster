-- Propmaster Test Data Finder: claims.
-- A claim marks a row as "in use by someone's test" until it expires, so two testers on a shared test
-- database don't pick the same customer. Recipes themselves never write; only claiming does.
-- Created on the first claim; safe to run more than once. Removed with the rest of Propmaster:
-- `propmaster uninstall` (DROP SCHEMA _propmaster CASCADE).

CREATE SCHEMA IF NOT EXISTS _propmaster;
COMMENT ON SCHEMA _propmaster IS 'Propmaster test-data toolkit. Remove it with: propmaster uninstall';

CREATE TABLE IF NOT EXISTS _propmaster.claims (
  id          bigserial PRIMARY KEY,
  -- The claimed row: its table as schema.table, and its primary key value as text.
  table_name  text NOT NULL,
  row_key     text NOT NULL,
  -- Who claimed it: the tester's name (their OS user unless they say otherwise), not the shared DB user.
  claimed_by  text NOT NULL,
  recipe      text,
  note        text,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- One claim per row. An expired claim stays until someone claims the row again (it is then taken over).
  UNIQUE (table_name, row_key),
  CHECK (expires_at > claimed_at)
);
CREATE INDEX IF NOT EXISTS claims_expires_idx ON _propmaster.claims (expires_at);
