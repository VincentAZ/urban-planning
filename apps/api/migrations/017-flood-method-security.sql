-- References select a calculation method independently of immutable source packs.
-- An omitted methodVersion retains flood-footprint-1.0.0 byte-for-byte; explicit
-- null, unknown or future values are rejected rather than silently upgraded.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_flood_method_reference(ref jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT NOT (ref ? 'methodVersion') OR (
  jsonb_typeof(ref->'methodVersion')='string' AND
  ref->>'methodVersion' IN ('flood-footprint-1.0.0','flood-footprint-1.1.0')
 )
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_flood_method_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE ref jsonb;
BEGIN
 IF TG_OP='UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='app_projects' THEN
  FOR ref IN SELECT * FROM __SCHEMA__.app_security_flood_references(NEW.payload->'project') LOOP
   IF __SCHEMA__.app_security_flood_method_reference(ref) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Unsupported flood calculation method' USING ERRCODE='23514';
   END IF;
  END LOOP;
 ELSE
  ref:=NEW.payload->'scenario'->'flood';
  IF ref IS NOT NULL AND __SCHEMA__.app_security_flood_method_reference(ref) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'Unsupported flood calculation method' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DO $install$
DECLARE cfg record; fn regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND p.proname IN ('app_security_flood_method_reference','app_security_flood_method_capture') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role);
 END LOOP;
END $install$;
DROP TRIGGER IF EXISTS security_flood_method ON __SCHEMA__.app_projects;
CREATE TRIGGER security_flood_method BEFORE INSERT OR UPDATE ON __SCHEMA__.app_projects FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_flood_method_capture();
DROP TRIGGER IF EXISTS security_flood_method ON __SCHEMA__.app_published;
CREATE TRIGGER security_flood_method BEFORE INSERT OR UPDATE ON __SCHEMA__.app_published FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_flood_method_capture();
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=17) THEN 17 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(17) ON CONFLICT DO NOTHING;
