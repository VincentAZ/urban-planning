CREATE TABLE IF NOT EXISTS app_housing_sources (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 ordinal bigint NOT NULL DEFAULT nextval('app_entity_ordinal'),
 organization_id text, user_id text, project_id text, snapshot_id text, email text,
 header jsonb NOT NULL, payload jsonb NOT NULL,
 baseline_hash text REFERENCES app_baseline_snapshots(sha256),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_housing_sources_ordinal_idx ON app_housing_sources(ordinal,id);
DROP TRIGGER IF EXISTS housing_source_immutable ON app_housing_sources;
CREATE TRIGGER housing_source_immutable BEFORE UPDATE OR DELETE ON app_housing_sources FOR EACH ROW EXECUTE FUNCTION app_reject_immutable_change();
DROP TRIGGER IF EXISTS housing_source_no_truncate ON app_housing_sources;
CREATE TRIGGER housing_source_no_truncate BEFORE TRUNCATE ON app_housing_sources FOR EACH STATEMENT EXECUTE FUNCTION app_reject_immutable_change();
INSERT INTO app_schema_migrations(version) VALUES(21) ON CONFLICT DO NOTHING;
