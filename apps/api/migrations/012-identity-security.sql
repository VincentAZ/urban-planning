-- Verified identity transitions. Only the configured migration LOGIN may bypass these guards.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow_v10(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
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
CREATE TABLE IF NOT EXISTS __SCHEMA__.app_identity_proofs(
 backend_pid integer NOT NULL,transaction_id bigint NOT NULL,kind text NOT NULL,id text NOT NULL,
 user_id text NOT NULL,organization_id text,body jsonb NOT NULL,
 PRIMARY KEY(backend_pid,transaction_id,kind,id));
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_proof(wanted text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT body FROM __SCHEMA__.app_identity_proofs WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND kind=wanted ORDER BY id LIMIT 1
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_session() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT s.header FROM __SCHEMA__.app_sessions s JOIN __SCHEMA__.app_users u ON u.id=s.user_id
 WHERE s.id=nullif(current_setting('urban.session_hash',true),'') AND (s.header->>'expiresAt')::timestamptz>statement_timestamp()
 AND coalesce(s.header->>'credentialVersion','0')=coalesce(u.header->>'credentialVersion','0')
 AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships m WHERE m.user_id=s.user_id AND m.organization_id=s.organization_id)
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_challenge() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT c.header FROM __SCHEMA__.app_identity_challenges c JOIN __SCHEMA__.app_users u ON u.id=c.user_id
 WHERE c.id=nullif(current_setting('urban.identity_challenge_id',true),'') AND c.header->>'tokenHash'=nullif(current_setting('urban.identity_token_hash',true),'')
 AND NOT(c.header ?| ARRAY['consumedAt','revokedAt']) AND (c.header->>'expiresAt')::timestamptz>statement_timestamp()
 AND c.email=u.email AND c.header->>'credentialVersion'=coalesce(u.header->>'credentialVersion','0')
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_owner(wanted text,organization text,project text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE member jsonb; pr record;
BEGIN
 SELECT header INTO member FROM __SCHEMA__.app_memberships WHERE user_id=wanted AND organization_id=organization;
 IF member IS NULL THEN RETURN false; END IF;
 IF project IS NOT NULL THEN
  SELECT header,organization_id INTO pr FROM __SCHEMA__.app_projects WHERE id=project;
  IF pr.organization_id IS DISTINCT FROM organization THEN RETURN false; END IF;
 END IF;
 IF member->>'role'='owner' AND coalesce(member->>'scope','workspace')='workspace' THEN RETURN true; END IF;
 IF project IS NULL THEN RETURN false; END IF;
 RETURN coalesce(pr.header ? 'acl' AND EXISTS(SELECT 1 FROM jsonb_array_elements(pr.header->'acl'->'members') a WHERE a->>'userId'=wanted AND a->>'role'='owner'),false);
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_invitation() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE invitation jsonb; recipient jsonb; session jsonb:=__SCHEMA__.app_security_identity_session();
BEGIN
 IF NOT __SCHEMA__.app_security_mode('auth.invitation-accept') OR session IS NULL THEN RETURN NULL; END IF;
 SELECT header INTO recipient FROM __SCHEMA__.app_users WHERE id=session->>'userId' AND id=current_setting('urban.auth_user_id',true) AND email=current_setting('urban.auth_email',true) AND header ? 'emailVerifiedAt';
 IF recipient IS NULL THEN RETURN NULL; END IF;
 SELECT header INTO invitation FROM __SCHEMA__.app_identity_invitations WHERE id=current_setting('urban.identity_invitation_id',true)
 AND email=recipient->>'email' AND header->>'tokenHash'=current_setting('urban.identity_token_hash',true)
 AND header->>'version'=current_setting('urban.identity_invitation_version',true)
 AND ((header->>'status'='pending' AND (header->>'expiresAt')::timestamptz>statement_timestamp()) OR (header->>'status'='accepted' AND header->>'acceptedBy'=recipient->>'id'));
 IF invitation IS NULL OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=invitation->>'createdBy' AND header ? 'emailVerifiedAt') OR NOT __SCHEMA__.app_security_identity_owner(invitation->>'createdBy',invitation->>'organizationId',invitation->>'projectId') THEN RETURN NULL; END IF;
 RETURN invitation||jsonb_build_object('recipientId',recipient->>'id');
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
 IF __SCHEMA__.app_security_kind()<>'web' AND NOT (__SCHEMA__.app_security_mode('worker.prep') OR __SCHEMA__.app_security_mode('worker.workforce') OR __SCHEMA__.app_security_mode('worker.gis') OR __SCHEMA__.app_security_mode('worker.traffic') OR __SCHEMA__.app_security_mode('auth.password-change') OR __SCHEMA__.app_security_mode('auth.invitation-accept') OR __SCHEMA__.app_security_mode('auth.invitation-manage')) THEN RETURN NULL; END IF;
 s:=__SCHEMA__.app_security_identity_session();
 IF s IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('userId',s->>'userId','organizationId',s->>'organizationId');
END $$;
-- Preserve all prior project-role semantics; an invitation transition may ONLY use its exact ACL operation.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_project_role(project text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE r record; p jsonb:=__SCHEMA__.app_security_principal(); m jsonb; result text; invitation jsonb;
BEGIN
 IF __SCHEMA__.app_security_mode('auth.invitation-accept') THEN
  invitation:=coalesce(__SCHEMA__.app_security_identity_proof('invitation'),__SCHEMA__.app_security_identity_invitation());
  IF invitation->>'status'='pending' AND invitation->>'projectId'=project AND invitation->>'recipientId'=p->>'userId' THEN RETURN 'owner'; END IF;
 END IF;
 SELECT organization_id,header INTO r FROM __SCHEMA__.app_projects WHERE id=project;
 IF r.organization_id IS DISTINCT FROM p->>'organizationId' THEN RETURN NULL; END IF;
 SELECT header INTO m FROM __SCHEMA__.app_memberships WHERE user_id=p->>'userId' AND organization_id=r.organization_id;
 IF m IS NULL THEN RETURN NULL; END IF;
 IF m->>'role'='owner' AND coalesce(m->>'scope','workspace')<>'project-only' THEN RETURN 'owner'; END IF;
 IF r.header ? 'acl' THEN SELECT value->>'role' INTO result FROM jsonb_array_elements(r.header->'acl'->'members') WHERE value->>'userId'=p->>'userId'; RETURN result; END IF;
 IF coalesce(m->>'scope','workspace')<>'project-only' THEN RETURN m->>'role'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
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
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_credential_authorized() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT (__SCHEMA__.app_security_mode('auth.password-change') AND __SCHEMA__.app_security_identity_session()->>'userId'=current_setting('urban.auth_user_id',true)
 AND EXISTS(SELECT 1 FROM __SCHEMA__.app_users u JOIN __SCHEMA__.app_user_credentials c ON c.user_id=u.id WHERE u.id=current_setting('urban.auth_user_id',true) AND u.email=current_setting('urban.auth_email',true) AND coalesce(u.header->>'credentialVersion','0')=current_setting('urban.auth_credential_version',true) AND c.password_hash=nullif(current_setting('urban.identity_password_hash',true),'')))
 OR (__SCHEMA__.app_security_mode('auth.challenge-consume') AND coalesce(__SCHEMA__.app_security_identity_proof('challenge'),__SCHEMA__.app_security_identity_challenge())->>'purpose'='password-reset')
 OR (__SCHEMA__.app_security_identity_proof('credential') IS NOT NULL)
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE entity text:=TG_ARGV[0]; body jsonb:=NEW.header; old_body jsonb; uid text:=__SCHEMA__.app_security_principal()->>'userId'; ch jsonb; inv jsonb; user_body jsonb; proof jsonb; next_version bigint; member jsonb; original jsonb; item jsonb; allowed boolean; stamp text;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN old_body:=OLD.header; END IF;
 IF entity IN ('identityChallenges','identityInvitations','identityOutbox') THEN
  IF body->>'id' IS DISTINCT FROM NEW.id OR NEW.user_id IS DISTINCT FROM body->>'userId' OR NEW.organization_id IS DISTINCT FROM body->>'organizationId' OR NEW.project_id IS DISTINCT FROM body->>'projectId' OR NEW.email IS DISTINCT FROM body->>'email' OR NEW.snapshot_id IS NOT NULL OR NEW.baseline_hash IS NOT NULL THEN RAISE EXCEPTION 'Identity record indexes must exactly match' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.email IS DISTINCT FROM OLD.email) THEN RAISE EXCEPTION 'Identity record identity is immutable' USING ERRCODE='42501'; END IF;
 END IF;
 IF entity='identityChallenges' THEN
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(body) k WHERE NOT k=ANY(ARRAY['id','userId','email','purpose','credentialVersion','tokenHash','createdAt','expiresAt','consumedAt','revokedAt'])) OR jsonb_typeof(body->'createdAt') IS DISTINCT FROM 'string' OR jsonb_typeof(body->'expiresAt') IS DISTINCT FROM 'string' OR (body ? 'consumedAt' AND jsonb_typeof(body->'consumedAt') IS DISTINCT FROM 'string') OR (body ? 'revokedAt' AND jsonb_typeof(body->'revokedAt') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'Challenge metadata must retain only bounded declared fields' USING ERRCODE='23514'; END IF;
  IF (NEW.payload IS NOT NULL AND NEW.payload IS DISTINCT FROM 'null'::jsonb) OR coalesce(body->>'purpose','') NOT IN ('verify-email','password-reset') OR coalesce(body->>'tokenHash','') !~ '^[a-f0-9]{64}$' OR coalesce(body->>'credentialVersion','') !~ '^(0|[1-9][0-9]{0,8})$' THEN RAISE EXCEPTION 'Invalid identity challenge' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
   SELECT header INTO user_body FROM __SCHEMA__.app_users WHERE id=NEW.user_id AND email=NEW.email;
   IF NOT __SCHEMA__.app_security_mode('auth.challenge-issue') OR NEW.id IS DISTINCT FROM current_setting('urban.identity_challenge_id',true) OR NEW.user_id IS DISTINCT FROM uid OR user_body IS NULL OR body->>'credentialVersion' IS DISTINCT FROM coalesce(user_body->>'credentialVersion','0') OR body ?| ARRAY['consumedAt','revokedAt'] OR (body->>'expiresAt')::timestamptz<=statement_timestamp() OR (body->>'expiresAt')::timestamptz>(body->>'createdAt')::timestamptz+interval '24 hours' THEN RAISE EXCEPTION 'Challenge issuance is not authorized' USING ERRCODE='42501'; END IF;
   IF body->>'purpose'='verify-email' AND (__SCHEMA__.app_security_identity_session()->>'userId' IS DISTINCT FROM uid OR user_body ? 'emailVerifiedAt') THEN RAISE EXCEPTION 'Verification requires the matching unverified session' USING ERRCODE='42501'; END IF;
  ELSE
   IF body-'consumedAt'-'revokedAt' IS DISTINCT FROM old_body-'consumedAt'-'revokedAt' OR old_body ?| ARRAY['consumedAt','revokedAt'] THEN RAISE EXCEPTION 'A challenge is immutable and single use' USING ERRCODE='42501'; END IF;
   IF body ? 'consumedAt' THEN
    ch:=__SCHEMA__.app_security_identity_challenge();
    IF NOT __SCHEMA__.app_security_mode('auth.challenge-consume') OR ch->>'id' IS DISTINCT FROM NEW.id OR body ? 'revokedAt' OR ch->>'userId' IS DISTINCT FROM uid OR (ch->>'purpose'='verify-email' AND __SCHEMA__.app_security_identity_session()->>'userId' IS DISTINCT FROM uid) THEN RAISE EXCEPTION 'Challenge consumption requires its active token and recipient' USING ERRCODE='42501'; END IF;
    proof:=ch||jsonb_build_object('organizationId',__SCHEMA__.app_security_principal()->>'organizationId','consumedAt',body->>'consumedAt');
    INSERT INTO __SCHEMA__.app_identity_proofs VALUES(pg_backend_pid(),txid_current(),'challenge',NEW.id,uid,proof->>'organizationId',proof);
   ELSIF body ? 'revokedAt' THEN
    IF NOT ((__SCHEMA__.app_security_mode('auth.challenge-issue') AND NEW.user_id=uid) OR (__SCHEMA__.app_security_identity_credential_authorized() AND NEW.user_id=uid)) THEN RAISE EXCEPTION 'Challenge revocation requires its account transition' USING ERRCODE='42501'; END IF;
   ELSE RAISE EXCEPTION 'Challenge update requires a terminal state' USING ERRCODE='42501'; END IF;
  END IF;
 ELSIF entity='users' THEN
  IF body ? 'emailVerifiedAt' AND (jsonb_typeof(body->'emailVerifiedAt') IS DISTINCT FROM 'string' OR NOT isfinite((body->>'emailVerifiedAt')::timestamptz)) THEN RAISE EXCEPTION 'Verification timestamp must be finite' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
   IF body ? 'emailVerifiedAt' OR coalesce(body->>'credentialVersion','0')<>'0' THEN RAISE EXCEPTION 'New accounts start unverified at generation zero' USING ERRCODE='42501'; END IF;
  ELSE
   IF body-'passwordHash'-'credentialVersion'-'emailVerifiedAt' IS DISTINCT FROM old_body-'credentialVersion'-'emailVerifiedAt' OR NEW.email IS DISTINCT FROM OLD.email THEN RAISE EXCEPTION 'Identity transition cannot rewrite the account profile' USING ERRCODE='42501'; END IF;
   ch:=__SCHEMA__.app_security_identity_proof('challenge');
   IF body ? 'passwordHash' THEN
    IF NOT coalesce(__SCHEMA__.app_security_identity_credential_authorized(),false) OR NEW.id IS DISTINCT FROM uid OR coalesce(body->>'passwordHash','') !~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$' OR coalesce(body->>'credentialVersion','') !~ '^[1-9][0-9]{0,8}$' OR (body->>'credentialVersion')::bigint<>coalesce((old_body->>'credentialVersion')::bigint,0)+1 THEN RAISE EXCEPTION 'Password replacement requires current proof and next generation' USING ERRCODE='42501'; END IF;
    IF (old_body ? 'emailVerifiedAt' AND body->'emailVerifiedAt' IS DISTINCT FROM old_body->'emailVerifiedAt') OR (NOT old_body ? 'emailVerifiedAt' AND body ? 'emailVerifiedAt' AND ch->>'purpose' IS DISTINCT FROM 'password-reset') THEN RAISE EXCEPTION 'Credential changes cannot fabricate email verification' USING ERRCODE='42501'; END IF;
    INSERT INTO __SCHEMA__.app_user_credentials VALUES(NEW.id,body->>'passwordHash') ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash;
    proof:=jsonb_build_object('userId',NEW.id,'organizationId',__SCHEMA__.app_security_principal()->>'organizationId','credentialVersion',body->'credentialVersion');
    INSERT INTO __SCHEMA__.app_identity_proofs VALUES(pg_backend_pid(),txid_current(),'credential',NEW.id,NEW.id,proof->>'organizationId',proof);
    NEW.header:=body-'passwordHash';
   ELSE
    IF NOT __SCHEMA__.app_security_mode('auth.challenge-consume') OR ch->>'userId' IS DISTINCT FROM NEW.id OR ch->>'purpose' IS DISTINCT FROM 'verify-email' OR body->'credentialVersion' IS DISTINCT FROM old_body->'credentialVersion' OR body->>'emailVerifiedAt' IS DISTINCT FROM coalesce(old_body->>'emailVerifiedAt',ch->>'consumedAt') THEN RAISE EXCEPTION 'Verification requires an exactly consumed verification challenge' USING ERRCODE='42501'; END IF;
   END IF;
  END IF;
 ELSIF entity='sessions' THEN
  SELECT header INTO user_body FROM __SCHEMA__.app_users WHERE id=NEW.user_id;
  IF coalesce(body->>'credentialVersion','0') IS DISTINCT FROM coalesce(user_body->>'credentialVersion','0') THEN RAISE EXCEPTION 'Session credential generation is stale' USING ERRCODE='42501'; END IF;
 ELSIF entity='identityInvitations' THEN
  IF (NEW.payload IS NOT NULL AND NEW.payload IS DISTINCT FROM 'null'::jsonb) OR coalesce(body->>'scope','') NOT IN ('project','workspace') OR (body->>'scope'='project') IS DISTINCT FROM (NEW.project_id IS NOT NULL) OR coalesce(body->>'role','') NOT IN ('owner','editor','commenter','viewer') OR coalesce(body->>'version','') !~ '^[1-9][0-9]{0,8}$' OR coalesce(body->>'tokenHash','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid invitation' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
   IF NOT __SCHEMA__.app_security_mode('auth.invitation-manage') OR body->>'createdBy' IS DISTINCT FROM uid OR body->>'status' IS DISTINCT FROM 'pending' OR body->'version' IS DISTINCT FROM '1'::jsonb OR body ?| ARRAY['acceptedBy','acceptedAt','revokedBy','revokedAt'] OR NOT __SCHEMA__.app_security_identity_owner(uid,NEW.organization_id,NEW.project_id) OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=uid AND header ? 'emailVerifiedAt') THEN RAISE EXCEPTION 'Invitations require a verified current owner' USING ERRCODE='42501'; END IF;
  ELSE
   IF body-'status'-'version'-'tokenHash'-'expiresAt'-'acceptedBy'-'acceptedAt'-'revokedBy'-'revokedAt' IS DISTINCT FROM old_body-'status'-'version'-'tokenHash'-'expiresAt'-'acceptedBy'-'acceptedAt'-'revokedBy'-'revokedAt' OR old_body->>'status'<>'pending' OR (body->>'version')::bigint<>(old_body->>'version')::bigint+1 THEN RAISE EXCEPTION 'Invitation origin and terminal states are immutable' USING ERRCODE='42501'; END IF;
   IF body->>'status'='accepted' THEN
    inv:=__SCHEMA__.app_security_identity_invitation();
    IF inv->>'status' IS DISTINCT FROM 'pending' OR inv->>'id' IS DISTINCT FROM NEW.id OR body->>'acceptedBy' IS DISTINCT FROM uid OR NOT body ? 'acceptedAt' OR body ?| ARRAY['revokedBy','revokedAt'] OR body->'tokenHash' IS DISTINCT FROM old_body->'tokenHash' OR body->'expiresAt' IS DISTINCT FROM old_body->'expiresAt' THEN RAISE EXCEPTION 'Invitation acceptance requires its active token and verified recipient' USING ERRCODE='42501'; END IF;
    INSERT INTO __SCHEMA__.app_identity_proofs VALUES(pg_backend_pid(),txid_current(),'invitation',NEW.id,uid,NEW.organization_id,inv);
   ELSIF body->>'status' IN ('pending','revoked') THEN
    IF NOT __SCHEMA__.app_security_mode('auth.invitation-manage') OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=uid AND jsonb_typeof(header->'emailVerifiedAt')='string') OR NOT __SCHEMA__.app_security_identity_owner(uid,NEW.organization_id,NEW.project_id) OR body ?| ARRAY['acceptedBy','acceptedAt'] THEN RAISE EXCEPTION 'Invitation management requires its current owner' USING ERRCODE='42501'; END IF;
    IF body->>'status'='revoked' AND (body->>'revokedBy' IS DISTINCT FROM uid OR NOT body ? 'revokedAt') THEN RAISE EXCEPTION 'Invitation revocation actor required' USING ERRCODE='42501'; END IF;
   ELSE RAISE EXCEPTION 'Unknown invitation transition' USING ERRCODE='42501'; END IF;
  END IF;
 ELSIF entity='memberships' THEN
  IF TG_OP='UPDATE' AND old_body->>'scope'='project-only' AND coalesce(body->>'scope','workspace')<>'project-only' AND NOT __SCHEMA__.app_security_mode('auth.invitation-accept') THEN RAISE EXCEPTION 'Workspace expansion requires accepted workspace invitation' USING ERRCODE='42501'; END IF;
  inv:=coalesce(__SCHEMA__.app_security_identity_proof('invitation'),__SCHEMA__.app_security_identity_invitation());
  IF __SCHEMA__.app_security_mode('auth.invitation-accept') THEN
   IF inv->>'status' IS DISTINCT FROM 'pending' OR inv->>'organizationId' IS DISTINCT FROM NEW.organization_id OR inv->>'recipientId' IS DISTINCT FROM NEW.user_id THEN RAISE EXCEPTION 'Membership must bind the accepted recipient and workspace' USING ERRCODE='42501'; END IF;
   IF inv->>'scope'='project' THEN
    IF TG_OP='INSERT' AND (body->>'scope' IS DISTINCT FROM 'project-only' OR body->>'role' IS DISTINCT FROM 'viewer') THEN RAISE EXCEPTION 'Project invitation cannot grant workspace-wide access' USING ERRCODE='42501'; END IF;
    IF TG_OP='UPDATE' AND body IS DISTINCT FROM old_body THEN RAISE EXCEPTION 'Project invitation preserves existing workspace membership' USING ERRCODE='42501'; END IF;
   ELSIF body->>'role' IS DISTINCT FROM inv->>'role' OR coalesce(body->>'scope','workspace')<>'workspace' THEN RAISE EXCEPTION 'Workspace membership must match invitation role' USING ERRCODE='42501'; END IF;
  ELSIF TG_OP='INSERT' AND NOT __SCHEMA__.app_security_mode('auth.register') THEN RAISE EXCEPTION 'New membership requires accepted invitation' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND old_body->>'role'='owner' AND coalesce(old_body->>'scope','workspace')='workspace' AND (body->>'role'<>'owner' OR coalesce(body->>'scope','workspace')<>'workspace') AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE organization_id=OLD.organization_id AND id<>OLD.id AND header->>'role'='owner' AND coalesce(header->>'scope','workspace')='workspace') THEN RAISE EXCEPTION 'Last workspace owner cannot be removed' USING ERRCODE='42501'; END IF;
 ELSIF entity='projects' THEN
  IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(body->'acl'->'members','[]')) m WHERE m->>'userId' IS DISTINCT FROM uid OR m->>'role' IS DISTINCT FROM 'owner') THEN RAISE EXCEPTION 'New projects cannot bypass invitation acceptance' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND body->'acl' IS DISTINCT FROM old_body->'acl' THEN
   inv:=coalesce(__SCHEMA__.app_security_identity_proof('invitation'),__SCHEMA__.app_security_identity_invitation());
   FOR item IN SELECT value FROM jsonb_array_elements(coalesce(body->'acl'->'members','[]')) LOOP
    SELECT value INTO original FROM jsonb_array_elements(coalesce(old_body->'acl'->'members','[]')) WHERE value->>'userId'=item->>'userId';
    IF original IS NULL THEN
     allowed:=inv->>'projectId'=NEW.id AND inv->>'recipientId'=item->>'userId' AND inv->>'role'=item->>'role';
     IF NOT old_body ? 'acl' THEN
      SELECT header INTO member FROM __SCHEMA__.app_memberships WHERE organization_id=NEW.organization_id AND user_id=item->>'userId' AND coalesce(header->>'scope','workspace')='workspace';
      allowed:=coalesce(allowed,false) OR (member IS NOT NULL AND member->>'role'=item->>'role');
     END IF;
     IF NOT coalesce(allowed,false) THEN RAISE EXCEPTION 'New project grant requires accepted invitation' USING ERRCODE='42501'; END IF;
    END IF;
   END LOOP;
   IF __SCHEMA__.app_security_mode('auth.invitation-accept') THEN
    IF NEW.payload IS DISTINCT FROM OLD.payload OR body-'acl' IS DISTINCT FROM old_body-'acl' OR (SELECT coalesce(jsonb_agg(value ORDER BY value->>'userId'),'[]') FROM jsonb_array_elements(body->'acl'->'members') WHERE value->>'userId'<>inv->>'recipientId') IS DISTINCT FROM (SELECT coalesce(jsonb_agg(value ORDER BY value->>'userId'),'[]') FROM jsonb_array_elements(coalesce(old_body->'acl'->'members',(SELECT coalesce(jsonb_agg(jsonb_build_object('userId',m.user_id,'role',m.header->>'role','addedAt',old_body->>'createdAt','addedBy',old_body->>'createdBy')),'[]') FROM __SCHEMA__.app_memberships m WHERE m.organization_id=NEW.organization_id AND coalesce(m.header->>'scope','workspace')='workspace'))) WHERE value->>'userId'<>inv->>'recipientId') THEN RAISE EXCEPTION 'Invitation may only patch its recipient grant' USING ERRCODE='42501'; END IF;
   END IF;
  ELSIF __SCHEMA__.app_security_mode('auth.invitation-accept') THEN RAISE EXCEPTION 'Invitation cannot modify project content' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_outbox_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE b jsonb:=NEW.header; before jsonb; reference jsonb; uid text:=__SCHEMA__.app_security_principal()->>'userId'; immutable text[]:=ARRAY['status','attempts','nextAttemptAt','leaseToken','leaseExpiresAt','sentAt','lastFailure','costReservationId'];
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(b) k WHERE NOT k=ANY(ARRAY['id','kind','userId','organizationId','challengeId','invitationId','invitationVersion','recipientKey','createdAt','expiresAt','status','attempts','nextAttemptAt','leaseToken','leaseExpiresAt','sentAt','lastFailure','costReservationId'])) OR coalesce(b->>'attempts','') !~ '^[0-3]$' OR coalesce(b->>'status','') NOT IN ('pending','sending','sent','failed','cancelled') OR jsonb_typeof(b->'createdAt') IS DISTINCT FROM 'string' OR jsonb_typeof(b->'expiresAt') IS DISTINCT FROM 'string' OR jsonb_typeof(b->'nextAttemptAt') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Mail metadata must retain only bounded declared fields' USING ERRCODE='23514'; END IF;
 IF b->>'status'='sending' AND (jsonb_typeof(b->'leaseExpiresAt') IS DISTINCT FROM 'string' OR jsonb_typeof(b->'leaseToken') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'Sending mail requires a live lease' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NOT (__SCHEMA__.app_security_mode('auth.challenge-issue') OR __SCHEMA__.app_security_mode('auth.challenge-consume') OR __SCHEMA__.app_security_mode('auth.password-change') OR __SCHEMA__.app_security_mode('auth.invitation-manage')) OR b->>'status' IS DISTINCT FROM 'pending' OR b->'attempts' IS DISTINCT FROM '0'::jsonb OR b ?| ARRAY['leaseToken','leaseExpiresAt','sentAt','lastFailure','costReservationId'] OR NEW.payload->'sealed'->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(NEW.payload->'sealed'->'ciphertext') IS DISTINCT FROM 'string' OR length(NEW.payload->'sealed'->>'ciphertext')>180000 OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload))<>1 THEN RAISE EXCEPTION 'Only bounded sealed pending mail may be queued' USING ERRCODE='42501'; END IF;
  IF b->>'kind' IN ('verify-email','password-reset') THEN
   SELECT header INTO reference FROM __SCHEMA__.app_identity_challenges WHERE id=b->>'challengeId';
   IF reference->>'userId' IS DISTINCT FROM uid OR b->>'userId' IS DISTINCT FROM uid OR reference->>'purpose' IS DISTINCT FROM b->>'kind' OR b->'expiresAt' IS DISTINCT FROM reference->'expiresAt' OR reference ?| ARRAY['consumedAt','revokedAt'] OR b ? 'invitationId' THEN RAISE EXCEPTION 'Mail must bind its active challenge' USING ERRCODE='42501'; END IF;
  ELSIF b->>'kind'='invitation' THEN
   SELECT header INTO reference FROM __SCHEMA__.app_identity_invitations WHERE id=b->>'invitationId';
   IF reference->>'status' IS DISTINCT FROM 'pending' OR reference->>'organizationId' IS DISTINCT FROM NEW.organization_id OR reference->'version' IS DISTINCT FROM b->'invitationVersion' OR b->'expiresAt' IS DISTINCT FROM reference->'expiresAt' OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=uid AND jsonb_typeof(header->'emailVerifiedAt')='string') OR NOT __SCHEMA__.app_security_identity_owner(uid,reference->>'organizationId',reference->>'projectId') OR b ? 'challengeId' THEN RAISE EXCEPTION 'Mail must bind its current invitation version' USING ERRCODE='42501'; END IF;
  ELSIF b->>'kind'='password-changed' THEN
   IF NOT coalesce(__SCHEMA__.app_security_identity_credential_authorized(),false) OR b->>'userId' IS DISTINCT FROM uid OR b ?| ARRAY['challengeId','invitationId'] THEN RAISE EXCEPTION 'Credential notice requires its actual account transition' USING ERRCODE='42501'; END IF;
  ELSE RAISE EXCEPTION 'Unknown identity mail kind' USING ERRCODE='42501'; END IF;
 ELSE
  before:=OLD.header;
  IF NOT __SCHEMA__.app_security_mode('worker.identity-mail') OR NEW.payload IS DISTINCT FROM OLD.payload OR b-immutable IS DISTINCT FROM before-immutable OR before->>'status' IN ('sent','failed','cancelled') THEN RAISE EXCEPTION 'Sealed mail content and terminal records are immutable' USING ERRCODE='42501'; END IF;
  IF b->>'status'='sending' AND before->>'status'='sending' AND b->'leaseToken'=before->'leaseToken' THEN
   IF OLD.id IS DISTINCT FROM nullif(current_setting('urban.identity_outbox_id',true),'') OR before->>'leaseToken' IS DISTINCT FROM nullif(current_setting('urban.identity_lease_token',true),'') OR (before->>'leaseExpiresAt')::timestamptz<=statement_timestamp() OR b->'attempts' IS DISTINCT FROM before->'attempts' OR (b-'leaseExpiresAt'-'costReservationId') IS DISTINCT FROM (before-'leaseExpiresAt'-'costReservationId') THEN RAISE EXCEPTION 'Mail lease metadata requires its exact current claim' USING ERRCODE='42501'; END IF;
  ELSIF b->>'status'='sending' THEN
   IF before->>'status' NOT IN ('pending','sending') OR (before->>'status'='sending' AND (before->>'leaseExpiresAt')::timestamptz>statement_timestamp()) OR (b->>'attempts')::integer<>(before->>'attempts')::integer+1 OR (b->>'attempts')::integer>3 OR coalesce(b->>'leaseToken','')='' OR b->>'leaseToken'=before->>'leaseToken' OR (b->>'leaseExpiresAt')::timestamptz<=statement_timestamp() OR (b->>'leaseExpiresAt')::timestamptz>statement_timestamp()+interval '10 minutes' OR (b->>'expiresAt')::timestamptz<=statement_timestamp() THEN RAISE EXCEPTION 'Mail claim requires a fresh bounded lease and attempt' USING ERRCODE='42501'; END IF;
  ELSIF before->>'status'='sending' AND b->>'status'='cancelled' AND (before->>'leaseExpiresAt')::timestamptz<=statement_timestamp() THEN
   IF b->'attempts' IS DISTINCT FROM before->'attempts' OR b->>'lastFailure' NOT IN ('expired','cancelled') THEN RAISE EXCEPTION 'Expired mail claims may only be cancelled without payload' USING ERRCODE='42501'; END IF;
  ELSIF before->>'status'='sending' THEN
   IF OLD.id IS DISTINCT FROM nullif(current_setting('urban.identity_outbox_id',true),'') OR before->>'leaseToken' IS DISTINCT FROM nullif(current_setting('urban.identity_lease_token',true),'') OR (before->>'leaseExpiresAt')::timestamptz<=statement_timestamp() OR b->'attempts' IS DISTINCT FROM before->'attempts' OR b->>'status' NOT IN ('pending','sent','failed','cancelled') THEN RAISE EXCEPTION 'Mail acknowledgement requires the current live lease' USING ERRCODE='42501'; END IF;
  ELSIF b->>'status'<>'cancelled' OR b->'attempts' IS DISTINCT FROM before->'attempts' THEN RAISE EXCEPTION 'Unclaimed mail may only be cancelled' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_OP='UPDATE' THEN
  INSERT INTO __SCHEMA__.app_identity_proofs VALUES(pg_backend_pid(),txid_current(),'mail-transition',NEW.id,coalesce(NEW.user_id,'identity-mail-worker'),NEW.organization_id,jsonb_build_object('before',OLD.header,'after',NEW.header)) ON CONFLICT(backend_pid,transaction_id,kind,id) DO UPDATE SET body=EXCLUDED.body;
  INSERT INTO __SCHEMA__.app_identity_proofs VALUES(pg_backend_pid(),txid_current(),'mail',NEW.id,coalesce(NEW.user_id,'identity-mail-worker'),NEW.organization_id,CASE WHEN b->>'status'='sending' THEN b ELSE OLD.header END) ON CONFLICT(backend_pid,transaction_id,kind,id) DO UPDATE SET body=EXCLUDED.body;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_outbox_payload(wanted text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN (SELECT payload FROM __SCHEMA__.app_identity_outbox WHERE id=wanted); END IF;
 IF NOT __SCHEMA__.app_security_mode('worker.identity-mail') OR wanted IS DISTINCT FROM nullif(current_setting('urban.identity_outbox_id',true),'') THEN RAISE EXCEPTION 'Sealed mail requires an exact worker claim' USING ERRCODE='42501'; END IF;
 SELECT payload INTO result FROM __SCHEMA__.app_identity_outbox WHERE id=wanted AND header->>'status'='sending' AND header->>'leaseToken'=nullif(current_setting('urban.identity_lease_token',true),'') AND (header->>'leaseExpiresAt')::timestamptz>statement_timestamp();
 IF result IS NULL THEN RAISE EXCEPTION 'Sealed mail lease is absent or stale' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE proof jsonb; u jsonb; inv jsonb; member jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='app_users' THEN
  proof:=__SCHEMA__.app_security_identity_proof('credential');
  IF proof IS NOT NULL AND proof->>'userId'=NEW.id THEN
   IF __SCHEMA__.app_security_mode('auth.challenge-consume') AND __SCHEMA__.app_security_identity_proof('challenge')->>'purpose' IS DISTINCT FROM 'password-reset' THEN RAISE EXCEPTION 'Reset must consume its challenge in the same transaction' USING ERRCODE='42501'; END IF;
   IF EXISTS(SELECT 1 FROM __SCHEMA__.app_sessions WHERE user_id=NEW.id) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_identity_challenges WHERE user_id=NEW.id AND NOT(header ?| ARRAY['consumedAt','revokedAt'])) THEN RAISE EXCEPTION 'Credential replacement must revoke every session and challenge atomically' USING ERRCODE='42501'; END IF;
  END IF;
 ELSIF TG_TABLE_NAME IN ('app_memberships','app_projects') AND __SCHEMA__.app_security_mode('auth.invitation-accept') THEN
  proof:=__SCHEMA__.app_security_identity_proof('invitation');
  IF proof IS NULL OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_identity_invitations WHERE id=proof->>'id' AND header->>'status'='accepted' AND header->>'acceptedBy'=proof->>'recipientId') THEN RAISE EXCEPTION 'Invitation grant must consume its exact pending invitation atomically' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='app_identity_challenges' AND NEW.header ? 'consumedAt' AND NOT OLD.header ? 'consumedAt' THEN
  SELECT header INTO u FROM __SCHEMA__.app_users WHERE id=NEW.user_id;
  IF NOT u ? 'emailVerifiedAt' OR (NEW.header->>'purpose'='password-reset' AND coalesce((u->>'credentialVersion')::bigint,0)<>(NEW.header->>'credentialVersion')::bigint+1) THEN RAISE EXCEPTION 'Consumed challenge requires its matching account update' USING ERRCODE='42501'; END IF;
 ELSIF TG_TABLE_NAME='app_identity_invitations' AND NEW.header->>'status'='accepted' THEN
  inv:=NEW.header;
  SELECT header INTO member FROM __SCHEMA__.app_memberships WHERE organization_id=NEW.organization_id AND user_id=inv->>'acceptedBy';
  IF member IS NULL OR (inv->>'scope'='workspace' AND (member->>'role' IS DISTINCT FROM inv->>'role' OR coalesce(member->>'scope','workspace')<>'workspace')) OR (inv->>'scope'='project' AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_projects p,jsonb_array_elements(p.header->'acl'->'members') m WHERE p.id=NEW.project_id AND m->>'userId'=inv->>'acceptedBy' AND m->>'role'=inv->>'role')) THEN RAISE EXCEPTION 'Accepted invitation must grant its exact recipient scope atomically' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_delete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN OLD; END IF;
 IF TG_TABLE_NAME='app_memberships' AND OLD.header->>'role'='owner' AND coalesce(OLD.header->>'scope','workspace')='workspace' AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE organization_id=OLD.organization_id AND id<>OLD.id AND header->>'role'='owner' AND coalesce(header->>'scope','workspace')='workspace') THEN RAISE EXCEPTION 'Last workspace owner cannot be removed' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME LIKE 'app_identity_%' THEN RAISE EXCEPTION 'Identity history is retained' USING ERRCODE='42501'; END IF;
 RETURN OLD;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=12) THEN 12 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
DO $install$
DECLARE cfg record; pair text[]; tab text; entity text; op text; fn regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 FOR pair IN SELECT ARRAY[a,b] FROM (VALUES ('identityChallenges','app_identity_challenges'),('identityInvitations','app_identity_invitations'),('identityOutbox','app_identity_outbox')) v(a,b) LOOP
  entity:=pair[1];tab:=pair[2];
  EXECUTE format('ALTER TABLE __SCHEMA__.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE __SCHEMA__.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('REVOKE ALL ON __SCHEMA__.%I FROM PUBLIC,%I,%I,%I',tab,cfg.web_role,cfg.auth_role,cfg.worker_role);
  EXECUTE format('DROP POLICY IF EXISTS operator_access ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE POLICY operator_access ON __SCHEMA__.%I TO %I USING(true) WITH CHECK(true)',tab,cfg.migration_role);
  FOREACH op IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
   EXECUTE format('DROP POLICY IF EXISTS %I ON __SCHEMA__.%I','runtime_'||lower(op),tab);
   IF op='INSERT' THEN EXECUTE format('CREATE POLICY runtime_insert ON __SCHEMA__.%I FOR INSERT TO %I,%I,%I WITH CHECK(__SCHEMA__.app_security_allow(%L,%L,id,organization_id,user_id,project_id,snapshot_id,header))',tab,cfg.web_role,cfg.auth_role,cfg.worker_role,entity,op);
   ELSIF op='UPDATE' THEN EXECUTE format('CREATE POLICY runtime_update ON __SCHEMA__.%I FOR UPDATE TO %I,%I,%I USING(__SCHEMA__.app_security_allow(%L,%L,id,organization_id,user_id,project_id,snapshot_id,header)) WITH CHECK(__SCHEMA__.app_security_kind() IN (''web'',''auth'',''worker''))',tab,cfg.web_role,cfg.auth_role,cfg.worker_role,entity,op);
   ELSE EXECUTE format('CREATE POLICY %I ON __SCHEMA__.%I FOR %s TO %I,%I,%I USING(__SCHEMA__.app_security_allow(%L,%L,id,organization_id,user_id,project_id,snapshot_id,header))','runtime_'||lower(op),tab,op,cfg.web_role,cfg.auth_role,cfg.worker_role,entity,op); END IF;
  END LOOP;
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON __SCHEMA__.%I TO %I,%I,%I',tab,cfg.web_role,cfg.auth_role,cfg.worker_role);
  EXECUTE format('DROP TRIGGER IF EXISTS identity_bind ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE TRIGGER identity_bind BEFORE INSERT OR UPDATE ON __SCHEMA__.%I FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_identity_write(%L)',tab,entity);
  EXECUTE format('DROP TRIGGER IF EXISTS identity_no_delete ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE TRIGGER identity_no_delete BEFORE DELETE ON __SCHEMA__.%I FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_identity_delete()',tab);
 END LOOP;
 FOREACH pair SLICE 1 IN ARRAY ARRAY[ARRAY['users','app_users'],ARRAY['sessions','app_sessions'],ARRAY['memberships','app_memberships'],ARRAY['projects','app_projects']] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS a_identity_bind ON __SCHEMA__.%I',pair[2]);
  EXECUTE format('CREATE TRIGGER a_identity_bind BEFORE INSERT OR UPDATE ON __SCHEMA__.%I FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_identity_write(%L)',pair[2],pair[1]);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['app_users','app_identity_challenges','app_identity_invitations','app_memberships','app_projects'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS identity_complete ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE CONSTRAINT TRIGGER identity_complete AFTER INSERT OR UPDATE ON __SCHEMA__.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_identity_complete()',tab);
 END LOOP;
 DROP TRIGGER IF EXISTS identity_membership_delete ON __SCHEMA__.app_memberships;
 CREATE TRIGGER identity_membership_delete BEFORE DELETE ON __SCHEMA__.app_memberships FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_identity_delete();
 DROP TRIGGER IF EXISTS identity_outbox_write ON __SCHEMA__.app_identity_outbox;
 CREATE TRIGGER identity_outbox_write BEFORE INSERT OR UPDATE ON __SCHEMA__.app_identity_outbox FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_identity_outbox_write();
 ALTER TABLE __SCHEMA__.app_identity_proofs ENABLE ROW LEVEL SECURITY;
 ALTER TABLE __SCHEMA__.app_identity_proofs FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON __SCHEMA__.app_identity_proofs FROM PUBLIC;
 EXECUTE format('REVOKE ALL ON __SCHEMA__.app_identity_proofs FROM %I,%I,%I',cfg.web_role,cfg.auth_role,cfg.worker_role);
 DROP POLICY IF EXISTS operator_access ON __SCHEMA__.app_identity_proofs;
 EXECUTE format('CREATE POLICY operator_access ON __SCHEMA__.app_identity_proofs TO %I USING(true) WITH CHECK(true)',cfg.migration_role);
 EXECUTE format('REVOKE SELECT ON __SCHEMA__.app_identity_outbox FROM %I,%I,%I',cfg.web_role,cfg.auth_role,cfg.worker_role);
 EXECUTE format('GRANT SELECT(id,ordinal,organization_id,user_id,project_id,snapshot_id,email,header,baseline_hash,updated_at) ON __SCHEMA__.app_identity_outbox TO %I,%I',cfg.auth_role,cfg.worker_role);
 EXECUTE format('REVOKE SELECT ON __SCHEMA__.app_projects FROM %I',cfg.auth_role);
 EXECUTE format('GRANT SELECT(id,ordinal,organization_id,user_id,project_id,snapshot_id,email,header,baseline_hash,updated_at) ON __SCHEMA__.app_projects TO %I',cfg.auth_role);
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND (p.proname LIKE 'app_security_identity_%' OR p.proname='app_security_allow_v10') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role);
 END LOOP;
 EXECUTE format('GRANT EXECUTE ON FUNCTION __SCHEMA__.app_security_identity_outbox_payload(text) TO %I',cfg.worker_role);
END $install$;
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(12) ON CONFLICT DO NOTHING;
-- Identity mail can reserve/start/cancel only its own dispatch holds. It cannot settle estimates as actual costs.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_identity_budget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE r jsonb; old_r jsonb; message jsonb; action jsonb; period text:=to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM'); fixed numeric; spent numeric; held numeric; new_holds integer:=0; releases integer:=0; transition jsonb; recovery boolean; admitting boolean:=false;
BEGIN
 IF NOT __SCHEMA__.app_security_mode('worker.identity-mail') THEN RETURN NEW; END IF;
 IF NEW.header-'reservations'-'audit' IS DISTINCT FROM OLD.header-'reservations'-'audit' OR jsonb_array_length(NEW.header->'reservations')<jsonb_array_length(OLD.header->'reservations') OR jsonb_array_length(NEW.header->'reservations')>jsonb_array_length(OLD.header->'reservations')+1 OR jsonb_array_length(NEW.header->'audit')<jsonb_array_length(OLD.header->'audit') OR (SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') FROM jsonb_array_elements(NEW.header->'audit') WITH ORDINALITY a(value,ord) WHERE ord<=jsonb_array_length(OLD.header->'audit')) IS DISTINCT FROM OLD.header->'audit' THEN RAISE EXCEPTION 'Mail budget scope cannot change policy or unrelated history' USING ERRCODE='42501'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(NEW.header->'reservations') LOOP
  SELECT value INTO old_r FROM jsonb_array_elements(OLD.header->'reservations') WHERE value->>'id'=r->>'id';
  IF r IS NOT DISTINCT FROM old_r THEN CONTINUE; END IF;
  recovery:=false; transition:=NULL;
  SELECT body INTO transition FROM __SCHEMA__.app_identity_proofs WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND kind='mail-transition' AND body->'before'->>'costReservationId'=r->>'id';
  IF old_r IS NOT NULL AND r->>'status'='released' AND transition IS NOT NULL THEN
   message:=transition->'before';
   recovery:=message->>'status'='pending' OR (message->>'status'='sending' AND (message->>'leaseExpiresAt')::timestamptz<=statement_timestamp());
  ELSE
   SELECT header INTO message FROM __SCHEMA__.app_identity_outbox WHERE header->>'costReservationId'=r->>'id';
   IF message->>'status'<>'sending' THEN message:=__SCHEMA__.app_security_identity_proof('mail'); END IF;
  END IF;
  IF message IS NULL OR r->>'provider' IS DISTINCT FROM 'configured-smtp' OR r->>'operation' IS DISTINCT FROM 'identity-email' OR r->>'actorId' IS DISTINCT FROM 'identity-mail-worker' OR r->>'idempotencyKey' IS DISTINCT FROM 'identity-mail:'||(message->>'id')||':'||(message->>'attempts') OR coalesce(r->>'maximumCents','') !~ '^[1-9][0-9]{0,8}$' THEN RAISE EXCEPTION 'Mail hold must bind its exact claimed attempt' USING ERRCODE='42501'; END IF;
  IF old_r IS NULL THEN
   new_holds:=new_holds+1;
   IF new_holds>1 OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_identity_proofs WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND kind='mail-transition' AND body->'after'->>'costReservationId'=r->>'id' AND body->'after'->>'status'='sending' AND body->'after'->'leaseToken' IS DISTINCT FROM body->'before'->'leaseToken') THEN RAISE EXCEPTION 'One fresh claim-bound mail reservation per transaction' USING ERRCODE='42501'; END IF;
   IF r->>'status' IS DISTINCT FROM 'reserved' OR r->>'period' IS DISTINCT FROM period OR r ?| ARRAY['startedAt','settledAt','settledPeriod','actualCents','releasedAt','releaseReason'] OR (r->>'expiresAt')::timestamptz<=statement_timestamp() THEN RAISE EXCEPTION 'New mail hold must be an undispatched bounded reservation' USING ERRCODE='42501'; END IF;
  ELSE
   IF r-'status'-'startedAt'-'releasedAt'-'releaseReason' IS DISTINCT FROM old_r-'status'-'startedAt'-'releasedAt'-'releaseReason' OR old_r->>'status' IS DISTINCT FROM 'reserved' OR r->>'status' NOT IN ('running','released') OR (NOT coalesce(recovery,false) AND (message->>'id' IS DISTINCT FROM nullif(current_setting('urban.identity_outbox_id',true),'') OR message->>'leaseToken' IS DISTINCT FROM nullif(current_setting('urban.identity_lease_token',true),''))) THEN RAISE EXCEPTION 'Only the current mail claim may dispatch or release its hold' USING ERRCODE='42501'; END IF;
  END IF;
  IF r->>'status'='released' THEN releases:=releases+1; IF releases>21 THEN RAISE EXCEPTION 'Bounded mail cleanup exceeded' USING ERRCODE='42501'; END IF; END IF;
  IF r->>'status' IN ('reserved','running') THEN
   admitting:=true;
   IF NEW.header->'policy'->'paidOperationsPaused' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'Mail delivery is paused by operating budget policy' USING ERRCODE='42501'; END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.header->'reservations') a WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.header->'reservations') b WHERE a->>'id'=b->>'id')) THEN RAISE EXCEPTION 'Mail cannot remove budget records' USING ERRCODE='42501'; END IF;
 FOR action IN SELECT value FROM jsonb_array_elements(NEW.header->'audit') WITH ORDINALITY a(value,ord) WHERE ord>jsonb_array_length(OLD.header->'audit') LOOP
  IF action->>'actorId' IS DISTINCT FROM 'identity-mail-worker' OR action->>'action' NOT IN ('reservation.created','reservation.started','reservation.released') OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.header->'reservations') v WHERE v->>'id'=action->'details'->>'reservationId' AND v->>'provider'='configured-smtp' AND v->>'operation'='identity-email') THEN RAISE EXCEPTION 'Mail audit must reference its own reservation' USING ERRCODE='42501'; END IF;
 END LOOP;
 SELECT coalesce(sum((v->>'amountCents')::numeric) FILTER(WHERE v->>'category'='fixed'),0),coalesce(sum((v->>'amountCents')::numeric),0) INTO fixed,spent FROM jsonb_array_elements(NEW.header->'adjustments') v WHERE v->>'period'=period;
 SELECT spent+coalesce(sum((v->>'actualCents')::numeric),0) INTO spent FROM jsonb_array_elements(NEW.header->'reservations') v WHERE v->>'status'='settled' AND v->>'settledPeriod'=period;
 SELECT coalesce(sum((v->>'maximumCents')::numeric),0) INTO held FROM jsonb_array_elements(NEW.header->'reservations') v WHERE v->>'status'='running' OR (v->>'status'='reserved' AND (v->>'expiresAt')::timestamptz>statement_timestamp());
 IF admitting AND spent+greatest(0,(NEW.header->'policy'->>'fixedCostReserveCents')::numeric-fixed)+held>(NEW.header->'policy'->>'monthlyLimitCents')::numeric-(NEW.header->'policy'->>'safetyMarginCents')::numeric THEN RAISE EXCEPTION 'Mail dispatch exceeds the shared operating budget' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION __SCHEMA__.app_security_identity_budget() FROM PUBLIC;
DROP TRIGGER IF EXISTS identity_budget_write ON __SCHEMA__.app_budget;
CREATE TRIGGER identity_budget_write BEFORE UPDATE ON __SCHEMA__.app_budget FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_identity_budget();
