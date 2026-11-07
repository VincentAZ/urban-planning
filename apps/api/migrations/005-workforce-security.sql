-- Workforce capability extension; installed atomically by the recorded migration owner.
-- Preserve the audited v3 policy for all unrelated entities/purposes.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow_v3(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE p jsonb:=__SCHEMA__.app_security_principal(); uid text:=p->>'userId'; org text:=p->>'organizationId'; role text;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN true; END IF;
 IF __SCHEMA__.app_security_kind()='worker' AND entity='budget' THEN RETURN __SCHEMA__.app_security_mode('worker.budget') AND operation IN ('SELECT','UPDATE'); END IF;
 IF __SCHEMA__.app_security_kind()='worker' AND entity IN ('preparationJobs','preparationControl') THEN RETURN __SCHEMA__.app_security_mode('worker.prep'); END IF;
 IF __SCHEMA__.app_security_kind()='worker' AND entity NOT IN ('preparationJobs','preparationControl','budget') THEN
  IF NOT __SCHEMA__.app_security_mode('worker.prep') OR operation<>'SELECT' THEN RETURN false; END IF;
  IF entity='users' THEN RETURN row_id=uid;
  ELSIF entity='memberships' THEN RETURN actor=uid;
  ELSIF entity='organizations' THEN RETURN EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE user_id=uid AND organization_id=row_id);
  ELSIF entity='sessions' THEN RETURN row_id=current_setting('urban.session_hash',true) AND actor=uid;
  ELSE RETURN false; END IF;
 END IF;
 IF __SCHEMA__.app_security_kind()='auth' THEN
  IF __SCHEMA__.app_security_mode('auth.lookup') AND NOT(entity='users' AND operation='SELECT') THEN RETURN false; END IF;
  IF __SCHEMA__.app_security_mode('auth.register') AND NOT ((entity IN ('users','organizations','memberships','sessions') AND operation IN ('SELECT','INSERT')) OR (entity='audit' AND operation='INSERT')) THEN RETURN false; END IF;
  IF __SCHEMA__.app_security_mode('auth.login') AND NOT ((entity IN ('users','organizations','memberships','sessions') AND operation='SELECT') OR (entity='sessions' AND operation='INSERT')) THEN RETURN false; END IF;
  IF NOT(__SCHEMA__.app_security_mode('auth.lookup') OR __SCHEMA__.app_security_mode('auth.register') OR __SCHEMA__.app_security_mode('auth.login')) THEN RETURN false; END IF;
 END IF;
 IF entity='users' THEN
  IF operation='SELECT' THEN RETURN row_id=uid OR ((__SCHEMA__.app_security_mode('auth.lookup') OR __SCHEMA__.app_security_mode('auth.register')) AND body->>'email'=current_setting('urban.auth_email',true)) OR (__SCHEMA__.app_security_kind()='web' AND ((body->>'email'=nullif(current_setting('urban.member_email',true),'') AND __SCHEMA__.app_security_member_lookup()) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships m WHERE m.user_id=row_id AND __SCHEMA__.app_security_can_view_member(row_id,m.organization_id)))); END IF;
  RETURN operation='INSERT' AND __SCHEMA__.app_security_mode('auth.register') AND row_id=uid AND body->>'email'=current_setting('urban.auth_email',true);
 ELSIF entity='organizations' THEN
  IF operation='SELECT' THEN RETURN EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE user_id=uid AND organization_id=row_id) OR (__SCHEMA__.app_security_mode('auth.register') AND row_id=org); END IF;
  RETURN (operation='INSERT' AND __SCHEMA__.app_security_mode('auth.register') AND row_id=org) OR (operation='UPDATE' AND __SCHEMA__.app_security_workspace_role(row_id)='owner');
 ELSIF entity='memberships' THEN
  IF operation='SELECT' THEN RETURN actor=uid OR (__SCHEMA__.app_security_kind()='web' AND __SCHEMA__.app_security_can_view_member(actor,organization)); END IF;
  RETURN (operation='INSERT' AND __SCHEMA__.app_security_mode('auth.register') AND actor=uid AND organization=org AND body->>'role'='owner') OR (__SCHEMA__.app_security_kind()='web' AND __SCHEMA__.app_security_workspace_role(organization)='owner') OR (operation='INSERT' AND __SCHEMA__.app_security_kind()='web' AND organization=org AND body->>'scope'='project-only' AND body->>'role'='viewer' AND __SCHEMA__.app_security_project_role(nullif(current_setting('urban.project_id',true),''))='owner');
 ELSIF entity='sessions' THEN
  IF operation='SELECT' THEN RETURN ((__SCHEMA__.app_security_kind()='web' OR __SCHEMA__.app_security_mode('worker.prep')) AND row_id=nullif(current_setting('urban.session_hash',true),'') AND actor=uid) OR ((__SCHEMA__.app_security_mode('auth.login') OR __SCHEMA__.app_security_mode('auth.register')) AND row_id=current_setting('urban.auth_session_hash',true) AND actor=uid); END IF;
  IF operation='INSERT' THEN RETURN (__SCHEMA__.app_security_mode('auth.login') OR __SCHEMA__.app_security_mode('auth.register')) AND row_id=current_setting('urban.auth_session_hash',true) AND actor=uid AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE user_id=uid AND organization_id=organization); END IF;
  RETURN __SCHEMA__.app_security_kind()='web' AND row_id=current_setting('urban.session_hash',true) AND actor=uid;
 ELSIF entity='projects' THEN
  IF operation='INSERT' THEN RETURN organization=org AND __SCHEMA__.app_security_workspace_role(org) IN ('owner','editor'); END IF;
  role:=__SCHEMA__.app_security_project_role(row_id);
  RETURN (operation='SELECT' AND role IS NOT NULL) OR (operation='UPDATE' AND role IN ('owner','editor')) OR (operation='DELETE' AND role='owner');
 ELSIF entity='published' THEN
  role:=__SCHEMA__.app_security_project_role(project);
  IF operation='SELECT' THEN RETURN role IS NOT NULL OR __SCHEMA__.app_security_public(row_id); END IF;
  RETURN operation IN ('INSERT','UPDATE') AND role='owner';
 ELSIF entity='comments' THEN
  role:=__SCHEMA__.app_security_project_role(project);
  RETURN (operation='SELECT' AND role IS NOT NULL) OR (operation IN ('INSERT','UPDATE') AND role IN ('owner','editor','commenter') AND (operation='UPDATE' OR body->>'actorId'=uid));
 ELSIF entity='publicFeedback' THEN
  role:=__SCHEMA__.app_security_snapshot_role(snapshot);
  IF operation='SELECT' THEN RETURN role IS NOT NULL OR (actor=uid AND __SCHEMA__.app_security_public(snapshot)); END IF;
  RETURN (operation='INSERT' AND actor=uid AND __SCHEMA__.app_security_public(snapshot)) OR (operation='UPDATE' AND (role='owner' OR (actor=uid AND __SCHEMA__.app_security_public(snapshot))));
 ELSIF entity='audit' THEN
  IF operation='SELECT' THEN RETURN (project IS NOT NULL AND __SCHEMA__.app_security_project_role(project) IS NOT NULL) OR (project IS NULL AND __SCHEMA__.app_security_workspace_role(organization)='owner'); END IF;
  IF operation<>'INSERT' THEN RETURN false; END IF;
  role:=__SCHEMA__.app_security_project_role(project);
  IF EXISTS(SELECT 1 FROM __SCHEMA__.app_project_write_proofs WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND project_id=project AND user_id=body->>'actorId' AND session_hash=current_setting('urban.session_hash',true) AND app_project_write_proofs.role='owner') THEN role:='owner'; uid:=body->>'actorId'; END IF;
  IF body->>'actorId' IS DISTINCT FROM uid THEN RETURN false; END IF;
  IF body->>'action'='account.created' THEN RETURN __SCHEMA__.app_security_mode('auth.register') AND organization=org AND project IS NULL;
  ELSIF body->>'action'='membership.updated' THEN RETURN __SCHEMA__.app_security_workspace_role(organization)='owner';
  ELSIF body->>'action'='engagement.submitted' THEN RETURN __SCHEMA__.app_security_public(body->'details'->>'snapshotId') AND EXISTS(SELECT 1 FROM __SCHEMA__.app_published s WHERE s.id=body->'details'->>'snapshotId' AND s.project_id=project AND s.organization_id=organization);
  ELSIF body->>'action' IN ('project.member.updated','project.member.removed','project.deleted','snapshot.published','snapshot.revoked','engagement.collection.changed','engagement.response.moderated') THEN RETURN role='owner';
  ELSIF body->>'action' IN ('comment.created','comment.replied') THEN RETURN role IN ('owner','editor','commenter');
  ELSIF body->>'action' IN ('comment.resolved','comment.reopened') THEN RETURN role IN ('owner','editor') OR (role='commenter' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_comments WHERE id=body->'details'->>'commentId' AND project_id=project AND header->>'actorId'=uid));
  ELSE RETURN role IN ('owner','editor'); END IF;
 ELSIF entity='imports' THEN
  RETURN operation<>'DELETE' AND organization=org AND body->>'createdBy'=uid AND (__SCHEMA__.app_security_workspace_role(org) IN ('owner','editor') OR __SCHEMA__.app_security_project_role(project) IN ('owner','editor'));
 ELSIF entity='preparationJobs' THEN
  RETURN __SCHEMA__.app_security_mode('worker.prep') OR (actor=uid AND operation IN ('SELECT','INSERT','UPDATE'));
 ELSIF entity='preparationControl' THEN RETURN __SCHEMA__.app_security_mode('worker.prep');
 ELSIF entity='budget' THEN RETURN operation IN ('SELECT','UPDATE') AND (__SCHEMA__.app_security_admin() OR __SCHEMA__.app_security_mode('worker.budget'));
 END IF;
 RETURN false;
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
 IF __SCHEMA__.app_security_kind()<>'web' AND NOT (__SCHEMA__.app_security_mode('worker.prep') OR __SCHEMA__.app_security_mode('worker.workforce')) THEN RETURN NULL; END IF;
 SELECT header INTO s FROM __SCHEMA__.app_sessions WHERE id=nullif(current_setting('urban.session_hash',true),'') AND (header->>'expiresAt')::timestamptz>statement_timestamp();
 IF s IS NULL THEN RETURN NULL; END IF;
 u:=s->>'userId'; o:=s->>'organizationId';
 IF EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=u) AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE user_id=u AND organization_id=o) THEN RETURN jsonb_build_object('userId',u,'organizationId',o); END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_workforce_creator_can_edit(job jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM __SCHEMA__.app_projects p JOIN __SCHEMA__.app_memberships m ON m.organization_id=p.organization_id AND m.user_id=job->>'userId'
 WHERE p.id=job->>'projectId' AND p.organization_id=job->>'organizationId'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'project'->'scenarios') s WHERE s->>'id'=job->>'scenarioId' AND s->>'id'<>'baseline')
 AND ((m.header->>'role'='owner' AND coalesce(m.header->>'scope','workspace')<>'project-only')
 OR (p.header ? 'acl' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'acl'->'members') a WHERE a->>'userId'=job->>'userId' AND a->>'role' IN ('owner','editor')))
 OR (NOT p.header ? 'acl' AND coalesce(m.header->>'scope','workspace')<>'project-only' AND m.header->>'role' IN ('owner','editor'))))
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
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

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_workforce_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE p record; j record; old_status text; new_status text; old_attempt integer; new_attempt integer; mutable text[]; last_old jsonb; last_new jsonb; item jsonb; i integer; is_worker boolean:=__SCHEMA__.app_security_mode('worker.workforce');
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF NEW.header->>'id' IS DISTINCT FROM NEW.id OR NEW.header->>'projectId' IS DISTINCT FROM NEW.project_id OR NEW.header->>'organizationId' IS DISTINCT FROM NEW.organization_id OR NEW.baseline_hash IS NOT NULL OR NEW.snapshot_id IS NOT NULL OR NEW.email IS NOT NULL THEN RAISE EXCEPTION 'Workforce identity indexes must match the record' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM __SCHEMA__.app_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Workforce project must exist in the matching organization' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='app_workforce_artifacts' THEN
  IF TG_OP<>'INSERT' OR NOT is_worker OR NEW.user_id IS NOT NULL THEN RAISE EXCEPTION 'Only the workforce worker can append an immutable artifact' USING ERRCODE='42501'; END IF;
  SELECT * INTO j FROM __SCHEMA__.app_workforce_jobs WHERE id=NEW.header->>'jobId' AND project_id=NEW.project_id AND organization_id=NEW.organization_id;
  item:=NEW.header->'workforce';
  IF j.id IS NULL OR item->>'origin' IS DISTINCT FROM 'server-run' OR j.header->>'status' NOT IN ('running','completed') OR j.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb
    OR item->'receipt'->>'projectId' IS DISTINCT FROM NEW.project_id OR item->'receipt'->>'jobId' IS DISTINCT FROM j.id
    OR item->'binding'->>'placeId' IS DISTINCT FROM j.header->>'placeId' OR item->'binding'->>'baselineHash' IS DISTINCT FROM j.header->>'baselineHash'
    OR item->'capture'->'request' IS DISTINCT FROM j.header->'request'
    OR item->'capture'->>'cohortPackHash' IS DISTINCT FROM j.header->'sourceIdentity'->>'cohortPackHash'
    OR item->'capture'->'coverage'->'cohort'->>'boundaryHash' IS DISTINCT FROM j.header->'sourceIdentity'->>'boundaryHash'
    OR item->'capture'->'network'->>'id' IS DISTINCT FROM j.header->'sourceIdentity'->>'manifestId'
    OR item->'capture'->'network'->>'graphHash' IS DISTINCT FROM j.header->'sourceIdentity'->>'graphHash'
    OR item->'capture'->'network'->>'profileHash' IS DISTINCT FROM j.header->'sourceIdentity'->>'profileHash'
    OR item->'capture'->>'methodVersion' IS DISTINCT FROM j.header->'sourceIdentity'->>'methodVersion'
    OR NEW.header->>'rawFileHash' IS DISTINCT FROM item->'capture'->>'artifactHash'
    OR NEW.header->'siteSnapMeters' IS DISTINCT FROM item->'capture'->'siteSnapMeters'
    OR NEW.payload->'contour'->'site' IS DISTINCT FROM j.header->'request'->'site'
    OR NEW.payload->'contour'->>'mode' IS DISTINCT FROM j.header->'request'->>'mode'
    OR NEW.payload->'contour'->>'direction' IS DISTINCT FROM 'inbound'
    OR NEW.payload->'contour'->>'manifestId' IS DISTINCT FROM j.header->'sourceIdentity'->>'manifestId'
    OR NEW.payload->'contour'->>'inputHash' IS DISTINCT FROM item->'capture'->'contour'->>'inputHash'
    OR jsonb_typeof(NEW.payload->'contour'->'geometry'->'features') IS DISTINCT FROM 'array'
    OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(j.header)
   THEN RAISE EXCEPTION 'Workforce artifact must match its admitted project, query, source and current creator access' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.header->>'userId' IS DISTINCT FROM NEW.user_id OR (NEW.payload IS NOT NULL AND NEW.payload<>'null'::jsonb) THEN RAISE EXCEPTION 'Workforce jobs must retain their original account and small header-only payload' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN RAISE EXCEPTION 'Workforce job identity cannot change' USING ERRCODE='42501'; END IF;
 new_status:=NEW.header->>'status';new_attempt:=(NEW.header->>'attempt')::integer;
 IF new_status IS NULL OR new_status NOT IN ('queued','running','completed','failed','cancelled') OR new_attempt IS NULL OR new_attempt<0 OR new_attempt>3 OR jsonb_typeof(NEW.header->'attempts') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.header->'attempts')<>new_attempt OR jsonb_typeof(NEW.header->'requestKeys') IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.header->'cancelRequested') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Workforce state/attempt records are invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT is_worker OR NEW.user_id IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(NEW.header)
   OR new_status<>'queued' OR new_attempt<>0 OR NEW.header->'version' IS DISTINCT FROM '1'::jsonb OR NEW.header->'progress' IS DISTINCT FROM '0'::jsonb OR NEW.header->>'stage' IS DISTINCT FROM 'queued' OR NEW.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NEW.header ?| ARRAY['workerId','leaseExpiresAt','result','error']
   OR NEW.header->>'baselineHash' IS DISTINCT FROM p.baseline_hash OR NEW.header->>'placeId' IS DISTINCT FROM p.header->'project'->>'placeId' OR NEW.header->'projectVersion' IS DISTINCT FROM p.header->'version'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'project'->'scenarios') s WHERE s->>'id'=NEW.header->>'scenarioId' AND s->'revision'=NEW.header->'scenarioRevision')
   OR NEW.header->'requestKeys' IS DISTINCT FROM jsonb_build_array(NEW.header->>'idempotencyKey')
  THEN RAISE EXCEPTION 'Workforce admission requires an unchanged saved proposal and authenticated editor' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 old_status:=OLD.header->>'status';old_attempt:=(OLD.header->>'attempt')::integer;
 IF NOT ((old_status='queued' AND new_status IN ('queued','running','failed','cancelled')) OR (old_status='running' AND new_status IN ('running','completed','failed','cancelled')) OR (old_status IN ('failed','cancelled') AND new_status='queued')) THEN RAISE EXCEPTION 'Workforce state transition is not permitted' USING ERRCODE='42501'; END IF;
 mutable:=ARRAY['version','status','stage','progress','attempt','attempts','cancelRequested','workerId','leaseExpiresAt','error','result','updatedAt','requestKeys'];
 IF NEW.header-mutable IS DISTINCT FROM OLD.header-mutable OR old_status='completed' THEN RAISE EXCEPTION 'Workforce admitted inputs and completed jobs are immutable' USING ERRCODE='42501'; END IF;
 IF (NEW.header->>'version')::integer IS NULL OR (NEW.header->>'version')::integer<>(OLD.header->>'version')::integer+(CASE WHEN new_status IS DISTINCT FROM old_status OR NEW.header->'cancelRequested' IS DISTINCT FROM OLD.header->'cancelRequested' OR NEW.header->'requestKeys' IS DISTINCT FROM OLD.header->'requestKeys' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Workforce transition version mismatch' USING ERRCODE='42501'; END IF;
 IF NOT is_worker THEN
  IF __SCHEMA__.app_security_project_role(NEW.project_id) NOT IN ('owner','editor') THEN RAISE EXCEPTION 'Workforce cancellation/retry needs project edit access' USING ERRCODE='42501'; END IF;
  IF old_status IN ('queued','running') AND NEW.header->'cancelRequested'='true'::jsonb AND new_status=(CASE old_status WHEN 'queued' THEN 'cancelled' ELSE 'running' END) THEN
   IF NEW.header-ARRAY['version','status','cancelRequested','updatedAt'] IS DISTINCT FROM OLD.header-ARRAY['version','status','cancelRequested','updatedAt'] THEN RAISE EXCEPTION 'Cancellation cannot change job inputs or worker output' USING ERRCODE='42501'; END IF;
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Retries require worker admission; clients may only cancel active jobs' USING ERRCODE='42501';
 END IF;
 IF (old_status='queued' AND new_status='running' AND new_attempt<>old_attempt+1) OR new_attempt<old_attempt OR new_attempt>old_attempt+1 OR (new_attempt=old_attempt+1 AND NOT(old_status='queued' AND new_status='running')) THEN RAISE EXCEPTION 'Workforce attempts can only increase once on a queued worker claim' USING ERRCODE='42501'; END IF;
 FOR i IN 0..old_attempt-1 LOOP
  last_old:=OLD.header->'attempts'->i;last_new:=NEW.header->'attempts'->i;
  IF (i<old_attempt-1 OR old_status<>'running') AND last_new IS DISTINCT FROM last_old THEN RAISE EXCEPTION 'Completed attempt history is immutable' USING ERRCODE='42501'; END IF;
  IF last_new-ARRAY['endedAt','outcome','elapsedMilliseconds'] IS DISTINCT FROM last_old-ARRAY['endedAt','outcome','elapsedMilliseconds'] THEN RAISE EXCEPTION 'Attempt provenance cannot change' USING ERRCODE='42501'; END IF;
 END LOOP;
 IF old_status IN ('failed','cancelled') AND new_status='queued' THEN
  IF new_attempt<>old_attempt OR new_attempt>=3 OR OLD.header->'error'->'retryable'='false'::jsonb OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(NEW.header)
   OR __SCHEMA__.app_security_project_role(NEW.project_id) NOT IN ('owner','editor')
   OR NEW.header->>'stage' IS DISTINCT FROM 'queued' OR NEW.header->'progress' IS DISTINCT FROM '0'::jsonb OR NEW.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NEW.header ?| ARRAY['workerId','leaseExpiresAt','result','error']
   OR jsonb_array_length(NEW.header->'requestKeys')<>jsonb_array_length(OLD.header->'requestKeys')+1 OR ((NEW.header->'requestKeys') - jsonb_array_length(OLD.header->'requestKeys')) IS DISTINCT FROM OLD.header->'requestKeys' OR (OLD.header->'requestKeys') @> jsonb_build_array((NEW.header->'requestKeys')->jsonb_array_length(OLD.header->'requestKeys'))
  THEN RAISE EXCEPTION 'Retry must preserve consumed attempts and require current editor admission' USING ERRCODE='42501'; END IF;
 ELSIF NEW.header->'requestKeys' IS DISTINCT FROM OLD.header->'requestKeys' THEN RAISE EXCEPTION 'Only retry may append an idempotency key' USING ERRCODE='42501'; END IF;
 IF new_status='running' THEN
  IF old_status NOT IN ('queued','running') OR NEW.header->>'workerId' IS NULL OR NEW.header->>'leaseExpiresAt' IS NULL OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(NEW.header) THEN RAISE EXCEPTION 'Running workforce work needs current creator access and worker lease' USING ERRCODE='42501'; END IF;
  IF old_status='running' AND NEW.header->>'workerId' IS DISTINCT FROM OLD.header->>'workerId' THEN RAISE EXCEPTION 'A running worker lease cannot be stolen' USING ERRCODE='42501'; END IF;
  IF old_status='queued' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_workforce_jobs other_job WHERE other_job.id<>NEW.id AND other_job.header->>'status'='running') THEN RAISE EXCEPTION 'Only one workforce job may run at once' USING ERRCODE='42501'; END IF;
 END IF;
 IF new_status='completed' AND (old_status<>'running' OR NEW.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NEW.header->>'stage' IS DISTINCT FROM 'complete' OR NEW.header->'progress' IS DISTINCT FROM '100'::jsonb OR NOT NEW.header ? 'result' OR NOT __SCHEMA__.app_security_workforce_creator_can_edit(NEW.header)) THEN RAISE EXCEPTION 'Only an uncancelled authorized worker can complete a result' USING ERRCODE='42501'; END IF;
 IF new_status<>'completed' AND NEW.header ? 'result' THEN RAISE EXCEPTION 'Only completed jobs may reference results' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_workforce_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE j record; a record;
BEGIN
 IF TG_TABLE_NAME='app_workforce_jobs' THEN SELECT * INTO j FROM __SCHEMA__.app_workforce_jobs WHERE id=NEW.id;
 ELSE SELECT * INTO j FROM __SCHEMA__.app_workforce_jobs WHERE id=NEW.header->>'jobId'; END IF;
 IF j.id IS NOT NULL AND j.header->>'status'='completed' THEN
  IF TG_TABLE_NAME='app_workforce_artifacts' AND j.header->'result'->>'artifactId' IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'A workforce artifact must be the exact completed job result' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM __SCHEMA__.app_workforce_artifacts WHERE id=j.header->'result'->>'artifactId' AND project_id=j.project_id AND organization_id=j.organization_id AND header->>'jobId'=j.id;
  IF a.id IS NULL OR a.header->'workforce'->>'captureHash' IS DISTINCT FROM j.header->'result'->>'captureHash' OR a.header->'workforce'->'capture'->>'resultHash' IS DISTINCT FROM j.header->'result'->>'resultHash' OR a.header->'workforce'->'capture'->>'inputHash' IS DISTINCT FROM j.header->'result'->>'inputHash' THEN RAISE EXCEPTION 'Completed workforce job requires its atomically stored authoritative artifact' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='app_workforce_artifacts' THEN RAISE EXCEPTION 'An artifact cannot survive without its completed job' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_workforce_project_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE item jsonb; project_key text; path text; candidates jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='app_projects' THEN project_key:=NEW.id;
  SELECT coalesce(jsonb_agg(v),'[]') INTO candidates FROM (
   SELECT jsonb_path_query(NEW.payload,'$.project.scenarios[*].workforce') v
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.history[*].before.workforce')
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.history[*].after.workforce')
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.history[*].command.workforce')
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.undone[*].before.workforce')
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.undone[*].after.workforce')
   UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.undone[*].command.workforce')) captured;
 ELSE project_key:=NEW.project_id;candidates:=jsonb_build_array(NEW.payload->'scenario'->'workforce'); END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(candidates) WHERE value IS NOT NULL AND value<>'null'::jsonb LOOP
  IF item->>'origin' IS NULL OR item->>'origin' NOT IN ('server-run','imported') OR item->'binding'->>'baselineHash' IS DISTINCT FROM NEW.baseline_hash THEN RAISE EXCEPTION 'Workforce origin and immutable baseline binding are required' USING ERRCODE='42501'; END IF;
  IF item->>'origin'='imported' THEN CONTINUE; END IF;
  IF item->'receipt'->>'projectId' IS DISTINCT FROM project_key
   OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_workforce_artifacts a WHERE a.project_id=project_key AND a.organization_id=NEW.organization_id AND a.header->>'jobId'=item->'receipt'->>'jobId' AND a.header->'workforce'=item)
  THEN RAISE EXCEPTION 'Saved or published workforce evidence must match its project-owned immutable artifact' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=5) THEN 5 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
DO $install$
DECLARE cfg record; tab text; entity text; fn regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 FOREACH tab IN ARRAY ARRAY['app_workforce_jobs','app_workforce_artifacts'] LOOP
  entity:=CASE tab WHEN 'app_workforce_jobs' THEN 'workforceJobs' ELSE 'workforceArtifacts' END;
  EXECUTE format('ALTER TABLE __SCHEMA__.%I ENABLE ROW LEVEL SECURITY',tab);EXECUTE format('ALTER TABLE __SCHEMA__.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('REVOKE ALL ON __SCHEMA__.%I FROM PUBLIC,%I,%I,%I',tab,cfg.web_role,cfg.auth_role,cfg.worker_role);
  EXECUTE format('DROP POLICY IF EXISTS operator_access ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE POLICY operator_access ON __SCHEMA__.%I TO %I USING(true) WITH CHECK(true)',tab,cfg.migration_role);
  EXECUTE format('DROP POLICY IF EXISTS runtime_select ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE POLICY runtime_select ON __SCHEMA__.%I FOR SELECT TO %I,%I USING(__SCHEMA__.app_security_allow(%L,''SELECT'',id,organization_id,user_id,project_id,snapshot_id,header))',tab,cfg.web_role,cfg.worker_role,entity);
  EXECUTE format('DROP POLICY IF EXISTS runtime_insert ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE POLICY runtime_insert ON __SCHEMA__.%I FOR INSERT TO %I WITH CHECK(__SCHEMA__.app_security_allow(%L,''INSERT'',id,organization_id,user_id,project_id,snapshot_id,header))',tab,cfg.worker_role,entity);
  EXECUTE format('GRANT SELECT ON __SCHEMA__.%I TO %I,%I',tab,cfg.web_role,cfg.worker_role);
  EXECUTE format('GRANT INSERT ON __SCHEMA__.%I TO %I',tab,cfg.worker_role);
  EXECUTE format('DROP TRIGGER IF EXISTS security_workforce_bind ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE TRIGGER security_workforce_bind BEFORE INSERT OR UPDATE ON __SCHEMA__.%I FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_workforce_bind()',tab);
  EXECUTE format('DROP TRIGGER IF EXISTS security_workforce_completion ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE CONSTRAINT TRIGGER security_workforce_completion AFTER INSERT OR UPDATE ON __SCHEMA__.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_workforce_completion()',tab);
 END LOOP;
 DROP POLICY IF EXISTS runtime_update ON __SCHEMA__.app_workforce_jobs;
 EXECUTE format('CREATE POLICY runtime_update ON __SCHEMA__.app_workforce_jobs FOR UPDATE TO %I,%I USING(__SCHEMA__.app_security_allow(''workforceJobs'',''UPDATE'',id,organization_id,user_id,project_id,snapshot_id,header)) WITH CHECK(__SCHEMA__.app_security_allow(''workforceJobs'',''UPDATE'',id,organization_id,user_id,project_id,snapshot_id,header))',cfg.web_role,cfg.worker_role);
 EXECUTE format('GRANT UPDATE ON __SCHEMA__.app_workforce_jobs TO %I,%I',cfg.web_role,cfg.worker_role);
 -- Worker project authorization sees headers only, never full private scenario/history payloads.
 EXECUTE format('REVOKE SELECT ON __SCHEMA__.app_projects FROM %I',cfg.worker_role);
 EXECUTE format('GRANT SELECT(id,ordinal,organization_id,user_id,project_id,snapshot_id,email,header,baseline_hash,updated_at) ON __SCHEMA__.app_projects TO %I',cfg.worker_role);
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND p.proname LIKE 'app_security_workforce_%' OR (n.nspname=replace('__SCHEMA__','"','') AND p.proname='app_security_allow_v3') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role);
 END LOOP;
END $install$;
DROP TRIGGER IF EXISTS security_workforce_capture ON __SCHEMA__.app_projects;
CREATE TRIGGER security_workforce_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_projects FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_workforce_project_capture();
DROP TRIGGER IF EXISTS security_workforce_capture ON __SCHEMA__.app_published;
CREATE TRIGGER security_workforce_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_published FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_workforce_project_capture();
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
