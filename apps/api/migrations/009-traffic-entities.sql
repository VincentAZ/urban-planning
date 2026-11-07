-- Project-owned reviewed input and immutable native evidence; existing captures are untouched.
DO $entities$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['app_traffic_configs','app_traffic_uploads','app_traffic_jobs','app_traffic_artifacts','app_native_capacity'] LOOP
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
   id text PRIMARY KEY, ordinal bigint NOT NULL DEFAULT nextval(''app_entity_ordinal''),
   organization_id text, user_id text, project_id text, snapshot_id text, email text,
   header jsonb NOT NULL, payload jsonb, baseline_hash text REFERENCES app_baseline_snapshots(sha256),
   updated_at timestamptz NOT NULL DEFAULT now())',name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(ordinal,id)',name||'_ordinal_idx',name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(project_id,ordinal)',name||'_project_idx',name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(organization_id,ordinal)',name||'_org_idx',name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(user_id,ordinal)',name||'_user_idx',name);
 END LOOP;
END $entities$;
CREATE UNIQUE INDEX IF NOT EXISTS app_traffic_uploads_request_idx ON app_traffic_uploads(project_id,user_id,(header->>'idempotencyKey'));
CREATE UNIQUE INDEX IF NOT EXISTS app_traffic_configs_request_idx ON app_traffic_configs(project_id,user_id,(header->>'idempotencyKey'));
CREATE UNIQUE INDEX IF NOT EXISTS app_traffic_jobs_request_idx ON app_traffic_jobs(project_id,user_id,(header->>'idempotencyKey'));
CREATE UNIQUE INDEX IF NOT EXISTS app_traffic_jobs_single_worker_idx ON app_traffic_jobs((1)) WHERE header->>'status'='running';
CREATE UNIQUE INDEX IF NOT EXISTS app_traffic_jobs_account_pending_idx ON app_traffic_jobs(user_id) WHERE header->>'status' IN ('queued','running');
CREATE INDEX IF NOT EXISTS app_traffic_jobs_pending_idx ON app_traffic_jobs((header->>'status'),ordinal) WHERE header->>'status' IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS app_traffic_artifacts_job_idx ON app_traffic_artifacts((header->>'jobId'));
-- Existing scoped stores gain an independent singleton; fresh aggregate migration inserts it itself.
INSERT INTO app_native_capacity(id,header,payload) SELECT 'nativeCapacity','{"version":1,"revision":0,"slot":null,"recoveryHistory":[]}'::jsonb,NULL
 WHERE EXISTS(SELECT 1 FROM app_storage_manifest WHERE id=1) ON CONFLICT DO NOTHING;
-- Fail closed when upgrading a store with already-running legacy native work.
WITH active AS (
 SELECT id,header,'gis' AS kind FROM app_gis_jobs WHERE header->>'status'='running'
 UNION ALL SELECT id,header,'workforce' FROM app_workforce_jobs WHERE header->>'status'='running'
), chosen AS (SELECT * FROM active ORDER BY id LIMIT 1)
UPDATE app_native_capacity SET header=jsonb_build_object('version',1,'revision',1,'recoveryHistory','[]'::jsonb,'slot',jsonb_build_object('token','legacy-'||chosen.id,'kind',chosen.kind,'jobId',chosen.id,'workerId',coalesce(chosen.header->>'workerId','legacy-worker'),'acquiredAt',statement_timestamp(),'heartbeatAt',statement_timestamp(),'hardDeadlineAt',statement_timestamp(),'status','quarantined','reason','Native processing was already running during shared capacity migration; operator termination confirmation is required.')) FROM chosen
 WHERE app_native_capacity.id='nativeCapacity' AND app_native_capacity.header->'revision'='0'::jsonb AND app_native_capacity.header->'slot'='null'::jsonb;
INSERT INTO app_schema_migrations(version) VALUES(9) ON CONFLICT DO NOTHING;
