-- Project-owned queue/evidence. No captured baseline, old project, or legacy JSON changes.
DO $migration$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['app_accessibility_jobs','app_accessibility_artifacts'] LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
      id text PRIMARY KEY, ordinal bigint NOT NULL DEFAULT nextval(''app_entity_ordinal''),
      organization_id text, user_id text, project_id text, snapshot_id text, email text,
      header jsonb NOT NULL, payload jsonb,
      baseline_hash text REFERENCES app_baseline_snapshots(sha256),
      updated_at timestamptz NOT NULL DEFAULT now()
    )',table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (ordinal,id)',table_name||'_ordinal_idx',table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (project_id,ordinal)',table_name||'_project_idx',table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (organization_id,ordinal)',table_name||'_org_idx',table_name);
  END LOOP;
END $migration$;
CREATE INDEX IF NOT EXISTS app_accessibility_jobs_user_idx ON app_accessibility_jobs(user_id,ordinal);
CREATE INDEX IF NOT EXISTS app_accessibility_jobs_pending_idx ON app_accessibility_jobs((header->>'status'),ordinal) WHERE header->>'status' IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS app_accessibility_jobs_request_idx ON app_accessibility_jobs(project_id,user_id,(header->>'idempotencyKey'));
CREATE UNIQUE INDEX IF NOT EXISTS app_accessibility_artifacts_job_idx ON app_accessibility_artifacts((header->>'jobId'));
DROP TRIGGER IF EXISTS app_accessibility_artifacts_immutable ON app_accessibility_artifacts;
CREATE TRIGGER app_accessibility_artifacts_immutable BEFORE UPDATE OR DELETE ON app_accessibility_artifacts FOR EACH ROW EXECUTE FUNCTION app_reject_immutable_change();
DROP TRIGGER IF EXISTS app_accessibility_artifacts_no_truncate ON app_accessibility_artifacts;
CREATE TRIGGER app_accessibility_artifacts_no_truncate BEFORE TRUNCATE ON app_accessibility_artifacts FOR EACH STATEMENT EXECUTE FUNCTION app_reject_immutable_change();
INSERT INTO app_schema_migrations(version) VALUES(13) ON CONFLICT DO NOTHING;
