-- Private GIS capability extension. Unrelated roles retain the audited v5 policy.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow_v5(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE p jsonb:=__SCHEMA__.app_security_principal(); uid text:=p->>'userId'; role text;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN true; END IF;
 IF __SCHEMA__.app_security_mode('worker.workforce') THEN
  IF entity='workforceJobs' THEN
   IF operation='SELECT' THEN RETURN true; END IF;
   IF operation='INSERT' THEN RETURN actor=uid AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor'); END IF;
   RETURN operation='UPDATE';
  ELSIF entity='workforceArtifacts' THEN RETURN operation IN ('SELECT','INSERT');
  ELSIF entity='budget' THEN RETURN operation='SELECT';
  ELSIF entity='projects' THEN RETURN operation='SELECT' AND ((row_id=nullif(current_setting('urban.project_id',true),'') AND __SCHEMA__.app_security_project_role(row_id) IN ('owner','editor')) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_workforce_jobs j WHERE j.project_id=row_id));
  ELSIF entity='memberships' THEN RETURN operation='SELECT' AND (actor=uid OR EXISTS(SELECT 1 FROM __SCHEMA__.app_workforce_jobs j WHERE j.user_id=actor AND j.organization_id=organization));
  ELSIF entity='users' THEN RETURN operation='SELECT' AND row_id=uid;
  ELSIF entity='sessions' THEN RETURN operation='SELECT' AND row_id=nullif(current_setting('urban.session_hash',true),'') AND actor=uid;
  ELSIF entity='organizations' THEN RETURN operation='SELECT' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships m WHERE m.user_id=uid AND m.organization_id=row_id);
  ELSIF entity='audit' THEN RETURN operation='INSERT' AND body->>'actorId'=uid AND body->>'action' IN ('workforce.submitted','workforce.retried') AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor');
  ELSE RETURN false; END IF;
 END IF;
 IF entity IN ('workforceJobs','workforceArtifacts') THEN
  IF __SCHEMA__.app_security_kind()<>'web' THEN RETURN false; END IF;
  role:=__SCHEMA__.app_security_project_role(project);
  IF operation='SELECT' THEN
   IF role IS NOT NULL THEN RETURN true; END IF;
   RETURN entity='workforceArtifacts' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_published s WHERE s.project_id=project AND s.organization_id=organization AND __SCHEMA__.app_security_public(s.id) AND s.payload->'scenario'->'workforce'=body->'workforce');
  END IF;
  RETURN entity='workforceJobs' AND operation='UPDATE' AND role IN ('owner','editor');
 END IF;
 RETURN __SCHEMA__.app_security_allow_v3(entity,operation,row_id,organization,actor,project,snapshot,body);
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
 IF __SCHEMA__.app_security_kind()<>'web' AND NOT (__SCHEMA__.app_security_mode('worker.prep') OR __SCHEMA__.app_security_mode('worker.workforce') OR __SCHEMA__.app_security_mode('worker.gis')) THEN RETURN NULL; END IF;
 SELECT header INTO s FROM __SCHEMA__.app_sessions WHERE id=nullif(current_setting('urban.session_hash',true),'') AND (header->>'expiresAt')::timestamptz>statement_timestamp();
 IF s IS NULL THEN RETURN NULL; END IF;
 u:=s->>'userId'; o:=s->>'organizationId';
 IF EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=u) AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE user_id=u AND organization_id=o) THEN RETURN jsonb_build_object('userId',u,'organizationId',o); END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_gis_active(project text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT __SCHEMA__.app_security_mode('worker.gis') AND EXISTS(SELECT 1 FROM __SCHEMA__.app_gis_jobs j
 WHERE j.project_id=project AND j.header->>'kind'='prepare' AND j.header->>'status'='running' AND j.header->'cancelRequested'='false'::jsonb
 AND (j.header->>'leaseExpiresAt')::timestamptz>statement_timestamp() AND __SCHEMA__.app_security_workforce_creator_can_edit(j.header))
$$;
-- These are the ONLY payload/baseline access paths granted to the shared worker role.
-- Switching purpose to workforce/prep cannot retain GIS payload authority.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_gis_project_payload(project text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF NOT __SCHEMA__.app_security_gis_active(project) THEN RAISE EXCEPTION 'Full GIS project access requires an active authorized prepare job' USING ERRCODE='42501'; END IF;
 RETURN (SELECT payload FROM __SCHEMA__.app_projects WHERE id=project);
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_gis_baseline(hash text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_projects p WHERE p.baseline_hash=hash AND __SCHEMA__.app_security_gis_active(p.id)) THEN RAISE EXCEPTION 'GIS baseline access requires an active authorized prepare job' USING ERRCODE='42501'; END IF;
 RETURN (SELECT payload FROM __SCHEMA__.app_baseline_snapshots WHERE sha256=hash);
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
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

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_gis_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE body jsonb:=NEW.header||coalesce(nullif(NEW.payload,'null'::jsonb),'{}'::jsonb); oldbody jsonb:=CASE WHEN TG_OP='UPDATE' THEN OLD.header||coalesce(nullif(OLD.payload,'null'::jsonb),'{}'::jsonb) ELSE NULL END; p record; upload record; old_status text; new_status text; old_attempt integer; new_attempt integer; mutable text[]; previous jsonb; current_attempt jsonb; i integer; is_worker boolean:=__SCHEMA__.app_security_mode('worker.gis');
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF body->>'id' IS DISTINCT FROM NEW.id OR body->>'projectId' IS DISTINCT FROM NEW.project_id OR body->>'organizationId' IS DISTINCT FROM NEW.organization_id OR body->>'userId' IS DISTINCT FROM NEW.user_id OR NEW.baseline_hash IS NOT NULL OR NEW.snapshot_id IS NOT NULL OR NEW.email IS NOT NULL OR jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' OR NEW.payload-ARRAY['recipe','inspection']<>'{}'::jsonb OR NEW.header ?| ARRAY['recipe','inspection'] THEN RAISE EXCEPTION 'GIS identity indexes must match the private job' USING ERRCODE='23514'; END IF;
 IF octet_length(coalesce((NEW.payload->'inspection')::text,''))>1048576 OR octet_length(coalesce((NEW.payload->'recipe')::text,''))>2097152 THEN RAISE EXCEPTION 'GIS inspection or recipe exceeds its stored metadata limit' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM __SCHEMA__.app_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id;
 IF p.id IS NULL THEN RAISE EXCEPTION 'GIS project must exist in its recorded organization' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN RAISE EXCEPTION 'GIS job identity is immutable' USING ERRCODE='42501'; END IF;
 new_status:=body->>'status';new_attempt:=(body->>'attempt')::integer;
 IF new_status IS NULL OR new_status NOT IN ('queued','running','completed','failed','cancelled') OR new_attempt IS NULL OR new_attempt<0 OR new_attempt>3 OR jsonb_typeof(body->'attempts') IS DISTINCT FROM 'array' OR jsonb_array_length(body->'attempts')<>new_attempt OR jsonb_typeof(body->'requestKeys') IS DISTINCT FROM 'array' OR jsonb_typeof(body->'cancelRequested') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'GIS state and attempt history are invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT is_worker OR NEW.user_id IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(body)
   OR new_status<>'queued' OR new_attempt<>0 OR body->'version' IS DISTINCT FROM '1'::jsonb OR body->>'stage' IS DISTINCT FROM 'queued' OR body->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR body ?| ARRAY['workerId','leaseExpiresAt','result','error','inspection']
   OR body->>'baselineHash' IS DISTINCT FROM p.baseline_hash OR body->'projectVersion' IS DISTINCT FROM p.header->'version'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'project'->'scenarios') s WHERE s->>'id'=body->>'scenarioId' AND s->'revision'=body->'scenarioRevision')
   OR body->'requestKeys' IS DISTINCT FROM jsonb_build_array(body->>'idempotencyKey')
   OR coalesce(length(body->>'idempotencyKey'),0) NOT BETWEEN 1 AND 240 OR coalesce(body->>'requestHash','')!~'^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'GIS admission requires an unchanged saved proposal and its authenticated editor' USING ERRCODE='42501'; END IF;
  IF body->>'kind'='inspect' THEN
   IF jsonb_typeof(body->'upload') IS DISTINCT FROM 'object' OR body ?| ARRAY['recipe','uploadId','exportSnapshot'] OR coalesce(body->'upload'->>'format','') NOT IN ('geojson','shapefile','dxf') OR coalesce(body->'upload'->>'sha256','')!~'^[0-9a-f]{64}$' OR coalesce((body->'upload'->>'bytes')::bigint,0) NOT BETWEEN 1 AND 20971520 THEN RAISE EXCEPTION 'GIS inspection requires bounded immutable upload identity' USING ERRCODE='23514'; END IF;
  ELSIF body->>'kind'='prepare' THEN
   SELECT * INTO upload FROM __SCHEMA__.app_gis_jobs WHERE id=body->>'uploadId' AND project_id=NEW.project_id AND organization_id=NEW.organization_id AND user_id=NEW.user_id AND header->>'kind'='inspect' AND header->>'status'='completed';
   IF upload.id IS NULL OR body ?| ARRAY['upload','exportSnapshot'] OR body->'recipe'->>'scenarioId' IS DISTINCT FROM body->>'scenarioId' OR body->'recipe'->'expectedVersion' IS DISTINCT FROM body->'projectVersion' OR body->'recipe'->'expectedRevision' IS DISTINCT FROM body->'scenarioRevision' OR upload.header->>'baselineHash' IS DISTINCT FROM body->>'baselineHash' THEN RAISE EXCEPTION 'GIS preparation requires this account project inspected source and exact recipe revision' USING ERRCODE='42501'; END IF;
  ELSIF body->>'kind'='export-shapefile' THEN
   IF body ?| ARRAY['upload','uploadId','recipe'] OR coalesce(body->'exportSnapshot'->>'sha256','')!~'^[0-9a-f]{64}$' OR coalesce((body->'exportSnapshot'->>'bytes')::bigint,0) NOT BETWEEN 1 AND 104857600 THEN RAISE EXCEPTION 'GIS export requires bounded frozen snapshot identity' USING ERRCODE='23514'; END IF;
  ELSE RAISE EXCEPTION 'Unknown GIS job kind' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 old_status:=oldbody->>'status';old_attempt:=(oldbody->>'attempt')::integer;
 IF NOT ((old_status='queued' AND new_status IN ('queued','running','failed','cancelled')) OR (old_status='running' AND new_status IN ('running','completed','failed','cancelled')) OR (old_status IN ('failed','cancelled') AND new_status='queued')) THEN RAISE EXCEPTION 'GIS transition is not permitted' USING ERRCODE='42501'; END IF;
 mutable:=ARRAY['version','status','stage','attempt','attempts','cancelRequested','workerId','leaseExpiresAt','error','result','inspection','updatedAt','requestKeys'];
 IF body-mutable IS DISTINCT FROM oldbody-mutable OR old_status='completed' THEN RAISE EXCEPTION 'GIS admitted source, recipe and finished jobs are immutable' USING ERRCODE='42501'; END IF;
 IF (body->>'version')::integer IS NULL OR (body->>'version')::integer<>(oldbody->>'version')::integer+(CASE WHEN new_status IS DISTINCT FROM old_status OR body->'cancelRequested' IS DISTINCT FROM oldbody->'cancelRequested' OR body->'requestKeys' IS DISTINCT FROM oldbody->'requestKeys' OR (old_status='queued' AND body->'error' IS DISTINCT FROM oldbody->'error') THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'GIS transition version mismatch' USING ERRCODE='42501'; END IF;
 IF NOT is_worker THEN
  IF NEW.user_id IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR __SCHEMA__.app_security_project_role(NEW.project_id) NOT IN ('owner','editor') THEN RAISE EXCEPTION 'Only the creator with current edit access can cancel GIS work' USING ERRCODE='42501'; END IF;
  IF old_status IN ('queued','running') AND body->'cancelRequested'='true'::jsonb AND new_status=(CASE old_status WHEN 'queued' THEN 'cancelled' ELSE 'running' END) AND body-ARRAY['version','status','cancelRequested','updatedAt'] IS NOT DISTINCT FROM oldbody-ARRAY['version','status','cancelRequested','updatedAt'] THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'GIS clients may only cancel active jobs; retry requires worker admission' USING ERRCODE='42501';
 END IF;
 IF (old_status='queued' AND new_status='running' AND new_attempt<>old_attempt+1) OR new_attempt<old_attempt OR new_attempt>old_attempt+1 OR (new_attempt=old_attempt+1 AND NOT(old_status='queued' AND new_status='running')) THEN RAISE EXCEPTION 'Each GIS claim must consume exactly one attempt' USING ERRCODE='42501'; END IF;
 FOR i IN 0..old_attempt-1 LOOP
  previous:=oldbody->'attempts'->i;current_attempt:=body->'attempts'->i;
  IF (i<old_attempt-1 OR old_status<>'running') AND current_attempt IS DISTINCT FROM previous THEN RAISE EXCEPTION 'Past GIS attempts are immutable' USING ERRCODE='42501'; END IF;
  IF current_attempt-ARRAY['endedAt','outcome','elapsedMilliseconds'] IS DISTINCT FROM previous-ARRAY['endedAt','outcome','elapsedMilliseconds'] THEN RAISE EXCEPTION 'GIS attempt admission provenance is immutable' USING ERRCODE='42501'; END IF;
 END LOOP;
 IF old_status IN ('failed','cancelled') AND new_status='queued' THEN
  IF NEW.user_id IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR new_attempt<>old_attempt OR new_attempt>=3 OR oldbody->'error'->'retryable'='false'::jsonb OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(body) OR __SCHEMA__.app_security_project_role(NEW.project_id) NOT IN ('owner','editor')
   OR body->>'stage' IS DISTINCT FROM 'queued' OR body->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR body ?| ARRAY['workerId','leaseExpiresAt','result','inspection','error']
   OR jsonb_array_length(body->'requestKeys')<>jsonb_array_length(oldbody->'requestKeys')+1 OR ((body->'requestKeys')-jsonb_array_length(oldbody->'requestKeys')) IS DISTINCT FROM oldbody->'requestKeys' OR (oldbody->'requestKeys') @> jsonb_build_array((body->'requestKeys')->jsonb_array_length(oldbody->'requestKeys'))
  THEN RAISE EXCEPTION 'GIS retry must preserve attempts and require current creator admission' USING ERRCODE='42501'; END IF;
 ELSIF body->'requestKeys' IS DISTINCT FROM oldbody->'requestKeys' THEN RAISE EXCEPTION 'Only GIS retry appends a request key' USING ERRCODE='42501'; END IF;
 IF new_status='queued' AND body->>'stage' IS DISTINCT FROM 'queued' THEN RAISE EXCEPTION 'Queued GIS jobs retain the queued stage' USING ERRCODE='42501'; END IF;
 IF new_status='running' THEN
  IF body->>'workerId' IS NULL OR body->>'leaseExpiresAt' IS NULL OR (body->>'leaseExpiresAt')::timestamptz<=statement_timestamp() OR (body->>'leaseExpiresAt')::timestamptz>statement_timestamp()+interval '120 seconds' OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(body) THEN RAISE EXCEPTION 'GIS running job needs current access and a lease' USING ERRCODE='42501'; END IF;
  IF old_status='running' AND body->>'workerId' IS DISTINCT FROM oldbody->>'workerId' THEN RAISE EXCEPTION 'GIS lease cannot be stolen' USING ERRCODE='42501'; END IF;
  IF old_status='queued' AND (body->'attempts'->(new_attempt-1)->'number' IS DISTINCT FROM to_jsonb(new_attempt) OR body->'attempts'->(new_attempt-1)->'admission'->'incrementalExternalCents' IS DISTINCT FROM '0'::jsonb OR body->'attempts'->(new_attempt-1)->'admission'->'costModel'->>'mode' IS DISTINCT FROM 'fixed-capacity' OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_budget b WHERE b.header->'policy'->'paidOperationsPaused'='false'::jsonb AND b.header->'policy'->'version'=body->'attempts'->(new_attempt-1)->'admission'->'budgetPolicyVersion')) THEN RAISE EXCEPTION 'GIS claim requires current unpaused fixed-capacity budget admission' USING ERRCODE='42501'; END IF;
  IF old_status='queued' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_gis_jobs other_job WHERE other_job.id<>NEW.id AND other_job.header->>'status'='running') THEN RAISE EXCEPTION 'Only one GIS job may run at once' USING ERRCODE='42501'; END IF;
 END IF;
 IF new_status='completed' AND (old_status<>'running' OR body->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR body->>'stage' IS DISTINCT FROM 'complete' OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(body)) THEN RAISE EXCEPTION 'Only uncancelled authorized work may complete' USING ERRCODE='42501'; END IF;
 IF new_status<>'completed' AND body ?| ARRAY['result','inspection'] THEN RAISE EXCEPTION 'Only completed jobs may retain output' USING ERRCODE='42501'; END IF;
 IF new_status='completed' THEN
  IF body ?| ARRAY['workerId','leaseExpiresAt','error'] OR body->'attempts'->(new_attempt-1)->>'outcome' IS DISTINCT FROM 'completed' OR body->'attempts'->(new_attempt-1)->>'endedAt' IS NULL THEN RAISE EXCEPTION 'GIS completion must close its consumed attempt' USING ERRCODE='42501'; END IF;
  IF body->>'kind'='inspect' THEN
   IF body ? 'result' OR body->'inspection'->'input'->>'sha256' IS DISTINCT FROM body->'upload'->>'sha256' OR body->'inspection'->'input'->'bytes' IS DISTINCT FROM body->'upload'->'bytes' OR jsonb_typeof(body->'inspection'->'layers') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GIS inspection must match its exact uploaded bytes' USING ERRCODE='42501'; END IF;
  ELSIF body->>'kind'='prepare' THEN
   IF body ? 'inspection' OR body->'result'->>'importId' IS NULL OR coalesce(body->'result'->>'previewHash','')!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'GIS preparation requires its immutable preview result' USING ERRCODE='42501'; END IF;
  ELSE
   IF body ? 'inspection' OR coalesce(body->'result'->>'downloadHash','')!~'^[0-9a-f]{64}$' OR coalesce((body->'result'->>'downloadBytes')::bigint,0) NOT BETWEEN 1 AND 104857600 THEN RAISE EXCEPTION 'GIS export requires bounded download identity' USING ERRCODE='42501'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_gis_import() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE j record; p record; preview jsonb:=NEW.header->'prepared'->'preview';
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.header-'committed' IS DISTINCT FROM OLD.header-'committed' OR NEW.payload IS DISTINCT FROM OLD.payload OR (OLD.header ? 'committed' AND NEW.header->'committed' IS DISTINCT FROM OLD.header->'committed') THEN RAISE EXCEPTION 'Staged import geometry, mapping and provenance are immutable' USING ERRCODE='42501'; END IF;
  IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
  IF NEW.header ? 'committed' THEN
   SELECT * INTO p FROM __SCHEMA__.app_projects WHERE id=NEW.header->'committed'->>'projectId' AND organization_id=NEW.organization_id;
   IF p.id IS NULL OR (NEW.project_id IS NOT NULL AND p.id IS DISTINCT FROM NEW.project_id) OR NEW.header->'committed'->'version' IS DISTINCT FROM p.header->'version' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'project'->'scenarios') s WHERE s->>'id'=NEW.header->'committed'->>'scenarioId' AND s->'revision'=NEW.header->'committed'->'revision') THEN RAISE EXCEPTION 'Import commit must bind the saved project revision' USING ERRCODE='42501'; END IF;
   IF NEW.header ? 'prepared' AND (NEW.header->'committed'->>'scenarioId' IS DISTINCT FROM preview->>'scenarioId' OR (NEW.header->'committed'->>'version')::integer IS DISTINCT FROM (preview->>'expectedVersion')::integer+1 OR (NEW.header->'committed'->>'revision')::integer IS DISTINCT FROM (preview->>'expectedRevision')::integer+1) THEN RAISE EXCEPTION 'Prepared import commits only its reviewed exact revision' USING ERRCODE='42501'; END IF;
   IF NEW.header ? 'prepared' THEN
    -- A version match alone is not evidence that the reviewed layer was applied.
    -- Reconstruct this one command from the immutable previous project version,
    -- then require the saved scenario and its latest history entry to agree.
    DECLARE
     prior_scenario jsonb; actual_scenario jsonb; expected_scenario jsonb;
     history_entry jsonb; expected_command jsonb; expected_sources jsonb;
     feature_key text; edit_key text; features jsonb; feature_edits jsonb;
    BEGIN
     feature_key:=CASE WHEN NEW.header->>'layer' IN ('parcels','blocks') THEN 'parcels' ELSE 'buildings' END;
     edit_key:=CASE WHEN feature_key='parcels' THEN 'parcelEdits' ELSE 'buildingEdits' END;
     features:=NEW.header->feature_key;
     IF jsonb_typeof(features) IS DISTINCT FROM 'array' OR jsonb_array_length(features) NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'Prepared import must retain its bounded feature inventory' USING ERRCODE='42501'; END IF;
     SELECT s INTO prior_scenario FROM __SCHEMA__.app_project_versions v
      CROSS JOIN LATERAL jsonb_array_elements(v.payload->'project'->'scenarios') s
      WHERE v.project_id=p.id AND v.organization_id=NEW.organization_id
       AND v.version=(preview->>'expectedVersion')::bigint
       AND v.baseline_hash=preview->'baselineIdentity'->>'sha256'
       AND s->>'id'=preview->>'scenarioId' AND s->'revision'=preview->'expectedRevision';
     SELECT s INTO actual_scenario FROM jsonb_array_elements(p.payload->'project'->'scenarios') s WHERE s->>'id'=preview->>'scenarioId';
     history_entry:=p.payload->'project'->'history'->-1;
     expected_command:=jsonb_build_object('type',feature_key||'.import',feature_key,features,'source',NEW.header->'source','mode',NEW.header->'prepared'->'mode');
     SELECT jsonb_object_agg(f->>'id',f) INTO feature_edits FROM jsonb_array_elements(features) f;
     SELECT coalesce(jsonb_agg(s ORDER BY ord),'[]'::jsonb) INTO expected_sources
      FROM jsonb_array_elements(coalesce(prior_scenario->'sources','[]'::jsonb)) WITH ORDINALITY a(s,ord)
      WHERE s->>'id' IS DISTINCT FROM NEW.header->'source'->>'id';
     expected_scenario:=prior_scenario||jsonb_build_object(
      'revision',NEW.header->'committed'->'revision','updatedAt',actual_scenario->'updatedAt',
      edit_key,coalesce(prior_scenario->edit_key,'{}'::jsonb)||feature_edits,
      'sources',expected_sources||jsonb_build_array(NEW.header->'source'));
     IF prior_scenario IS NULL OR actual_scenario IS NULL OR history_entry IS NULL
      OR actual_scenario IS DISTINCT FROM expected_scenario
      OR history_entry->'command' IS DISTINCT FROM expected_command
      OR history_entry->'before' IS DISTINCT FROM prior_scenario
      OR history_entry->'after' IS DISTINCT FROM actual_scenario
      OR coalesce(history_entry->'superseded','false'::jsonb) IS DISTINCT FROM 'false'::jsonb
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p.payload->'project'->'undone','[]'::jsonb)) h WHERE h->>'id'=history_entry->>'id')
     THEN RAISE EXCEPTION 'Prepared import receipt requires its exact applied command, source, features and history' USING ERRCODE='42501'; END IF;
    END;
   END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF NEW.header ? 'prepared' THEN
  SELECT *,xmin INTO j FROM __SCHEMA__.app_gis_jobs WHERE id=preview->>'jobId';
  IF NOT __SCHEMA__.app_security_mode('worker.gis') OR j.id IS NULL OR j.header->>'kind' IS DISTINCT FROM 'prepare' OR (j.header->>'status' NOT IN ('running','completed') OR (j.header->>'status'='completed' AND j.xmin::text::bigint<>mod(txid_current(),4294967296))) OR j.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR j.organization_id IS DISTINCT FROM NEW.organization_id OR j.project_id IS DISTINCT FROM NEW.project_id OR j.user_id IS DISTINCT FROM NEW.header->>'createdBy' OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(j.header)
   OR preview->>'projectId' IS DISTINCT FROM j.project_id OR preview->>'scenarioId' IS DISTINCT FROM j.header->>'scenarioId' OR preview->>'uploadId' IS DISTINCT FROM j.header->>'uploadId' OR preview->'expectedVersion' IS DISTINCT FROM j.header->'projectVersion' OR preview->'expectedRevision' IS DISTINCT FROM j.header->'scenarioRevision' OR preview->'baselineIdentity'->>'sha256' IS DISTINCT FROM j.header->>'baselineHash' OR NEW.header->'prepared'->>'mode' IS DISTINCT FROM j.payload->'recipe'->'mapping'->'target'->>'mode'
   OR NEW.header ? 'committed' OR NEW.user_id IS NOT NULL OR NEW.snapshot_id IS NOT NULL OR NEW.email IS NOT NULL OR NEW.baseline_hash IS NOT NULL OR (NEW.payload IS NOT NULL AND NEW.payload<>'null'::jsonb)
  THEN RAISE EXCEPTION 'Prepared import must match its authorized running GIS job' USING ERRCODE='42501'; END IF;
 ELSE
  IF __SCHEMA__.app_security_mode('worker.gis') OR NEW.header ? 'committed' THEN RAISE EXCEPTION 'GIS workers cannot create unbound imports' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_gis_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE j record; staged record;
BEGIN
 IF TG_TABLE_NAME='app_gis_jobs' THEN SELECT * INTO j FROM __SCHEMA__.app_gis_jobs WHERE id=NEW.id;
 ELSE
  IF NOT NEW.header ? 'prepared' THEN RETURN NEW; END IF;
  SELECT * INTO j FROM __SCHEMA__.app_gis_jobs WHERE id=NEW.header->'prepared'->'preview'->>'jobId';
 END IF;
 IF j.id IS NOT NULL AND j.header->>'kind'='prepare' AND j.header->>'status'='completed' THEN
  SELECT * INTO staged FROM __SCHEMA__.app_imports WHERE id=j.header->'result'->>'importId' AND project_id=j.project_id AND organization_id=j.organization_id AND header->>'createdBy'=j.user_id AND header->'prepared'->'preview'->>'jobId'=j.id;
  IF staged.id IS NULL OR staged.header->'prepared'->'preview'->>'previewHash' IS DISTINCT FROM j.header->'result'->>'previewHash' OR (TG_TABLE_NAME='app_imports' AND staged.id IS DISTINCT FROM NEW.id) THEN RAISE EXCEPTION 'Completed GIS preparation requires its exact atomically stored preview' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='app_imports' THEN RAISE EXCEPTION 'Prepared import cannot survive without its completed GIS job' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
-- GIS audit claims must accompany the matching job mutation, not an unrelated editor write.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_gis_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE job record; action text:=NEW.header->>'action';
BEGIN
 IF action NOT IN ('gis.submitted','gis.retried','gis.cancelled') OR __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 SELECT *,xmin INTO job FROM __SCHEMA__.app_gis_jobs WHERE id=NEW.header->'details'->>'jobId';
 IF job.id IS NULL OR job.project_id IS DISTINCT FROM NEW.project_id OR job.organization_id IS DISTINCT FROM NEW.organization_id OR job.user_id IS DISTINCT FROM NEW.header->>'actorId' OR job.xmin::text::bigint<>mod(txid_current(),4294967296) THEN RAISE EXCEPTION 'GIS audit must bind the matching account project job mutation' USING ERRCODE='42501'; END IF;
 IF action='gis.submitted' AND (job.header->'version' IS DISTINCT FROM '1'::jsonb OR job.header->>'status' IS DISTINCT FROM 'queued' OR NEW.header->'details'->>'requestHash' IS DISTINCT FROM job.header->>'requestHash' OR NEW.header->'details'->>'scenarioId' IS DISTINCT FROM job.header->>'scenarioId' OR NEW.header->'details'->>'kind' IS DISTINCT FROM job.header->>'kind') THEN RAISE EXCEPTION 'GIS admission audit must match the original job' USING ERRCODE='42501'; END IF;
 IF action='gis.retried' AND (job.header->>'status' IS DISTINCT FROM 'queued' OR jsonb_array_length(job.header->'requestKeys')<2 OR NEW.header->'details'->'consumedAttempts' IS DISTINCT FROM job.header->'attempt') THEN RAISE EXCEPTION 'GIS retry audit must retain consumed attempts' USING ERRCODE='42501'; END IF;
 IF action='gis.cancelled' AND (job.header->'cancelRequested' IS DISTINCT FROM 'true'::jsonb OR job.header->>'status' NOT IN ('cancelled','running')) THEN RAISE EXCEPTION 'GIS cancellation audit must match actual cancellation' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=7) THEN 7 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
DO $install$
DECLARE cfg record; fn regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 ALTER TABLE __SCHEMA__.app_gis_jobs ENABLE ROW LEVEL SECURITY;
 ALTER TABLE __SCHEMA__.app_gis_jobs FORCE ROW LEVEL SECURITY;
 EXECUTE format('REVOKE ALL ON __SCHEMA__.app_gis_jobs FROM PUBLIC,%I,%I,%I',cfg.web_role,cfg.auth_role,cfg.worker_role);
 DROP POLICY IF EXISTS operator_access ON __SCHEMA__.app_gis_jobs;
 EXECUTE format('CREATE POLICY operator_access ON __SCHEMA__.app_gis_jobs TO %I USING(true) WITH CHECK(true)',cfg.migration_role);
 DROP POLICY IF EXISTS runtime_select ON __SCHEMA__.app_gis_jobs;
 EXECUTE format('CREATE POLICY runtime_select ON __SCHEMA__.app_gis_jobs FOR SELECT TO %I,%I USING(__SCHEMA__.app_security_allow(''gisJobs'',''SELECT'',id,organization_id,user_id,project_id,snapshot_id,header))',cfg.web_role,cfg.worker_role);
 DROP POLICY IF EXISTS runtime_insert ON __SCHEMA__.app_gis_jobs;
 EXECUTE format('CREATE POLICY runtime_insert ON __SCHEMA__.app_gis_jobs FOR INSERT TO %I WITH CHECK(__SCHEMA__.app_security_allow(''gisJobs'',''INSERT'',id,organization_id,user_id,project_id,snapshot_id,header))',cfg.worker_role);
 DROP POLICY IF EXISTS runtime_update ON __SCHEMA__.app_gis_jobs;
 EXECUTE format('CREATE POLICY runtime_update ON __SCHEMA__.app_gis_jobs FOR UPDATE TO %I,%I USING(__SCHEMA__.app_security_allow(''gisJobs'',''UPDATE'',id,organization_id,user_id,project_id,snapshot_id,header)) WITH CHECK(__SCHEMA__.app_security_allow(''gisJobs'',''UPDATE'',id,organization_id,user_id,project_id,snapshot_id,header))',cfg.web_role,cfg.worker_role);
 EXECUTE format('GRANT SELECT,UPDATE ON __SCHEMA__.app_gis_jobs TO %I,%I',cfg.web_role,cfg.worker_role);
 EXECUTE format('GRANT INSERT ON __SCHEMA__.app_gis_jobs TO %I',cfg.worker_role);
 -- Reinstallation must not retain accidental helper grants from a prior install.
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND (p.proname LIKE 'app_security_gis_%' OR p.proname='app_security_allow_v5') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role);
 END LOOP;
 EXECUTE format('GRANT EXECUTE ON FUNCTION __SCHEMA__.app_security_gis_project_payload(text),__SCHEMA__.app_security_gis_baseline(text) TO %I',cfg.worker_role);
END $install$;
DROP TRIGGER IF EXISTS security_gis_bind ON __SCHEMA__.app_gis_jobs;
CREATE TRIGGER security_gis_bind BEFORE INSERT OR UPDATE ON __SCHEMA__.app_gis_jobs FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_gis_bind();
DROP TRIGGER IF EXISTS security_gis_completion ON __SCHEMA__.app_gis_jobs;
CREATE CONSTRAINT TRIGGER security_gis_completion AFTER INSERT OR UPDATE ON __SCHEMA__.app_gis_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_gis_completion();
DROP TRIGGER IF EXISTS security_gis_import ON __SCHEMA__.app_imports;
CREATE TRIGGER security_gis_import BEFORE INSERT OR UPDATE ON __SCHEMA__.app_imports FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_gis_import();
DROP TRIGGER IF EXISTS security_gis_completion ON __SCHEMA__.app_imports;
CREATE CONSTRAINT TRIGGER security_gis_completion AFTER INSERT ON __SCHEMA__.app_imports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_gis_completion();
DROP TRIGGER IF EXISTS security_gis_audit ON __SCHEMA__.app_audit;
CREATE CONSTRAINT TRIGGER security_gis_audit AFTER INSERT ON __SCHEMA__.app_audit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_gis_audit();
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
