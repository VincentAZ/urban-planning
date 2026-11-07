-- Temporary fail-closed traffic admission. No completed-job authority registry exists yet.
-- Preserve trusted operator migrations; application roles may retain imported evidence only.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_traffic_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE item jsonb; candidates jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 -- ACL/revocation metadata writes cannot introduce evidence and may preserve trusted legacy content.
 IF TG_OP='UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='app_projects' THEN
  SELECT coalesce(jsonb_agg(v),'[]'::jsonb) INTO candidates FROM (
   SELECT jsonb_path_query(NEW.payload,'$.project.scenarios[*].traffic') v
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.history[*].before.traffic')
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.history[*].after.traffic')
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.history[*].command.traffic')
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.undone[*].before.traffic')
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.undone[*].after.traffic')
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.undone[*].command.traffic')
  ) captured;
 ELSE candidates:=jsonb_build_array(NEW.payload->'scenario'->'traffic'); END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(candidates) WHERE value IS NOT NULL AND value<>'null'::jsonb LOOP
  IF item->>'origin' IS DISTINCT FROM 'imported' THEN
   RAISE EXCEPTION 'Traffic server-run admission requires a completed immutable authority registry; retain external evidence as imported' USING ERRCODE='42501';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION __SCHEMA__.app_security_traffic_capture() FROM PUBLIC;
DO $install$
DECLARE cfg record;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 EXECUTE format('REVOKE ALL ON FUNCTION __SCHEMA__.app_security_traffic_capture() FROM %I,%I,%I',cfg.web_role,cfg.auth_role,cfg.worker_role);
END $install$;
DROP TRIGGER IF EXISTS security_traffic_capture ON __SCHEMA__.app_projects;
CREATE TRIGGER security_traffic_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_projects FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_traffic_capture();
DROP TRIGGER IF EXISTS security_traffic_capture ON __SCHEMA__.app_published;
CREATE TRIGGER security_traffic_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_published FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_traffic_capture();
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=8) THEN 8 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;
