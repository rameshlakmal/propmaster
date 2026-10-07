-- Propmaster DB Change Recorder.
-- Everything lives in the _propmaster schema, so `DROP SCHEMA _propmaster CASCADE`
-- removes the recorder completely, triggers included.
-- Safe to run more than once: re-running upgrades an older install in place.
--
-- Design:
-- * Statement-level AFTER triggers with transition tables (REFERENCING OLD/NEW TABLE). Each INSERT,
--   UPDATE or DELETE statement calls the trigger once and records all its rows with one set-based
--   INSERT ... SELECT. One exception block per statement, never one subtransaction per row.
-- * Triggers on tables the recorder owns are disabled while idle, so they cost nothing then.
--   The one-row switch in _propmaster.state is the backstop for tables it can't disable.

CREATE SCHEMA IF NOT EXISTS _propmaster;
COMMENT ON SCHEMA _propmaster IS 'Propmaster test-data recorder. Remove it with: propmaster uninstall';

CREATE TABLE IF NOT EXISTS _propmaster.sessions (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at  timestamptz,
  started_by  text NOT NULL DEFAULT session_user
);

CREATE TABLE IF NOT EXISTS _propmaster.steps (
  id          bigserial PRIMARY KEY,
  session_id  bigint NOT NULL REFERENCES _propmaster.sessions (id) ON DELETE CASCADE,
  seq         int NOT NULL,
  name        text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, seq)
);

-- One row per captured row change, and one per TRUNCATE statement.
-- For updates, old_values/new_values hold only the columns that changed.
-- This is the only high-volume table, so it is built for write speed:
-- * UNLOGGED: no write-ahead log, so recording costs about half as much. Still transactional (rolled-back
--   app changes disappear), but emptied after a server crash. Recordings are test evidence, not business data.
-- * No foreign keys: a FK check per captured row was the biggest single cost, and one more way a capture
--   could fail. delete_session() and prune() remove a session's changes explicitly.
CREATE UNLOGGED TABLE IF NOT EXISTS _propmaster.changes (
  id            bigserial PRIMARY KEY,
  session_id    bigint NOT NULL,
  step_id       bigint NOT NULL,
  table_schema  text NOT NULL,
  table_name    text NOT NULL,
  op            text NOT NULL,
  row_key       jsonb,
  old_values    jsonb,
  new_values    jsonb,
  changed_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid          bigint NOT NULL DEFAULT txid_current(),
  db_user       text NOT NULL DEFAULT session_user,
  app_name      text DEFAULT current_setting('application_name', true),
  client_addr   inet DEFAULT inet_client_addr()
);
CREATE INDEX IF NOT EXISTS changes_session_idx ON _propmaster.changes (session_id, id);

-- The on/off switch: a single row. When session_id is NULL, triggers return immediately.
CREATE TABLE IF NOT EXISTS _propmaster.state (
  singleton   boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  session_id  bigint REFERENCES _propmaster.sessions (id) ON DELETE SET NULL,
  step_id     bigint REFERENCES _propmaster.steps (id) ON DELETE SET NULL
);
INSERT INTO _propmaster.state DEFAULT VALUES ON CONFLICT DO NOTHING;
-- While paused, a session stays open but nothing is recorded (setup the tester doesn't want in the test).
ALTER TABLE _propmaster.state ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
-- Auto steps: the session is split into steps at quiet gaps of this many milliseconds (NULL: steps are typed).
ALTER TABLE _propmaster.sessions ADD COLUMN IF NOT EXISTS auto_split_ms integer CHECK (auto_split_ms > 0);

-- Things the tester marks during a session: pauses, resumes, and flags ("this looks wrong") with a note.
CREATE TABLE IF NOT EXISTS _propmaster.markers (
  id          bigserial PRIMARY KEY,
  session_id  bigint NOT NULL REFERENCES _propmaster.sessions (id) ON DELETE CASCADE,
  step_id     bigint NOT NULL REFERENCES _propmaster.steps (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('pause', 'resume', 'flag')),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Busy or irrelevant tables (sessions, logs, queues) that should never get triggers.
CREATE TABLE IF NOT EXISTS _propmaster.excluded_tables (
  table_schema  text NOT NULL,
  table_name    text NOT NULL,
  PRIMARY KEY (table_schema, table_name)
);


-- The primary key part of a row, e.g. {"id": 7}; NULL for tables without a primary key.
CREATE OR REPLACE FUNCTION _propmaster.key_of(p_row jsonb, p_key_columns text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN cardinality(p_key_columns) > 0
              THEN (SELECT jsonb_object_agg(c, p_row -> c) FROM unnest(p_key_columns) AS c) END;
$$;


-- The capture trigger: one call per INSERT, UPDATE or DELETE statement.
-- Primary key column names arrive as trigger arguments (TG_ARGV), read once when attaching.
-- SECURITY DEFINER lets the app's DB user write to _propmaster without extra grants.
CREATE OR REPLACE FUNCTION _propmaster.capture_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_state  _propmaster.state;
BEGIN
  -- Idle check stays outside the exception block: no subtransaction cost when not recording.
  SELECT * INTO v_state FROM _propmaster.state;
  IF v_state.session_id IS NULL OR v_state.paused THEN
    RETURN NULL;
  END IF;

  -- Any failure here must never break the app's own write, so errors become warnings.
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO _propmaster.changes (session_id, step_id, table_schema, table_name, op, row_key, new_values)
      SELECT v_state.session_id, v_state.step_id, TG_TABLE_SCHEMA, TG_TABLE_NAME, 'INSERT',
             _propmaster.key_of(r.j, TG_ARGV), r.j
        FROM (SELECT to_jsonb(n.*) AS j FROM new_rows n) r;

    ELSIF TG_OP = 'DELETE' THEN
      INSERT INTO _propmaster.changes (session_id, step_id, table_schema, table_name, op, row_key, old_values)
      SELECT v_state.session_id, v_state.step_id, TG_TABLE_SCHEMA, TG_TABLE_NAME, 'DELETE',
             _propmaster.key_of(r.j, TG_ARGV), r.j
        FROM (SELECT to_jsonb(o.*) AS j FROM old_rows o) r;

    ELSE
      -- Postgres fills both transition tables row by row in the same order, so position N of
      -- old_rows and position N of new_rows are the same row. That also pairs rows of tables
      -- without a primary key, and rows whose key itself changed.
      INSERT INTO _propmaster.changes (session_id, step_id, table_schema, table_name, op, row_key, old_values, new_values)
      SELECT v_state.session_id, v_state.step_id, TG_TABLE_SCHEMA, TG_TABLE_NAME, 'UPDATE',
             _propmaster.key_of(p.o, TG_ARGV), d.old_values, d.new_values
        FROM unnest(ARRAY(SELECT to_jsonb(o.*) FROM old_rows o),
                    ARRAY(SELECT to_jsonb(n.*) FROM new_rows n)) WITH ORDINALITY AS p (o, n, ord)
       CROSS JOIN LATERAL (
              SELECT jsonb_object_agg(e.key, e.value) AS old_values,
                     jsonb_object_agg(e.key, p.n -> e.key) AS new_values
                FROM jsonb_each(p.o) AS e
               WHERE e.value IS DISTINCT FROM p.n -> e.key) d
       WHERE d.old_values IS NOT NULL  -- rows the UPDATE didn't actually change
       ORDER BY p.ord;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'propmaster: could not record % on %.%: %', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLERRM;
  END;

  RETURN NULL;  -- AFTER trigger: the return value is ignored
END $$;


-- TRUNCATE has no rows to capture, so this records that the table was emptied.
CREATE OR REPLACE FUNCTION _propmaster.capture_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_state  _propmaster.state;
BEGIN
  SELECT * INTO v_state FROM _propmaster.state;
  IF v_state.session_id IS NULL OR v_state.paused THEN
    RETURN NULL;
  END IF;

  BEGIN
    INSERT INTO _propmaster.changes (session_id, step_id, table_schema, table_name, op)
    VALUES (v_state.session_id, v_state.step_id, TG_TABLE_SCHEMA, TG_TABLE_NAME, 'TRUNCATE');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'propmaster: could not record TRUNCATE on %.%: %', TG_TABLE_SCHEMA, TG_TABLE_NAME, SQLERRM;
  END;

  RETURN NULL;
END $$;


-- Tables the recorder can watch: ordinary, partitioned and partition tables it may add triggers to.
-- Statement triggers fire only for the table a statement names, so partitions and inheritance
-- children get their own triggers without anything being recorded twice.
CREATE OR REPLACE VIEW _propmaster.candidate_tables AS
SELECT c.oid,
       n.nspname AS table_schema,
       c.relname AS table_name,
       pg_has_role(c.relowner, 'USAGE') AS owned,
       (SELECT string_agg(quote_literal(a.attname), ', ' ORDER BY k.ord)
          FROM pg_index i
         CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k (attnum, ord)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE i.indrelid = c.oid AND i.indisprimary) AS key_args,
       EXISTS (SELECT 1 FROM _propmaster.excluded_tables x
                WHERE x.table_schema = n.nspname AND x.table_name = c.relname) AS excluded
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p')
   AND n.nspname NOT IN ('information_schema', '_propmaster')
   AND n.nspname NOT LIKE 'pg\_%'
   AND has_table_privilege(c.oid, 'TRIGGER');

-- The recorder's triggers: name, event, and the REFERENCING clause each one needs.
CREATE OR REPLACE VIEW _propmaster.trigger_kinds (name, event, referencing) AS
VALUES ('propmaster_insert', 'INSERT', 'REFERENCING NEW TABLE AS new_rows'),
       ('propmaster_update', 'UPDATE', 'REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows'),
       ('propmaster_delete', 'DELETE', 'REFERENCING OLD TABLE AS old_rows'),
       ('propmaster_truncate', 'TRUNCATE', '');


-- Attaches the capture triggers to every candidate table that doesn't have them yet.
-- Called on install, start and every step, so new tables are picked up quickly.
-- New triggers start enabled; set_triggers_enabled() then matches them to the recording state.
CREATE OR REPLACE FUNCTION _propmaster.attach_triggers() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_table     record;
  v_kind      record;
  v_attached  int := 0;
BEGIN
  FOR v_table IN
    SELECT * FROM _propmaster.candidate_tables WHERE NOT excluded ORDER BY table_schema, table_name
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = v_table.oid AND g.tgname = 'propmaster_insert') THEN
      v_attached := v_attached + 1;
    END IF;

    FOR v_kind IN SELECT * FROM _propmaster.trigger_kinds LOOP
      CONTINUE WHEN EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = v_table.oid AND g.tgname = v_kind.name);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER %s ON %I.%I %s FOR EACH STATEMENT EXECUTE FUNCTION _propmaster.%s(%s)',
        v_kind.name, v_kind.event, v_table.table_schema, v_table.table_name, v_kind.referencing,
        CASE v_kind.event WHEN 'TRUNCATE' THEN 'capture_truncate' ELSE 'capture_rows' END,
        CASE v_kind.event WHEN 'TRUNCATE' THEN '' ELSE coalesce(v_table.key_args, '') END);
    END LOOP;
  END LOOP;

  RETURN v_attached;
END $$;


-- Enables (while recording) or disables (while idle) the triggers on tables the current user owns.
-- Disabling is best effort: a table locked by someone else keeps its trigger enabled, which is
-- still correct because the idle check returns at once. Enabling must succeed, or changes would be missed.
CREATE OR REPLACE FUNCTION _propmaster.set_triggers_enabled(p_enabled boolean) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_table  record;
  v_done   int := 0;
BEGIN
  FOR v_table IN
    SELECT c.oid, n.nspname AS table_schema, c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE pg_has_role(c.relowner, 'USAGE')
       AND EXISTS (SELECT 1 FROM pg_trigger g
                    WHERE g.tgrelid = c.oid AND g.tgname LIKE 'propmaster\_%'
                      AND (g.tgenabled = 'D') = p_enabled)
     ORDER BY 2, 3
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %1$I.%2$I %3$s TRIGGER propmaster_insert, %3$s TRIGGER propmaster_update, '
        '%3$s TRIGGER propmaster_delete, %3$s TRIGGER propmaster_truncate',
        v_table.table_schema, v_table.table_name, CASE WHEN p_enabled THEN 'ENABLE' ELSE 'DISABLE' END);
      v_done := v_done + 1;
    EXCEPTION WHEN lock_not_available THEN
      IF p_enabled THEN
        RAISE;
      END IF;
      RAISE NOTICE 'propmaster: % is locked, so its trigger stays enabled (idle, so it records nothing)',
        format('%I.%I', v_table.table_schema, v_table.table_name);
    END;
  END LOOP;

  RETURN v_done;
END $$;


CREATE OR REPLACE FUNCTION _propmaster.watched_table_count() RETURNS int
LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM pg_trigger WHERE tgname = 'propmaster_insert' AND tgparentid = 0;
$$;


-- Stops watching a table: removes its triggers and keeps it out of future attach runs.
CREATE OR REPLACE FUNCTION _propmaster.exclude_table(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_schema  text;
  v_name    text;
  v_kind    record;
BEGIN
  SELECT n.nspname, c.relname INTO v_schema, v_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = p_table;

  INSERT INTO _propmaster.excluded_tables VALUES (v_schema, v_name) ON CONFLICT DO NOTHING;
  FOR v_kind IN SELECT * FROM _propmaster.trigger_kinds LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', v_kind.name, p_table);
  END LOOP;
END $$;


CREATE OR REPLACE FUNCTION _propmaster.include_table(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM _propmaster.excluded_tables x
   USING pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = p_table AND x.table_schema = n.nspname AND x.table_name = c.relname;
  PERFORM _propmaster.attach_triggers();
  PERFORM _propmaster.set_triggers_enabled((SELECT session_id IS NOT NULL FROM _propmaster.state));
END $$;


-- Starts a recording session. Changes before the first named step go into step 0.
CREATE OR REPLACE FUNCTION _propmaster.start(p_name text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_state    _propmaster.state;
  v_session  bigint;
  v_step     bigint;
BEGIN
  SELECT * INTO v_state FROM _propmaster.state FOR UPDATE;
  IF v_state.session_id IS NOT NULL THEN
    RAISE EXCEPTION 'session #% is already recording; stop it first', v_state.session_id;
  END IF;

  PERFORM _propmaster.attach_triggers();
  PERFORM _propmaster.set_triggers_enabled(true);

  INSERT INTO _propmaster.sessions (name) VALUES (p_name) RETURNING id INTO v_session;
  INSERT INTO _propmaster.steps (session_id, seq, name)
  VALUES (v_session, 0, '(before first step)')
  RETURNING id INTO v_step;

  UPDATE _propmaster.state SET session_id = v_session, step_id = v_step, paused = false;
  RETURN v_session;
END $$;


-- Marks the start of a new test step; returns its number.
CREATE OR REPLACE FUNCTION _propmaster.step(p_name text) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  v_state  _propmaster.state;
  v_seq    int;
  v_step   bigint;
BEGIN
  SELECT * INTO v_state FROM _propmaster.state FOR UPDATE;
  IF v_state.session_id IS NULL THEN
    RAISE EXCEPTION 'nothing is recording; start a session first';
  END IF;

  PERFORM _propmaster.attach_triggers();  -- watch tables created during the session (new triggers are enabled)

  SELECT max(seq) + 1 INTO v_seq FROM _propmaster.steps WHERE session_id = v_state.session_id;
  INSERT INTO _propmaster.steps (session_id, seq, name)
  VALUES (v_state.session_id, v_seq, p_name)
  RETURNING id INTO v_step;

  UPDATE _propmaster.state SET step_id = v_step;
  RETURN v_seq;
END $$;


-- Stops the running session; returns its id.
CREATE OR REPLACE FUNCTION _propmaster.stop() RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_state  _propmaster.state;
BEGIN
  SELECT * INTO v_state FROM _propmaster.state FOR UPDATE;
  IF v_state.session_id IS NULL THEN
    RAISE EXCEPTION 'nothing is recording';
  END IF;

  UPDATE _propmaster.sessions SET stopped_at = clock_timestamp() WHERE id = v_state.session_id;
  UPDATE _propmaster.state SET session_id = NULL, step_id = NULL, paused = false;
  PERFORM _propmaster.set_triggers_enabled(false);
  RETURN v_state.session_id;
END $$;


-- Pauses or resumes the running session; the marker goes on the current step.
CREATE OR REPLACE FUNCTION _propmaster.set_paused(p_paused boolean) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_state  _propmaster.state;
BEGIN
  SELECT * INTO v_state FROM _propmaster.state FOR UPDATE;
  IF v_state.session_id IS NULL THEN
    RAISE EXCEPTION 'nothing is recording';
  END IF;
  IF v_state.paused = p_paused THEN
    RAISE EXCEPTION 'the recording is already %', CASE WHEN p_paused THEN 'paused' ELSE 'running' END;
  END IF;

  UPDATE _propmaster.state SET paused = p_paused;
  INSERT INTO _propmaster.markers (session_id, step_id, kind)
  VALUES (v_state.session_id, v_state.step_id, CASE WHEN p_paused THEN 'pause' ELSE 'resume' END);
END $$;


-- Flags the current step ("this looks wrong"), with an optional note.
CREATE OR REPLACE FUNCTION _propmaster.flag(p_note text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_state  _propmaster.state;
BEGIN
  SELECT * INTO v_state FROM _propmaster.state;
  IF v_state.session_id IS NULL THEN
    RAISE EXCEPTION 'nothing is recording';
  END IF;
  INSERT INTO _propmaster.markers (session_id, step_id, kind, note)
  VALUES (v_state.session_id, v_state.step_id, 'flag', nullif(trim(p_note), ''));
END $$;


-- Deletes one stopped session with its steps and changes.
CREATE OR REPLACE FUNCTION _propmaster.delete_session(p_session bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _propmaster.sessions WHERE id = p_session) THEN
    RAISE EXCEPTION 'there is no session #%', p_session;
  END IF;
  IF EXISTS (SELECT 1 FROM _propmaster.state WHERE session_id = p_session) THEN
    RAISE EXCEPTION 'session #% is still recording; stop it first', p_session;
  END IF;
  DELETE FROM _propmaster.changes WHERE session_id = p_session;
  DELETE FROM _propmaster.sessions WHERE id = p_session;  -- steps go with it (ON DELETE CASCADE)
END $$;


-- Deletes stopped sessions that started before now() - p_older_than; returns how many.
CREATE OR REPLACE FUNCTION _propmaster.prune(p_older_than interval) RETURNS int
LANGUAGE sql AS $$
  WITH old AS (
    SELECT id FROM _propmaster.sessions
     WHERE stopped_at IS NOT NULL AND started_at < now() - p_older_than),
  changes_gone AS (
    DELETE FROM _propmaster.changes c USING old WHERE c.session_id = old.id),
  sessions_gone AS (
    DELETE FROM _propmaster.sessions s USING old WHERE s.id = old.id RETURNING 1)
  SELECT count(*)::int FROM sessions_gone;
$$;
