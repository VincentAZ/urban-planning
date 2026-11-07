CREATE SEQUENCE IF NOT EXISTS app_entity_ordinal;
CREATE TABLE IF NOT EXISTS app_baseline_snapshots (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  place_id text NOT NULL, payload jsonb NOT NULL,
  canonical_bytes bigint NOT NULL CHECK (canonical_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
DO $migration$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'app_users','app_organizations','app_memberships','app_sessions','app_projects',
    'app_audit','app_comments','app_published','app_public_feedback','app_imports',
    'app_preparation_jobs','app_budget','app_preparation_control'
  ] LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
      id text PRIMARY KEY, ordinal bigint NOT NULL DEFAULT nextval(''app_entity_ordinal''),
      organization_id text, user_id text, project_id text, snapshot_id text, email text,
      header jsonb NOT NULL, payload jsonb,
      baseline_hash text REFERENCES app_baseline_snapshots(sha256),
      updated_at timestamptz NOT NULL DEFAULT now()
    )', table_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (ordinal,id)', table_name || '_ordinal_idx',table_name);
  END LOOP;
END
$migration$;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_idx ON app_users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_memberships_user_idx ON app_memberships(user_id);
CREATE INDEX IF NOT EXISTS app_memberships_org_idx ON app_memberships(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS app_memberships_pair_idx ON app_memberships(organization_id,user_id);
CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions(user_id);
CREATE INDEX IF NOT EXISTS app_sessions_org_idx ON app_sessions(organization_id);
CREATE INDEX IF NOT EXISTS app_projects_org_idx ON app_projects(organization_id);
CREATE INDEX IF NOT EXISTS app_published_org_idx ON app_published(organization_id);
CREATE INDEX IF NOT EXISTS app_published_project_idx ON app_published(project_id);
CREATE INDEX IF NOT EXISTS app_comments_project_idx ON app_comments(project_id);
CREATE INDEX IF NOT EXISTS app_comments_org_idx ON app_comments(organization_id);
CREATE INDEX IF NOT EXISTS app_audit_org_idx ON app_audit(organization_id);
CREATE INDEX IF NOT EXISTS app_audit_project_idx ON app_audit(project_id);
CREATE INDEX IF NOT EXISTS app_audit_snapshot_idx ON app_audit(snapshot_id);
CREATE INDEX IF NOT EXISTS app_public_feedback_snapshot_idx ON app_public_feedback(snapshot_id);
CREATE INDEX IF NOT EXISTS app_public_feedback_user_idx ON app_public_feedback(user_id);
CREATE INDEX IF NOT EXISTS app_imports_org_idx ON app_imports(organization_id);
CREATE INDEX IF NOT EXISTS app_imports_project_idx ON app_imports(project_id);
CREATE INDEX IF NOT EXISTS app_preparation_jobs_user_idx ON app_preparation_jobs(user_id);
CREATE TABLE IF NOT EXISTS app_project_versions (
  project_id text NOT NULL, version bigint NOT NULL, organization_id text NOT NULL,
  baseline_hash text NOT NULL REFERENCES app_baseline_snapshots(sha256),
  payload jsonb NOT NULL, content_sha256 text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,version)
);
CREATE TABLE IF NOT EXISTS app_storage_manifest (
  id integer PRIMARY KEY CHECK(id=1), version integer NOT NULL CHECK(version=2),
  legacy_fingerprint text NOT NULL, verified_fingerprint text NOT NULL,
  entity_counts jsonb NOT NULL, baseline_count integer NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION app_reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'Immutable storage records cannot be updated or deleted' USING ERRCODE='55000';
END
$function$;
DROP TRIGGER IF EXISTS app_baseline_immutable ON app_baseline_snapshots;
CREATE TRIGGER app_baseline_immutable BEFORE UPDATE OR DELETE ON app_baseline_snapshots
  FOR EACH ROW EXECUTE FUNCTION app_reject_immutable_change();
DROP TRIGGER IF EXISTS app_project_version_immutable ON app_project_versions;
CREATE TRIGGER app_project_version_immutable BEFORE UPDATE OR DELETE ON app_project_versions
  FOR EACH ROW EXECUTE FUNCTION app_reject_immutable_change();
DROP TRIGGER IF EXISTS app_baseline_no_truncate ON app_baseline_snapshots;
CREATE TRIGGER app_baseline_no_truncate BEFORE TRUNCATE ON app_baseline_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_immutable_change();
DROP TRIGGER IF EXISTS app_project_version_no_truncate ON app_project_versions;
CREATE TRIGGER app_project_version_no_truncate BEFORE TRUNCATE ON app_project_versions
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_immutable_change();
-- Preserve the legacy document but reject writes from obsolete application binaries.
CREATE OR REPLACE FUNCTION app_reject_legacy_write() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS(SELECT 1 FROM app_storage_manifest WHERE id=1) THEN
    RAISE EXCEPTION 'Legacy app_state is read-only after normalized storage migration' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='TRUNCATE' THEN RETURN NULL; END IF;
  RETURN NEW;
END
$function$;
DROP TRIGGER IF EXISTS app_state_readonly ON app_state;
CREATE TRIGGER app_state_readonly BEFORE INSERT OR UPDATE OR DELETE ON app_state
  FOR EACH ROW EXECUTE FUNCTION app_reject_legacy_write();
DROP TRIGGER IF EXISTS app_state_no_truncate ON app_state;
CREATE TRIGGER app_state_no_truncate BEFORE TRUNCATE ON app_state
  FOR EACH STATEMENT EXECUTE FUNCTION app_reject_legacy_write();
