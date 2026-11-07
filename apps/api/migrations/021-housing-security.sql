-- HUD authority is installed only by an operator. Uploaded/imported evidence
-- never acquires authority merely by naming HUD or carrying a content hash.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_housing_references(p jsonb) RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT s->'affordability' FROM jsonb_array_elements(coalesce(p->'scenarios','[]'::jsonb)) s WHERE s->'affordability' IS NOT NULL
 UNION ALL SELECT e->'before'->'affordability' FROM jsonb_array_elements(coalesce(p->'history','[]'::jsonb)||coalesce(p->'undone','[]'::jsonb)) e WHERE e->'before'->'affordability' IS NOT NULL
 UNION ALL SELECT e->'after'->'affordability' FROM jsonb_array_elements(coalesce(p->'history','[]'::jsonb)||coalesce(p->'undone','[]'::jsonb)) e WHERE e->'after'->'affordability' IS NOT NULL
 UNION ALL SELECT e->'command'->'affordability' FROM jsonb_array_elements(coalesce(p->'history','[]'::jsonb)||coalesce(p->'undone','[]'::jsonb)) e WHERE e->'command'->>'type'='scenario.affordability' AND e->'command'->'affordability'<>'null'::jsonb
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_housing_groups(p jsonb) RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,__SCHEMA__ AS $$
 SELECT g FROM __SCHEMA__.app_security_housing_references(p) a CROSS JOIN LATERAL jsonb_array_elements(coalesce(a->'baselineGroups','[]'::jsonb)||coalesce(a->'proposalGroups','[]'::jsonb)) g
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_housing_permission(source jsonb, permission text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_typeof(source->'rights')='object' AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['privateUse','cache','analyze','privateDisplay','historicalRetention'] || CASE WHEN permission='private' THEN ARRAY[]::text[] ELSE ARRAY[permission] END) key WHERE source->'rights'->key IS DISTINCT FROM 'true'::jsonb)
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_housing_sources(p jsonb) RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,__SCHEMA__ AS $$
 SELECT s FROM jsonb_each(coalesce(p->'housingIncomeLimits','{}'::jsonb)) d CROSS JOIN LATERAL jsonb_array_elements(d.value->'sources') s
 UNION ALL SELECT s FROM __SCHEMA__.app_security_housing_references(p) a CROSS JOIN LATERAL jsonb_array_elements(a->'sources') s
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_housing_pack(pack jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE l jsonb; key text;
BEGIN
 IF jsonb_typeof(pack) IS DISTINCT FROM 'object' OR pack->'version' IS DISTINCT FROM '1'::jsonb OR pack->>'program' IS DISTINCT FROM 'hud-section8' OR pack->>'currency' IS DISTINCT FROM 'USD' OR jsonb_typeof(pack->'limits') IS DISTINCT FROM 'array' OR jsonb_array_length(pack->'limits')<>8 OR jsonb_typeof(pack->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(pack->'sources')<1 OR jsonb_typeof(pack->'sourceRows') IS DISTINCT FROM 'array' OR jsonb_array_length(pack->'sourceRows')<1 OR octet_length(pack::text)>524288 THEN RETURN false; END IF;
 IF (SELECT count(DISTINCT e->>'householdSize') FROM jsonb_array_elements(pack->'limits') e)<>8 THEN RETURN false; END IF;
 FOR l IN SELECT * FROM jsonb_array_elements(pack->'limits') LOOP
  IF jsonb_typeof(l->'householdSize') IS DISTINCT FROM 'number' OR coalesce(l->>'householdSize','') !~ '^[1-8]$' THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['extremelyLow','veryLow','low'] LOOP
   IF jsonb_typeof(l->key) IS DISTINCT FROM 'number' OR coalesce(l->>key,'') !~ '^[0-9]+$' OR (l->>key)::numeric>100000000 THEN RETURN false; END IF;
  END LOOP;
  IF (l->>'extremelyLow')::numeric>(l->>'veryLow')::numeric OR (l->>'veryLow')::numeric>(l->>'low')::numeric THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_housing_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE p jsonb; prior jsonb; pair record; g jsonb; a jsonb; s jsonb; pack jsonb; registered jsonb; target record; selected jsonb;
BEGIN
 IF TG_OP='UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='app_projects' THEN
  p:=NEW.payload->'project'; prior:=CASE WHEN TG_OP='UPDATE' THEN OLD.payload->'project' ELSE NULL END;
  IF jsonb_typeof(coalesce(p->'housingIncomeLimits','{}'::jsonb)) IS DISTINCT FROM 'object' OR octet_length(coalesce(p->'housingIncomeLimits','{}'::jsonb)::text)>8388608 OR (SELECT count(*) FROM jsonb_object_keys(coalesce(p->'housingIncomeLimits','{}'::jsonb)))>32 THEN RAISE EXCEPTION 'Invalid or oversized housing catalog' USING ERRCODE='23514'; END IF;
  FOR pair IN SELECT * FROM jsonb_each(coalesce(prior->'housingIncomeLimits','{}'::jsonb)) LOOP
   IF p->'housingIncomeLimits'->pair.key IS DISTINCT FROM pair.value THEN RAISE EXCEPTION 'Retained housing catalog is immutable' USING ERRCODE='42501'; END IF;
  END LOOP;
  FOR pair IN SELECT * FROM jsonb_each(coalesce(p->'housingIncomeLimits','{}'::jsonb)) LOOP
   IF pair.key !~ '^[a-f0-9]{64}$' OR __SCHEMA__.app_security_housing_pack(pair.value) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Invalid housing pack' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR a IN SELECT * FROM __SCHEMA__.app_security_housing_references(p) LOOP
   IF a->'version' IS DISTINCT FROM '1'::jsonb OR a->>'methodVersion' IS DISTINCT FROM 'housing-affordability-1.0.0' OR jsonb_typeof(a->'baselineGroups') IS DISTINCT FROM 'array' OR jsonb_typeof(a->'proposalGroups') IS DISTINCT FROM 'array' OR jsonb_typeof(a->'sources') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid housing scenario reference' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR s IN SELECT * FROM __SCHEMA__.app_security_housing_sources(p) LOOP
   IF __SCHEMA__.app_security_housing_permission(s,'private') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Housing private processing permissions required' USING ERRCODE='42501'; END IF;
  END LOOP;
  FOR s IN SELECT * FROM __SCHEMA__.app_security_housing_sources(prior) LOOP
   IF s->'rights' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_security_housing_sources(p) n WHERE n->'rights' IS NOT NULL AND (n->>'id'=s->>'id' OR (coalesce(s->>'url','')<>'' AND n->>'url'=s->>'url'))) THEN RAISE EXCEPTION 'Housing rights history cannot be erased' USING ERRCODE='42501'; END IF;
  END LOOP;
  FOR g IN SELECT * FROM __SCHEMA__.app_security_housing_groups(p) LOOP
   IF coalesce(g->>'areaHash','') !~ '^[a-f0-9]{64}$' OR coalesce(g->>'areaOrigin','') NOT IN ('server-catalog','imported') THEN RAISE EXCEPTION 'Invalid housing source reference' USING ERRCODE='23514'; END IF;
   pack:=p->'housingIncomeLimits'->(g->>'areaHash');
   IF pack IS NULL OR pack='null'::jsonb THEN RAISE EXCEPTION 'Referenced housing pack is missing' USING ERRCODE='23514'; END IF;
   IF g->>'areaOrigin'='imported' THEN CONTINUE; END IF;
   IF prior->'housingIncomeLimits'->(g->>'areaHash')=pack AND EXISTS(SELECT 1 FROM __SCHEMA__.app_security_housing_groups(prior) oldg WHERE oldg->>'areaOrigin'='server-catalog' AND oldg->>'areaHash'=g->>'areaHash') THEN CONTINUE; END IF;
   SELECT payload->'pack' INTO registered FROM __SCHEMA__.app_housing_sources WHERE id=g->>'areaHash';
   IF registered IS NULL OR registered IS DISTINCT FROM pack THEN RAISE EXCEPTION 'Housing authority requires exact operator-registered pack' USING ERRCODE='42501'; END IF;
  END LOOP;
 ELSE
  a:=NEW.payload->'scenario'->'affordability';selected:=NEW.payload->'housingIncomeLimits';
  IF a IS NULL THEN IF selected IS NOT NULL THEN RAISE EXCEPTION 'Unselected housing packs cannot be published' USING ERRCODE='23514'; END IF; RETURN NEW; END IF;
  SELECT id,organization_id,baseline_hash,payload INTO target FROM __SCHEMA__.app_projects WHERE id=NEW.project_id;
  IF target.id IS NULL OR target.organization_id IS DISTINCT FROM NEW.organization_id OR target.baseline_hash IS DISTINCT FROM NEW.baseline_hash OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(target.payload->'project'->'scenarios') scenario WHERE scenario->>'id'=NEW.payload->'scenario'->>'id' AND scenario->'affordability'=a) THEN RAISE EXCEPTION 'Published housing configuration must match its project' USING ERRCODE='42501'; END IF;
  p:=target.payload->'project';
  IF selected IS DISTINCT FROM coalesce((SELECT jsonb_object_agg(DISTINCT item.value->>'areaHash',p->'housingIncomeLimits'->(item.value->>'areaHash')) FROM jsonb_array_elements((a->'baselineGroups')||(a->'proposalGroups')) item(value)),'{}'::jsonb) THEN RAISE EXCEPTION 'Published housing packs must exactly match selected project evidence' USING ERRCODE='42501'; END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(a->'sources') UNION ALL SELECT citation.value FROM jsonb_each(selected) selected_pack CROSS JOIN LATERAL jsonb_array_elements(selected_pack.value->'sources') citation(value) LOOP
   IF __SCHEMA__.app_security_housing_permission(s,'publicRedistribution') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Housing public redistribution permission required' USING ERRCODE='42501'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_housing_registry() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF __SCHEMA__.app_security_kind() IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Housing registration requires operator role' USING ERRCODE='42501'; END IF;
 IF NEW.header->>'id' IS DISTINCT FROM NEW.id OR coalesce(NEW.header->>'sourceManifestHash','') !~ '^[a-f0-9]{64}$' OR __SCHEMA__.app_security_housing_pack(NEW.payload->'pack') IS DISTINCT FROM true OR NEW.organization_id IS NOT NULL OR NEW.project_id IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.payload->'pack'->'sources') s WHERE __SCHEMA__.app_security_housing_permission(s,'export') IS DISTINCT FROM true OR __SCHEMA__.app_security_housing_permission(s,'publicRedistribution') IS DISTINCT FROM true) THEN RAISE EXCEPTION 'Invalid registered housing evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DO $install$
DECLARE cfg record; fn regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 ALTER TABLE __SCHEMA__.app_housing_sources ENABLE ROW LEVEL SECURITY;
 ALTER TABLE __SCHEMA__.app_housing_sources FORCE ROW LEVEL SECURITY;
 EXECUTE format('REVOKE ALL ON __SCHEMA__.app_housing_sources FROM PUBLIC,%I,%I,%I',cfg.web_role,cfg.auth_role,cfg.worker_role);
 DROP POLICY IF EXISTS operator_all ON __SCHEMA__.app_housing_sources;
 EXECUTE format('CREATE POLICY operator_all ON __SCHEMA__.app_housing_sources TO %I USING(true) WITH CHECK(true)',cfg.migration_role);
 DROP POLICY IF EXISTS public_source_read ON __SCHEMA__.app_housing_sources;
 EXECUTE format('CREATE POLICY public_source_read ON __SCHEMA__.app_housing_sources FOR SELECT TO %I USING(true)',cfg.web_role);
 EXECUTE format('GRANT SELECT ON __SCHEMA__.app_housing_sources TO %I',cfg.web_role);
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND p.proname LIKE 'app_security_housing_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role); END LOOP;
END $install$;
DROP TRIGGER IF EXISTS security_housing_capture ON __SCHEMA__.app_projects;
CREATE TRIGGER security_housing_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_projects FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_housing_capture();
DROP TRIGGER IF EXISTS security_housing_capture ON __SCHEMA__.app_published;
CREATE TRIGGER security_housing_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_published FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_housing_capture();
DROP TRIGGER IF EXISTS security_housing_registry ON __SCHEMA__.app_housing_sources;
CREATE TRIGGER security_housing_registry BEFORE INSERT ON __SCHEMA__.app_housing_sources FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_housing_registry();
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=21) THEN 21 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(21) ON CONFLICT DO NOTHING;
