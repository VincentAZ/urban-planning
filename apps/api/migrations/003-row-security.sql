-- Installed by the migration owner, with __SCHEMA__ replaced by its quoted schema.
CREATE TABLE IF NOT EXISTS __SCHEMA__.app_user_credentials(user_id text PRIMARY KEY,password_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS __SCHEMA__.app_feedback_moderation(feedback_id text PRIMARY KEY,moderation jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS __SCHEMA__.app_baseline_proofs(backend_pid integer NOT NULL,transaction_id bigint NOT NULL,hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(backend_pid,transaction_id,hash));
CREATE TABLE IF NOT EXISTS __SCHEMA__.app_auth_bootstrap(backend_pid integer NOT NULL,transaction_id bigint NOT NULL,user_id text NOT NULL,organization_id text NOT NULL,PRIMARY KEY(backend_pid,transaction_id));
CREATE TABLE IF NOT EXISTS __SCHEMA__.app_project_write_proofs(backend_pid integer NOT NULL,transaction_id bigint NOT NULL,project_id text NOT NULL,user_id text NOT NULL,session_hash text NOT NULL,role text NOT NULL,PRIMARY KEY(backend_pid,transaction_id,project_id,user_id));
ALTER TABLE __SCHEMA__.app_project_versions ADD COLUMN IF NOT EXISTS content_hash_algorithm text NOT NULL DEFAULT 'canonical-json-sha256';
INSERT INTO __SCHEMA__.app_user_credentials SELECT id,header->>'passwordHash' FROM __SCHEMA__.app_users WHERE header ? 'passwordHash' ON CONFLICT(user_id) DO NOTHING;
UPDATE __SCHEMA__.app_users SET header=header-'passwordHash' WHERE header ? 'passwordHash';
INSERT INTO __SCHEMA__.app_feedback_moderation SELECT id,header->'moderation' FROM __SCHEMA__.app_public_feedback WHERE header ? 'moderation' ON CONFLICT(feedback_id) DO NOTHING;
UPDATE __SCHEMA__.app_public_feedback SET header=jsonb_set(header,'{moderation}',(header->'moderation')-'reason') WHERE header->'moderation' ? 'reason';

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_kind() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT CASE session_user WHEN migration_role THEN 'owner' WHEN web_role THEN 'web' WHEN auth_role THEN 'auth' WHEN worker_role THEN 'worker' ELSE 'unknown' END FROM __SCHEMA__.app_security_config WHERE id=1
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=3) THEN 3 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_admin_ids_match(wanted text[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT coalesce((SELECT array_agg(DISTINCT value ORDER BY value) FROM unnest(wanted) value),'{}')=coalesce((SELECT array_agg(DISTINCT value ORDER BY value) FROM unnest(admin_user_ids) value),'{}') FROM __SCHEMA__.app_security_config WHERE id=1
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_mode(wanted text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT coalesce(current_setting('urban.purpose',true)=wanted AND ((wanted LIKE 'auth.%' AND __SCHEMA__.app_security_kind()='auth') OR (wanted LIKE 'worker.%' AND __SCHEMA__.app_security_kind()='worker')),false)
$$;
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
 IF __SCHEMA__.app_security_kind()<>'web' AND NOT __SCHEMA__.app_security_mode('worker.prep') THEN RETURN NULL; END IF;
 SELECT header INTO s FROM __SCHEMA__.app_sessions WHERE id=nullif(current_setting('urban.session_hash',true),'') AND (header->>'expiresAt')::timestamptz>statement_timestamp();
 IF s IS NULL THEN RETURN NULL; END IF;
 u:=s->>'userId'; o:=s->>'organizationId';
 IF EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=u) AND EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE user_id=u AND organization_id=o) THEN RETURN jsonb_build_object('userId',u,'organizationId',o); END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_workspace_role(organization text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT header->>'role' FROM __SCHEMA__.app_memberships WHERE user_id=__SCHEMA__.app_security_principal()->>'userId' AND organization_id=organization AND coalesce(header->>'scope','workspace')<>'project-only'
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_project_role(project text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE r record; p jsonb; m jsonb; result text;
BEGIN
 p:=__SCHEMA__.app_security_principal();
 SELECT organization_id,header INTO r FROM __SCHEMA__.app_projects WHERE id=project;
 IF r IS NULL OR r.organization_id IS DISTINCT FROM p->>'organizationId' THEN RETURN NULL; END IF;
 SELECT header INTO m FROM __SCHEMA__.app_memberships WHERE user_id=p->>'userId' AND organization_id=r.organization_id;
 IF m IS NULL THEN RETURN NULL; END IF;
 IF m->>'role'='owner' AND coalesce(m->>'scope','workspace')<>'project-only' THEN RETURN 'owner'; END IF;
 IF r.header ? 'acl' THEN SELECT value->>'role' INTO result FROM jsonb_array_elements(r.header->'acl'->'members') WHERE value->>'userId'=p->>'userId'; RETURN result; END IF;
 IF coalesce(m->>'scope','workspace')<>'project-only' THEN RETURN m->>'role'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_public(snapshot text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT coalesce(snapshot=nullif(current_setting('urban.public_snapshot_id',true),'') AND EXISTS(SELECT 1 FROM __SCHEMA__.app_published WHERE id=snapshot AND NOT header ? 'revokedAt'),false)
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_snapshot_role(snapshot text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT __SCHEMA__.app_security_project_role(project_id) FROM __SCHEMA__.app_published WHERE id=snapshot
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT coalesce((__SCHEMA__.app_security_principal()->>'userId')=ANY(admin_user_ids),false) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_member_lookup() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT coalesce(__SCHEMA__.app_security_workspace_role(__SCHEMA__.app_security_principal()->>'organizationId')='owner' OR __SCHEMA__.app_security_project_role(nullif(current_setting('urban.project_id',true),''))='owner',false)
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_can_view_member(wanted text,organization text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE p jsonb:=__SCHEMA__.app_security_principal(); membership jsonb;
BEGIN
 IF wanted=p->>'userId' THEN RETURN true; END IF;
 IF organization IS DISTINCT FROM p->>'organizationId' THEN RETURN false; END IF;
 SELECT header INTO membership FROM __SCHEMA__.app_memberships WHERE user_id=p->>'userId' AND organization_id=organization;
 IF membership IS NULL THEN RETURN false; END IF;
 IF coalesce(membership->>'scope','workspace')<>'project-only' THEN RETURN true; END IF;
 IF EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE user_id=wanted AND organization_id=organization AND header->>'role'='owner' AND coalesce(header->>'scope','workspace')<>'project-only') THEN RETURN true; END IF;
 RETURN EXISTS(SELECT 1 FROM __SCHEMA__.app_projects r,jsonb_array_elements(coalesce(r.header->'acl'->'members','[]')) grant_member WHERE r.organization_id=organization AND __SCHEMA__.app_security_project_role(r.id) IS NOT NULL AND grant_member->>'userId'=wanted);
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
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

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_user_header(wanted text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE r record; secret text;
BEGIN
 SELECT * INTO r FROM __SCHEMA__.app_users WHERE id=wanted;
 IF r IS NULL OR NOT coalesce(__SCHEMA__.app_security_allow('users','SELECT',r.id,r.organization_id,r.user_id,r.project_id,r.snapshot_id,r.header),false) THEN RETURN NULL; END IF;
 IF __SCHEMA__.app_security_kind()='owner' OR (__SCHEMA__.app_security_mode('auth.lookup') AND r.email=current_setting('urban.auth_email',true)) THEN
  SELECT password_hash INTO secret FROM __SCHEMA__.app_user_credentials WHERE user_id=wanted;
  IF secret IS NOT NULL THEN RETURN r.header||jsonb_build_object('passwordHash',secret); END IF;
 END IF;
 RETURN r.header;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_feedback_header(wanted text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE r record; detail jsonb;
BEGIN
 SELECT * INTO r FROM __SCHEMA__.app_public_feedback WHERE id=wanted;
 IF r IS NULL OR NOT coalesce(__SCHEMA__.app_security_allow('publicFeedback','SELECT',r.id,r.organization_id,r.user_id,r.project_id,r.snapshot_id,r.header),false) THEN RETURN NULL; END IF;
 IF __SCHEMA__.app_security_kind()='owner' OR __SCHEMA__.app_security_snapshot_role(r.snapshot_id) IS NOT NULL THEN
  SELECT moderation INTO detail FROM __SCHEMA__.app_feedback_moderation WHERE feedback_id=wanted;
  IF detail IS NOT NULL THEN RETURN jsonb_set(r.header,'{moderation}',detail); END IF;
 END IF;
 RETURN r.header;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_baseline_access(wanted text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT __SCHEMA__.app_security_kind()='owner' OR EXISTS(SELECT 1 FROM __SCHEMA__.app_projects WHERE baseline_hash=wanted AND __SCHEMA__.app_security_project_role(id) IS NOT NULL) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_published WHERE baseline_hash=wanted AND (__SCHEMA__.app_security_project_role(project_id) IS NOT NULL OR __SCHEMA__.app_security_public(id))) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_baseline_proofs WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current() AND hash=wanted)
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_put_baseline(wanted text,canonical_text text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE value jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()<>'owner' AND (__SCHEMA__.app_security_kind()<>'web' OR __SCHEMA__.app_security_principal() IS NULL) THEN RAISE EXCEPTION 'Authentication required for baseline capture' USING ERRCODE='42501'; END IF;
 IF encode(sha256(convert_to(canonical_text,'UTF8')),'hex')<>wanted THEN RAISE EXCEPTION 'Baseline hash mismatch' USING ERRCODE='23514'; END IF;
 value:=canonical_text::jsonb;
 IF jsonb_typeof(value)<>'object' OR coalesce(value->>'id','')='' THEN RAISE EXCEPTION 'Invalid baseline' USING ERRCODE='23514'; END IF;
 INSERT INTO __SCHEMA__.app_baseline_snapshots(sha256,place_id,payload,canonical_bytes) VALUES(wanted,value->>'id',value,octet_length(canonical_text)) ON CONFLICT(sha256) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_baseline_snapshots WHERE sha256=wanted AND payload=value AND place_id=value->>'id') THEN RAISE EXCEPTION 'Existing baseline integrity mismatch' USING ERRCODE='23514'; END IF;
 DELETE FROM __SCHEMA__.app_baseline_proofs WHERE backend_pid=pg_backend_pid() AND transaction_id<>txid_current();
 INSERT INTO __SCHEMA__.app_baseline_proofs(backend_pid,transaction_id,hash) VALUES(pg_backend_pid(),txid_current(),wanted) ON CONFLICT DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_project_id_used(wanted text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM __SCHEMA__.app_projects WHERE id=wanted) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_project_versions WHERE project_id=wanted)
$$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_bind_write() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE entity text:=TG_ARGV[0]; p jsonb:=__SCHEMA__.app_security_principal(); role text; detail jsonb; previous_detail jsonb; old_replies jsonb; new_replies jsonb; item jsonb; expected text; publication jsonb; old_policy jsonb; new_policy jsonb;
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN
  IF entity='users' AND NEW.header ? 'passwordHash' THEN INSERT INTO __SCHEMA__.app_user_credentials VALUES(NEW.id,NEW.header->>'passwordHash') ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash; NEW.header:=NEW.header-'passwordHash'; END IF;
  IF entity='publicFeedback' AND NEW.header ? 'moderation' THEN INSERT INTO __SCHEMA__.app_feedback_moderation VALUES(NEW.id,NEW.header->'moderation') ON CONFLICT(feedback_id) DO UPDATE SET moderation=EXCLUDED.moderation; NEW.header:=jsonb_set(NEW.header,'{moderation}',(NEW.header->'moderation')-'reason'); END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.ordinal<>OLD.ordinal OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id OR (entity<>'sessions' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id) OR NEW.baseline_hash IS DISTINCT FROM OLD.baseline_hash) THEN RAISE EXCEPTION 'Entity identity and captured baseline are immutable' USING ERRCODE='42501'; END IF;
 IF NEW.organization_id IS DISTINCT FROM (NEW.header->>'organizationId') AND entity NOT IN ('organizations','users','budget','preparationControl','publicFeedback') THEN RAISE EXCEPTION 'Organization index mismatch' USING ERRCODE='23514'; END IF;
 IF entity IN ('users','organizations','audit','comments','published','publicFeedback','imports','preparationJobs') AND NEW.header->>'id' IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Entity index mismatch' USING ERRCODE='23514'; END IF;
 IF entity IN ('memberships','sessions','publicFeedback','preparationJobs') AND NEW.header->>'userId' IS DISTINCT FROM NEW.user_id THEN RAISE EXCEPTION 'Actor index mismatch' USING ERRCODE='23514'; END IF;
 IF entity IN ('published','comments','imports','audit') AND NEW.header->>'projectId' IS DISTINCT FROM NEW.project_id THEN RAISE EXCEPTION 'Project index mismatch' USING ERRCODE='23514'; END IF;
 IF entity IN ('published','comments','imports','audit') AND NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_projects WHERE id=NEW.project_id AND organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Referenced project and organization must match' USING ERRCODE='23514'; END IF;
 IF entity='users' AND NEW.user_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'User index mismatch' USING ERRCODE='23514'; END IF;
 IF entity='organizations' AND NEW.organization_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Workspace index mismatch' USING ERRCODE='23514'; END IF;
 IF entity='published' AND NEW.snapshot_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Publication index mismatch' USING ERRCODE='23514'; END IF;
 IF entity='comments' AND NEW.user_id IS DISTINCT FROM NEW.header->>'actorId' THEN RAISE EXCEPTION 'Comment actor index mismatch' USING ERRCODE='23514'; END IF;
 IF entity='audit' AND NEW.snapshot_id IS DISTINCT FROM NEW.header->'details'->>'snapshotId' THEN RAISE EXCEPTION 'Audit snapshot index mismatch' USING ERRCODE='23514'; END IF;
 IF entity='publicFeedback' AND NEW.header->>'snapshotId' IS DISTINCT FROM NEW.snapshot_id THEN RAISE EXCEPTION 'Snapshot index mismatch' USING ERRCODE='23514'; END IF;
 IF entity='users' THEN
  IF NEW.header->>'email' IS DISTINCT FROM NEW.email THEN RAISE EXCEPTION 'Email index mismatch' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND __SCHEMA__.app_security_mode('auth.register') AND (EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=NEW.id) OR EXISTS(SELECT 1 FROM __SCHEMA__.app_organizations WHERE id=current_setting('urban.auth_organization_id',true)) OR NEW.id IS DISTINCT FROM current_setting('urban.auth_user_id',true) OR NEW.email IS DISTINCT FROM current_setting('urban.auth_email',true) OR coalesce(NEW.header->>'passwordHash','')='') THEN RAISE EXCEPTION 'Registration requires fresh identities and credentials' USING ERRCODE='42501'; END IF;
  IF NEW.header ? 'passwordHash' THEN
   IF NOT __SCHEMA__.app_security_mode('auth.register') OR TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Credential mutation is restricted' USING ERRCODE='42501'; END IF;
   INSERT INTO __SCHEMA__.app_user_credentials VALUES(NEW.id,NEW.header->>'passwordHash'); NEW.header:=NEW.header-'passwordHash';
   DELETE FROM __SCHEMA__.app_auth_bootstrap WHERE backend_pid=pg_backend_pid() AND transaction_id<>txid_current();
   INSERT INTO __SCHEMA__.app_auth_bootstrap VALUES(pg_backend_pid(),txid_current(),NEW.id,current_setting('urban.auth_organization_id',true));
  END IF;
 ELSIF entity='sessions' THEN
  IF NEW.header->>'hash' IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Session index mismatch' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW.header-'organizationId') IS DISTINCT FROM (OLD.header-'organizationId') THEN RAISE EXCEPTION 'Session credential is immutable' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_memberships WHERE user_id=NEW.user_id AND organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'Session workspace membership required' USING ERRCODE='42501'; END IF;
 ELSIF entity='memberships' THEN
  IF NOT coalesce(__SCHEMA__.app_security_allow('memberships',TG_OP,NEW.id,NEW.organization_id,NEW.user_id,NEW.project_id,NEW.snapshot_id,NEW.header),false) THEN RAISE EXCEPTION 'Membership transition is not authorized' USING ERRCODE='42501'; END IF;
  IF NEW.id<>jsonb_build_array(NEW.user_id,NEW.organization_id)::text AND NEW.id<>replace(jsonb_build_array(NEW.user_id,NEW.organization_id)::text,', ', ',') THEN RAISE EXCEPTION 'Membership identity mismatch' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_users WHERE id=NEW.user_id) OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_organizations WHERE id=NEW.organization_id) THEN RAISE EXCEPTION 'Membership endpoints required' USING ERRCODE='23514'; END IF;
 ELSIF entity='projects' THEN
  IF NEW.header->'project'->>'id' IS DISTINCT FROM NEW.id OR NEW.payload->'project'->>'id' IS DISTINCT FROM NEW.id OR NEW.project_id IS DISTINCT FROM NEW.id THEN RAISE EXCEPTION 'Project identity mismatch' USING ERRCODE='23514'; END IF;
  detail:=NEW.payload->'project';
  IF NEW.header->'project' IS DISTINCT FROM jsonb_build_object('id',detail->'id','name',detail->'name','placeId',detail->'placeId','updatedAt',detail->'updatedAt','activeScenarioId',detail->'activeScenarioId','scenarios',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s->'id','name',s->'name','revision',s->'revision') ORDER BY ord),'[]') FROM jsonb_array_elements(detail->'scenarios') WITH ORDINALITY a(s,ord))) THEN RAISE EXCEPTION 'Project summary must match saved content' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
   IF EXISTS(SELECT 1 FROM __SCHEMA__.app_project_versions WHERE project_id=NEW.id) THEN RAISE EXCEPTION 'Retired project identity cannot be reused' USING ERRCODE='42501'; END IF;
   IF NOT __SCHEMA__.app_security_baseline_access(NEW.baseline_hash) THEN RAISE EXCEPTION 'Baseline content proof required' USING ERRCODE='42501'; END IF;
   IF (NEW.header->>'version')::bigint IS DISTINCT FROM 1::bigint OR NEW.header->>'createdBy' IS DISTINCT FROM p->>'userId' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.header->'acl'->'members') m WHERE m->>'userId'=p->>'userId' AND m->>'role'='owner') THEN RAISE EXCEPTION 'New project owner/version required' USING ERRCODE='42501'; END IF;
  ELSE
   role:=__SCHEMA__.app_security_project_role(OLD.id);
   IF role='owner' THEN
    DELETE FROM __SCHEMA__.app_project_write_proofs WHERE backend_pid=pg_backend_pid() AND transaction_id<>txid_current();
    INSERT INTO __SCHEMA__.app_project_write_proofs VALUES(pg_backend_pid(),txid_current(),OLD.id,p->>'userId',current_setting('urban.session_hash',true),role) ON CONFLICT DO NOTHING;
   END IF;
   IF NEW.header->>'createdBy' IS DISTINCT FROM OLD.header->>'createdBy' OR NEW.header->>'createdAt' IS DISTINCT FROM OLD.header->>'createdAt' THEN RAISE EXCEPTION 'Project origin is immutable' USING ERRCODE='42501'; END IF;
   IF NEW.header->'acl' IS DISTINCT FROM OLD.header->'acl' AND (role IS DISTINCT FROM 'owner' OR (NEW.header->'acl'->>'version')::bigint IS DISTINCT FROM coalesce((OLD.header->'acl'->>'version')::bigint,0)+1) THEN RAISE EXCEPTION 'Only a project owner may revise sharing' USING ERRCODE='42501'; END IF;
   IF (NEW.payload IS DISTINCT FROM OLD.payload OR (NEW.header-'acl') IS DISTINCT FROM (OLD.header-'acl')) AND (coalesce(role,'') NOT IN ('owner','editor') OR (NEW.header->>'version')::bigint IS DISTINCT FROM (OLD.header->>'version')::bigint+1) THEN RAISE EXCEPTION 'Content edits require an editor and next version' USING ERRCODE='42501'; END IF;
  END IF;
  IF NEW.header ? 'acl' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.header->'acl'->'members') m WHERE m->>'role'='owner') THEN RAISE EXCEPTION 'Last explicit project owner cannot be removed' USING ERRCODE='42501'; END IF;
 ELSIF entity='published' THEN
  IF TG_OP='INSERT' AND NOT __SCHEMA__.app_security_baseline_access(NEW.baseline_hash) THEN RAISE EXCEPTION 'Baseline content proof required' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND (NEW.payload IS DISTINCT FROM OLD.payload OR (NEW.header-'revokedAt'-'engagement') IS DISTINCT FROM (OLD.header-'revokedAt'-'engagement') OR (OLD.header ? 'engagement' AND NEW.header->'engagement'->'config' IS DISTINCT FROM OLD.header->'engagement'->'config') OR (NOT OLD.header ? 'engagement' AND NEW.header ? 'engagement' AND NEW.header->'engagement'->'config' IS DISTINCT FROM jsonb_build_object('introduction','','comments',coalesce(OLD.header->'feedbackEnabled','false'),'votes',coalesce(OLD.header->'feedbackEnabled','false'),'pins',coalesce(OLD.header->'feedbackEnabled','false'),'questions','[]'::jsonb))) THEN RAISE EXCEPTION 'Published content is immutable' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND OLD.header ? 'revokedAt' AND NEW.header->'revokedAt' IS DISTINCT FROM OLD.header->'revokedAt' THEN RAISE EXCEPTION 'A revoked link cannot be restored' USING ERRCODE='42501'; END IF;
 ELSIF entity='comments' THEN
  IF TG_OP='INSERT' AND NEW.header->>'actorId' IS DISTINCT FROM p->>'userId' THEN RAISE EXCEPTION 'Comment author mismatch' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' AND (NEW.header->'resolved' IS DISTINCT FROM 'false'::jsonb OR NEW.header->'threadVersion' IS DISTINCT FROM '1'::jsonb OR NEW.header->'replies' IS DISTINCT FROM '[]'::jsonb OR NEW.header ? 'resolvedAt' OR NEW.header ? 'resolvedBy') THEN RAISE EXCEPTION 'New comments must start unresolved without replies' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' THEN
   IF (NEW.header-'replies'-'threadVersion'-'resolved'-'resolvedAt'-'resolvedBy') IS DISTINCT FROM (OLD.header-'replies'-'threadVersion'-'resolved'-'resolvedAt'-'resolvedBy') OR (NEW.header->>'threadVersion')::bigint IS DISTINCT FROM coalesce((OLD.header->>'threadVersion')::bigint,1)+1 THEN RAISE EXCEPTION 'Comment history is immutable' USING ERRCODE='42501'; END IF;
   IF (NEW.header->'resolved' IS DISTINCT FROM OLD.header->'resolved' OR NEW.header->'resolvedAt' IS DISTINCT FROM OLD.header->'resolvedAt' OR NEW.header->'resolvedBy' IS DISTINCT FROM OLD.header->'resolvedBy') THEN
    IF jsonb_typeof(NEW.header->'resolved') IS DISTINCT FROM 'boolean' OR NEW.header->'resolved' IS NOT DISTINCT FROM OLD.header->'resolved' THEN RAISE EXCEPTION 'Resolution requires a boolean state transition' USING ERRCODE='42501'; END IF;
    IF coalesce(__SCHEMA__.app_security_project_role(OLD.project_id),'') NOT IN ('owner','editor') AND OLD.header->>'actorId' IS DISTINCT FROM p->>'userId' THEN RAISE EXCEPTION 'Cannot resolve another author thread' USING ERRCODE='42501'; END IF;
    IF NEW.header->'resolved'='true'::jsonb AND (NEW.header->>'resolvedBy' IS DISTINCT FROM p->>'userId' OR jsonb_typeof(NEW.header->'resolvedAt') IS DISTINCT FROM 'string' OR coalesce(NEW.header->>'resolvedAt','')='') THEN RAISE EXCEPTION 'Resolution actor and timestamp required' USING ERRCODE='42501'; END IF;
    IF NEW.header->'resolved'='false'::jsonb AND (NEW.header ? 'resolvedAt' OR NEW.header ? 'resolvedBy') THEN RAISE EXCEPTION 'Reopened threads cannot retain resolution metadata' USING ERRCODE='42501'; END IF;
   END IF;
   old_replies:=coalesce(OLD.header->'replies','[]'); new_replies:=coalesce(NEW.header->'replies','[]');
   IF jsonb_array_length(new_replies)<jsonb_array_length(old_replies) OR jsonb_array_length(new_replies)>jsonb_array_length(old_replies)+1 THEN RAISE EXCEPTION 'Replies are append-only' USING ERRCODE='42501'; END IF;
   IF (SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') FROM jsonb_array_elements(new_replies) WITH ORDINALITY a(value,ord) WHERE ord<=jsonb_array_length(old_replies)) IS DISTINCT FROM old_replies THEN RAISE EXCEPTION 'Existing replies cannot change' USING ERRCODE='42501'; END IF;
   IF jsonb_array_length(new_replies)>jsonb_array_length(old_replies) AND new_replies->-1->>'actorId' IS DISTINCT FROM p->>'userId' THEN RAISE EXCEPTION 'Reply author mismatch' USING ERRCODE='42501'; END IF;
  END IF;
 ELSIF entity='publicFeedback' THEN
  IF TG_OP='INSERT' THEN
   SELECT header INTO publication FROM __SCHEMA__.app_published WHERE id=NEW.snapshot_id;
   IF coalesce(publication->'engagement'->'collection'->>'status',CASE WHEN publication->'feedbackEnabled'='true'::jsonb THEN 'open' ELSE 'closed' END)<>'open' THEN RAISE EXCEPTION 'Feedback collection is closed' USING ERRCODE='42501'; END IF;
   expected:=CASE NEW.header->>'kind' WHEN 'comment' THEN 'comments' WHEN 'vote' THEN 'votes' WHEN 'survey' THEN 'survey' ELSE 'invalid' END;
   IF expected='invalid' OR (expected='survey' AND jsonb_array_length(coalesce(publication->'engagement'->'config'->'questions','[]'))=0) OR (expected NOT IN ('survey','invalid') AND coalesce(publication->'engagement'->'config'->expected,publication->'feedbackEnabled','false')<>'true'::jsonb) OR (NEW.header ? 'position' AND coalesce(publication->'engagement'->'config'->'pins',publication->'feedbackEnabled','false')<>'true'::jsonb) THEN RAISE EXCEPTION 'This feedback kind is disabled' USING ERRCODE='42501'; END IF;
   IF NEW.header ? 'supersededAt' THEN RAISE EXCEPTION 'New feedback cannot start superseded' USING ERRCODE='42501'; END IF;
  END IF;
  detail:=NEW.header->'moderation'; SELECT moderation INTO previous_detail FROM __SCHEMA__.app_feedback_moderation WHERE feedback_id=NEW.id;
  IF TG_OP='UPDATE' AND (NEW.header-'supersededAt'-'moderation') IS DISTINCT FROM (OLD.header-'supersededAt'-'moderation') THEN RAISE EXCEPTION 'Feedback content is immutable' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' AND (detail->>'status' IS DISTINCT FROM 'pending' OR coalesce((detail->>'version')::int,0)<>1 OR detail ? 'reason') THEN RAISE EXCEPTION 'New feedback starts pending at moderation version one' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND (detail-'reason') IS DISTINCT FROM (OLD.header->'moderation') AND __SCHEMA__.app_security_snapshot_role(NEW.snapshot_id) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Only the project owner can moderate' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND detail IS DISTINCT FROM coalesce(previous_detail,OLD.header->'moderation') AND __SCHEMA__.app_security_snapshot_role(NEW.snapshot_id)='owner' THEN
   IF coalesce(detail->>'status','') NOT IN ('included','excluded') OR (detail->>'version')::bigint IS DISTINCT FROM coalesce((OLD.header->'moderation'->>'version')::bigint,1)+1 OR coalesce(length(trim(detail->>'reason')),0)=0 OR NOT detail ? 'updatedAt' THEN RAISE EXCEPTION 'Moderation requires a reason and next version' USING ERRCODE='42501'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW.header->'supersededAt' IS DISTINCT FROM OLD.header->'supersededAt' AND (OLD.header ? 'supersededAt' OR NOT NEW.header ? 'supersededAt' OR NEW.header->>'kind'='comment' OR NEW.user_id IS DISTINCT FROM p->>'userId') THEN RAISE EXCEPTION 'Feedback replacement is append-only and account-bound' USING ERRCODE='42501'; END IF;
  IF detail ? 'reason' AND __SCHEMA__.app_security_snapshot_role(NEW.snapshot_id) IS DISTINCT FROM 'owner' AND detail IS DISTINCT FROM previous_detail THEN RAISE EXCEPTION 'Private moderation mutation denied' USING ERRCODE='42501'; END IF;
  IF detail IS NOT NULL THEN
   IF TG_OP='INSERT' OR __SCHEMA__.app_security_snapshot_role(NEW.snapshot_id)='owner' THEN INSERT INTO __SCHEMA__.app_feedback_moderation VALUES(NEW.id,detail) ON CONFLICT(feedback_id) DO UPDATE SET moderation=EXCLUDED.moderation; END IF;
   NEW.header:=jsonb_set(NEW.header,'{moderation}',detail-'reason');
  END IF;
 ELSIF entity='budget' AND __SCHEMA__.app_security_mode('worker.budget') THEN
  old_policy:=OLD.header->'policy'; new_policy:=NEW.header->'policy';
  IF NEW.header->'adjustments' IS DISTINCT FROM OLD.header->'adjustments' OR (new_policy-'paidOperationsPaused'-'version'-'updatedAt'-'updatedBy') IS DISTINCT FROM (old_policy-'paidOperationsPaused'-'version'-'updatedAt'-'updatedBy') THEN RAISE EXCEPTION 'Workers cannot change budget policy or fixed costs' USING ERRCODE='42501'; END IF;
  IF new_policy IS DISTINCT FROM old_policy AND (new_policy->'paidOperationsPaused' IS DISTINCT FROM 'true'::jsonb OR old_policy->'paidOperationsPaused' IS DISTINCT FROM 'false'::jsonb OR new_policy->>'updatedBy' IS DISTINCT FROM 'system' OR (new_policy->>'version')::bigint IS DISTINCT FROM (old_policy->>'version')::bigint+1 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.header->'reservations') n JOIN jsonb_array_elements(OLD.header->'reservations') o ON n->>'id'=o->>'id' WHERE o->>'status'='running' AND n->>'status'='settled' AND (n->>'actualCents')::bigint>(o->>'maximumCents')::bigint)) THEN RAISE EXCEPTION 'Only an actual overrun may trigger a worker safety pause' USING ERRCODE='42501'; END IF;
 ELSIF entity='preparationJobs' AND NOT __SCHEMA__.app_security_mode('worker.prep') THEN
  IF TG_OP='INSERT' AND (NEW.header->>'status'<>'queued' OR NEW.header ? 'workerId') THEN RAISE EXCEPTION 'New requests must be queued' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' THEN
   IF (NEW.header-'status'-'stage'-'progress'-'updatedAt'-'cancelRequested'-'error'-'requestKeys') IS DISTINCT FROM (OLD.header-'status'-'stage'-'progress'-'updatedAt'-'cancelRequested'-'error'-'requestKeys') THEN RAISE EXCEPTION 'Worker-owned preparation fields are immutable' USING ERRCODE='42501'; END IF;
   IF OLD.header->>'status' IN ('queued','running') AND NEW.header->'cancelRequested'='true'::jsonb AND NEW.header->>'status'=(CASE WHEN OLD.header->>'status'='queued' THEN 'cancelled' ELSE 'running' END) THEN
    IF (NEW.header-'status'-'updatedAt'-'cancelRequested') IS DISTINCT FROM (OLD.header-'status'-'updatedAt'-'cancelRequested') THEN RAISE EXCEPTION 'Cancellation cannot change worker progress or request identity' USING ERRCODE='42501'; END IF;
   ELSIF OLD.header->>'status' IN ('failed','cancelled') AND NEW.header->>'status'='queued' AND (OLD.header->>'attempt')::int<3 AND coalesce(OLD.header->'error'->'retryable','true')='true'::jsonb THEN
    IF NEW.header->>'stage' IS DISTINCT FROM 'queued' OR NEW.header->'progress' IS DISTINCT FROM '0'::jsonb OR NEW.header->'cancelRequested' IS DISTINCT FROM 'false'::jsonb OR NEW.header ? 'error' OR jsonb_array_length(NEW.header->'requestKeys') IS DISTINCT FROM jsonb_array_length(OLD.header->'requestKeys')+1 OR (SELECT jsonb_agg(value ORDER BY ord) FROM jsonb_array_elements(NEW.header->'requestKeys') WITH ORDINALITY a(value,ord) WHERE ord<=jsonb_array_length(OLD.header->'requestKeys')) IS DISTINCT FROM OLD.header->'requestKeys' THEN RAISE EXCEPTION 'Retry must append one request key and reset queued progress' USING ERRCODE='42501'; END IF;
   ELSE RAISE EXCEPTION 'Only cancellation or eligible retry is allowed' USING ERRCODE='42501'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_feedback_replacement() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF NEW.header->'supersededAt' IS DISTINCT FROM OLD.header->'supersededAt' AND (jsonb_typeof(NEW.header->'supersededAt') IS DISTINCT FROM 'string' OR coalesce(NEW.header->>'supersededAt','')='' OR NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_public_feedback r WHERE r.ordinal>NEW.ordinal AND r.user_id=NEW.user_id AND r.snapshot_id=NEW.snapshot_id AND NOT r.header ? 'supersededAt' AND r.header->>'kind'=NEW.header->>'kind' AND r.header->'createdAt'=NEW.header->'supersededAt' AND r.xmin=(txid_current()%4294967296)::text::xid)) THEN RAISE EXCEPTION 'Superseding feedback requires its same-account replacement' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_feedback_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF NEW.header->>'action'='engagement.submitted' AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_public_feedback r JOIN __SCHEMA__.app_published s ON s.id=r.snapshot_id WHERE r.id=NEW.header->'details'->>'feedbackId' AND r.user_id=NEW.header->>'actorId' AND r.snapshot_id=NEW.snapshot_id AND s.project_id=NEW.project_id AND s.organization_id=NEW.organization_id AND r.header->>'kind'=NEW.header->'details'->>'kind') THEN RAISE EXCEPTION 'Participant audit must match the submitted response and snapshot' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_archive_project() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.header->'version' IS DISTINCT FROM OLD.header->'version' THEN
  INSERT INTO __SCHEMA__.app_project_versions(project_id,version,organization_id,baseline_hash,payload,content_sha256,content_hash_algorithm) VALUES(NEW.id,(NEW.header->>'version')::bigint,NEW.organization_id,NEW.baseline_hash,NEW.payload,encode(sha256(convert_to(NEW.payload::text,'UTF8')),'hex'),'postgres-jsonb-text-sha256');
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_prune_memberships() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE member record; fallback text;
BEGIN
 IF TG_OP='UPDATE' AND NEW.header->'acl' IS NOT DISTINCT FROM OLD.header->'acl' THEN RETURN NULL; END IF;
 FOR member IN SELECT * FROM __SCHEMA__.app_memberships m WHERE m.organization_id=OLD.organization_id AND m.header->>'scope'='project-only' AND NOT EXISTS(SELECT 1 FROM __SCHEMA__.app_projects p,jsonb_array_elements(coalesce(p.header->'acl'->'members','[]')) a WHERE p.organization_id=m.organization_id AND a->>'userId'=m.user_id) LOOP
  DELETE FROM __SCHEMA__.app_memberships WHERE id=member.id;
  SELECT organization_id INTO fallback FROM __SCHEMA__.app_memberships WHERE user_id=member.user_id ORDER BY (coalesce(header->>'scope','workspace')='workspace') DESC,ordinal LIMIT 1;
  IF fallback IS NULL THEN DELETE FROM __SCHEMA__.app_sessions WHERE user_id=member.user_id AND organization_id=member.organization_id;
  ELSE UPDATE __SCHEMA__.app_sessions SET organization_id=fallback,header=jsonb_set(header,'{organizationId}',to_jsonb(fallback)) WHERE user_id=member.user_id AND organization_id=member.organization_id; END IF;
 END LOOP;
 RETURN NULL;
END $$;

DO $install$
DECLARE cfg record; pair text[]; entity text; tab text; role_name text; op text; function_oid regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 FOR pair IN SELECT ARRAY[a,b] FROM (VALUES ('users','app_users'),('organizations','app_organizations'),('memberships','app_memberships'),('sessions','app_sessions'),('projects','app_projects'),('audit','app_audit'),('comments','app_comments'),('published','app_published'),('publicFeedback','app_public_feedback'),('imports','app_imports'),('preparationJobs','app_preparation_jobs'),('budget','app_budget'),('preparationControl','app_preparation_control')) v(a,b) LOOP
  entity:=pair[1]; tab:=pair[2];
  EXECUTE format('ALTER TABLE __SCHEMA__.%I ENABLE ROW LEVEL SECURITY',tab); EXECUTE format('ALTER TABLE __SCHEMA__.%I FORCE ROW LEVEL SECURITY',tab);
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
  EXECUTE format('DROP TRIGGER IF EXISTS security_bind_write ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE TRIGGER security_bind_write BEFORE INSERT OR UPDATE ON __SCHEMA__.%I FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_bind_write(%L)',tab,entity);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['app_baseline_snapshots','app_project_versions','app_user_credentials','app_feedback_moderation','app_baseline_proofs','app_auth_bootstrap','app_project_write_proofs','app_security_config'] LOOP
  EXECUTE format('ALTER TABLE __SCHEMA__.%I ENABLE ROW LEVEL SECURITY',tab); EXECUTE format('ALTER TABLE __SCHEMA__.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('REVOKE ALL ON __SCHEMA__.%I FROM PUBLIC,%I,%I,%I',tab,cfg.web_role,cfg.auth_role,cfg.worker_role);
  EXECUTE format('DROP POLICY IF EXISTS operator_access ON __SCHEMA__.%I',tab);
  EXECUTE format('CREATE POLICY operator_access ON __SCHEMA__.%I TO %I USING(true) WITH CHECK(true)',tab,cfg.migration_role);
 END LOOP;
 DROP POLICY IF EXISTS runtime_baseline_read ON __SCHEMA__.app_baseline_snapshots;
 EXECUTE format('CREATE POLICY runtime_baseline_read ON __SCHEMA__.app_baseline_snapshots FOR SELECT TO %I USING(__SCHEMA__.app_security_baseline_access(sha256))',cfg.web_role);
 EXECUTE format('GRANT SELECT ON __SCHEMA__.app_baseline_snapshots TO %I',cfg.web_role);
 FOREACH tab IN ARRAY ARRAY['app_state','app_storage_manifest','app_schema_migrations','source_manifests','geographic_features'] LOOP EXECUTE format('REVOKE ALL ON __SCHEMA__.%I FROM PUBLIC,%I,%I,%I',tab,cfg.web_role,cfg.auth_role,cfg.worker_role); END LOOP;
 FOREACH role_name IN ARRAY ARRAY[cfg.web_role,cfg.auth_role,cfg.worker_role] LOOP
  EXECUTE format('GRANT USAGE ON SCHEMA __SCHEMA__ TO %I',role_name);
  EXECUTE format('GRANT USAGE ON SEQUENCE __SCHEMA__.app_entity_ordinal TO %I',role_name);
 END LOOP;
 FOR function_oid IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND p.proname LIKE 'app_security_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',function_oid,cfg.web_role,cfg.auth_role,cfg.worker_role);
 END LOOP;
 FOR function_oid IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND p.proname IN ('app_security_kind','app_security_runtime_configuration','app_security_admin_ids_match','app_security_allow','app_security_principal','app_security_baseline_access','app_security_user_header','app_security_feedback_header','app_security_project_id_used','app_security_put_baseline') LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I,%I,%I',function_oid,cfg.web_role,cfg.auth_role,cfg.worker_role);
 END LOOP;
END $install$;
DROP TRIGGER IF EXISTS security_archive_project ON __SCHEMA__.app_projects;
CREATE TRIGGER security_archive_project AFTER INSERT OR UPDATE ON __SCHEMA__.app_projects FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_archive_project();
DROP TRIGGER IF EXISTS security_prune_memberships ON __SCHEMA__.app_projects;
CREATE TRIGGER security_prune_memberships AFTER UPDATE OR DELETE ON __SCHEMA__.app_projects FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_prune_memberships();
DROP TRIGGER IF EXISTS security_feedback_replacement ON __SCHEMA__.app_public_feedback;
CREATE CONSTRAINT TRIGGER security_feedback_replacement AFTER UPDATE ON __SCHEMA__.app_public_feedback DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_feedback_replacement();
DROP TRIGGER IF EXISTS security_feedback_audit ON __SCHEMA__.app_audit;
CREATE CONSTRAINT TRIGGER security_feedback_audit AFTER INSERT ON __SCHEMA__.app_audit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_feedback_audit();
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
