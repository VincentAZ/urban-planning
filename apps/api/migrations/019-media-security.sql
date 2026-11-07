-- Media exports retain frozen input identities and immutable output authority; legacy migrations stay unchanged.

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow_v18(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF entity='budget' AND __SCHEMA__.app_security_mode('worker.prep') THEN RETURN operation='SELECT'; END IF;
 RETURN __SCHEMA__.app_security_allow_v17(entity,operation,row_id,organization,actor,project,snapshot,body);
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_principal() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE s jsonb; u text; o text; proof jsonb; challenge jsonb;
BEGIN
 IF __SCHEMA__.app_security_mode('auth.register') THEN
  u:=nullif(current_setting('urban.auth_user_id',true),''); o:=nullif(current_setting('urban.auth_organization_id',true),'');
  IF u IS NULL OR o IS NULL THEN RETURN NULL; END IF;
  IF (EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=u) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_organizations WHERE id=o)) AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_auth_bootstrap WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND user_id=u AND organization_id=o) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('userId',u,'organizationId',o);
 END IF;
 IF __SCHEMA__.app_security_mode('auth.login') THEN
  SELECT id INTO u FROM __SCHEMA__.app_users WHERE id=current_setting('urban.auth_user_id',true) AND email=current_setting('urban.auth_email',true) AND coalesce(header->>'credentialVersion','0')=coalesce(nullif(current_setting('urban.auth_credential_version',true),''),'0');
  IF u IS NOT NULL THEN RETURN jsonb_build_object('userId',u); END IF;
  RETURN NULL;
 END IF;
 IF __SCHEMA__.app_security_mode('auth.challenge-consume') OR __SCHEMA__.app_security_mode('auth.password-change') THEN
  proof:=coalesce(__SCHEMA__.app_security_identity_proof('credential'),__SCHEMA__.app_security_identity_proof('challenge'));
  IF proof IS NOT NULL THEN RETURN jsonb_build_object('userId',proof->>'userId','organizationId',proof->>'organizationId'); END IF;
 END IF;
 IF __SCHEMA__.app_security_mode('auth.challenge-issue') OR __SCHEMA__.app_security_mode('auth.challenge-consume') THEN
  SELECT id INTO u FROM __SCHEMA__.app_users WHERE id=current_setting('urban.auth_user_id',true) AND email=current_setting('urban.auth_email',true) AND coalesce(header->>'credentialVersion','0')=current_setting('urban.auth_credential_version',true);
  IF __SCHEMA__.app_security_mode('auth.challenge-consume') THEN
   challenge:=__SCHEMA__.app_security_identity_challenge();
   IF challenge->>'userId' IS DISTINCT FROM u THEN RETURN NULL; END IF;
  END IF;
  SELECT organization_id INTO o FROM __SCHEMA__.app_memberships WHERE user_id=u ORDER BY ordinal LIMIT 1;
  IF u IS NOT NULL THEN RETURN jsonb_build_object('userId',u,'organizationId',o); END IF;
  RETURN NULL;
 END IF;
 IF __SCHEMA__.app_security_kind()<>'web' AND NOT (__SCHEMA__.app_security_mode('worker.prep') OR __SCHEMA__.app_security_mode('worker.media') OR __SCHEMA__.app_security_mode('worker.accessibility') OR __SCHEMA__.app_security_mode('worker.workforce') OR __SCHEMA__.app_security_mode('worker.gis') OR __SCHEMA__.app_security_mode('worker.traffic') OR __SCHEMA__.app_security_mode('auth.password-change') OR __SCHEMA__.app_security_mode('auth.invitation-accept') OR __SCHEMA__.app_security_mode('auth.invitation-manage')) THEN RETURN NULL; END IF;
 s:=__SCHEMA__.app_security_identity_session();
 IF s IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('userId',s->>'userId','organizationId',s->>'organizationId');
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
 IF coalesce(kind,'') NOT IN ('gis','workforce','traffic','accessibility','media') OR coalesce(length(current_slot->>'token'),0)<8 OR coalesce(length(current_slot->>'jobId'),0)=0 OR coalesce(length(current_slot->>'workerId'),0)=0 OR coalesce(current_slot->>'status','') NOT IN ('running','quarantined') OR current_slot->>'acquiredAt' IS NULL OR current_slot->>'heartbeatAt' IS NULL OR current_slot->>'hardDeadlineAt' IS NULL THEN RAISE EXCEPTION 'Invalid native slot identity' USING ERRCODE='23514'; END IF;
 IF NOT isfinite((current_slot->>'acquiredAt')::timestamptz) OR NOT isfinite((current_slot->>'heartbeatAt')::timestamptz) OR NOT isfinite((current_slot->>'hardDeadlineAt')::timestamptz) THEN RAISE EXCEPTION 'Native timestamps must be finite' USING ERRCODE='23514';END IF;
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
  table_name:=CASE prior_slot->>'kind' WHEN 'gis' THEN 'app_gis_jobs' WHEN 'workforce' THEN 'app_workforce_jobs' WHEN 'traffic' THEN 'app_traffic_jobs' WHEN 'media' THEN 'app_media_jobs' WHEN 'accessibility' THEN 'app_accessibility_jobs' END;
  EXECUTE format('SELECT header FROM __SCHEMA__.%I WHERE id=$1',table_name) INTO job USING prior_slot->>'jobId';
  IF job->>'status'='running' THEN RAISE EXCEPTION 'Running native work cannot release its slot before terminal job state' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF current_slot->>'status'='quarantined' THEN RETURN NEW; END IF;
 table_name:=CASE current_slot->>'kind' WHEN 'gis' THEN 'app_gis_jobs' WHEN 'workforce' THEN 'app_workforce_jobs' WHEN 'traffic' THEN 'app_traffic_jobs' WHEN 'media' THEN 'app_media_jobs' WHEN 'accessibility' THEN 'app_accessibility_jobs' END;
 EXECUTE format('SELECT header FROM __SCHEMA__.%I WHERE id=$1',table_name) INTO job USING current_slot->>'jobId';
 IF job IS NULL OR job->>'status' IS DISTINCT FROM 'running' OR job->>'capacityToken' IS DISTINCT FROM current_slot->>'token' OR job->>'workerId' IS DISTINCT FROM current_slot->>'workerId' THEN RAISE EXCEPTION 'Shared native slot must bind its exact running job' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_native_job_slot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE slot jsonb; kind text:=CASE TG_TABLE_NAME WHEN 'app_gis_jobs' THEN 'gis' WHEN 'app_workforce_jobs' THEN 'workforce' WHEN 'app_media_jobs' THEN 'media' WHEN 'app_accessibility_jobs' THEN 'accessibility' ELSE 'traffic' END; current_job jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 -- Read the final row: an atomic short operation may already have completed.
 EXECUTE format('SELECT header FROM __SCHEMA__.%I WHERE id=$1',TG_TABLE_NAME) INTO current_job USING NEW.id;
 IF current_job->>'status' IS DISTINCT FROM 'running' THEN RETURN NEW; END IF;
 SELECT header->'slot' INTO slot FROM __SCHEMA__.app_native_capacity WHERE id='nativeCapacity';
 IF slot IS NULL OR slot='null'::jsonb OR slot->>'status' IS DISTINCT FROM 'running' OR slot->>'kind' IS DISTINCT FROM kind OR slot->>'jobId' IS DISTINCT FROM NEW.id OR slot->>'workerId' IS DISTINCT FROM current_job->>'workerId' OR slot->>'token' IS DISTINCT FROM current_job->>'capacityToken' OR (slot->>'hardDeadlineAt')::timestamptz<=statement_timestamp() THEN RAISE EXCEPTION 'Native work requires its exact active shared capacity token' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_media_creator_can_edit(job jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM __SCHEMA__.app_projects p JOIN __SCHEMA__.app_memberships m ON m.organization_id=p.organization_id AND m.user_id=job->>'userId'
 WHERE p.id=job->>'projectId' AND p.organization_id=job->>'organizationId'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'project'->'scenarios') s WHERE s->>'id'=job->>'scenarioId')
 AND ((m.header->>'role'='owner' AND coalesce(m.header->>'scope','workspace')<>'project-only')
 OR (p.header ? 'acl' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'acl'->'members') a WHERE a->>'userId'=job->>'userId' AND a->>'role' IN ('owner','editor')))
 OR (NOT p.header ? 'acl' AND coalesce(m.header->>'scope','workspace')<>'project-only' AND m.header->>'role' IN ('owner','editor'))))
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
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

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_media_admission(job jsonb,starting boolean) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE b jsonb;r jsonb;period text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM');cost jsonb:=job->'attempts'->-1->'admission';
BEGIN
 SELECT header INTO b FROM __SCHEMA__.app_budget WHERE id='budget';r:=b->'costReviews'->-1;
 IF r IS NULL OR r->>'period' IS DISTINCT FROM period OR (r->>'expiresAt')::timestamptz<=now() OR (r->>'createdAt')::timestamptz>now() OR r->>'coverageHash' IS DISTINCT FROM __SCHEMA__.app_security_budget_hash(__SCHEMA__.app_security_budget_coverage(b,period)) OR b->'policy'->'paidOperationsPaused' IS DISTINCT FROM 'false'::jsonb OR __SCHEMA__.app_security_budget_known(b,now())+(r->>'estimatedUnreportedCents')::bigint>=(b->'policy'->>'monthlyLimitCents')::bigint-(b->'policy'->>'safetyMarginCents')::bigint THEN RAISE EXCEPTION 'Media requires fresh reviewed operating-cost headroom' USING ERRCODE='42501';END IF;
 IF (SELECT count(*) FROM __SCHEMA__.app_media_jobs WHERE id<>job->>'id' AND header->>'status' IN ('queued','running'))>=10 OR EXISTS(SELECT 1 FROM __SCHEMA__.app_media_jobs WHERE id<>job->>'id' AND user_id=job->>'userId' AND header->>'status' IN ('queued','running')) OR (SELECT count(*) FROM __SCHEMA__.app_media_jobs j CROSS JOIN LATERAL jsonb_array_elements(j.header->'attempts') a WHERE j.user_id=job->>'userId' AND left(a->>'startedAt',10)=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD'))>=3 THEN RAISE EXCEPTION 'Media shared fair-use limit reached' USING ERRCODE='42501';END IF;
 IF starting AND (cost->'budgetPolicyVersion' IS DISTINCT FROM b->'policy'->'version' OR cost->>'period' IS DISTINCT FROM period OR cost->'incrementalExternalCents' IS DISTINCT FROM '0'::jsonb OR cost->'costModel'->>'mode' IS DISTINCT FROM 'fixed-capacity' OR coalesce(cost->'costModel'->>'environment','') NOT IN ('local-development','deployment') OR length(trim(coalesce(cost->'costModel'->>'statement','')))<12 OR (cost->'costModel'->>'environment'='deployment' AND (b->'policy'->>'fixedCostReserveCents')::bigint<=0 AND (__SCHEMA__.app_security_budget_accounting(b,now())->>0)::bigint<=0)) THEN RAISE EXCEPTION 'Media attempt must retain exact fixed-capacity admission evidence' USING ERRCODE='42501';END IF;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_media_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE p record; j jsonb; old_status text; new_status text; n integer; old_n integer; mutable text[]:=ARRAY['version','status','stage','completedFrames','attempt','attempts','cancelRequested','workerId','leaseExpiresAt','capacityToken','error','result','updatedAt','requestKeys']; is_worker boolean:=__SCHEMA__.app_security_mode('worker.media'); a jsonb; b jsonb; i integer; k text; slot jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF NEW.header->>'id' IS DISTINCT FROM NEW.id OR NEW.header->>'organizationId' IS DISTINCT FROM NEW.organization_id OR NEW.header->>'projectId' IS DISTINCT FROM NEW.project_id OR NEW.header->>'userId' IS DISTINCT FROM NEW.user_id OR NEW.payload IS NOT NULL AND NEW.payload<>'null'::jsonb OR NEW.baseline_hash IS NOT NULL OR NEW.snapshot_id IS NOT NULL OR NEW.email IS NOT NULL OR octet_length(NEW.header::text)>65536 THEN RAISE EXCEPTION 'Media metadata indexes and bounded header must match' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM __SCHEMA__.app_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Media project must exist in its organization' USING ERRCODE='42501'; END IF;
 j:=CASE TG_TABLE_NAME WHEN 'app_media_artifacts' THEN NEW.header->'archive' ELSE NEW.header->'input' END;
 IF jsonb_typeof(j) IS DISTINCT FROM 'object' OR jsonb_typeof(j->'sha256') IS DISTINCT FROM 'string' OR coalesce(j->>'sha256','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(j->'bytes') IS DISTINCT FROM 'number' OR coalesce(j->>'bytes','') !~ '^[0-9]+$' OR (j->>'bytes')::numeric NOT BETWEEN 1 AND 268435456 OR jsonb_typeof(j->'fileCount') IS DISTINCT FROM 'number' OR coalesce(j->>'fileCount','') !~ '^[0-9]+$' OR (j->>'fileCount')::integer NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'Media archive requires an explicit complete bounded identity' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['id','organizationId','projectId','userId','sceneHash','requestHash'] LOOP IF jsonb_typeof(NEW.header->k) IS DISTINCT FROM 'string' OR length(coalesce(NEW.header->>k,'')) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Media identities require bounded strings' USING ERRCODE='23514';END IF;END LOOP;
 IF TG_TABLE_NAME='app_media_artifacts' THEN
  IF jsonb_typeof(NEW.header->'files') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Media artifact requires full file inventory' USING ERRCODE='23514';END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(NEW.header->'files') LOOP
   IF jsonb_typeof(a->'name') IS DISTINCT FROM 'string' OR coalesce(a->>'name','') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$' OR position('..' in a->>'name')>0 OR jsonb_typeof(a->'sha256') IS DISTINCT FROM 'string' OR coalesce(a->>'sha256','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(a->'bytes') IS DISTINCT FROM 'number' OR coalesce(a->>'bytes','') !~ '^[0-9]+$' OR (a->>'bytes')::numeric NOT BETWEEN 1 AND 268435456 OR jsonb_typeof(a->'contentType') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Media file inventory is invalid' USING ERRCODE='23514';END IF;
  END LOOP;
  IF (SELECT count(DISTINCT f->>'name') FROM jsonb_array_elements(NEW.header->'files') f)<>jsonb_array_length(NEW.header->'files') THEN RAISE EXCEPTION 'Media artifact files must be unique' USING ERRCODE='23514';END IF;
  SELECT header INTO j FROM __SCHEMA__.app_media_jobs WHERE id=NEW.header->>'jobId' AND project_id=NEW.project_id AND organization_id=NEW.organization_id;
  IF TG_OP<>'INSERT' OR NOT is_worker OR j IS NULL OR j->>'status' NOT IN ('running','completed') OR j->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NOT __SCHEMA__.app_security_media_creator_can_edit(j) OR NEW.user_id IS DISTINCT FROM j->>'userId' OR NEW.header->'sceneHash' IS DISTINCT FROM j->'sceneHash' OR NEW.header->'requestHash' IS DISTINCT FROM j->'requestHash' OR NEW.header->'runtimeIdentity' IS DISTINCT FROM j->'runtimeIdentity' OR jsonb_typeof(NEW.header->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.header->'files') NOT BETWEEN 4 AND 7 OR coalesce(NEW.header->'archive'->>'sha256','') !~ '^[a-f0-9]{64}$' OR (NEW.header->'archive'->>'bytes')::bigint NOT BETWEEN 1 AND 268435456 THEN RAISE EXCEPTION 'Only a live authorized media job may append its bound immutable artifact' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 FOREACH k IN ARRAY ARRAY['totalFrames','completedFrames','attempt','version','projectVersion','scenarioRevision'] LOOP IF jsonb_typeof(NEW.header->k) IS DISTINCT FROM 'number' OR coalesce(NEW.header->>k,'') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Media counters require explicit nonnegative integers' USING ERRCODE='23514';END IF;END LOOP;
 new_status:=NEW.header->>'status';n:=(NEW.header->>'attempt')::integer;
 IF coalesce(new_status,'') NOT IN ('queued','running','completed','failed','cancelled') OR n IS NULL OR n NOT BETWEEN 0 AND 3 OR jsonb_typeof(NEW.header->'attempts') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.header->'attempts')<>n OR jsonb_typeof(NEW.header->'requestKeys') IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.header->'cancelRequested') IS DISTINCT FROM 'boolean' OR coalesce(NEW.header->>'sceneHash','') !~ '^[a-f0-9]{64}$' OR coalesce(NEW.header->>'requestHash','') !~ '^[a-f0-9]{64}$' OR (NEW.header->>'totalFrames')::integer NOT BETWEEN 1 AND 30000 OR (NEW.header->>'completedFrames')::integer NOT BETWEEN 0 AND (NEW.header->>'totalFrames')::integer THEN RAISE EXCEPTION 'Invalid media job state or frame inventory' USING ERRCODE='23514'; END IF;
 IF (SELECT count(DISTINCT v) FROM jsonb_array_elements(NEW.header->'requestKeys') v)<>jsonb_array_length(NEW.header->'requestKeys') OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.header->'requestKeys') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 8 AND 160) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_media_jobs other WHERE other.id<>NEW.id AND other.user_id=NEW.user_id AND other.project_id=NEW.project_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.header->'requestKeys') v WHERE other.header->'requestKeys' @> jsonb_build_array(v))) THEN RAISE EXCEPTION 'Media request keys cannot be duplicated or reassigned' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NOT is_worker OR NEW.user_id IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR NOT __SCHEMA__.app_security_media_creator_can_edit(NEW.header) OR new_status<>'queued' OR n<>0 OR NEW.header->'version' IS DISTINCT FROM '1'::jsonb OR NEW.header->'completedFrames' IS DISTINCT FROM '0'::jsonb OR NEW.header->>'stage' IS DISTINCT FROM 'queued' OR NEW.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NEW.header ?| ARRAY['workerId','leaseExpiresAt','capacityToken','result','error'] OR NEW.header->>'baselineHash' IS DISTINCT FROM p.baseline_hash OR NEW.header->'projectVersion' IS DISTINCT FROM p.header->'version' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'project'->'scenarios') s WHERE s->>'id'=NEW.header->>'scenarioId' AND s->'revision'=NEW.header->'scenarioRevision') OR NEW.header->'requestKeys' IS DISTINCT FROM jsonb_build_array(NEW.header->>'idempotencyKey') OR coalesce(NEW.header->'input'->>'sha256','') !~ '^[a-f0-9]{64}$' OR (NEW.header->'input'->>'bytes')::bigint NOT BETWEEN 1 AND 268435456 THEN RAISE EXCEPTION 'Media admission requires current authenticated editor and saved scene' USING ERRCODE='42501'; END IF;
  PERFORM __SCHEMA__.app_security_media_admission(NEW.header,false);
  RETURN NEW;
 END IF;
 old_status:=OLD.header->>'status';old_n:=(OLD.header->>'attempt')::integer;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.header-mutable IS DISTINCT FROM OLD.header-mutable OR old_status='completed' THEN RAISE EXCEPTION 'Media input identities and completed jobs are immutable' USING ERRCODE='42501'; END IF;
 IF NOT ((old_status='queued' AND new_status IN ('queued','running','failed','cancelled')) OR (old_status='running' AND new_status IN ('running','completed','failed','cancelled')) OR (old_status IN ('failed','cancelled') AND new_status='queued')) THEN RAISE EXCEPTION 'Invalid media transition' USING ERRCODE='42501'; END IF;
 IF (NEW.header->>'version')::integer IS DISTINCT FROM (OLD.header->>'version')::integer+(CASE WHEN new_status IS DISTINCT FROM old_status OR NEW.header->'cancelRequested' IS DISTINCT FROM OLD.header->'cancelRequested' OR NEW.header->'requestKeys' IS DISTINCT FROM OLD.header->'requestKeys' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Media version transition mismatch' USING ERRCODE='42501'; END IF;
 IF NOT is_worker THEN
  IF old_status NOT IN ('queued','running') OR NEW.header->'cancelRequested' IS DISTINCT FROM 'true'::jsonb OR new_status IS DISTINCT FROM (CASE old_status WHEN 'queued' THEN 'cancelled' ELSE 'running' END) OR NEW.header-ARRAY['version','status','cancelRequested','updatedAt'] IS DISTINCT FROM OLD.header-ARRAY['version','status','cancelRequested','updatedAt'] THEN RAISE EXCEPTION 'Web editors may only request cancellation' USING ERRCODE='42501'; END IF; RETURN NEW;
 END IF;
 IF old_status IN ('failed','cancelled') THEN
  IF __SCHEMA__.app_security_project_role(NEW.project_id) NOT IN ('owner','editor') OR NOT __SCHEMA__.app_security_media_creator_can_edit(NEW.header) OR old_n>=3 OR OLD.header->'error'->'retryable'='false'::jsonb OR NEW.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR jsonb_array_length(NEW.header->'requestKeys')<>jsonb_array_length(OLD.header->'requestKeys')+1 OR (SELECT jsonb_agg(v ORDER BY i) FROM jsonb_array_elements(NEW.header->'requestKeys') WITH ORDINALITY t(v,i) WHERE i<=jsonb_array_length(OLD.header->'requestKeys')) IS DISTINCT FROM OLD.header->'requestKeys' OR NEW.header-ARRAY['version','status','stage','completedFrames','cancelRequested','updatedAt','requestKeys','error'] IS DISTINCT FROM OLD.header-ARRAY['version','status','stage','completedFrames','cancelRequested','updatedAt','requestKeys','error'] THEN RAISE EXCEPTION 'Media retry requires authenticated editor and unchanged consumed attempts' USING ERRCODE='42501'; END IF; PERFORM __SCHEMA__.app_security_media_admission(NEW.header,false);RETURN NEW;
 END IF;
 IF NEW.header->'requestKeys' IS DISTINCT FROM OLD.header->'requestKeys' THEN RAISE EXCEPTION 'Only explicit retries may append request keys' USING ERRCODE='42501'; END IF;
 IF old_status='queued' AND new_status='running' THEN
  IF n<>old_n+1 OR NOT __SCHEMA__.app_security_media_creator_can_edit(NEW.header) OR NEW.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NEW.header->>'workerId' IS NULL OR NEW.header->>'capacityToken' IS NULL OR NEW.header->>'leaseExpiresAt' IS NULL OR (NEW.header->'attempts'->-1->>'number')::integer<>n OR NEW.header->'attempts'->-1->'admission'->'incrementalExternalCents' IS DISTINCT FROM '0'::jsonb THEN RAISE EXCEPTION 'Media starts require a live fixed-capacity lease and consumed attempt' USING ERRCODE='42501'; END IF;PERFORM __SCHEMA__.app_security_media_admission(NEW.header,true);
 ELSIF n<>old_n THEN RAISE EXCEPTION 'Only renderer start may consume an attempt' USING ERRCODE='42501'; END IF;
 FOR i IN 0..old_n-1 LOOP
  a:=OLD.header->'attempts'->i;b:=NEW.header->'attempts'->i;
  IF old_status='running' AND i=old_n-1 THEN
   IF a-ARRAY['endedAt','outcome','elapsedMilliseconds'] IS DISTINCT FROM b-ARRAY['endedAt','outcome','elapsedMilliseconds'] OR (new_status='running' AND a IS DISTINCT FROM b) THEN RAISE EXCEPTION 'Media attempt inputs cannot change' USING ERRCODE='42501'; END IF;
  ELSIF a IS DISTINCT FROM b THEN RAISE EXCEPTION 'Past media attempts are immutable' USING ERRCODE='42501'; END IF;
 END LOOP;
 IF old_status='running' AND new_status='running' AND (NEW.header->'workerId' IS DISTINCT FROM OLD.header->'workerId' OR NEW.header->'capacityToken' IS DISTINCT FROM OLD.header->'capacityToken' OR (NEW.header->>'completedFrames')::integer<(OLD.header->>'completedFrames')::integer) THEN RAISE EXCEPTION 'Media progress must retain exact worker and monotone frame count' USING ERRCODE='42501'; END IF;
 IF new_status='completed' THEN
  SELECT header->'slot' INTO slot FROM __SCHEMA__.app_native_capacity WHERE id='nativeCapacity';
  IF old_status IS DISTINCT FROM 'running' OR slot IS NULL OR slot->>'status' IS DISTINCT FROM 'running' OR slot->>'kind' IS DISTINCT FROM 'media' OR slot->>'jobId' IS DISTINCT FROM NEW.id OR slot->'token' IS DISTINCT FROM OLD.header->'capacityToken' OR slot->'workerId' IS DISTINCT FROM OLD.header->'workerId' OR NOT isfinite((slot->>'hardDeadlineAt')::timestamptz) OR (slot->>'hardDeadlineAt')::timestamptz<=statement_timestamp() OR OLD.header->>'leaseExpiresAt' IS NULL OR NOT isfinite((OLD.header->>'leaseExpiresAt')::timestamptz) OR (OLD.header->>'leaseExpiresAt')::timestamptz<=statement_timestamp() THEN RAISE EXCEPTION 'Media completion requires its live originally running native lease' USING ERRCODE='42501';END IF;
 END IF;
 IF new_status<>'completed' AND NEW.header ? 'result' THEN RAISE EXCEPTION 'Incomplete exports cannot claim an artifact' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_media_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE j jsonb;a jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='app_media_jobs' THEN SELECT header INTO j FROM __SCHEMA__.app_media_jobs WHERE id=NEW.id; ELSE SELECT header INTO j FROM __SCHEMA__.app_media_jobs WHERE id=NEW.header->>'jobId'; END IF;
 IF j->>'status'='completed' THEN
  SELECT header INTO a FROM __SCHEMA__.app_media_artifacts WHERE id=j->'result'->>'artifactId';
  IF a IS NULL OR a->>'jobId' IS DISTINCT FROM j->>'id' OR a->'sceneHash' IS DISTINCT FROM j->'sceneHash' OR a->'requestHash' IS DISTINCT FROM j->'requestHash' OR a->'archive'->'sha256' IS DISTINCT FROM j->'result'->'archiveHash' OR a->'files' IS DISTINCT FROM j->'result'->'files' OR j->'completedFrames' IS DISTINCT FROM j->'totalFrames' OR NOT __SCHEMA__.app_security_media_creator_can_edit(j) THEN RAISE EXCEPTION 'Media completion requires its exact immutable artifact and current authorization' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='app_media_artifacts' THEN RAISE EXCEPTION 'Media artifact and completed job must commit atomically' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
DO $install$
DECLARE cfg record;tab text;entity text;fn regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 FOREACH tab IN ARRAY ARRAY['app_media_jobs','app_media_artifacts'] LOOP
  entity:=CASE tab WHEN 'app_media_jobs' THEN 'mediaJobs' ELSE 'mediaArtifacts' END;
  EXECUTE format('ALTER TABLE __SCHEMA__.%I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE __SCHEMA__.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('REVOKE ALL ON __SCHEMA__.%I FROM PUBLIC,%I,%I,%I',tab,cfg.web_role,cfg.auth_role,cfg.worker_role);
  EXECUTE format('DROP POLICY IF EXISTS operator_access ON __SCHEMA__.%I',tab);EXECUTE format('CREATE POLICY operator_access ON __SCHEMA__.%I TO %I USING(true) WITH CHECK(true)',tab,cfg.migration_role);
  EXECUTE format('DROP POLICY IF EXISTS runtime_select ON __SCHEMA__.%I',tab);EXECUTE format('CREATE POLICY runtime_select ON __SCHEMA__.%I FOR SELECT TO %I,%I USING(__SCHEMA__.app_security_allow(%L,''SELECT'',id,organization_id,user_id,project_id,snapshot_id,header))',tab,cfg.web_role,cfg.worker_role,entity);
  EXECUTE format('DROP POLICY IF EXISTS runtime_insert ON __SCHEMA__.%I',tab);EXECUTE format('CREATE POLICY runtime_insert ON __SCHEMA__.%I FOR INSERT TO %I WITH CHECK(__SCHEMA__.app_security_allow(%L,''INSERT'',id,organization_id,user_id,project_id,snapshot_id,header))',tab,cfg.worker_role,entity);
  EXECUTE format('GRANT SELECT ON __SCHEMA__.%I TO %I,%I',tab,cfg.web_role,cfg.worker_role);EXECUTE format('GRANT INSERT ON __SCHEMA__.%I TO %I',tab,cfg.worker_role);
  EXECUTE format('DROP TRIGGER IF EXISTS security_media_bind ON __SCHEMA__.%I',tab);EXECUTE format('CREATE TRIGGER security_media_bind BEFORE INSERT OR UPDATE ON __SCHEMA__.%I FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_media_bind()',tab);
  EXECUTE format('DROP TRIGGER IF EXISTS security_media_completion ON __SCHEMA__.%I',tab);EXECUTE format('CREATE CONSTRAINT TRIGGER security_media_completion AFTER INSERT OR UPDATE ON __SCHEMA__.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_media_completion()',tab);
 END LOOP;
 DROP POLICY IF EXISTS runtime_update ON __SCHEMA__.app_media_jobs;
 EXECUTE format('CREATE POLICY runtime_update ON __SCHEMA__.app_media_jobs FOR UPDATE TO %I,%I USING(__SCHEMA__.app_security_allow(''mediaJobs'',''UPDATE'',id,organization_id,user_id,project_id,snapshot_id,header)) WITH CHECK(__SCHEMA__.app_security_allow(''mediaJobs'',''UPDATE'',id,organization_id,user_id,project_id,snapshot_id,header))',cfg.web_role,cfg.worker_role);
 EXECUTE format('GRANT UPDATE ON __SCHEMA__.app_media_jobs TO %I,%I',cfg.web_role,cfg.worker_role);
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND (p.proname LIKE 'app_security_media_%' OR p.proname='app_security_allow_v18') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role);END LOOP;
END $install$;
DROP TRIGGER IF EXISTS security_native_job_slot ON __SCHEMA__.app_media_jobs;
CREATE CONSTRAINT TRIGGER security_native_job_slot AFTER INSERT OR UPDATE ON __SCHEMA__.app_media_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_native_job_slot();
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=19) THEN 19 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(19) ON CONFLICT DO NOTHING;
