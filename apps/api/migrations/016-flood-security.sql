CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_flood_source_keys(dataset jsonb, source jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT ARRAY['id:'||(source->>'id')] || CASE WHEN coalesce(source->>'url','')<>'' THEN ARRAY['url:'||(source->>'url')] ELSE ARRAY[]::text[] END || coalesce((SELECT array_agg('sha:'||(f->>'sha256')) FROM jsonb_array_elements(coalesce(dataset->'files','[]'::jsonb)) f WHERE f->>'sourceId'=source->>'id'),ARRAY[]::text[])
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_flood_declared_keys(project jsonb, permission text DEFAULT NULL) RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,__SCHEMA__ AS $$
 SELECT coalesce(array_agg(DISTINCT k),ARRAY[]::text[]) FROM jsonb_each(coalesce(project->'floodDatasets','{}'::jsonb)) d CROSS JOIN LATERAL jsonb_array_elements(d.value->'sources') s CROSS JOIN LATERAL unnest(__SCHEMA__.app_security_flood_source_keys(d.value,s)) k WHERE s->'rights' IS NOT NULL AND s->'rights'<>'null'::jsonb AND (permission IS NULL OR s->'rights'->>'privateUse' IS DISTINCT FROM 'true' OR s->'rights'->>permission IS DISTINCT FROM 'true')
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_flood_references(project jsonb) RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT s->'flood' FROM jsonb_array_elements(coalesce(project->'scenarios','[]'::jsonb)) s WHERE s->'flood' IS NOT NULL
 UNION ALL SELECT e->'before'->'flood' FROM jsonb_array_elements(coalesce(project->'history','[]'::jsonb)||coalesce(project->'undone','[]'::jsonb)) e WHERE e->'before'->'flood' IS NOT NULL
 UNION ALL SELECT e->'after'->'flood' FROM jsonb_array_elements(coalesce(project->'history','[]'::jsonb)||coalesce(project->'undone','[]'::jsonb)) e WHERE e->'after'->'flood' IS NOT NULL
 UNION ALL SELECT e->'command'->'flood' FROM jsonb_array_elements(coalesce(project->'history','[]'::jsonb)||coalesce(project->'undone','[]'::jsonb)) e WHERE e->'command'->>'type'='scenario.flood' AND e->'command'->'flood'<>'null'::jsonb
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_flood_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE p jsonb; prior jsonb; pair record; ref jsonb; dataset jsonb; registered jsonb; baseline jsonb; target record; shape jsonb; declared_keys text[];
BEGIN
 IF TG_OP='UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload THEN RETURN NEW; END IF;
 SELECT payload INTO baseline FROM __SCHEMA__.app_baseline_snapshots WHERE sha256=NEW.baseline_hash;
 shape:=coalesce(baseline->'studyArea',jsonb_build_object('type','Polygon','coordinates',jsonb_build_array(baseline->'boundary')));
 IF TG_TABLE_NAME='app_projects' THEN
  p:=NEW.payload->'project';prior:=CASE WHEN TG_OP='UPDATE' THEN OLD.payload->'project' ELSE NULL END;
  IF jsonb_typeof(coalesce(p->'floodDatasets','{}'::jsonb)) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid flood catalog' USING ERRCODE='23514'; END IF;
  IF octet_length(coalesce(p->'floodDatasets','{}'::jsonb)::text)>16777216 OR (SELECT count(*) FROM jsonb_object_keys(coalesce(p->'floodDatasets','{}'::jsonb)))>8 THEN RAISE EXCEPTION 'Flood catalog exceeds bounded capacity' USING ERRCODE='23514'; END IF;
  FOR pair IN SELECT * FROM jsonb_each(coalesce(prior->'floodDatasets','{}'::jsonb)) LOOP
   IF p->'floodDatasets'->pair.key IS DISTINCT FROM pair.value THEN RAISE EXCEPTION 'Existing flood source catalog is immutable' USING ERRCODE='42501'; END IF;
  END LOOP;
  declared_keys:=__SCHEMA__.app_security_flood_declared_keys(p);
  FOR pair IN SELECT * FROM jsonb_each(coalesce(p->'floodDatasets','{}'::jsonb)) LOOP
   IF pair.key !~ '^[a-f0-9]{64}$' OR pair.value->'studyArea' IS DISTINCT FROM shape OR octet_length(pair.value::text)>8388608 THEN RAISE EXCEPTION 'Flood source boundary or size mismatch' USING ERRCODE='23514'; END IF;
   IF prior->'floodDatasets'->pair.key IS NULL AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_security_flood_references(p) r WHERE r->>'origin'='server-catalog' AND r->>'datasetHash'=pair.key) AND EXISTS(SELECT 1 FROM jsonb_array_elements(pair.value->'sources') source WHERE (source->'rights' IS NULL OR source->'rights'='null'::jsonb) AND __SCHEMA__.app_security_flood_source_keys(pair.value,source) && declared_keys) THEN RAISE EXCEPTION 'Imported flood source permissions cannot be erased under a new dataset hash' USING ERRCODE='42501'; END IF;
  END LOOP;
  FOR ref IN SELECT * FROM __SCHEMA__.app_security_flood_references(p) LOOP
   IF jsonb_typeof(ref) IS DISTINCT FROM 'object' OR ref->>'version' IS DISTINCT FROM '1' OR coalesce(ref->>'origin','') NOT IN ('server-catalog','imported') THEN RAISE EXCEPTION 'Invalid flood reference' USING ERRCODE='23514'; END IF;
   dataset:=p->'floodDatasets'->(ref->>'datasetHash');
   IF dataset IS NULL OR dataset='null'::jsonb THEN RAISE EXCEPTION 'Referenced flood dataset is missing' USING ERRCODE='23514'; END IF;
   IF ref->>'origin'='imported' THEN CONTINUE; END IF;
   IF prior->'floodDatasets'->(ref->>'datasetHash')=dataset AND EXISTS(SELECT 1 FROM __SCHEMA__.app_security_flood_references(prior) r WHERE r->>'origin'='server-catalog' AND r->>'datasetHash'=ref->>'datasetHash') THEN CONTINUE; END IF;
   SELECT payload->'dataset' INTO registered FROM __SCHEMA__.app_flood_sources WHERE id=ref->>'datasetHash';
   IF registered IS NULL OR registered IS DISTINCT FROM dataset THEN RAISE EXCEPTION 'Server flood authority requires exact operator-registered source' USING ERRCODE='42501'; END IF;
  END LOOP;
 ELSE
  ref:=NEW.payload->'scenario'->'flood';dataset:=NEW.payload->'floodDataset';
  IF ref IS NULL THEN
   IF dataset IS NOT NULL THEN RAISE EXCEPTION 'Cannot publish an unselected flood dataset' USING ERRCODE='23514'; END IF;
   RETURN NEW;
  END IF;
  SELECT id,organization_id,baseline_hash,payload INTO target FROM __SCHEMA__.app_projects WHERE id=NEW.project_id;
  IF target.id IS NULL OR target.organization_id IS DISTINCT FROM NEW.organization_id OR target.baseline_hash IS DISTINCT FROM NEW.baseline_hash OR dataset IS NULL OR dataset IS DISTINCT FROM target.payload->'project'->'floodDatasets'->(ref->>'datasetHash') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(target.payload->'project'->'scenarios') s WHERE s->>'id'=NEW.payload->'scenario'->>'id' AND s->'flood'=ref) THEN RAISE EXCEPTION 'Published flood evidence must match its exact project source' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(dataset->'sources') s WHERE s->'rights' IS NOT NULL AND (s->'rights'->>'privateUse' IS DISTINCT FROM 'true' OR s->'rights'->>'publicRedistribution' IS DISTINCT FROM 'true')) THEN RAISE EXCEPTION 'Flood source publication is restricted' USING ERRCODE='42501'; END IF;
  IF ref->>'origin'<>'server-catalog' AND EXISTS(SELECT 1 FROM jsonb_array_elements(dataset->'sources') source WHERE (source->'rights' IS NULL OR source->'rights'='null'::jsonb) AND __SCHEMA__.app_security_flood_source_keys(dataset,source) && __SCHEMA__.app_security_flood_declared_keys(target.payload->'project','publicRedistribution')) THEN RAISE EXCEPTION 'Retained flood source publication permissions cannot be bypassed' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_flood_registry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF __SCHEMA__.app_security_kind() IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Flood source installation is operator-only' USING ERRCODE='42501'; END IF;
 IF NEW.header->>'id' IS DISTINCT FROM NEW.id OR NEW.header->>'studyAreaHash' IS DISTINCT FROM NEW.payload->'dataset'->>'studyAreaHash' OR coalesce(NEW.header->>'sourceManifestHash','') !~ '^[a-f0-9]{64}$' OR NEW.payload->'dataset'->>'kind' IS DISTINCT FROM 'fema-effective-nfhl' OR NEW.organization_id IS NOT NULL OR NEW.project_id IS NOT NULL OR octet_length(NEW.payload::text)>8388608 THEN RAISE EXCEPTION 'Invalid flood registry record' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DO $install$
DECLARE cfg record; fn regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 ALTER TABLE __SCHEMA__.app_flood_sources ENABLE ROW LEVEL SECURITY;
 ALTER TABLE __SCHEMA__.app_flood_sources FORCE ROW LEVEL SECURITY;
 EXECUTE format('REVOKE ALL ON __SCHEMA__.app_flood_sources FROM PUBLIC,%I,%I,%I',cfg.web_role,cfg.auth_role,cfg.worker_role);
 DROP POLICY IF EXISTS operator_all ON __SCHEMA__.app_flood_sources;
 EXECUTE format('CREATE POLICY operator_all ON __SCHEMA__.app_flood_sources TO %I USING(true) WITH CHECK(true)',cfg.migration_role);
 DROP POLICY IF EXISTS public_source_read ON __SCHEMA__.app_flood_sources;
 EXECUTE format('CREATE POLICY public_source_read ON __SCHEMA__.app_flood_sources FOR SELECT TO %I USING(true)',cfg.web_role);
 EXECUTE format('GRANT SELECT ON __SCHEMA__.app_flood_sources TO %I',cfg.web_role);
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND p.proname LIKE 'app_security_flood_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role);
 END LOOP;
END $install$;
DROP TRIGGER IF EXISTS security_flood_capture ON __SCHEMA__.app_projects;
CREATE TRIGGER security_flood_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_projects FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_flood_capture();
DROP TRIGGER IF EXISTS security_flood_capture ON __SCHEMA__.app_published;
CREATE TRIGGER security_flood_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_published FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_flood_capture();
DROP TRIGGER IF EXISTS security_flood_registry ON __SCHEMA__.app_flood_sources;
CREATE TRIGGER security_flood_registry BEFORE INSERT ON __SCHEMA__.app_flood_sources FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_flood_registry();
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=16) THEN 16 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(16) ON CONFLICT DO NOTHING;
