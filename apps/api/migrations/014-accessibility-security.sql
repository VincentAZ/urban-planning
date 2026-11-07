-- Append-only project-owned outbound jobs; preserve every prior identity and native capability.

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow_v12(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE p jsonb:=__SCHEMA__.app_security_principal(); uid text:=p->>'userId'; invitation jsonb; challenge jsonb; message jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN true; END IF;
 IF __SCHEMA__.app_security_mode('worker.identity-mail') THEN
  SELECT header INTO message FROM __SCHEMA__.app_identity_outbox WHERE id=nullif(current_setting('urban.identity_outbox_id',true),'');
  IF entity='identityOutbox' THEN RETURN operation='SELECT' OR (operation='UPDATE' AND (nullif(current_setting('urban.identity_outbox_id',true),'') IS NULL OR row_id=current_setting('urban.identity_outbox_id',true))); END IF;
  IF entity='budget' THEN RETURN operation IN ('SELECT','UPDATE'); END IF;
  IF operation<>'SELECT' OR message IS NULL THEN RETURN false; END IF;
  IF entity='identityChallenges' THEN RETURN row_id=message->>'challengeId'; END IF;
  IF entity='identityInvitations' THEN RETURN row_id=message->>'invitationId'; END IF;
  SELECT header INTO invitation FROM __SCHEMA__.app_identity_invitations WHERE id=message->>'invitationId';
  IF entity='users' THEN RETURN row_id=message->>'userId' OR row_id=invitation->>'createdBy'; END IF;
  IF entity='memberships' THEN RETURN actor=invitation->>'createdBy' AND organization=invitation->>'organizationId'; END IF;
  IF entity='projects' THEN RETURN row_id=invitation->>'projectId'; END IF;
  IF entity='organizations' THEN RETURN row_id=invitation->>'organizationId'; END IF;
  RETURN false;
 END IF;
 IF __SCHEMA__.app_security_mode('auth.challenge-lookup') THEN
  challenge:=__SCHEMA__.app_security_identity_challenge();
  RETURN operation='SELECT' AND ((entity='identityChallenges' AND row_id=challenge->>'id') OR (entity='users' AND row_id=challenge->>'userId'));
 END IF;
 IF __SCHEMA__.app_security_mode('auth.challenge-issue') OR __SCHEMA__.app_security_mode('auth.challenge-consume') OR __SCHEMA__.app_security_mode('auth.password-change') OR __SCHEMA__.app_security_mode('auth.invitation-manage') OR __SCHEMA__.app_security_mode('auth.invitation-accept') THEN
  IF uid IS NULL THEN RETURN false; END IF;
  invitation:=coalesce(__SCHEMA__.app_security_identity_proof('invitation'),__SCHEMA__.app_security_identity_invitation());
  IF entity='identityOutbox' THEN RETURN operation IN ('SELECT','INSERT'); END IF;
  IF entity='budget' THEN RETURN operation='SELECT'; END IF;
  IF entity='users' THEN RETURN (operation='SELECT' AND (row_id=uid OR row_id=invitation->>'createdBy')) OR (operation='UPDATE' AND row_id=uid AND (__SCHEMA__.app_security_mode('auth.challenge-consume') OR __SCHEMA__.app_security_mode('auth.password-change'))); END IF;
  IF entity='sessions' THEN RETURN (operation='SELECT' AND actor=uid) OR (operation='DELETE' AND actor=uid AND (__SCHEMA__.app_security_mode('auth.challenge-consume') OR __SCHEMA__.app_security_mode('auth.password-change'))); END IF;
  IF entity='organizations' THEN RETURN operation='SELECT' AND (EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships m WHERE m.user_id=uid AND m.organization_id=row_id) OR row_id=invitation->>'organizationId'); END IF;
  IF entity='memberships' THEN RETURN (operation='SELECT' AND (actor=uid OR organization=invitation->>'organizationId' OR (__SCHEMA__.app_security_mode('auth.invitation-manage') AND __SCHEMA__.app_security_identity_owner(uid,organization,nullif(current_setting('urban.project_id',true),''))))) OR (operation IN ('INSERT','UPDATE') AND actor=uid AND organization=invitation->>'organizationId'); END IF;
  IF entity='projects' THEN RETURN (operation='SELECT' AND (__SCHEMA__.app_security_project_role(row_id) IS NOT NULL OR row_id=invitation->>'projectId')) OR (operation='UPDATE' AND row_id=invitation->>'projectId'); END IF;
  IF entity='identityChallenges' THEN RETURN actor=uid AND ((operation IN ('SELECT','INSERT','UPDATE') AND __SCHEMA__.app_security_mode('auth.challenge-issue')) OR (operation IN ('SELECT','UPDATE') AND (__SCHEMA__.app_security_mode('auth.challenge-consume') OR __SCHEMA__.app_security_mode('auth.password-change')))); END IF;
  IF entity='identityInvitations' THEN
   RETURN (operation IN ('SELECT','INSERT','UPDATE') AND __SCHEMA__.app_security_mode('auth.invitation-manage') AND __SCHEMA__.app_security_identity_owner(uid,organization,project)) OR (operation IN ('SELECT','UPDATE') AND row_id=invitation->>'id');
  END IF;
  IF entity='audit' THEN RETURN operation='INSERT' AND body->>'actorId'=uid AND body->>'action' LIKE 'identity.%' AND (organization=p->>'organizationId' OR organization=invitation->>'organizationId'); END IF;
  RETURN false;
 END IF;
 IF entity IN ('identityChallenges','identityOutbox') THEN RETURN false; END IF;
 IF entity='identityInvitations' THEN RETURN __SCHEMA__.app_security_kind()='web' AND operation='SELECT' AND (__SCHEMA__.app_security_identity_owner(uid,organization,project) OR body->>'email'=(SELECT email FROM __SCHEMA__.app_users WHERE id=uid AND jsonb_typeof(header->'emailVerifiedAt')='string')); END IF;
 RETURN __SCHEMA__.app_security_allow_v10(entity,operation,row_id,organization,actor,project,snapshot,body);
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
 IF __SCHEMA__.app_security_kind()<>'web' AND NOT (__SCHEMA__.app_security_mode('worker.prep') OR __SCHEMA__.app_security_mode('worker.accessibility') OR __SCHEMA__.app_security_mode('worker.workforce') OR __SCHEMA__.app_security_mode('worker.gis') OR __SCHEMA__.app_security_mode('worker.traffic') OR __SCHEMA__.app_security_mode('auth.password-change') OR __SCHEMA__.app_security_mode('auth.invitation-accept') OR __SCHEMA__.app_security_mode('auth.invitation-manage')) THEN RETURN NULL; END IF;
 s:=__SCHEMA__.app_security_identity_session();
 IF s IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('userId',s->>'userId','organizationId',s->>'organizationId');
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_accessibility_creator_can_edit(job jsonb) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
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
 IF __SCHEMA__.app_security_mode('worker.accessibility') THEN
  IF entity='accessibilityJobs' THEN
   IF operation='SELECT' THEN RETURN true; END IF;
   IF operation='INSERT' THEN RETURN actor=uid AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor'); END IF;
   RETURN operation='UPDATE';
  ELSIF entity='accessibilityArtifacts' THEN RETURN operation IN ('SELECT','INSERT');
  ELSIF entity='nativeCapacity' THEN RETURN operation IN ('SELECT','UPDATE');
  ELSIF entity='budget' THEN RETURN operation='SELECT';
  ELSIF entity='projects' THEN RETURN operation='SELECT' AND ((row_id=nullif(current_setting('urban.project_id',true),'') AND __SCHEMA__.app_security_project_role(row_id) IN ('owner','editor')) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_accessibility_jobs j WHERE j.project_id=row_id));
  ELSIF entity='memberships' THEN RETURN operation='SELECT' AND (actor=uid OR EXISTS(SELECT 1 FROM __SCHEMA__.app_accessibility_jobs j WHERE j.user_id=actor AND j.organization_id=organization));
  ELSIF entity='users' THEN RETURN operation='SELECT' AND row_id=uid;
  ELSIF entity='sessions' THEN RETURN operation='SELECT' AND row_id=nullif(current_setting('urban.session_hash',true),'') AND actor=uid;
  ELSIF entity='organizations' THEN RETURN operation='SELECT' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships m WHERE m.user_id=uid AND m.organization_id=row_id);
  ELSIF entity='audit' THEN RETURN operation='INSERT' AND body->>'actorId'=uid AND body->>'action' IN ('accessibility.submitted','accessibility.retried') AND __SCHEMA__.app_security_project_role(project) IN ('owner','editor');
  ELSE RETURN false; END IF;
 END IF;
 IF entity IN ('accessibilityJobs','accessibilityArtifacts') THEN
  IF __SCHEMA__.app_security_kind()<>'web' THEN RETURN false; END IF;
  role:=__SCHEMA__.app_security_project_role(project);
  IF operation='SELECT' THEN
   IF role IS NOT NULL THEN RETURN true; END IF;
   RETURN entity='accessibilityArtifacts' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_published s WHERE s.project_id=project AND s.organization_id=organization AND __SCHEMA__.app_security_public(s.id) AND s.payload->'scenario'->'accessibility'->'captures'->(body->'accessibility'->'capture'->'request'->>'mode')=body->'accessibility');
  END IF;
  RETURN entity='accessibilityJobs' AND operation='UPDATE' AND role IN ('owner','editor');
 END IF;
 RETURN __SCHEMA__.app_security_allow_v12(entity,operation,row_id,organization,actor,project,snapshot,body);
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_accessibility_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE p record; j record; old_status text; new_status text; old_attempt integer; new_attempt integer; mutable text[]; last_old jsonb; last_new jsonb; item jsonb; i integer; is_worker boolean:=__SCHEMA__.app_security_mode('worker.accessibility');
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF NEW.header->>'id' IS DISTINCT FROM NEW.id OR NEW.header->>'projectId' IS DISTINCT FROM NEW.project_id OR NEW.header->>'organizationId' IS DISTINCT FROM NEW.organization_id OR NEW.baseline_hash IS NOT NULL OR NEW.snapshot_id IS NOT NULL OR NEW.email IS NOT NULL THEN RAISE EXCEPTION 'Accessibility identity indexes must match the record' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM __SCHEMA__.app_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id;
 IF p.id IS NULL THEN RAISE EXCEPTION 'Accessibility project must exist in the matching organization' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='app_accessibility_artifacts' THEN
  IF TG_OP<>'INSERT' OR NOT is_worker OR NEW.user_id IS NOT NULL THEN RAISE EXCEPTION 'Only the accessibility worker can append an immutable artifact' USING ERRCODE='42501'; END IF;
  SELECT * INTO j FROM __SCHEMA__.app_accessibility_jobs WHERE id=NEW.header->>'jobId' AND project_id=NEW.project_id AND organization_id=NEW.organization_id;
  item:=NEW.header->'accessibility';
  IF j.id IS NULL OR item->>'origin' IS DISTINCT FROM 'server-run' OR j.header->>'status' NOT IN ('running','completed') OR j.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb
    OR NEW.header->>'scenarioId' IS DISTINCT FROM j.header->>'scenarioId'
    OR item->'receipt'->>'projectId' IS DISTINCT FROM NEW.project_id OR item->'receipt'->>'jobId' IS DISTINCT FROM j.id
    OR item->'binding'->>'placeId' IS DISTINCT FROM j.header->>'placeId' OR item->'binding'->>'baselineHash' IS DISTINCT FROM j.header->>'baselineHash'
    OR item->'capture'->'request' IS DISTINCT FROM j.header->'request'
    OR item->'capture'->>'jobsPackHash' IS DISTINCT FROM j.header->'sourceIdentity'->>'jobsPackHash'
    OR item->'capture'->'coverage'->'destinations'->>'boundaryHash' IS DISTINCT FROM j.header->'sourceIdentity'->>'boundaryHash'
    OR item->'capture'->'network'->>'id' IS DISTINCT FROM j.header->'sourceIdentity'->>'manifestId'
    OR item->'capture'->'network'->>'graphHash' IS DISTINCT FROM j.header->'sourceIdentity'->>'graphHash'
    OR item->'capture'->'network'->>'profileHash' IS DISTINCT FROM j.header->'sourceIdentity'->>'profileHash'
    OR item->'capture'->>'methodVersion' IS DISTINCT FROM j.header->'sourceIdentity'->>'methodVersion'
    OR octet_length(item::text)>262144
    OR NEW.header->>'rawFileHash' IS DISTINCT FROM item->'capture'->>'artifactHash'
    OR NEW.header->'siteSnapMeters' IS DISTINCT FROM item->'capture'->'siteSnapMeters'
    OR NEW.payload->'contour'->'site' IS DISTINCT FROM j.header->'request'->'site'
    OR NEW.payload->'contour'->>'mode' IS DISTINCT FROM j.header->'request'->>'mode'
    OR NEW.payload->'contour'->>'direction' IS DISTINCT FROM 'outbound'
    OR NEW.payload->'contour'->>'manifestId' IS DISTINCT FROM j.header->'sourceIdentity'->>'manifestId'
    OR NEW.payload->'contour'->>'inputHash' IS DISTINCT FROM item->'capture'->'contour'->>'inputHash'
    OR jsonb_typeof(NEW.payload->'contour'->'geometry'->'features') IS DISTINCT FROM 'array'
    OR NOT __SCHEMA__.app_security_accessibility_creator_can_edit(j.header)
   THEN RAISE EXCEPTION 'Accessibility artifact must match its admitted project, query, source and current creator access' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.header->>'userId' IS DISTINCT FROM NEW.user_id OR (NEW.payload IS NOT NULL AND NEW.payload<>'null'::jsonb) THEN RAISE EXCEPTION 'Accessibility jobs must retain their original account and small header-only payload' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id) THEN RAISE EXCEPTION 'Accessibility job identity cannot change' USING ERRCODE='42501'; END IF;
 new_status:=NEW.header->>'status';new_attempt:=(NEW.header->>'attempt')::integer;
 IF new_status IS NULL OR new_status NOT IN ('queued','running','completed','failed','cancelled') OR new_attempt IS NULL OR new_attempt<0 OR new_attempt>3 OR jsonb_typeof(NEW.header->'attempts') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.header->'attempts')<>new_attempt OR jsonb_typeof(NEW.header->'requestKeys') IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.header->'cancelRequested') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Accessibility state/attempt records are invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT is_worker OR NEW.user_id IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR NOT __SCHEMA__.app_security_accessibility_creator_can_edit(NEW.header)
   OR new_status<>'queued' OR new_attempt<>0 OR NEW.header->'version' IS DISTINCT FROM '1'::jsonb OR NEW.header->'progress' IS DISTINCT FROM '0'::jsonb OR NEW.header->>'stage' IS DISTINCT FROM 'queued' OR NEW.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NEW.header ?| ARRAY['workerId','leaseExpiresAt','capacityToken','result','error']
   OR NEW.header->>'baselineHash' IS DISTINCT FROM p.baseline_hash OR NEW.header->>'placeId' IS DISTINCT FROM p.header->'project'->>'placeId' OR NEW.header->'projectVersion' IS DISTINCT FROM p.header->'version'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.header->'project'->'scenarios') s WHERE s->>'id'=NEW.header->>'scenarioId' AND s->'revision'=NEW.header->'scenarioRevision')
   OR NEW.header->'requestKeys' IS DISTINCT FROM jsonb_build_array(NEW.header->>'idempotencyKey')
  THEN RAISE EXCEPTION 'Accessibility admission requires an unchanged saved proposal and authenticated editor' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 old_status:=OLD.header->>'status';old_attempt:=(OLD.header->>'attempt')::integer;
 IF NOT ((old_status='queued' AND new_status IN ('queued','running','failed','cancelled')) OR (old_status='running' AND new_status IN ('running','completed','failed','cancelled')) OR (old_status IN ('failed','cancelled') AND new_status='queued')) THEN RAISE EXCEPTION 'Accessibility state transition is not permitted' USING ERRCODE='42501'; END IF;
 mutable:=ARRAY['version','status','stage','progress','attempt','attempts','cancelRequested','workerId','leaseExpiresAt','capacityToken','error','result','updatedAt','requestKeys'];
 IF NEW.header-mutable IS DISTINCT FROM OLD.header-mutable OR old_status='completed' THEN RAISE EXCEPTION 'Accessibility admitted inputs and completed jobs are immutable' USING ERRCODE='42501'; END IF;
 IF (NEW.header->>'version')::integer IS NULL OR (NEW.header->>'version')::integer<>(OLD.header->>'version')::integer+(CASE WHEN new_status IS DISTINCT FROM old_status OR NEW.header->'cancelRequested' IS DISTINCT FROM OLD.header->'cancelRequested' OR NEW.header->'requestKeys' IS DISTINCT FROM OLD.header->'requestKeys' THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Accessibility transition version mismatch' USING ERRCODE='42501'; END IF;
 IF NOT is_worker THEN
  IF __SCHEMA__.app_security_project_role(NEW.project_id) NOT IN ('owner','editor') THEN RAISE EXCEPTION 'Accessibility cancellation/retry needs project edit access' USING ERRCODE='42501'; END IF;
  IF old_status IN ('queued','running') AND NEW.header->'cancelRequested'='true'::jsonb AND new_status=(CASE old_status WHEN 'queued' THEN 'cancelled' ELSE 'running' END) THEN
   IF NEW.header-ARRAY['version','status','cancelRequested','updatedAt'] IS DISTINCT FROM OLD.header-ARRAY['version','status','cancelRequested','updatedAt'] THEN RAISE EXCEPTION 'Cancellation cannot change job inputs or worker output' USING ERRCODE='42501'; END IF;
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Retries require worker admission; clients may only cancel active jobs' USING ERRCODE='42501';
 END IF;
 IF (old_status='queued' AND new_status='running' AND new_attempt<>old_attempt+1) OR new_attempt<old_attempt OR new_attempt>old_attempt+1 OR (new_attempt=old_attempt+1 AND NOT(old_status='queued' AND new_status='running')) THEN RAISE EXCEPTION 'Accessibility attempts can only increase once on a queued worker claim' USING ERRCODE='42501'; END IF;
 FOR i IN 0..old_attempt-1 LOOP
  last_old:=OLD.header->'attempts'->i;last_new:=NEW.header->'attempts'->i;
  IF (i<old_attempt-1 OR old_status<>'running') AND last_new IS DISTINCT FROM last_old THEN RAISE EXCEPTION 'Completed attempt history is immutable' USING ERRCODE='42501'; END IF;
  IF last_new-ARRAY['endedAt','outcome','elapsedMilliseconds'] IS DISTINCT FROM last_old-ARRAY['endedAt','outcome','elapsedMilliseconds'] THEN RAISE EXCEPTION 'Attempt provenance cannot change' USING ERRCODE='42501'; END IF;
 END LOOP;
 IF old_status IN ('failed','cancelled') AND new_status='queued' THEN
  IF new_attempt<>old_attempt OR new_attempt>=3 OR OLD.header->'error'->'retryable'='false'::jsonb OR NOT __SCHEMA__.app_security_accessibility_creator_can_edit(NEW.header)
   OR __SCHEMA__.app_security_project_role(NEW.project_id) NOT IN ('owner','editor')
   OR NEW.header->>'stage' IS DISTINCT FROM 'queued' OR NEW.header->'progress' IS DISTINCT FROM '0'::jsonb OR NEW.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NEW.header ?| ARRAY['workerId','leaseExpiresAt','capacityToken','result','error']
   OR jsonb_array_length(NEW.header->'requestKeys')<>jsonb_array_length(OLD.header->'requestKeys')+1 OR ((NEW.header->'requestKeys') - jsonb_array_length(OLD.header->'requestKeys')) IS DISTINCT FROM OLD.header->'requestKeys' OR (OLD.header->'requestKeys') @> jsonb_build_array((NEW.header->'requestKeys')->jsonb_array_length(OLD.header->'requestKeys'))
  THEN RAISE EXCEPTION 'Retry must preserve consumed attempts and require current editor admission' USING ERRCODE='42501'; END IF;
 ELSIF NEW.header->'requestKeys' IS DISTINCT FROM OLD.header->'requestKeys' THEN RAISE EXCEPTION 'Only retry may append an idempotency key' USING ERRCODE='42501'; END IF;
 IF new_status='running' THEN
  IF old_status NOT IN ('queued','running') OR NEW.header->>'workerId' IS NULL OR NEW.header->>'leaseExpiresAt' IS NULL OR NOT __SCHEMA__.app_security_accessibility_creator_can_edit(NEW.header) THEN RAISE EXCEPTION 'Running accessibility work needs current creator access and worker lease' USING ERRCODE='42501'; END IF;
  IF old_status='running' AND NEW.header->>'workerId' IS DISTINCT FROM OLD.header->>'workerId' THEN RAISE EXCEPTION 'A running worker lease cannot be stolen' USING ERRCODE='42501'; END IF;
  IF old_status='queued' AND EXISTS(SELECT 1 FROM __SCHEMA__.app_accessibility_jobs other_job WHERE other_job.id<>NEW.id AND other_job.header->>'status'='running') THEN RAISE EXCEPTION 'Only one accessibility job may run at once' USING ERRCODE='42501'; END IF;
 END IF;
 IF new_status='completed' AND (old_status<>'running' OR NEW.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NEW.header->>'stage' IS DISTINCT FROM 'complete' OR NEW.header->'progress' IS DISTINCT FROM '100'::jsonb OR NOT NEW.header ? 'result' OR NOT __SCHEMA__.app_security_accessibility_creator_can_edit(NEW.header)) THEN RAISE EXCEPTION 'Only an uncancelled authorized worker can complete a result' USING ERRCODE='42501'; END IF;
 IF new_status<>'completed' AND NEW.header ? 'result' THEN RAISE EXCEPTION 'Only completed jobs may reference results' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_accessibility_completion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE j record; a record;
BEGIN
 IF TG_TABLE_NAME='app_accessibility_jobs' THEN SELECT * INTO j FROM __SCHEMA__.app_accessibility_jobs WHERE id=NEW.id;
 ELSE SELECT * INTO j FROM __SCHEMA__.app_accessibility_jobs WHERE id=NEW.header->>'jobId'; END IF;
 IF j.id IS NOT NULL AND j.header->>'status'='completed' THEN
  IF TG_TABLE_NAME='app_accessibility_artifacts' AND j.header->'result'->>'artifactId' IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'A accessibility artifact must be the exact completed job result' USING ERRCODE='42501'; END IF;
  SELECT * INTO a FROM __SCHEMA__.app_accessibility_artifacts WHERE id=j.header->'result'->>'artifactId' AND project_id=j.project_id AND organization_id=j.organization_id AND header->>'jobId'=j.id;
  IF a.id IS NULL OR a.header->'accessibility'->>'captureHash' IS DISTINCT FROM j.header->'result'->>'captureHash' OR a.header->'accessibility'->'capture'->>'resultHash' IS DISTINCT FROM j.header->'result'->>'resultHash' OR a.header->'accessibility'->'capture'->>'inputHash' IS DISTINCT FROM j.header->'result'->>'inputHash' THEN RAISE EXCEPTION 'Completed accessibility job requires its atomically stored authoritative artifact' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='app_accessibility_artifacts' THEN RAISE EXCEPTION 'An artifact cannot survive without its completed job' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_accessibility_project_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE item jsonb; candidate jsonb; project_key text; scenario_key text; candidates jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='app_projects' THEN
  project_key:=NEW.id;
  SELECT coalesce(jsonb_agg(v),'[]') INTO candidates FROM (
    SELECT jsonb_build_object('scenarioId',s->>'id','evidence',e.value) v FROM (
      SELECT jsonb_path_query(NEW.payload,'$.project.scenarios[*]') s
      UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.history[*].before')
      UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.history[*].after')
      UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.undone[*].before')
      UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.undone[*].after')
    ) states CROSS JOIN LATERAL jsonb_each(coalesce(s->'accessibility'->'captures','{}')) e
    UNION ALL SELECT jsonb_build_object('scenarioId',h->'after'->>'id','evidence',h->'command'->'evidence') FROM (
      SELECT jsonb_path_query(NEW.payload,'$.project.history[*]') h
      UNION ALL SELECT jsonb_path_query(NEW.payload,'$.project.undone[*]')
    ) histories WHERE h->'command'->>'type'='scenario.accessibility'
  ) all_captures;
 ELSE
  project_key:=NEW.project_id;
  SELECT coalesce(jsonb_agg(jsonb_build_object('scenarioId',NEW.payload->'scenario'->>'id','evidence',value)),'[]') INTO candidates FROM jsonb_each(coalesce(NEW.payload->'scenario'->'accessibility'->'captures','{}'));
 END IF;
 FOR candidate IN SELECT value FROM jsonb_array_elements(candidates) LOOP
  item:=candidate->'evidence';scenario_key:=candidate->>'scenarioId';
  IF item IS NULL OR item='null'::jsonb THEN CONTINUE; END IF;
  IF item->>'origin' IS NULL OR item->>'origin' NOT IN ('server-run','imported') OR item->'binding'->>'baselineHash' IS DISTINCT FROM NEW.baseline_hash THEN RAISE EXCEPTION 'Accessibility origin and immutable baseline binding are required' USING ERRCODE='42501'; END IF;
  IF item->>'origin'='imported' THEN CONTINUE; END IF;
  IF item->'receipt'->>'projectId' IS DISTINCT FROM project_key OR NOT EXISTS(
    SELECT 1 FROM __SCHEMA__.app_accessibility_artifacts a JOIN __SCHEMA__.app_accessibility_jobs j ON j.id=a.header->>'jobId' AND j.project_id=a.project_id AND j.organization_id=a.organization_id
    WHERE a.project_id=project_key AND a.organization_id=NEW.organization_id AND a.header->>'jobId'=item->'receipt'->>'jobId' AND a.header->'accessibility'=item
      AND j.header->>'status'='completed' AND j.header->'result'->>'artifactId'=a.id AND j.header->'result'->>'captureHash'=item->>'captureHash'
      AND (NOT a.header ? 'scenarioId' OR a.header->>'scenarioId'=j.header->>'scenarioId')
  ) THEN RAISE EXCEPTION 'Saved or published accessibility evidence must match its completed project artifact and original producer metadata' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN NEW;
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
 IF coalesce(kind,'') NOT IN ('gis','workforce','traffic','accessibility') OR coalesce(length(current_slot->>'token'),0)<8 OR coalesce(length(current_slot->>'jobId'),0)=0 OR coalesce(length(current_slot->>'workerId'),0)=0 OR coalesce(current_slot->>'status','') NOT IN ('running','quarantined') OR current_slot->>'acquiredAt' IS NULL OR current_slot->>'heartbeatAt' IS NULL OR current_slot->>'hardDeadlineAt' IS NULL THEN RAISE EXCEPTION 'Invalid native slot identity' USING ERRCODE='23514'; END IF;
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
  table_name:=CASE prior_slot->>'kind' WHEN 'gis' THEN 'app_gis_jobs' WHEN 'workforce' THEN 'app_workforce_jobs' WHEN 'traffic' THEN 'app_traffic_jobs' WHEN 'accessibility' THEN 'app_accessibility_jobs' END;
  EXECUTE format('SELECT header FROM __SCHEMA__.%I WHERE id=$1',table_name) INTO job USING prior_slot->>'jobId';
  IF job->>'status'='running' THEN RAISE EXCEPTION 'Running native work cannot release its slot before terminal job state' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF current_slot->>'status'='quarantined' THEN RETURN NEW; END IF;
 table_name:=CASE current_slot->>'kind' WHEN 'gis' THEN 'app_gis_jobs' WHEN 'workforce' THEN 'app_workforce_jobs' WHEN 'traffic' THEN 'app_traffic_jobs' WHEN 'accessibility' THEN 'app_accessibility_jobs' END;
 EXECUTE format('SELECT header FROM __SCHEMA__.%I WHERE id=$1',table_name) INTO job USING current_slot->>'jobId';
 IF job IS NULL OR job->>'status' IS DISTINCT FROM 'running' OR job->>'capacityToken' IS DISTINCT FROM current_slot->>'token' OR job->>'workerId' IS DISTINCT FROM current_slot->>'workerId' THEN RAISE EXCEPTION 'Shared native slot must bind its exact running job' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_native_job_slot() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE slot jsonb; kind text:=CASE TG_TABLE_NAME WHEN 'app_gis_jobs' THEN 'gis' WHEN 'app_workforce_jobs' THEN 'workforce' WHEN 'app_accessibility_jobs' THEN 'accessibility' ELSE 'traffic' END; current_job jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 -- Read the final row: an atomic short operation may already have completed.
 EXECUTE format('SELECT header FROM __SCHEMA__.%I WHERE id=$1',TG_TABLE_NAME) INTO current_job USING NEW.id;
 IF current_job->>'status' IS DISTINCT FROM 'running' THEN RETURN NEW; END IF;
 SELECT header->'slot' INTO slot FROM __SCHEMA__.app_native_capacity WHERE id='nativeCapacity';
 IF slot IS NULL OR slot='null'::jsonb OR slot->>'status' IS DISTINCT FROM 'running' OR slot->>'kind' IS DISTINCT FROM kind OR slot->>'jobId' IS DISTINCT FROM NEW.id OR slot->>'workerId' IS DISTINCT FROM current_job->>'workerId' OR slot->>'token' IS DISTINCT FROM current_job->>'capacityToken' OR (slot->>'hardDeadlineAt')::timestamptz<=statement_timestamp() THEN RAISE EXCEPTION 'Native work requires its exact active shared capacity token' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=14) THEN 14 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;

DO $install$
DECLARE cfg record; tab text; entity text; fn regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 FOREACH tab IN ARRAY ARRAY['app_accessibility_jobs','app_accessibility_artifacts'] LOOP
  entity:=CASE tab WHEN 'app_accessibility_jobs' THEN 'accessibilityJobs' ELSE 'accessibilityArtifacts' END;
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
  EXECUTE format('DROP TRIGGER IF EXISTS security_accessibility_bind ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE TRIGGER security_accessibility_bind BEFORE INSERT OR UPDATE ON __SCHEMA__.%I FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_accessibility_bind()',tab);
  EXECUTE format('DROP TRIGGER IF EXISTS security_accessibility_completion ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE CONSTRAINT TRIGGER security_accessibility_completion AFTER INSERT OR UPDATE ON __SCHEMA__.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_accessibility_completion()',tab);
 END LOOP;
 DROP POLICY IF EXISTS runtime_update ON __SCHEMA__.app_accessibility_jobs;
 EXECUTE format('CREATE POLICY runtime_update ON __SCHEMA__.app_accessibility_jobs FOR UPDATE TO %I,%I USING(__SCHEMA__.app_security_allow(''accessibilityJobs'',''UPDATE'',id,organization_id,user_id,project_id,snapshot_id,header)) WITH CHECK(__SCHEMA__.app_security_allow(''accessibilityJobs'',''UPDATE'',id,organization_id,user_id,project_id,snapshot_id,header))',cfg.web_role,cfg.worker_role);
 EXECUTE format('GRANT UPDATE ON __SCHEMA__.app_accessibility_jobs TO %I,%I',cfg.web_role,cfg.worker_role);
 -- Worker project authorization sees headers only, never full private scenario/history payloads.
 EXECUTE format('REVOKE SELECT ON __SCHEMA__.app_projects FROM %I',cfg.worker_role);
 EXECUTE format('GRANT SELECT(id,ordinal,organization_id,user_id,project_id,snapshot_id,email,header,baseline_hash,updated_at) ON __SCHEMA__.app_projects TO %I',cfg.worker_role);
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND p.proname LIKE 'app_security_accessibility_%' OR (n.nspname=replace('__SCHEMA__','"','') AND p.proname='app_security_allow_v12') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role);
 END LOOP;
END $install$;
DROP TRIGGER IF EXISTS security_accessibility_capture ON __SCHEMA__.app_projects;
CREATE TRIGGER security_accessibility_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_projects FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_accessibility_project_capture();
DROP TRIGGER IF EXISTS security_accessibility_capture ON __SCHEMA__.app_published;
CREATE TRIGGER security_accessibility_capture BEFORE INSERT OR UPDATE ON __SCHEMA__.app_published FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_accessibility_project_capture();
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(14) ON CONFLICT DO NOTHING;

DROP TRIGGER IF EXISTS security_native_job_slot ON __SCHEMA__.app_accessibility_jobs;
CREATE CONSTRAINT TRIGGER security_native_job_slot AFTER INSERT OR UPDATE ON __SCHEMA__.app_accessibility_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_native_job_slot();
