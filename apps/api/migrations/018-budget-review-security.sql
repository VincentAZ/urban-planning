-- Manual cost-review evidence is append-only and cannot be minted by a worker.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow_v17(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
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
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_allow(entity text,operation text,row_id text,organization text,actor text,project text,snapshot text,body jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
BEGIN
 IF entity='budget' AND __SCHEMA__.app_security_mode('worker.prep') THEN RETURN operation='SELECT'; END IF;
 RETURN __SCHEMA__.app_security_allow_v17(entity,operation,row_id,organization,actor,project,snapshot,body);
END $$;
-- Fixed arrays use only bounded integers, strings, booleans and null. Compact
-- array serialization matches the exported core budget-review projections.
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_budget_compact(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,__SCHEMA__ AS $$
DECLARE result text;
BEGIN
 IF jsonb_typeof(value)='array' THEN
  SELECT '['||coalesce(string_agg(__SCHEMA__.app_security_budget_compact(v),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY a(v,n);
  RETURN result;
 END IF;
 IF jsonb_typeof(value)='object' THEN RAISE EXCEPTION 'Budget hash projection must use fixed arrays'; END IF;
 RETURN coalesce(value::text,'null');
END $$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_budget_coverage(b jsonb,period text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_build_array('budget-outlook-1.0.0',period,b->'policy'->'fixedCostReserveCents',
  coalesce((SELECT jsonb_agg(jsonb_build_array(a->'id',a->'idempotencyKey',a->'period',a->'amountCents',a->'category',a->'reason',a->'actorId',a->'createdAt') ORDER BY (a->>'id') COLLATE "C") FROM jsonb_array_elements(b->'adjustments') a WHERE a->>'period'=period),'[]'),
  coalesce((SELECT jsonb_agg(jsonb_build_array(r->'id',r->'maximumCents',r->'actualCents',r->'settledAt',r->'settledPeriod') ORDER BY (r->>'id') COLLATE "C") FROM jsonb_array_elements(b->'reservations') r WHERE r->>'status'='settled' AND (r->>'actualCents')::bigint>(r->>'maximumCents')::bigint),'[]'))
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_budget_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,__SCHEMA__ AS $$
 SELECT encode(sha256(convert_to(__SCHEMA__.app_security_budget_compact(value),'UTF8')),'hex')
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_budget_known(b jsonb,at_time timestamptz) RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 WITH a AS (SELECT coalesce(sum((v->>'amountCents')::bigint) FILTER(WHERE v->>'category'='fixed'),0) fixed,coalesce(sum((v->>'amountCents')::bigint) FILTER(WHERE v->>'category'='variable'),0) variable FROM jsonb_array_elements(b->'adjustments') v WHERE v->>'period'=to_char(at_time AT TIME ZONE 'UTC','YYYY-MM')),
 r AS (SELECT coalesce(sum((v->>'actualCents')::bigint) FILTER(WHERE v->>'status'='settled' AND v->>'settledPeriod'=to_char(at_time AT TIME ZONE 'UTC','YYYY-MM')),0) spent,coalesce(sum((v->>'maximumCents')::bigint) FILTER(WHERE v->>'status'='running' OR (v->>'status'='reserved' AND (v->>'expiresAt')::timestamptz>at_time)),0) held FROM jsonb_array_elements(b->'reservations') v)
 SELECT a.fixed+a.variable+r.spent+greatest(0,(b->'policy'->>'fixedCostReserveCents')::bigint-a.fixed)+r.held FROM a,r
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_budget_accounting(b jsonb,at_time timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 WITH a AS (SELECT coalesce(sum((v->>'amountCents')::bigint) FILTER(WHERE v->>'category'='fixed'),0) fixed,coalesce(sum((v->>'amountCents')::bigint) FILTER(WHERE v->>'category'='variable'),0) variable FROM jsonb_array_elements(b->'adjustments') v WHERE v->>'period'=to_char(at_time AT TIME ZONE 'UTC','YYYY-MM')),
 r AS (SELECT coalesce(sum((v->>'actualCents')::bigint) FILTER(WHERE v->>'status'='settled' AND v->>'settledPeriod'=to_char(at_time AT TIME ZONE 'UTC','YYYY-MM')),0) spent,coalesce(sum((v->>'maximumCents')::bigint) FILTER(WHERE v->>'status'='running' OR (v->>'status'='reserved' AND (v->>'expiresAt')::timestamptz>at_time)),0) held FROM jsonb_array_elements(b->'reservations') v)
 SELECT jsonb_build_array(a.fixed,a.variable+r.spent,greatest(0,(b->'policy'->>'fixedCostReserveCents')::bigint-a.fixed),r.held,a.fixed+a.variable+r.spent+greatest(0,(b->'policy'->>'fixedCostReserveCents')::bigint-a.fixed)+r.held) FROM a,r
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_budget_basis(b jsonb,at_time timestamptz) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,__SCHEMA__ AS $$
 SELECT __SCHEMA__.app_security_budget_hash(jsonb_build_array(__SCHEMA__.app_security_budget_coverage(b,to_char(at_time AT TIME ZONE 'UTC','YYYY-MM')),
  jsonb_build_array(b->'policy'->'version',b->'policy'->'monthlyLimitCents',b->'policy'->'safetyMarginCents',b->'policy'->'paidOperationsPaused'),
  __SCHEMA__.app_security_budget_accounting(b,at_time),
  coalesce((SELECT jsonb_agg(jsonb_build_array(r->'id',r->'idempotencyKey',r->'provider',r->'operation',r->'actorId',r->'period',r->'maximumCents',r->'status',r->'createdAt',r->'expiresAt',r->'startedAt',r->'settledAt',r->'settledPeriod',r->'actualCents',r->'releasedAt',r->'releaseReason') ORDER BY (r->>'id') COLLATE "C") FROM jsonb_array_elements(b->'reservations') r),'[]'),
  CASE WHEN jsonb_array_length(coalesce(b->'costReviews','[]'))>0 THEN jsonb_build_array(b->'costReviews'->-1->'id',b->'costReviews'->-1->'estimatedUnreportedCents') ELSE 'null'::jsonb END))
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_budget_review_dates(created timestamptz,covered timestamptz,expires timestamptz) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT covered<=created AND to_char(covered AT TIME ZONE 'UTC','YYYY-MM')=to_char(created AT TIME ZONE 'UTC','YYYY-MM') AND expires>created AND expires<=covered+interval '168 hours' AND expires<=(date_trunc('month',created AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC'
$$;
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_budget_review() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
DECLARE prior jsonb:=coalesce(OLD.header->'costReviews','[]'); reviews jsonb:=coalesce(NEW.header->'costReviews','[]'); review jsonb; base jsonb; p text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM'); item jsonb; old_item jsonb; admitting boolean:=false; n integer; amount text; created timestamptz; covered timestamptz; expires timestamptz; fields text[]; worker boolean:=__SCHEMA__.app_security_mode('worker.budget') OR __SCHEMA__.app_security_mode('worker.identity-mail');
BEGIN
 IF __SCHEMA__.app_security_kind()='owner' THEN RETURN NEW; END IF;
 IF jsonb_typeof(reviews) IS DISTINCT FROM 'array' OR jsonb_array_length(reviews)<jsonb_array_length(prior) OR jsonb_array_length(reviews)>jsonb_array_length(prior)+1 OR jsonb_array_length(reviews)>10000 OR (SELECT coalesce(jsonb_agg(v ORDER BY i),'[]') FROM jsonb_array_elements(reviews) WITH ORDINALITY a(v,i) WHERE i<=jsonb_array_length(prior)) IS DISTINCT FROM prior THEN RAISE EXCEPTION 'Cost reviews are immutable and append-only' USING ERRCODE='42501'; END IF;
 IF jsonb_array_length(NEW.header->'adjustments')>jsonb_array_length(OLD.header->'adjustments')+1 OR (SELECT coalesce(jsonb_agg(v ORDER BY i),'[]') FROM jsonb_array_elements(NEW.header->'adjustments') WITH ORDINALITY a(v,i) WHERE i<=jsonb_array_length(OLD.header->'adjustments')) IS DISTINCT FROM OLD.header->'adjustments' THEN RAISE EXCEPTION 'Manual ledger entries are immutable and append-only' USING ERRCODE='42501'; END IF;
 IF jsonb_array_length(NEW.header->'adjustments')>jsonb_array_length(OLD.header->'adjustments') THEN
  item:=NEW.header->'adjustments'->-1;
  FOREACH amount IN ARRAY ARRAY['id','idempotencyKey','actorId','createdAt'] LOOP
   IF jsonb_typeof(item->amount) IS DISTINCT FROM 'string' OR length(coalesce(item->>amount,'')) NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'Manual cost identity and creation time are required' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF item->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR NOT isfinite((item->>'createdAt')::timestamptz) THEN RAISE EXCEPTION 'Manual cost identity and creation time are required' USING ERRCODE='23514'; END IF;

  IF NOT (__SCHEMA__.app_security_kind()='web' AND __SCHEMA__.app_security_admin()) OR item->>'actorId' IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR item->>'period' IS DISTINCT FROM p OR jsonb_typeof(item->'amountCents') IS DISTINCT FROM 'number' OR coalesce(item->>'amountCents','') !~ '^-?[0-9]+$' OR (item->>'amountCents')::numeric NOT BETWEEN -100000000 AND 100000000 OR (item->>'amountCents')::numeric=0 OR coalesce(item->>'category','') NOT IN ('fixed','variable') OR length(trim(coalesce(item->>'reason',''))) NOT BETWEEN 5 AND 1000 OR length(coalesce(item->>'idempotencyKey','')) NOT BETWEEN 8 AND 160 OR EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.header->'adjustments') a WHERE a->>'id'=item->>'id' OR a->>'idempotencyKey'=item->>'idempotencyKey') THEN RAISE EXCEPTION 'Invalid manual cost correction' USING ERRCODE='23514'; END IF;
  IF ((__SCHEMA__.app_security_budget_accounting(NEW.header,now())->>0)::bigint)<0 OR ((__SCHEMA__.app_security_budget_accounting(NEW.header,now())->>1)::bigint)<0 THEN RAISE EXCEPTION 'Manual correction cannot erase more than recorded category costs' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.header->'costReviews' IS DISTINCT FROM OLD.header->'costReviews' AND NOT (__SCHEMA__.app_security_kind()='web' AND __SCHEMA__.app_security_admin()) THEN RAISE EXCEPTION 'Only a platform administrator may record cost review evidence' USING ERRCODE='42501'; END IF;
 IF (SELECT coalesce(jsonb_agg(v ORDER BY i),'[]') FROM jsonb_array_elements(NEW.header->'audit') WITH ORDINALITY a(v,i) WHERE i<=jsonb_array_length(OLD.header->'audit')) IS DISTINCT FROM OLD.header->'audit' THEN RAISE EXCEPTION 'Existing budget audit entries are immutable' USING ERRCODE='42501'; END IF;
 IF jsonb_array_length(reviews)>jsonb_array_length(prior) THEN
  review:=reviews->-1; base:=jsonb_set(NEW.header,'{costReviews}',prior);
  IF jsonb_typeof(review) IS DISTINCT FROM 'object' OR review->'version' IS DISTINCT FROM '1'::jsonb OR review->>'methodVersion' IS DISTINCT FROM 'budget-outlook-1.0.0' OR review->>'actorId' IS DISTINCT FROM __SCHEMA__.app_security_principal()->>'userId' OR review->>'period' IS DISTINCT FROM p OR review->'includesPriorUnreported' IS DISTINCT FROM 'true'::jsonb OR review->'replacesReviewId' IS DISTINCT FROM coalesce(prior->-1->'id','null'::jsonb) OR coalesce(review->>'id','') !~ '^[a-f0-9-]{36}$' OR length(coalesce(review->>'idempotencyKey','')) NOT BETWEEN 8 AND 160 OR length(trim(coalesce(review->>'scopeStatement',''))) NOT BETWEEN 12 AND 2000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(prior) r WHERE r->>'id'=review->>'id' OR r->>'idempotencyKey'=review->>'idempotencyKey') THEN RAISE EXCEPTION 'Invalid or stale cost review identity' USING ERRCODE='23514'; END IF;
  FOREACH amount IN ARRAY ARRAY['id','idempotencyKey','actorId','methodVersion','period','basisHash','coverageHash','scopeStatement'] LOOP
   IF jsonb_typeof(review->amount) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Review fields require explicit string values' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF (review-ARRAY['version','methodVersion','id','idempotencyKey','actorId','createdAt','period','coveredThrough','expiresAt','replacesReviewId','includesPriorUnreported','basisHash','coverageHash','accountedAtReviewCents','estimatedUnreportedCents','futureVariable','scopeStatement'])<>'{}'::jsonb OR ((review->'futureVariable')-ARRAY['lowCents','expectedCents','highCents'])<>'{}'::jsonb THEN RAISE EXCEPTION 'Unknown cost review fields' USING ERRCODE='23514'; END IF;
  FOREACH amount IN ARRAY ARRAY['accountedAtReviewCents','estimatedUnreportedCents'] LOOP
   IF jsonb_typeof(review->amount) IS DISTINCT FROM 'number' OR coalesce(review->>amount,'') !~ '^[0-9]+$' OR (review->>amount)::numeric>(CASE WHEN amount='accountedAtReviewCents' THEN 9007199254740991 ELSE 100000000 END) THEN RAISE EXCEPTION 'Invalid review amount' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOREACH amount IN ARRAY ARRAY['lowCents','expectedCents','highCents'] LOOP
   IF jsonb_typeof(review->'futureVariable'->amount) IS DISTINCT FROM 'number' OR coalesce(review->'futureVariable'->>amount,'') !~ '^[0-9]+$' OR (review->'futureVariable'->>amount)::numeric>100000000 THEN RAISE EXCEPTION 'Invalid forecast amount' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF (review->'futureVariable'->>'lowCents')::bigint>(review->'futureVariable'->>'expectedCents')::bigint OR (review->'futureVariable'->>'expectedCents')::bigint>(review->'futureVariable'->>'highCents')::bigint THEN RAISE EXCEPTION 'Invalid forecast order' USING ERRCODE='23514'; END IF;
  FOREACH amount IN ARRAY ARRAY['createdAt','coveredThrough','expiresAt'] LOOP
   IF coalesce(review->>amount,'') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RAISE EXCEPTION 'Invalid review timestamp' USING ERRCODE='23514'; END IF;
  END LOOP;
  created:=(review->>'createdAt')::timestamptz;covered:=(review->>'coveredThrough')::timestamptz;expires:=(review->>'expiresAt')::timestamptz;
  IF abs(extract(epoch FROM created-now()))>60 OR to_char(created AT TIME ZONE 'UTC','YYYY-MM')<>p OR expires<=now() OR __SCHEMA__.app_security_budget_review_dates(created,covered,expires) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Cost review coverage or expiry is invalid' USING ERRCODE='23514'; END IF;
  IF review->>'basisHash' IS DISTINCT FROM __SCHEMA__.app_security_budget_basis(base,created) OR review->>'coverageHash' IS DISTINCT FROM __SCHEMA__.app_security_budget_hash(__SCHEMA__.app_security_budget_coverage(base,p)) OR (review->>'accountedAtReviewCents')::bigint IS DISTINCT FROM __SCHEMA__.app_security_budget_known(base,created) THEN RAISE EXCEPTION 'Cost review must bind exact current accounting' USING ERRCODE='23514'; END IF;
 END IF;
 IF jsonb_array_length(NEW.header->'reservations')>jsonb_array_length(OLD.header->'reservations')+1 OR
 (SELECT count(DISTINCT r->>'id') FROM jsonb_array_elements(NEW.header->'reservations') r)<>jsonb_array_length(NEW.header->'reservations') OR
 (SELECT coalesce(jsonb_agg(r->'id' ORDER BY i),'[]') FROM jsonb_array_elements(NEW.header->'reservations') WITH ORDINALITY a(r,i) WHERE i<=jsonb_array_length(OLD.header->'reservations')) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(r->'id' ORDER BY i),'[]') FROM jsonb_array_elements(OLD.header->'reservations') WITH ORDINALITY a(r,i)) THEN RAISE EXCEPTION 'Reservation identities cannot be erased, reordered or duplicated' USING ERRCODE='42501'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(NEW.header->'reservations') LOOP
  SELECT v INTO old_item FROM jsonb_array_elements(OLD.header->'reservations') v WHERE v->>'id'=item->>'id';
  IF item IS NOT DISTINCT FROM old_item THEN CONTINUE; END IF;
  IF old_item IS NULL THEN
   IF NOT worker OR item->>'status' IS DISTINCT FROM 'reserved' OR jsonb_typeof(item->'maximumCents') IS DISTINCT FROM 'number' OR coalesce(item->>'maximumCents','') !~ '^[0-9]+$' OR (item->>'maximumCents')::numeric NOT BETWEEN 1 AND 100000000 OR item->>'period' IS DISTINCT FROM p OR item->>'createdAt' IS NULL OR item->>'expiresAt' IS NULL OR abs(extract(epoch FROM (item->>'createdAt')::timestamptz-now()))>60 OR (item->>'expiresAt')::timestamptz<=now() OR (item->>'expiresAt')::timestamptz>(item->>'createdAt')::timestamptz+interval '1 hour' OR item ?| ARRAY['startedAt','settledAt','settledPeriod','actualCents','releasedAt','releaseReason'] THEN RAISE EXCEPTION 'New costs require a bounded undispatched reservation' USING ERRCODE='23514'; END IF;
   FOREACH amount IN ARRAY ARRAY['id','idempotencyKey','provider','operation','actorId'] LOOP
    IF jsonb_typeof(item->amount) IS DISTINCT FROM 'string' OR length(coalesce(item->>amount,'')) NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'Invalid reservation identity' USING ERRCODE='23514'; END IF;
   END LOOP;
  ELSE
   fields:=CASE item->>'status' WHEN 'running' THEN ARRAY['status','startedAt'] WHEN 'settled' THEN ARRAY['status','settledAt','settledPeriod','actualCents'] ELSE ARRAY['status','releasedAt','releaseReason'] END;
   IF item-fields IS DISTINCT FROM old_item-fields OR coalesce(old_item->>'status','') NOT IN ('reserved','running') THEN RAISE EXCEPTION 'Reservation evidence and terminal costs are immutable' USING ERRCODE='42501'; END IF;
   CASE item->>'status'
    WHEN 'running' THEN IF NOT worker OR old_item->>'status'<>'reserved' OR (old_item->>'expiresAt')::timestamptz<=now() OR item->>'startedAt' IS NULL THEN RAISE EXCEPTION 'Only an unexpired reservation may start' USING ERRCODE='42501'; END IF; IF NOT isfinite((item->>'startedAt')::timestamptz) THEN RAISE EXCEPTION 'Cost transition time must be finite' USING ERRCODE='23514'; END IF;
    WHEN 'settled' THEN IF NOT __SCHEMA__.app_security_mode('worker.budget') OR old_item->>'status'<>'running' OR jsonb_typeof(item->'actualCents') IS DISTINCT FROM 'number' OR coalesce(item->>'actualCents','') !~ '^[0-9]+$' OR (item->>'actualCents')::numeric>100000000 OR item->>'settledPeriod' IS DISTINCT FROM p OR item->>'settledAt' IS NULL OR ((item->>'actualCents')::bigint>(item->>'maximumCents')::bigint AND NEW.header->'policy'->'paidOperationsPaused' IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'Settlement must retain actual costs and pause on overruns' USING ERRCODE='42501'; END IF; IF NOT isfinite((item->>'settledAt')::timestamptz) THEN RAISE EXCEPTION 'Cost transition time must be finite' USING ERRCODE='23514'; END IF;
    WHEN 'expired' THEN IF old_item->>'status'<>'reserved' OR (old_item->>'expiresAt')::timestamptz>now() OR item->>'releasedAt' IS NULL OR length(coalesce(item->>'releaseReason',''))=0 THEN RAISE EXCEPTION 'Only undispatched expired holds may expire' USING ERRCODE='42501'; END IF; IF NOT isfinite((item->>'releasedAt')::timestamptz) THEN RAISE EXCEPTION 'Cost transition time must be finite' USING ERRCODE='23514'; END IF;
    WHEN 'released' THEN IF NOT worker OR item->>'releasedAt' IS NULL OR length(coalesce(item->>'releaseReason',''))=0 THEN RAISE EXCEPTION 'Release requires trusted no-charge confirmation' USING ERRCODE='42501'; END IF; IF NOT isfinite((item->>'releasedAt')::timestamptz) THEN RAISE EXCEPTION 'Cost transition time must be finite' USING ERRCODE='23514'; END IF;
    ELSE RAISE EXCEPTION 'Invalid reservation transition' USING ERRCODE='42501';
   END CASE;
  END IF;
  admitting:=admitting OR item->>'status' IN ('reserved','running');
 END LOOP;
 IF __SCHEMA__.app_security_kind()='worker' THEN
  IF (SELECT coalesce(jsonb_agg(v ORDER BY i),'[]') FROM jsonb_array_elements(NEW.header->'audit') WITH ORDINALITY a(v,i) WHERE i<=jsonb_array_length(OLD.header->'audit')) IS DISTINCT FROM OLD.header->'audit' THEN RAISE EXCEPTION 'Existing budget audit entries are immutable' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.header->'audit') WITH ORDINALITY a(v,i) WHERE i>jsonb_array_length(OLD.header->'audit') AND v->>'action' IN ('cost-review.recorded','budget.alerts.observed')) THEN RAISE EXCEPTION 'Workers cannot author administrator review or alert observations' USING ERRCODE='42501'; END IF;
  IF NEW.header-ARRAY['reservations','audit','policy'] IS DISTINCT FROM OLD.header-ARRAY['reservations','audit','policy'] THEN RAISE EXCEPTION 'Workers cannot change review evidence or budget metadata' USING ERRCODE='42501'; END IF;
  IF admitting THEN
   review:=reviews->-1;
   IF review IS NULL OR review->>'period' IS DISTINCT FROM p OR (review->>'expiresAt')::timestamptz<=now() OR (review->>'createdAt')::timestamptz>now() OR review->>'coverageHash' IS DISTINCT FROM __SCHEMA__.app_security_budget_hash(__SCHEMA__.app_security_budget_coverage(NEW.header,p)) THEN RAISE EXCEPTION 'Fresh operating cost review required' USING ERRCODE='42501'; END IF;
   IF NEW.header->'policy'->'paidOperationsPaused' IS DISTINCT FROM 'false'::jsonb OR __SCHEMA__.app_security_budget_known(NEW.header,now())+(review->>'estimatedUnreportedCents')::bigint>(NEW.header->'policy'->>'monthlyLimitCents')::bigint-(NEW.header->'policy'->>'safetyMarginCents')::bigint THEN RAISE EXCEPTION 'Reviewed operating budget exceeded' USING ERRCODE='42501'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
DO $install$
DECLARE cfg record; fn regprocedure;
BEGIN
 SELECT * INTO cfg FROM __SCHEMA__.app_security_config WHERE id=1;
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=replace('__SCHEMA__','"','') AND p.proname IN ('app_security_allow_v17','app_security_budget_compact','app_security_budget_coverage','app_security_budget_hash','app_security_budget_basis','app_security_budget_known','app_security_budget_accounting','app_security_budget_review_dates','app_security_budget_review') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,%I,%I,%I',fn,cfg.web_role,cfg.auth_role,cfg.worker_role);
 END LOOP;
END $install$;
DROP TRIGGER IF EXISTS security_budget_review ON __SCHEMA__.app_budget;
CREATE TRIGGER security_budget_review BEFORE UPDATE ON __SCHEMA__.app_budget FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.app_security_budget_review();
CREATE OR REPLACE FUNCTION __SCHEMA__.app_security_runtime_configuration() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,__SCHEMA__,pg_temp AS $$
 SELECT jsonb_build_object('schema',replace('__SCHEMA__','"',''),'owner',migration_role,'role',session_user,'kind',__SCHEMA__.app_security_kind(),'roles',jsonb_build_array(web_role,auth_role,worker_role),'securityVersion',CASE WHEN EXISTS(SELECT 1 FROM __SCHEMA__.app_schema_migrations WHERE version=18) THEN 18 ELSE 0 END) FROM __SCHEMA__.app_security_config WHERE id=1
$$;
INSERT INTO __SCHEMA__.app_schema_migrations(version) VALUES(18) ON CONFLICT DO NOTHING;
