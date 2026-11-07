-- Appended fiscal library and immutable new-study boundaries.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow_v19(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE uid text:=__SCHEMA__.app_security_principal()->>'userId';
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN true; END IF;
 IF __SCHEMA__.app_security_mode('worker.media') THEN
  IF entity='mediaJobs' THEN RETURN operation IN ('SELECT','UPDATE') OR (operation='INSERT' AND actor=uid AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor')); END IF;
  IF entity='mediaArtifacts' THEN RETURN operation IN ('SELECT','INSERT'); END IF;
  IF entity='nativeCapacity' THEN RETURN operation IN ('SELECT','UPDATE'); END IF;
  IF entity='budget' THEN RETURN operation='SELECT'; END IF;
  IF entity='projects' THEN RETURN operation='SELECT' AND ((row_id=nullif(current_setting('urban.project_id',true),'') AND __SCHEMA__.app_security_project_role(row_id) IN ('owner','editor')) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_media_jobs j WHERE j.project_id=row_id)); END IF;
  IF entity='memberships' THEN RETURN operation='SELECT' AND (actor=uid OR EXISTS(SELECT 1 FROM __SCHEMA__.app_media_jobs j WHERE j.user_id=actor AND j.organization_id=organization)); END IF;
  IF entity='users' THEN RETURN operation='SELECT' AND row_id=uid; END IF;
  IF entity='sessions' THEN RETURN operation='SELECT' AND row_id=nullif(current_setting('urban.session_hash',true),'') AND actor=uid; END IF;
  IF entity='organizations' THEN RETURN operation='SELECT' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships m WHERE m.user_id=uid AND m.organization_id=row_id); END IF;
  IF entity='audit' THEN RETURN operation='INSERT' AND body->>'actorId'=uid AND body->>'action'='media.submitted' AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor'); END IF;
  RETURN false;
 END IF;
 IF entity IN ('mediaJobs','mediaArtifacts') THEN
  IF __SCHEMA__.app_security_kind()<>'web' THEN RETURN false; END IF;
  RETURN (operation='SELECT' AND __SCHEMA__.app_security_project_role(project) IS NOT NULL) OR (entity='mediaJobs' AND operation='UPDATE' AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor'));
 END IF;
 RETURN __SCHEMA__.app_security_allow_v18(entity,operation,row_id,organization,actor,project,snapshot,body);
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_fiscal_workspace(organization text,writing boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT __SCHEMA__.app_security_kind()='web' AND organization=__SCHEMA__.app_security_principal()->>'organizationId' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships m WHERE m.organization_id=organization AND m.user_id=__SCHEMA__.app_security_principal()->>'userId' AND coalesce(m.header->>'scope','workspace')<>'project-only' AND (NOT writing OR m.header->>'role' IN ('owner','editor')))
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN true;END IF;
 IF entity='audit' AND operation='INSERT' AND body->>'action'='fiscal.profile.saved' THEN RETURN body->>'actorId'=__SCHEMA__.app_security_principal()->>'userId' AND __SCHEMA__.app_security_fiscal_workspace(organization,true) AND EXISTS(SELECT 1 FROM __SCHEMA__.app_fiscal_profiles f WHERE f.organization_id=organization AND f.user_id=body->>'actorId' AND f.id=body->'details'->>'versionId' AND f.header->'profileHash'=body->'details'->'profileHash'); END IF;
 IF entity='fiscalProfiles' THEN RETURN (operation='SELECT' AND __SCHEMA__.app_security_fiscal_workspace(organization,false)) OR (operation='INSERT' AND actor=__SCHEMA__.app_security_principal()->>'userId' AND __SCHEMA__.app_security_fiscal_workspace(organization,true)); END IF;
 IF entity='fiscalStudyCreations' THEN RETURN operation IN ('SELECT','INSERT') AND actor=__SCHEMA__.app_security_principal()->>'userId' AND __SCHEMA__.app_security_fiscal_workspace(organization,true) AND __SCHEMA__.app_security_project_role(body->>'sourceProjectId') IN ('owner','editor'); END IF;
 RETURN __SCHEMA__.app_security_allow_v19(entity,operation,row_id,organization,actor,project,snapshot,body);
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_fiscal_profile(profile jsonb,public_use boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE s jsonb;k text;v numeric;
BEGIN
 IF profile IS NULL OR profile->'version' IS DISTINCT FROM '1'::jsonb OR profile->>'methodVersion' IS DISTINCT FROM 'fiscal-study-1.0.0' OR profile->>'currency' IS DISTINCT FROM 'USD' OR profile->>'priceBasis' IS DISTINCT FROM 'constant-dollars' OR profile->>'discountBasis' IS DISTINCT FROM 'real' OR jsonb_typeof(profile->'sources') IS DISTINCT FROM 'array' OR jsonb_array_length(profile->'sources') NOT BETWEEN 1 AND 100 OR octet_length(profile::text)>524288 THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['assessedValuePerSqft','effectivePropertyTaxRate','annualServiceCostPerResident','annualServiceCostPerJob','annualGrowthRate','discountRate','salesPerSqft','localSalesTaxRate','retailCaptureRate'] LOOP
  IF jsonb_typeof(profile->'coefficients'->k) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  v:=(profile->'coefficients'->>k)::numeric;
  IF v<(CASE WHEN k='annualGrowthRate' THEN -0.99 ELSE 0 END) OR v>(CASE WHEN k IN ('effectivePropertyTaxRate','annualGrowthRate','discountRate','localSalesTaxRate','retailCaptureRate') THEN 1 WHEN k='salesPerSqft' THEN 100000000 ELSE 10000000 END) THEN RETURN false;END IF;
 END LOOP;
 FOR s IN SELECT value FROM jsonb_array_elements(profile->'sources') LOOP
  IF s->'rights'->'version' IS DISTINCT FROM '1'::jsonb OR s->'rights'->'privateUse' IS DISTINCT FROM 'true'::jsonb OR s->'rights'->'cache' IS DISTINCT FROM 'true'::jsonb OR s->'rights'->'analyze' IS DISTINCT FROM 'true'::jsonb OR s->'rights'->'privateDisplay' IS DISTINCT FROM 'true'::jsonb OR s->'rights'->'historicalRetention' IS DISTINCT FROM 'true'::jsonb OR (public_use AND s->'rights'->'publicRedistribution' IS DISTINCT FROM 'true'::jsonb) THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_fiscal_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE h jsonb:=NEW.header;p jsonb:=NEW.payload->'profile';prior jsonb;src record;target record;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW;END IF;
 IF TG_OP<>'INSERT' OR h->>'id' IS DISTINCT FROM NEW.id OR h->>'organizationId' IS DISTINCT FROM NEW.organization_id OR h->>'userId' IS DISTINCT FROM NEW.user_id OR NEW.user_id IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR NOT __SCHEMA__.app_security_fiscal_workspace(NEW.organization_id,true) OR NEW.snapshot_id IS NOT NULL OR NEW.email IS NOT NULL OR NEW.baseline_hash IS NOT NULL THEN RAISE EXCEPTION 'Invalid fiscal record identity or workspace permission' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(h->'createdAt') IS DISTINCT FROM 'string' OR NOT isfinite((h->>'createdAt')::timestamptz) OR (h->>'createdAt')::timestamptz NOT BETWEEN statement_timestamp()-interval '30 seconds' AND statement_timestamp()+interval '5 seconds' OR jsonb_typeof(h->'idempotencyKey') IS DISTINCT FROM 'string' OR length(h->>'idempotencyKey') NOT BETWEEN 8 AND 160 OR jsonb_typeof(h->'submissionHash') IS DISTINCT FROM 'string' OR h->>'submissionHash' !~ '^[a-f0-9]{64}$' OR h->>'profileHash' IS NULL OR h->>'profileHash' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid fiscal receipt fields' USING ERRCODE='23514';END IF;
 PERFORM (NEW.id)::uuid;
 IF TG_TABLE_NAME='app_fiscal_profiles' THEN
  PERFORM (h->>'profileId')::uuid;
  IF NEW.project_id IS NOT NULL OR NEW.payload-ARRAY['profile']<>'{}'::jsonb OR NOT __SCHEMA__.app_security_fiscal_profile(p) OR h->'name' IS DISTINCT FROM p->'name' OR h->'jurisdictionName' IS DISTINCT FROM p->'jurisdiction'->'name' OR h->'fiscalYear' IS DISTINCT FROM p->'fiscalYear' OR jsonb_typeof(h->'version') IS DISTINCT FROM 'number' OR (h->>'version')::numeric NOT BETWEEN 1 AND 100 OR (h->>'version')::numeric<>trunc((h->>'version')::numeric) THEN RAISE EXCEPTION 'Invalid fiscal profile snapshot' USING ERRCODE='23514';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'sources') s WHERE s->'rights'->>'declaredBy' IS DISTINCT FROM NEW.user_id OR s->'rights'->'declaredAt' IS DISTINCT FROM h->'createdAt') THEN RAISE EXCEPTION 'Fiscal attestations must identify their authenticated submitter and receipt time' USING ERRCODE='23514';END IF;
  SELECT header INTO prior FROM __SCHEMA__.app_fiscal_profiles WHERE organization_id=NEW.organization_id AND header->>'profileId'=h->>'profileId' ORDER BY (header->>'version')::integer DESC LIMIT 1;
  IF (h->>'version')::integer<>coalesce((prior->>'version')::integer,0)+1 OR h->'previousVersionId' IS DISTINCT FROM coalesce(prior->'id','null'::jsonb) OR (SELECT count(*) FROM __SCHEMA__.app_fiscal_profiles WHERE organization_id=NEW.organization_id)>=1000 THEN RAISE EXCEPTION 'Fiscal versions must append to their current family within retained capacity' USING ERRCODE='42501';END IF;
 ELSE
  IF (NEW.payload IS NOT NULL AND NEW.payload<>'null'::jsonb) OR h->>'projectId' IS DISTINCT FROM NEW.project_id OR h->>'sourceProjectId' IS NULL OR jsonb_typeof(h->'sourceVersion') IS DISTINCT FROM 'number' OR jsonb_typeof(h->'sourceRevision') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid fiscal study receipt' USING ERRCODE='23514';END IF;
  SELECT * INTO src FROM __SCHEMA__.app_projects WHERE id=h->>'sourceProjectId' AND organization_id=NEW.organization_id;
  SELECT * INTO target FROM __SCHEMA__.app_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id;
  IF src.id IS NULL OR target.id IS NULL OR target.header->>'createdBy' IS DISTINCT FROM NEW.user_id OR target.header->'version' IS DISTINCT FROM '1'::jsonb OR src.header->'version' IS DISTINCT FROM h->'sourceVersion' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(src.header->'project'->'scenarios') s WHERE s->>'id'=h->>'sourceScenarioId' AND s->'revision'=h->'sourceRevision') OR target.payload->'project'->'fiscalStudy'->'profileHash' IS DISTINCT FROM h->'profileHash' OR target.payload->'project'->'fiscalStudy'->'lineage'->'projectId' IS DISTINCT FROM h->'sourceProjectId' OR target.payload->'project'->'fiscalStudy'->'lineage'->'scenarioId' IS DISTINCT FROM h->'sourceScenarioId' OR target.baseline_hash IS DISTINCT FROM src.baseline_hash THEN RAISE EXCEPTION 'Fiscal creation must bind the new study and exact authorized source' USING ERRCODE='42501';END IF;
  IF h ? 'libraryVersionId' AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_fiscal_profiles f WHERE f.id=h->>'libraryVersionId' AND f.organization_id=NEW.organization_id AND f.header->'profileHash'=h->'profileHash' AND f.payload->'profile'=target.payload->'project'->'fiscalStudy'->'profile') THEN RAISE EXCEPTION 'Fiscal library version differs from frozen new study' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_fiscal_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE p jsonb:=NEW.payload->'project';study jsonb;source jsonb;ref jsonb;base jsonb;k text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='app_projects' THEN
  study:=p->'fiscalStudy';
  IF TG_OP='UPDATE' AND study IS DISTINCT FROM OLD.payload->'project'->'fiscalStudy' THEN RAISE EXCEPTION 'Saved fiscal study profile is immutable; create a separate study' USING ERRCODE='42501';END IF;
  FOR ref IN
   SELECT s->'fiscal' FROM jsonb_array_elements(coalesce(p->'scenarios','[]'::jsonb)) s
   UNION ALL SELECT e->'before'->'fiscal' FROM jsonb_array_elements(coalesce(p->'history','[]'::jsonb)||coalesce(p->'undone','[]'::jsonb)) e
   UNION ALL SELECT e->'after'->'fiscal' FROM jsonb_array_elements(coalesce(p->'history','[]'::jsonb)||coalesce(p->'undone','[]'::jsonb)) e
   UNION ALL SELECT e->'command'->'fiscal' FROM jsonb_array_elements(coalesce(p->'history','[]'::jsonb)||coalesce(p->'undone','[]'::jsonb)) e WHERE e->'command'->>'type'='scenario.fiscal'
  LOOP IF ref IS NOT NULL AND ref<>'null'::jsonb AND (study IS NULL OR ref->'profileHash' IS DISTINCT FROM study->'profileHash') THEN RAISE EXCEPTION 'Fiscal review belongs to another study profile' USING ERRCODE='23514';END IF;END LOOP;
  IF study IS NULL THEN RETURN NEW;END IF;
  SELECT s INTO base FROM jsonb_array_elements(p->'scenarios') s WHERE s->>'id'='baseline';
  IF study->'version' IS DISTINCT FROM '1'::jsonb OR study->>'methodVersion' IS DISTINCT FROM 'fiscal-study-1.0.0' OR (p->>'schemaVersion')::integer<12 OR study->>'placeHash' IS DISTINCT FROM NEW.baseline_hash OR NOT __SCHEMA__.app_security_fiscal_profile(study->'profile') OR base IS NULL THEN RAISE EXCEPTION 'Invalid frozen fiscal study profile' USING ERRCODE='23514';END IF;
  FOREACH k IN ARRAY ARRAY['assessedValuePerSqft','effectivePropertyTaxRate','annualServiceCostPerResident','annualServiceCostPerJob','annualGrowthRate','discountRate','salesPerSqft','localSalesTaxRate','retailCaptureRate'] LOOP IF base->'assumptions'->k IS DISTINCT FROM study->'profile'->'coefficients'->k THEN RAISE EXCEPTION 'Fiscal baseline coefficients differ from frozen profile' USING ERRCODE='23514';END IF;END LOOP;
 ELSE
  study:=NEW.payload->'fiscalStudy';
  SELECT payload->'project'->'fiscalStudy' INTO source FROM __SCHEMA__.app_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id;
  IF study IS DISTINCT FROM source OR (study IS NOT NULL AND NOT __SCHEMA__.app_security_fiscal_profile(study->'profile',true)) THEN RAISE EXCEPTION 'Publication must retain exact publicly permitted fiscal evidence' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
DO $install$
DECLARE cfg record;tab text;entity text;fn regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 FOREACH tab IN ARRAY ARRAY['app_fiscal_profiles','app_fiscal_study_creations'] LOOP
  entity:=CASE tab WHEN 'app_fiscal_profiles' THEN 'fiscalProfiles' ELSE 'fiscalStudyCreations' END;
  EXECUTE format('ALTER TABLE __SCHEMA__.%I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE __SCHEMA__.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('REVOKE ALL ON __SCHEMA__.%I FROM PUBLIC,%I,%I,%I',tab,cfg.web_role,cfg.auth_role,cfg.worker_role);
  EXECUTE format('DROP POLICY IF EXISTS operator_access ON __SCHEMA__.%I',tab);EXECUTE format('CREATE POLICY operator_access ON __SCHEMA__.%I TO %I USING(true) WITH CHECK(true)',tab,cfg.migration_role);
  EXECUTE format('DROP POLICY IF EXISTS fiscal_read ON __SCHEMA__.%I',tab);EXECUTE format('CREATE POLICY fiscal_read ON __SCHEMA__.%I FOR SELECT TO %I USING(__SCHEMA__.app_security_allow(%L,''SELECT'',id,organization_id,user_id,project_id,snapshot_id,header))',tab,cfg.web_role,entity);
  EXECUTE format('DROP POLICY IF EXISTS fiscal_insert ON __SCHEMA__.%I',tab);EXECUTE format('CREATE POLICY fiscal_insert ON __SCHEMA__.%I FOR INSERT TO %I WITH CHECK(__SCHEMA__.app_security_allow(%L,''INSERT'',id,organization_id,user_id,project_id,snapshot_id,header))',tab,cfg.web_role,entity);
  EXECUTE format('GRANT SELECT,INSERT ON __SCHEMA__.%I TO %I',tab,cfg.web_role);
  EXECUTE format('DROP TRIGGER IF EXISTS fiscal_bind ON __SCHEMA__.%I',tab);EXECUTE format('CREATE TRIGGER fiscal_bind BEFORE INSERT ON __SCHEMA__.%I FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_fiscal_bind()',tab);
 END LOOP;
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND (p.proname LIKE 'app_security_fiscal_%' OR p.proname='app_security_allow_v19') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role);END LOOP;
END $install$;
DROP TRIGGER IF EXISTS security_fiscal_capture ON __SCHEMA__.app_projects;
CREATE TRIGGER security_fiscal_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_projects FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_fiscal_capture();
DROP TRIGGER IF EXISTS security_fiscal_capture ON __SCHEMA__.app_published;
CREATE TRIGGER security_fiscal_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_published FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_fiscal_capture();
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=20) THEN 20 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(20) ON CONFLICT DO NOTHING;
