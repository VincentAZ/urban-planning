-- Fiscal library versions and creation receipts are independent immutable records.
DO $migration$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['app_fiscal_profiles','app_fiscal_study_creations'] LOOP
 EXECUTE format('CREATE TABLE IF NOT EXISTS %I (id text PRIMARY KEY, ordinal bigint NOT NULL DEFAULT nextval(''app_entity_ordinal''),organization_id text,user_id text,project_id text,snapshot_id text,email text,header jsonb NOT NULL,payload jsonb,baseline_hash text REFERENCES app_baseline_snapshots(sha256),updated_at timestamptz NOT NULL DEFAULT now())',table_name);
 EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (organization_id,ordinal,id)',table_name||'_org_idx',table_name);
 EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (organization_id,user_id,(header->>''idempotencyKey''))',table_name||'_request_idx',table_name);
 EXECUTE format('DROP TRIGGER IF EXISTS fiscal_immutable ON %I',table_name);
 EXECUTE format('CREATE TRIGGER fiscal_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_reject_immutable_change()',table_name);
 EXECUTE format('DROP TRIGGER IF EXISTS fiscal_no_truncate ON %I',table_name);
 EXECUTE format('CREATE TRIGGER fiscal_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION app_reject_immutable_change()',table_name);
 END LOOP;
END $migration$;
CREATE UNIQUE INDEX IF NOT EXISTS app_fiscal_profiles_version_idx ON app_fiscal_profiles(organization_id,(header->>'profileId'),((header->>'version')::integer));
CREATE UNIQUE INDEX IF NOT EXISTS app_fiscal_study_project_idx ON app_fiscal_study_creations(project_id);
INSERT INTO app_schema_migrations(version) VALUES(20) ON CONFLICT DO NOTHING;
