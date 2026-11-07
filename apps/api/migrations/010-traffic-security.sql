-- Traffic authority and one shared native execution slot; prior migrations remain unchanged.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow_v7(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE principal jsonb:=__SCHEMA__.app_security_principal(); uid text:=principal->>'userId';
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN true; END IF;
 IF __SCHEMA__.app_security_mode('worker.gis') THEN
  IF entity='gisJobs' THEN RETURN operation IN ('SELECT','UPDATE') OR (operation='INSERT' AND actor=uid AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor'));
  ELSIF entity='budget' THEN RETURN operation='SELECT';
  ELSIF entity='projects' THEN RETURN operation='SELECT' AND ((row_id=nullif(current_setting('urban.project_id',true),'') AND __SCHEMA__.app_security_project_role(row_id) IN ('owner','editor')) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_gis_jobs j WHERE j.project_id=row_id));
  ELSIF entity='memberships' THEN RETURN operation='SELECT' AND (actor=uid OR EXISTS(SELECT 1 FROM __SCHEMA__.app_gis_jobs j WHERE j.user_id=actor AND j.organization_id=organization));
  ELSIF entity='users' THEN RETURN operation='SELECT' AND row_id=uid;
  ELSIF entity='sessions' THEN RETURN operation='SELECT' AND row_id=nullif(current_setting('urban.session_hash',true),'') AND actor=uid;
  ELSIF entity='organizations' THEN RETURN operation='SELECT' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships m WHERE m.user_id=uid AND m.organization_id=row_id);
  ELSIF entity='audit' THEN RETURN operation='INSERT' AND body->>'actorId'=uid AND body->>'action' IN ('gis.submitted','gis.retried') AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor');
  ELSIF entity='imports' THEN RETURN operation IN ('SELECT','INSERT') AND EXISTS(SELECT 1 FROM __SCHEMA__.app_gis_jobs j WHERE j.id=body->'prepared'->'preview'->>'jobId' AND j.project_id=project AND j.organization_id=organization AND j.user_id=body->>'createdBy' AND j.header->>'kind'='prepare' AND j.header->>'status' IN ('running','completed') AND (operation='SELECT' OR (j.header->>'status'='running' AND __SCHEMA__.app_security_gis_active(project)) OR (j.header->>'status'='completed' AND j.xmin::text::bigint=mod(txid_current(),4294967296))));
  ELSE RETURN false; END IF;
 END IF;
 IF entity='gisJobs' THEN RETURN __SCHEMA__.app_security_kind()='web' AND operation IN ('SELECT','UPDATE') AND actor=uid AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor'); END IF;
 IF entity='imports' AND project IS NOT NULL THEN RETURN __SCHEMA__.app_security_kind()='web' AND operation IN ('SELECT','INSERT','UPDATE') AND organization=principal->>'organizationId' AND body->>'createdBy'=uid AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor'); END IF;
 RETURN __SCHEMA__.app_security_allow_v5(entity,operation,row_id,organization,actor,project,snapshot,body);
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_principal() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE s jsonb; u text; o text;
BEGIN
 IF __SCHEMA__.app_security_mode('auth.register') THEN
  u:=nullif(current_setting('urban.auth_user_id',true),''); o:=nullif(current_setting('urban.auth_organization_id',true),'');
  IF u IS NULL OR o IS NULL THEN RETURN NULL; END IF;
  IF (EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=u) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_organizations WHERE id=o)) AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_auth_bootstrap WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND user_id=u AND organization_id=o) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('userId',u,'organizationId',o);
 END IF;
 IF __SCHEMA__.app_security_mode('auth.login') THEN
  SELECT id INTO u FROM __SCHEMA__.app_users WHERE id=current_setting('urban.auth_user_id',true) AND email=current_setting('urban.auth_email',true);
  IF u IS NOT NULL THEN RETURN jsonb_build_object('userId',u); END IF;
  RETURN NULL;
 END IF;
 IF __SCHEMA__.app_security_kind()<>'web' AND NOT (__SCHEMA__.app_security_mode('worker.prep') OR __SCHEMA__.app_security_mode('worker.workforce') OR __SCHEMA__.app_security_mode('worker.gis') OR __SCHEMA__.app_security_mode('worker.traffic')) THEN RETURN NULL; END IF;
 SELECT header INTO s FROM __SCHEMA__.app_sessions WHERE id=nullif(current_setting('urban.session_hash',true),'') AND (header->>'expiresAt')::timestamptz>statement_timestamp();
 IF s IS NULL THEN RETURN NULL; END IF;
 u:=s->>'userId'; o:=s->>'organizationId';
 IF EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=u) AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE user_id=u AND organization_id=o) THEN RETURN jsonb_build_object('userId',u,'organizationId',o); END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_traffic_active(project text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT __SCHEMA__.app_security_mode('worker.traffic') AND EXISTS(SELECT 1 FROM __SCHEMA__.app_traffic_jobs j WHERE j.project_id=project AND j.header->>'status'='running' AND j.header->'cancelRequested'='false'::jsonb AND (j.header->>'leaseExpiresAt')::timestamptz>statement_timestamp() AND __SCHEMA__.app_security_workforce_creator_can_edit(j.header))
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_traffic_project_payload(project text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF NOT __SCHEMA__.app_security_traffic_active(project) THEN RAISE EXCEPTION 'Traffic project access requires an active authorized job' USING ERRCODE='42501'; END IF;
 RETURN (SELECT payload FROM __SCHEMA__.app_projects WHERE id=project);
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_traffic_baseline(hash text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_projects p WHERE p.baseline_hash=hash AND __SCHEMA__.app_security_traffic_active(p.id)) THEN RAISE EXCEPTION 'Traffic baseline access requires an active authorized job' USING ERRCODE='42501'; END IF;
 RETURN (SELECT payload FROM __SCHEMA__.app_baseline_snapshots WHERE sha256=hash);
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE uid text:=__SCHEMA__.app_security_principal()->>'userId'; role text:=__SCHEMA__.app_security_project_role(project);
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN true; END IF;
 IF entity='nativeCapacity' THEN RETURN operation IN ('SELECT','UPDATE') AND (__SCHEMA__.app_security_mode('worker.gis') OR __SCHEMA__.app_security_mode('worker.workforce') OR __SCHEMA__.app_security_mode('worker.traffic')); END IF;
 IF __SCHEMA__.app_security_mode('worker.traffic') THEN
  IF entity='trafficJobs' THEN RETURN operation IN ('SELECT','UPDATE') OR (operation='INSERT' AND actor=uid AND role IN ('owner','editor'));
  ELSIF entity='trafficArtifacts' THEN RETURN operation IN ('SELECT','INSERT');
  ELSIF entity IN ('trafficConfigs','trafficUploads') THEN RETURN (operation='INSERT' AND actor=uid AND role IN ('owner','editor')) OR (operation='SELECT' AND ((project=nullif(current_setting('urban.project_id',true),'') AND role IN ('owner','editor')) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_traffic_jobs j WHERE j.project_id=project AND j.organization_id=organization AND j.header->>'status' IN ('queued','running','completed'))));
  ELSIF entity='budget' THEN RETURN operation='SELECT';
  ELSIF entity='projects' THEN RETURN operation='SELECT' AND ((row_id=nullif(current_setting('urban.project_id',true),'') AND __SCHEMA__.app_security_project_role(row_id) IN ('owner','editor')) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_traffic_jobs j WHERE j.project_id=row_id));
  ELSIF entity='memberships' THEN RETURN operation='SELECT' AND (actor=uid OR EXISTS(SELECT 1 FROM __SCHEMA__.app_traffic_jobs j WHERE j.user_id=actor AND j.organization_id=organization));
  ELSIF entity='users' THEN RETURN operation='SELECT' AND row_id=uid;
  ELSIF entity='sessions' THEN RETURN operation='SELECT' AND row_id=nullif(current_setting('urban.session_hash',true),'') AND actor=uid;
  ELSIF entity='organizations' THEN RETURN operation='SELECT' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships m WHERE m.user_id=uid AND m.organization_id=row_id);
  ELSIF entity='audit' THEN RETURN operation='INSERT' AND body->>'actorId'=uid AND body->>'action' IN ('traffic.submitted','traffic.retried','traffic.configured','traffic.uploaded') AND role IN ('owner','editor');
  ELSE RETURN false; END IF;
 END IF;
 IF entity IN ('trafficConfigs','trafficUploads','trafficJobs','trafficArtifacts') THEN
  IF __SCHEMA__.app_security_kind()<>'web' THEN RETURN false; END IF;
  IF operation='SELECT' THEN RETURN role IS NOT NULL; END IF;
  IF entity IN ('trafficConfigs','trafficUploads') THEN RETURN false; END IF;
  RETURN entity='trafficJobs' AND operation='UPDATE' AND role IN ('owner','editor');
 END IF;
 RETURN __SCHEMA__.app_security_allow_v7(entity,operation,row_id,organization,actor,project,snapshot,body);
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_native_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE previous jsonb:=OLD.header->'slot'; current_slot jsonb:=NEW.header->'slot'; kind text;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF TG_OP<>'UPDATE' OR NEW.id<>'nativeCapacity' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.organization_id IS NOT NULL OR NEW.user_id IS NOT NULL OR NEW.project_id IS NOT NULL OR NEW.snapshot_id IS NOT NULL OR NEW.email IS NOT NULL OR NEW.baseline_hash IS NOT NULL
  OR jsonb_typeof(NEW.header->'slot') NOT IN ('object','null') OR NOT NEW.header ? 'slot' OR NEW.header->'version' IS DISTINCT FROM '1'::jsonb OR (NEW.header->>'revision')::bigint IS DISTINCT FROM (OLD.header->>'revision')::bigint+1 OR NEW.header->'recoveryHistory' IS DISTINCT FROM OLD.header->'recoveryHistory' OR NEW.header-ARRAY['version','revision','slot','recoveryHistory']<>'{}'::jsonb
 THEN RAISE EXCEPTION 'Invalid native capacity mutation' USING ERRCODE='42501'; END IF;
 IF current_slot='null'::jsonb THEN
  IF previous='null'::jsonb OR previous->>'status'='quarantined' OR NOT __SCHEMA__.app_security_mode('worker.'||(previous->>'kind')) THEN RAISE EXCEPTION 'Only the owning service can release native capacity' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 kind:=current_slot->>'kind';
 IF coalesce(kind,'') NOT IN ('gis','workforce','traffic') OR coalesce(length(current_slot->>'token'),0)<8 OR coalesce(length(current_slot->>'jobId'),0)=0 OR coalesce(length(current_slot->>'workerId'),0)=0 OR coalesce(current_slot->>'status','') NOT IN ('running','quarantined') OR current_slot->>'acquiredAt' IS NULL OR current_slot->>'heartbeatAt' IS NULL OR current_slot->>'hardDeadlineAt' IS NULL THEN RAISE EXCEPTION 'Invalid native slot identity' USING ERRCODE='23514'; END IF;
 IF previous='null'::jsonb THEN
  IF NOT __SCHEMA__.app_security_mode('worker.'||kind) OR current_slot->>'status'<>'running' OR (current_slot->>'acquiredAt')::timestamptz<statement_timestamp()-interval '30 seconds' OR (current_slot->>'acquiredAt')::timestamptz>statement_timestamp()+interval '5 seconds' OR current_slot->'heartbeatAt' IS DISTINCT FROM current_slot->'acquiredAt' OR (current_slot->>'hardDeadlineAt')::timestamptz<=(current_slot->>'acquiredAt')::timestamptz OR (current_slot->>'hardDeadlineAt')::timestamptz>(current_slot->>'acquiredAt')::timestamptz+interval '15 minutes' THEN RAISE EXCEPTION 'Native claim requires its fixed hard deadline and service' USING ERRCODE='42501'; END IF;
 ELSE
  IF current_slot-ARRAY['heartbeatAt','status','reason'] IS DISTINCT FROM previous-ARRAY['heartbeatAt','status','reason'] OR (previous->>'status'='quarantined' AND current_slot->>'status'<>'quarantined') THEN RAISE EXCEPTION 'A native lease cannot be stolen or its hard deadline extended' USING ERRCODE='42501'; END IF;
  IF NOT __SCHEMA__.app_security_mode('worker.'||kind) AND NOT(current_slot->>'status'='quarantined' AND current_slot->'heartbeatAt' IS NOT DISTINCT FROM previous->'heartbeatAt' AND ((previous->>'hardDeadlineAt')::timestamptz<=statement_timestamp() OR (previous->>'heartbeatAt')::timestamptz+interval '60 seconds'<=statement_timestamp())) THEN RAISE EXCEPTION 'Only the owning service may heartbeat its slot' USING ERRCODE='42501'; END IF;
  IF (current_slot->>'heartbeatAt')::timestamptz<(previous->>'heartbeatAt')::timestamptz OR (current_slot->>'heartbeatAt')::timestamptz>statement_timestamp()+interval '5 seconds' THEN RAISE EXCEPTION 'Invalid native heartbeat' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_native_slot_binding() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE current_slot jsonb; prior_slot jsonb:=OLD.header->'slot'; job jsonb; table_name text;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 SELECT header->'slot' INTO current_slot FROM __SCHEMA__.app_native_capacity WHERE id='nativeCapacity';
 IF current_slot='null'::jsonb THEN
  IF prior_slot IS NULL OR prior_slot='null'::jsonb THEN RETURN NEW; END IF;
  table_name:=CASE prior_slot->>'kind' WHEN 'gis' THEN 'app_gis_jobs' WHEN 'workforce' THEN 'app_workforce_jobs' WHEN 'traffic' THEN 'app_traffic_jobs' END;
  EXECUTE format('SELECT header FROM __SCHEMA__.%I WHERE id=$1',table_name) INTO job USING prior_slot->>'jobId';
  IF job->>'status'='running' THEN RAISE EXCEPTION 'Running native work cannot release its slot before terminal job state' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF current_slot->>'status'='quarantined' THEN RETURN NEW; END IF;
 table_name:=CASE current_slot->>'kind' WHEN 'gis' THEN 'app_gis_jobs' WHEN 'workforce' THEN 'app_workforce_jobs' WHEN 'traffic' THEN 'app_traffic_jobs' END;
 EXECUTE format('SELECT header FROM __SCHEMA__.%I WHERE id=$1',table_name) INTO job USING current_slot->>'jobId';
 IF job IS NULL OR job->>'status' IS DISTINCT FROM 'running' OR job->>'capacityToken' IS DISTINCT FROM current_slot->>'token' OR job->>'workerId' IS DISTINCT FROM current_slot->>'workerId' THEN RAISE EXCEPTION 'Shared native slot must bind its exact running job' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_native_job_slot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE slot jsonb; kind text:=CASE TG_TABLE_NAME WHEN 'app_gis_jobs' THEN 'gis' WHEN 'app_workforce_jobs' THEN 'workforce' ELSE 'traffic' END; current_job jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 -- Read the final row: an atomic short operation may already have completed.
 EXECUTE format('SELECT header FROM __SCHEMA__.%I WHERE id=$1',TG_TABLE_NAME) INTO current_job USING NEW.id;
 IF current_job->>'status' IS DISTINCT FROM 'running' THEN RETURN NEW; END IF;
 SELECT header->'slot' INTO slot FROM __SCHEMA__.app_native_capacity WHERE id='nativeCapacity';
 IF slot IS NULL OR slot='null'::jsonb OR slot->>'status' IS DISTINCT FROM 'running' OR slot->>'kind' IS DISTINCT FROM kind OR slot->>'jobId' IS DISTINCT FROM NEW.id OR slot->>'workerId' IS DISTINCT FROM current_job->>'workerId' OR slot->>'token' IS DISTINCT FROM current_job->>'capacityToken' OR (slot->>'hardDeadlineAt')::timestamptz<=statement_timestamp() THEN RAISE EXCEPTION 'Native work requires its exact active shared capacity token' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_traffic_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE body jsonb:=NEW.header; p record; config record; job record; artifact jsonb; old_status text; new_status text; old_attempt integer; new_attempt integer; i integer; previous jsonb; current_attempt jsonb; mutable text[];
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF body->>'id' IS DISTINCT FROM NEW.id OR body->>'organizationId' IS DISTINCT FROM NEW.organization_id OR body->>'projectId' IS DISTINCT FROM NEW.project_id OR NEW.snapshot_id IS NOT NULL OR NEW.email IS NOT NULL OR NEW.baseline_hash IS NOT NULL THEN RAISE EXCEPTION 'Traffic scalar identity must match the captured record' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM __SCHEMA__.app_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Traffic project must exist in its recorded organization' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN RAISE EXCEPTION 'Traffic record identity is immutable' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME<>'app_traffic_jobs' AND TG_OP='UPDATE' THEN RAISE EXCEPTION 'Traffic inputs and artifacts are append-only' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='app_traffic_artifacts' THEN
  artifact:=body->'traffic';
  SELECT * INTO job FROM __SCHEMA__.app_traffic_jobs WHERE id=body->>'jobId';
  IF NOT __SCHEMA__.app_security_mode('worker.traffic') OR NEW.user_id IS NOT NULL OR NEW.payload IS NOT NULL AND NEW.payload<>'null'::jsonb OR octet_length(artifact::text)>262144 OR artifact->>'origin' IS DISTINCT FROM 'server-run' OR job.id IS NULL OR job.project_id IS DISTINCT FROM NEW.project_id OR job.organization_id IS DISTINCT FROM NEW.organization_id OR job.header->>'configurationId' IS DISTINCT FROM body->>'configurationId' OR job.header->>'scenarioId' IS DISTINCT FROM body->>'scenarioId' OR job.header->>'status' NOT IN ('running','completed') OR job.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(job.header)
   OR artifact->'receipt'->>'captureId' IS DISTINCT FROM NEW.id OR artifact->'receipt'->>'jobId' IS DISTINCT FROM job.id OR artifact->'receipt'->>'projectId' IS DISTINCT FROM NEW.project_id OR artifact->'binding'->>'baselineHash' IS DISTINCT FROM job.header->>'baselineHash' OR artifact->'binding'->>'roadEditsHash' IS DISTINCT FROM job.header->>'roadEditsHash' OR artifact->'binding'->>'placeId' IS DISTINCT FROM p.header->'project'->>'placeId' OR coalesce(artifact->>'captureHash','')!~'^[0-9a-f]{64}$'
   OR artifact->'capture'->'network'->>'baselineFileSha256' IS DISTINCT FROM job.header->'prepared'->>'networkHash'
  THEN RAISE EXCEPTION 'Traffic artifact requires its exact authorized native job and study identity' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF body->>'userId' IS DISTINCT FROM NEW.user_id THEN RAISE EXCEPTION 'Traffic creator index mismatch' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME IN ('app_traffic_uploads','app_traffic_configs') THEN
  IF NEW.user_id IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR __SCHEMA__.app_security_project_role(NEW.project_id) NOT IN ('owner','editor') THEN RAISE EXCEPTION 'Traffic inputs require a current project editor' USING ERRCODE='42501'; END IF;
  IF TG_TABLE_NAME='app_traffic_uploads' THEN
   IF NEW.payload IS NOT NULL AND NEW.payload<>'null'::jsonb OR coalesce(body->>'sha256','')!~'^[0-9a-f]{64}$' OR coalesce((body->>'bytes')::bigint,0) NOT BETWEEN 1 AND 20971520 OR coalesce((body->>'rows')::integer,0) NOT BETWEEN 1 AND 100000 THEN RAISE EXCEPTION 'Traffic upload requires bounded immutable source bytes' USING ERRCODE='23514'; END IF;
  ELSE
   IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' OR NEW.payload-ARRAY['request']<>'{}'::jsonb OR body ? 'request' OR octet_length(NEW.payload::text)>8388608 OR coalesce(body->>'requestHash','')!~'^[0-9a-f]{64}$' OR body->'scopeAcknowledged' IS DISTINCT FROM 'true'::jsonb OR body->'projectVersion' IS DISTINCT FROM p.header->'version' OR body->>'baselineHash' IS DISTINCT FROM p.baseline_hash OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'project'->'scenarios') s WHERE s->>'id'=body->>'scenarioId' AND s->>'id'<>'baseline' AND s->'revision'=body->'scenarioRevision') THEN RAISE EXCEPTION 'Traffic configuration must bind the reviewed saved proposal' USING ERRCODE='42501'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(body->'uploadIds') id WHERE NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_traffic_uploads u WHERE u.id=id AND u.project_id=NEW.project_id AND u.organization_id=NEW.organization_id)) THEN RAISE EXCEPTION 'Traffic configuration cannot reference another project upload' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.payload IS NOT NULL AND NEW.payload<>'null'::jsonb THEN RAISE EXCEPTION 'Traffic job headers cannot hide an extra payload' USING ERRCODE='23514'; END IF;
 SELECT * INTO config FROM __SCHEMA__.app_traffic_configs WHERE id=body->>'configurationId';
 IF config.id IS NULL OR config.project_id IS DISTINCT FROM NEW.project_id OR config.organization_id IS DISTINCT FROM NEW.organization_id OR body->>'scenarioId' IS DISTINCT FROM config.header->>'scenarioId' OR body->>'requestHash' IS DISTINCT FROM config.header->>'requestHash' OR body->>'baselineHash' IS DISTINCT FROM config.header->>'baselineHash' OR body->>'roadEditsHash' IS DISTINCT FROM config.header->>'roadEditsHash' OR body->'prepared' IS DISTINCT FROM config.header->'prepared' THEN RAISE EXCEPTION 'Traffic job must retain its exact immutable reviewed configuration' USING ERRCODE='42501'; END IF;
 new_status:=body->>'status';new_attempt:=(body->>'attempt')::integer;
 IF coalesce(new_status,'') NOT IN ('queued','running','completed','failed','cancelled') OR new_attempt IS NULL OR new_attempt<0 OR new_attempt>3 OR jsonb_typeof(body->'attempts') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'attempts')<>new_attempt OR jsonb_typeof(body->'requestKeys') IS DISTINCT FROM 'array' OR jsonb_typeof(body->'cancelRequested') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid traffic status or attempt ledger' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT __SCHEMA__.app_security_mode('worker.traffic') OR NEW.user_id IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(body) OR new_status<>'queued' OR new_attempt<>0 OR body->'version' IS DISTINCT FROM '1'::jsonb OR body->>'stage' IS DISTINCT FROM 'queued' OR body->'progress' IS DISTINCT FROM '0'::jsonb OR body->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR body ?| ARRAY['workerId','leaseExpiresAt','capacityToken','result','error'] OR body->'projectVersion' IS DISTINCT FROM p.header->'version' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'project'->'scenarios') s WHERE s->>'id'=body->>'scenarioId' AND s->'revision'=body->'scenarioRevision') OR body->'requestKeys' IS DISTINCT FROM jsonb_build_array(body->>'idempotencyKey') THEN RAISE EXCEPTION 'Traffic admission requires a current unchanged proposal and authenticated editor' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 old_status:=OLD.header->>'status';old_attempt:=(OLD.header->>'attempt')::integer;
 IF NOT((old_status='queued' AND new_status IN ('queued','running','failed','cancelled')) OR (old_status='running' AND new_status IN ('running','completed','failed','cancelled')) OR (old_status IN ('failed','cancelled') AND new_status='queued')) THEN RAISE EXCEPTION 'Traffic state transition is forbidden' USING ERRCODE='42501'; END IF;
 mutable:=ARRAY['version','status','stage','progress','attempt','attempts','cancelRequested','workerId','leaseExpiresAt','capacityToken','error','result','updatedAt','requestKeys'];
 IF body-mutable IS DISTINCT FROM OLD.header-mutable THEN RAISE EXCEPTION 'Traffic admitted inputs are immutable' USING ERRCODE='42501'; END IF;
 IF (body->>'version')::integer IS DISTINCT FROM (OLD.header->>'version')::integer+(CASE WHEN new_status IS DISTINCT FROM old_status OR body->'stage' IS DISTINCT FROM OLD.header->'stage' OR body->'progress' IS DISTINCT FROM OLD.header->'progress' OR body->'cancelRequested' IS DISTINCT FROM OLD.header->'cancelRequested' OR body->'requestKeys' IS DISTINCT FROM OLD.header->'requestKeys' OR (old_status='queued' AND body->'error' IS DISTINCT FROM OLD.header->'error') THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Traffic optimistic job version mismatch' USING ERRCODE='42501'; END IF;
 IF NOT __SCHEMA__.app_security_mode('worker.traffic') THEN
  IF __SCHEMA__.app_security_project_role(NEW.project_id) IN ('owner','editor') AND old_status IN ('queued','running') AND body->'cancelRequested'='true'::jsonb AND new_status=(CASE old_status WHEN 'queued' THEN 'cancelled' ELSE 'running' END) AND body-ARRAY['version','status','cancelRequested','updatedAt'] IS NOT DISTINCT FROM OLD.header-ARRAY['version','status','cancelRequested','updatedAt'] THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Traffic clients may only request cancellation' USING ERRCODE='42501';
 END IF;
 IF (old_status='queued' AND new_status='running' AND new_attempt<>old_attempt+1) OR new_attempt<old_attempt OR new_attempt>old_attempt+1 OR (new_attempt=old_attempt+1 AND NOT(old_status='queued' AND new_status='running')) THEN RAISE EXCEPTION 'Each native traffic claim consumes one attempt' USING ERRCODE='42501'; END IF;
 FOR i IN 0..old_attempt-1 LOOP
  previous:=OLD.header->'attempts'->i;current_attempt:=body->'attempts'->i;
  IF (i<old_attempt-1 OR old_status<>'running') AND current_attempt IS DISTINCT FROM previous THEN RAISE EXCEPTION 'Past traffic attempts are immutable' USING ERRCODE='42501'; END IF;
  IF current_attempt-ARRAY['endedAt','outcome','elapsedMilliseconds'] IS DISTINCT FROM previous-ARRAY['endedAt','outcome','elapsedMilliseconds'] THEN RAISE EXCEPTION 'Traffic attempt admission is immutable' USING ERRCODE='42501'; END IF;
 END LOOP;
 IF old_status IN ('failed','cancelled') AND new_status='queued' THEN
  IF __SCHEMA__.app_security_project_role(NEW.project_id) NOT IN ('owner','editor') OR new_attempt<>old_attempt OR new_attempt>=3 OR OLD.header->'error'->'retryable'='false'::jsonb OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(body) OR body->>'stage' IS DISTINCT FROM 'queued' OR body->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR body ?| ARRAY['workerId','leaseExpiresAt','result','error'] OR jsonb_array_length(body->'requestKeys')<>jsonb_array_length(OLD.header->'requestKeys')+1 OR ((body->'requestKeys')-jsonb_array_length(OLD.header->'requestKeys')) IS DISTINCT FROM OLD.header->'requestKeys' OR (OLD.header->'requestKeys') @> jsonb_build_array((body->'requestKeys')->jsonb_array_length(OLD.header->'requestKeys')) THEN RAISE EXCEPTION 'Traffic retry requires current creator admission and retains consumed attempts' USING ERRCODE='42501'; END IF;
 ELSIF body->'requestKeys' IS DISTINCT FROM OLD.header->'requestKeys' THEN RAISE EXCEPTION 'Only retry adds traffic idempotency keys' USING ERRCODE='42501'; END IF;
 IF new_status='running' THEN
  IF body->>'workerId' IS NULL OR body->>'capacityToken' IS NULL OR body->>'leaseExpiresAt' IS NULL OR (body->>'leaseExpiresAt')::timestamptz<=statement_timestamp() OR (body->>'leaseExpiresAt')::timestamptz>statement_timestamp()+interval '240 seconds' OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(body) THEN RAISE EXCEPTION 'Traffic execution requires current access and a bounded worker lease' USING ERRCODE='42501'; END IF;
  IF old_status='running' AND (body->>'workerId' IS DISTINCT FROM OLD.header->>'workerId' OR body->>'capacityToken' IS DISTINCT FROM OLD.header->>'capacityToken') THEN RAISE EXCEPTION 'Traffic worker identity cannot be stolen' USING ERRCODE='42501'; END IF;
  IF old_status='queued' AND (body->'attempts'->(new_attempt-1)->'number' IS DISTINCT FROM to_jsonb(new_attempt) OR body->'attempts'->(new_attempt-1)->'admission'->'incrementalExternalCents' IS DISTINCT FROM '0'::jsonb OR body->'attempts'->(new_attempt-1)->'admission'->'costModel'->>'mode' IS DISTINCT FROM 'fixed-capacity' OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_budget b WHERE b.header->'policy'->'paidOperationsPaused'='false'::jsonb AND b.header->'policy'->'version'=body->'attempts'->(new_attempt-1)->'admission'->'budgetPolicyVersion')) THEN RAISE EXCEPTION 'Traffic execution requires unpaused fixed-capacity admission' USING ERRCODE='42501'; END IF;
 END IF;
 IF new_status='completed' THEN
  IF old_status<>'running' OR body->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR body->>'stage' IS DISTINCT FROM 'complete' OR body->'progress' IS DISTINCT FROM '100'::jsonb OR body ?| ARRAY['workerId','leaseExpiresAt','error'] OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(body) OR body->'attempts'->(new_attempt-1)->>'outcome' IS DISTINCT FROM 'completed' OR body->'attempts'->(new_attempt-1)->>'endedAt' IS NULL THEN RAISE EXCEPTION 'Only authorized completed native traffic may retain a result' USING ERRCODE='42501'; END IF;
 ELSIF body ? 'result' THEN RAISE EXCEPTION 'Only completed traffic jobs may reference results' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_traffic_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE job record; artifact record;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='app_traffic_jobs' THEN SELECT * INTO job FROM __SCHEMA__.app_traffic_jobs WHERE id=NEW.id;
 ELSE SELECT * INTO job FROM __SCHEMA__.app_traffic_jobs WHERE id=NEW.header->>'jobId'; END IF;
 IF job.id IS NOT NULL AND job.header->>'status'='completed' THEN
  SELECT * INTO artifact FROM __SCHEMA__.app_traffic_artifacts WHERE id=job.header->'result'->>'artifactId' AND project_id=job.project_id AND organization_id=job.organization_id AND header->>'jobId'=job.id;
  IF artifact.id IS NULL OR artifact.header->'traffic'->>'captureHash' IS DISTINCT FROM job.header->'result'->>'captureHash' OR artifact.header->'traffic'->'capture'->'privateArchive' IS DISTINCT FROM job.header->'result'->'archive' OR (TG_TABLE_NAME='app_traffic_artifacts' AND artifact.id IS DISTINCT FROM NEW.id) THEN RAISE EXCEPTION 'Completed traffic work requires its exact atomically stored artifact and archive' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='app_traffic_artifacts' THEN RAISE EXCEPTION 'Traffic artifact cannot survive without its completed job' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_traffic_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE item jsonb; candidates jsonb; project_key text;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 -- ACL/revocation metadata writes cannot introduce evidence and may preserve trusted legacy content.
 IF TG_OP='UPDATE' AND NEW.payload IS NOT DISTINCT FROM OLD.payload THEN RETURN NEW; END IF;
 project_key:=CASE WHEN TG_TABLE_NAME='app_projects' THEN NEW.id ELSE NEW.project_id END;
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
  IF item->'binding'->>'baselineHash' IS DISTINCT FROM NEW.baseline_hash THEN RAISE EXCEPTION 'Traffic captured baseline must match the saved project' USING ERRCODE='42501'; END IF;
  IF item->>'origin'='imported' THEN CONTINUE; END IF;
  IF item->>'origin' IS DISTINCT FROM 'server-run' OR item->'receipt'->>'projectId' IS DISTINCT FROM project_key OR NOT EXISTS(
    SELECT 1 FROM __SCHEMA__.app_traffic_artifacts a JOIN __SCHEMA__.app_traffic_jobs j ON j.id=a.header->>'jobId'
    WHERE a.id=item->'receipt'->>'captureId' AND j.id=item->'receipt'->>'jobId' AND a.project_id=project_key AND a.organization_id=NEW.organization_id AND j.project_id=project_key AND j.organization_id=NEW.organization_id
      AND j.header->>'status'='completed' AND j.header->'result'->>'artifactId'=a.id AND j.header->'result'->>'captureHash'=item->>'captureHash' AND a.header->'traffic'=item)
  THEN RAISE EXCEPTION 'Traffic server-run admission must exactly match its completed project-owned immutable artifact' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN NEW;
END $$;

-- Existing native services acquire the same slot. Preserve all their earlier state-machine guards.
DO $upgrade_native_guards$
DECLARE definition text; function_name text; mutable_line text;
BEGIN
 FOREACH function_name IN ARRAY ARRAY['app_security_workforce_bind','app_security_gis_bind'] LOOP
  SELECT pg_get_functiondef(p.oid) INTO definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND p.proname=function_name;
  IF definition IS NULL THEN RAISE EXCEPTION 'Required native state guard is missing'; END IF;
  mutable_line:=substring(definition FROM 'mutable:=ARRAY\[[^;]+;');
  IF mutable_line IS NULL THEN RAISE EXCEPTION 'Native mutable-field guard is missing'; END IF;
  definition:=replace(definition,mutable_line,replace(mutable_line,'''workerId'',''leaseExpiresAt''','''workerId'',''leaseExpiresAt'',''capacityToken'''));
  EXECUTE definition;
 END LOOP;
END $upgrade_native_guards$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_traffic_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE target record; action text:=NEW.header->>'action'; details jsonb:=NEW.header->'details';
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' OR action NOT IN ('traffic.uploaded','traffic.configured','traffic.submitted','traffic.retried','traffic.cancelled') THEN RETURN NEW; END IF;
 IF action='traffic.uploaded' THEN SELECT *,xmin INTO target FROM __SCHEMA__.app_traffic_uploads WHERE id=details->>'uploadId';
 ELSIF action='traffic.configured' THEN SELECT *,xmin INTO target FROM __SCHEMA__.app_traffic_configs WHERE id=details->>'configurationId';
 ELSE SELECT *,xmin INTO target FROM __SCHEMA__.app_traffic_jobs WHERE id=details->>'jobId'; END IF;
 IF target.id IS NULL OR target.project_id IS DISTINCT FROM NEW.project_id OR target.organization_id IS DISTINCT FROM NEW.organization_id OR target.xmin::text::bigint<>mod(txid_current(),4294967296) OR NEW.header->>'actorId' IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' THEN RAISE EXCEPTION 'Traffic audit must bind its actual authenticated project mutation' USING ERRCODE='42501'; END IF;
 IF action='traffic.uploaded' AND (target.user_id IS DISTINCT FROM NEW.header->>'actorId' OR target.header->'sha256' IS DISTINCT FROM details->'sha256' OR target.header->'bytes' IS DISTINCT FROM details->'bytes' OR target.header->'rows' IS DISTINCT FROM details->'rows') THEN RAISE EXCEPTION 'Traffic upload audit must preserve exact source identity' USING ERRCODE='42501'; END IF;
 IF action='traffic.configured' AND (target.user_id IS DISTINCT FROM NEW.header->>'actorId' OR target.header->'requestHash' IS DISTINCT FROM details->'requestHash' OR target.header->'scenarioId' IS DISTINCT FROM details->'scenarioId') THEN RAISE EXCEPTION 'Traffic configuration audit must match reviewed input identity' USING ERRCODE='42501'; END IF;
 IF action='traffic.submitted' AND (target.user_id IS DISTINCT FROM NEW.header->>'actorId' OR target.header->'version' IS DISTINCT FROM '1'::jsonb OR target.header->>'status' IS DISTINCT FROM 'queued' OR target.header->'configurationId' IS DISTINCT FROM details->'configurationId' OR target.header->'requestHash' IS DISTINCT FROM details->'requestHash') THEN RAISE EXCEPTION 'Traffic submission audit must match its admitted job' USING ERRCODE='42501'; END IF;
 IF action='traffic.cancelled' AND (target.header->'cancelRequested' IS DISTINCT FROM 'true'::jsonb OR target.header->>'status' NOT IN ('running','cancelled') OR target.header->'attempt' IS DISTINCT FROM details->'attempt') THEN RAISE EXCEPTION 'Traffic cancellation audit must match its actual job' USING ERRCODE='42501'; END IF;
 IF action='traffic.retried' AND (target.header->>'status' IS DISTINCT FROM 'queued' OR jsonb_array_length(target.header->'requestKeys')<2 OR target.header->'attempt' IS DISTINCT FROM details->'consumedAttempts') THEN RAISE EXCEPTION 'Traffic retry audit must preserve consumed attempts' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=10) THEN 10 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
DO $install$
DECLARE cfg record; fn regprocedure; name text; entity text;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 FOR name,entity IN SELECT * FROM (VALUES('app_traffic_configs','trafficConfigs'),('app_traffic_uploads','trafficUploads'),('app_traffic_jobs','trafficJobs'),('app_traffic_artifacts','trafficArtifacts'),('app_native_capacity','nativeCapacity')) v(table_name,entity_name) LOOP
  EXECUTE format('ALTER TABLE __SCHEMA__.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE __SCHEMA__.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('REVOKE ALL ON __SCHEMA__.%I FROM PUBLIC,%I,%I,%I',name,cfg.web_role,cfg.auth_role,cfg.worker_role);
  EXECUTE format('DROP POLICY IF EXISTS operator_access ON __SCHEMA__.%I',name);
  EXECUTE format('CREATE POLICY operator_access ON __SCHEMA__.%I TO %I USING(true) WITH CHECK(true)',name,cfg.migration_role);
  EXECUTE format('DROP POLICY IF EXISTS runtime_select ON __SCHEMA__.%I',name);
  EXECUTE format('CREATE POLICY runtime_select ON __SCHEMA__.%I FOR SELECT TO %I,%I USING(__SCHEMA__.app_security_allow(%L,''SELECT'',id,organization_id,user_id,project_id,snapshot_id,header))',name,cfg.web_role,cfg.worker_role,entity);
  EXECUTE format('DROP POLICY IF EXISTS runtime_insert ON __SCHEMA__.%I',name);
  EXECUTE format('CREATE POLICY runtime_insert ON __SCHEMA__.%I FOR INSERT TO %I,%I WITH CHECK(__SCHEMA__.app_security_allow(%L,''INSERT'',id,organization_id,user_id,project_id,snapshot_id,header))',name,cfg.web_role,cfg.worker_role,entity);
  EXECUTE format('DROP POLICY IF EXISTS runtime_update ON __SCHEMA__.%I',name);
  EXECUTE format('CREATE POLICY runtime_update ON __SCHEMA__.%I FOR UPDATE TO %I,%I USING(__SCHEMA__.app_security_allow(%L,''UPDATE'',id,organization_id,user_id,project_id,snapshot_id,header)) WITH CHECK(__SCHEMA__.app_security_allow(%L,''UPDATE'',id,organization_id,user_id,project_id,snapshot_id,header))',name,cfg.web_role,cfg.worker_role,entity,entity);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON __SCHEMA__.%I TO %I,%I',name,cfg.web_role,cfg.worker_role);
  IF name<>'app_native_capacity' THEN
   EXECUTE format('DROP TRIGGER IF EXISTS security_traffic_bind ON __SCHEMA__.%I',name);
   EXECUTE format('CREATE TRIGGER security_traffic_bind BEFORE INSERT OR UPDATE ON __SCHEMA__.%I FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_traffic_bind()',name);
  END IF;
 END LOOP;
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND (p.proname LIKE 'app_security_traffic_%' OR p.proname LIKE 'app_security_native_%' OR p.proname='app_security_allow_v7') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role);
 END LOOP;
 EXECUTE format('GRANT EXECUTE ON FUNCTION __SCHEMA__.app_security_traffic_project_payload(text),__SCHEMA__.app_security_traffic_baseline(text) TO %I',cfg.worker_role);
 FOREACH name IN ARRAY ARRAY['app_gis_jobs','app_workforce_jobs','app_traffic_jobs'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS security_native_slot ON __SCHEMA__.%I',name);
  EXECUTE format('CREATE CONSTRAINT TRIGGER security_native_slot AFTER INSERT OR UPDATE ON __SCHEMA__.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_native_job_slot()',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['app_traffic_jobs','app_traffic_artifacts'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS security_traffic_completion ON __SCHEMA__.%I',name);
  EXECUTE format('CREATE CONSTRAINT TRIGGER security_traffic_completion AFTER INSERT OR UPDATE ON __SCHEMA__.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_traffic_completion()',name);
 END LOOP;
END $install$;
DROP TRIGGER IF EXISTS security_traffic_audit ON __SCHEMA__.app_audit;
CREATE CONSTRAINT TRIGGER security_traffic_audit AFTER INSERT ON __SCHEMA__.app_audit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_traffic_audit();
DROP TRIGGER IF EXISTS security_native_capacity ON __SCHEMA__.app_native_capacity;
CREATE TRIGGER security_native_capacity BEFORE INSERT OR UPDATE ON __SCHEMA__.app_native_capacity FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_native_capacity();
DROP TRIGGER IF EXISTS security_native_slot_binding ON __SCHEMA__.app_native_capacity;
CREATE CONSTRAINT TRIGGER security_native_slot_binding AFTER UPDATE ON __SCHEMA__.app_native_capacity DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_native_slot_binding();
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(10) ON CONFLICT DO NOTHING;
