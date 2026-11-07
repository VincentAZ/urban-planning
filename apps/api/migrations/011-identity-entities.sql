-- New collections only. Existing user/session documents retain absent identity fields.
DO $entities$
DECLARE name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['app_identity_challenges','app_identity_invitations','app_identity_outbox'] LOOP
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I (
   id text PRIMARY KEY, ordinal bigint NOT NULL DEFAULT nextval(''app_entity_ordinal''),
   organization_id text, user_id text, project_id text, snapshot_id text, email text,
   header jsonb NOT NULL, payload jsonb, baseline_hash text REFERENCES app_baseline_snapshots(sha256),
   updated_at timestamptz NOT NULL DEFAULT now())',name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(ordinal,id)',name||'_ordinal_idx',name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(user_id,ordinal)',name||'_user_idx',name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(organization_id,ordinal)',name||'_org_idx',name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(project_id,ordinal)',name||'_project_idx',name);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(email,ordinal)',name||'_email_idx',name);
 END LOOP;
END $entities$;
CREATE UNIQUE INDEX IF NOT EXISTS app_identity_challenges_token_idx ON app_identity_challenges((header->>'tokenHash'));
CREATE UNIQUE INDEX IF NOT EXISTS app_identity_invitations_token_idx ON app_identity_invitations((header->>'tokenHash'));
CREATE UNIQUE INDEX IF NOT EXISTS app_identity_invitations_request_idx ON app_identity_invitations(organization_id,(header->>'createdBy'),(header->>'idempotencyKey'));
CREATE UNIQUE INDEX IF NOT EXISTS app_identity_outbox_single_sending_idx ON app_identity_outbox((1)) WHERE header->>'status'='sending';
CREATE INDEX IF NOT EXISTS app_identity_outbox_pending_idx ON app_identity_outbox((header->>'status'),(header->>'nextAttemptAt'),ordinal) WHERE header->>'status' IN ('pending','sending');
INSERT INTO app_schema_migrations(version) VALUES(11) ON CONFLICT DO NOTHING;
