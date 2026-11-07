-- Private, project-bound conversion jobs. Captured planning baselines are untouched.
CREATE TABLE IF NOT EXISTS app_gis_jobs (
 id text PRIMARY KEY, ordinal bigint NOT NULL DEFAULT nextval('app_entity_ordinal'),
 organization_id text, user_id text, project_id text, snapshot_id text, email text,
 header jsonb NOT NULL, payload jsonb,
 baseline_hash text REFERENCES app_baseline_snapshots(sha256),
 updated_at timestamptz NOT NULL DEFAULT now()
);
UPDATE app_gis_jobs SET payload=coalesce(nullif(payload,'null'::jsonb),'{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('recipe',header->'recipe','inspection',header->'inspection')),header=header-ARRAY['recipe','inspection'] WHERE header ?| ARRAY['recipe','inspection'];
CREATE INDEX IF NOT EXISTS app_gis_jobs_ordinal_idx ON app_gis_jobs(ordinal,id);
CREATE INDEX IF NOT EXISTS app_gis_jobs_project_user_idx ON app_gis_jobs(project_id,user_id,ordinal);
CREATE INDEX IF NOT EXISTS app_gis_jobs_org_idx ON app_gis_jobs(organization_id,ordinal);
CREATE INDEX IF NOT EXISTS app_gis_jobs_user_idx ON app_gis_jobs(user_id,ordinal);
CREATE INDEX IF NOT EXISTS app_gis_jobs_pending_idx ON app_gis_jobs((header->>'status'),ordinal) WHERE header->>'status' IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS app_gis_jobs_request_idx ON app_gis_jobs(project_id,user_id,(header->>'idempotencyKey'));
CREATE UNIQUE INDEX IF NOT EXISTS app_gis_jobs_single_worker_idx ON app_gis_jobs((1)) WHERE header->>'status'='running';
CREATE UNIQUE INDEX IF NOT EXISTS app_gis_jobs_account_pending_idx ON app_gis_jobs(user_id) WHERE header->>'status' IN ('queued','running');
INSERT INTO app_schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
