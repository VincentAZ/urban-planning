CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS app_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
-- Initial transactional aggregate. Normalize per-tenant records before national multi-instance launch.
-- The adapter does not expose direct database access to end users.
CREATE TABLE IF NOT EXISTS app_state (
  id integer PRIMARY KEY CHECK (id = 1),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_manifests (
  id text PRIMARY KEY,
  publisher text NOT NULL,
  vintage text NOT NULL,
  license text NOT NULL,
  source_url text NOT NULL,
  checksum text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS geographic_features (
  id text NOT NULL,
  source_manifest_id text NOT NULL REFERENCES source_manifests(id),
  organization_id text,
  feature_type text NOT NULL,
  geometry geometry(Geometry, 4326) NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(id, source_manifest_id)
);
CREATE INDEX IF NOT EXISTS geographic_features_geometry_idx ON geographic_features USING gist(geometry);
CREATE INDEX IF NOT EXISTS geographic_features_organization_idx ON geographic_features(organization_id);
INSERT INTO app_schema_migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
