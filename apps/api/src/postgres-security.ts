import type pg from "pg";
import { readFile } from "node:fs/promises";

export interface PostgresSecurityConfig {
  webRole: string;
  authRole: string;
  workerRole: string;
  platformAdminUserIds: string[];
}
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
async function assertRestricted(
  client: pg.PoolClient,
  role: string,
  schema: string,
  owner: string,
) {
  const result = await client.query<{ allowed: boolean }>(
    `SELECT (
    r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole
    AND NOT r.rolcreatedb AND NOT r.rolreplication AND r.rolname<>$3
    AND NOT has_schema_privilege(r.oid,$2,'CREATE')
    AND NOT has_database_privilege(r.oid,current_database(),'CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_roles p WHERE p.oid<>r.oid AND pg_has_role(r.oid,p.oid,'MEMBER')
      AND (p.rolsuper OR p.rolbypassrls OR p.rolcreaterole OR p.rolcreatedb OR p.rolreplication OR p.rolname=$3 OR p.rolname LIKE 'pg\\_%' ESCAPE '\\'
        OR has_schema_privilege(p.oid,$2,'CREATE') OR has_database_privilege(p.oid,current_database(),'CREATE')
        OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2 AND c.relowner=p.oid)
        OR EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname=$2 AND f.proowner=p.oid)))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2 AND c.relowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=$2 AND n.nspowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname=$2 AND f.proowner=r.oid)
  ) AS allowed FROM pg_roles r WHERE r.rolname=$1`,
    [role, schema, owner],
  );
  if (result.rows[0]?.allowed !== true)
    throw new Error(
      `Database role ${role} must be an existing restricted LOGIN role without ownership, schema creation, bypass privileges, or privileged memberships.`,
    );
}

/** Operator-only installation. Caller must hold a transaction after entity migrations 001/002/004/006.
 * Credentials and role creation remain explicit operator tasks; no passwords are generated or logged here. */
export async function installPostgresSecurity(
  client: pg.PoolClient,
  config: PostgresSecurityConfig,
) {
  if (new Set([config.webRole, config.authRole, config.workerRole]).size !== 3)
    throw new Error("Web, authentication, and worker roles must be distinct.");
  const context = (
    await client.query<{ schema: string; owner: string }>(
      "SELECT current_schema() AS schema,current_user AS owner",
    )
  ).rows[0];
  if (!context.schema)
    throw new Error(
      "Select the application schema before installing its security boundary.",
    );
  if (!/^[a-z_][a-z0-9_]*$/.test(context.schema))
    throw new Error(
      "Application schema names must use lowercase letters, digits, and underscores.",
    );
  for (const role of [config.webRole, config.authRole, config.workerRole])
    await assertRestricted(client, role, context.schema, context.owner);
  for (const left of [config.webRole, config.authRole, config.workerRole])
    for (const right of [config.webRole, config.authRole, config.workerRole])
      if (left !== right) {
        const access = await client.query(
          "SELECT pg_has_role($1,$2,'MEMBER') AS allowed",
          [left, right],
        );
        if (access.rows[0].allowed)
          throw new Error(
            "Runtime roles must not inherit or SET ROLE to one another.",
          );
      }
  const sql = (
    await readFile(
      new URL("../migrations/003-row-security.sql", import.meta.url),
      "utf8",
    )
  ).replaceAll("__SCHEMA__", identifier(context.schema));
  await client.query("SELECT pg_advisory_xact_lock(752188018)");
  await client.query(`CREATE TABLE IF NOT EXISTS ${identifier(context.schema)}.app_security_config (
      id integer PRIMARY KEY CHECK(id=1),migration_role text NOT NULL,web_role text NOT NULL,auth_role text NOT NULL,worker_role text NOT NULL,admin_user_ids text[] NOT NULL)`);
  const existing = await client.query(
    `SELECT migration_role FROM ${identifier(context.schema)}.app_security_config WHERE id=1`,
  );
  if (existing.rowCount && existing.rows[0].migration_role !== context.owner)
    throw new Error(
      "Only the recorded migration owner can change runtime security configuration.",
    );
  await client.query(
    `INSERT INTO ${identifier(context.schema)}.app_security_config VALUES(1,$1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET web_role=EXCLUDED.web_role,auth_role=EXCLUDED.auth_role,worker_role=EXCLUDED.worker_role,admin_user_ids=EXCLUDED.admin_user_ids`,
    [
      context.owner,
      config.webRole,
      config.authRole,
      config.workerRole,
      [...new Set(config.platformAdminUserIds)],
    ],
  );
  await client.query(sql);
  const workforceSql = (
    await readFile(
      new URL("../migrations/005-workforce-security.sql", import.meta.url),
      "utf8",
    )
  ).replaceAll("__SCHEMA__", identifier(context.schema));
  await client.query(workforceSql);
  const gisSql = (
    await readFile(
      new URL("../migrations/007-gis-security.sql", import.meta.url),
      "utf8",
    )
  ).replaceAll("__SCHEMA__", identifier(context.schema));
  await client.query(gisSql);
  const trafficSql = (
    await readFile(
      new URL("../migrations/008-traffic-admission.sql", import.meta.url),
      "utf8",
    )
  ).replaceAll("__SCHEMA__", identifier(context.schema));
  await client.query(trafficSql);
  const trafficAuthoritySql = (
    await readFile(
      new URL("../migrations/010-traffic-security.sql", import.meta.url),
      "utf8",
    )
  ).replaceAll("__SCHEMA__", identifier(context.schema));
  await client.query(trafficAuthoritySql);
  await client.query(
    (
      await readFile(
        new URL("../migrations/012-identity-security.sql", import.meta.url),
        "utf8",
      )
    ).replaceAll("__SCHEMA__", identifier(context.schema)),
  );
  await client.query(
    (
      await readFile(
        new URL(
          "../migrations/014-accessibility-security.sql",
          import.meta.url,
        ),
        "utf8",
      )
    ).replaceAll("__SCHEMA__", identifier(context.schema)),
  );
  await client.query(
    (
      await readFile(
        new URL("../migrations/016-flood-security.sql", import.meta.url),
        "utf8",
      )
    ).replaceAll("__SCHEMA__", identifier(context.schema)),
  );
  await client.query(
    (
      await readFile(
        new URL("../migrations/017-flood-method-security.sql", import.meta.url),
        "utf8",
      )
    ).replaceAll("__SCHEMA__", identifier(context.schema)),
  );
  await client.query(
    (
      await readFile(
        new URL(
          "../migrations/018-budget-review-security.sql",
          import.meta.url,
        ),
        "utf8",
      )
    ).replaceAll("__SCHEMA__", identifier(context.schema)),
  );
  await client.query(
    (
      await readFile(
        new URL("../migrations/019-media-security.sql", import.meta.url),
        "utf8",
      )
    ).replaceAll("__SCHEMA__", identifier(context.schema)),
  );
  await client.query(
    (
      await readFile(
        new URL("../migrations/020-fiscal-security.sql", import.meta.url),
        "utf8",
      )
    ).replaceAll("__SCHEMA__", identifier(context.schema)),
  );
  await client.query(
    (
      await readFile(
        new URL("../migrations/021-housing-security.sql", import.meta.url),
        "utf8",
      )
    ).replaceAll("__SCHEMA__", identifier(context.schema)),
  );
}

/** Runtime startup check; never performs migrations or privilege changes. */
export async function assertPostgresRuntimeRole(
  client: pg.PoolClient,
  expected: "web" | "auth" | "worker",
) {
  const result = await client.query<{
    configuration: {
      schema: string;
      owner: string;
      role: string;
      kind: string;
      roles: string[];
      securityVersion: number;
    };
  }>("SELECT app_security_runtime_configuration() AS configuration");
  const configuration = result.rows[0]?.configuration;
  if (!configuration || configuration.kind !== expected)
    throw new Error(
      `This connection is not the configured ${expected} database role.`,
    );
  const location = (
    await client.query<{ schema: string; database: string }>(
      "SELECT current_schema() AS schema,current_database() AS database",
    )
  ).rows[0];
  if (
    configuration.schema !== location.schema ||
    configuration.securityVersion !== 21
  )
    throw new Error(
      "Runtime schema or database security migration does not match the configured application.",
    );
  const protectedTables = [
    "app_fiscal_profiles",
    "app_fiscal_study_creations",
    "app_media_jobs",
    "app_media_artifacts",
    "app_flood_sources",
    "app_housing_sources",
    "app_identity_challenges",
    "app_identity_invitations",
    "app_identity_outbox",
    "app_identity_proofs",
    "app_users",
    "app_organizations",
    "app_memberships",
    "app_sessions",
    "app_projects",
    "app_audit",
    "app_comments",
    "app_published",
    "app_public_feedback",
    "app_imports",
    "app_preparation_jobs",
    "app_budget",
    "app_preparation_control",
    "app_baseline_snapshots",
    "app_project_versions",
    "app_user_credentials",
    "app_feedback_moderation",
    "app_baseline_proofs",
    "app_auth_bootstrap",
    "app_project_write_proofs",
    "app_security_config",
    "app_gis_jobs",
    "app_traffic_configs",
    "app_traffic_uploads",
    "app_traffic_jobs",
    "app_traffic_artifacts",
    "app_native_capacity",
    "app_accessibility_jobs",
    "app_accessibility_artifacts",
    "app_workforce_jobs",
    "app_workforce_artifacts",
  ];
  const protection = await client.query<{ secured: boolean }>(
    `SELECT count(*)=$2::integer AND bool_and(c.relrowsecurity AND c.relforcerowsecurity) AS secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($3::text[])`,
    [configuration.schema, protectedTables.length, protectedTables],
  );
  if (protection.rows[0]?.secured !== true)
    throw new Error(
      "Every application security table must retain enabled and forced row-level security.",
    );
  await assertRestricted(
    client,
    configuration.role,
    configuration.schema,
    configuration.owner,
  );
  for (const other of configuration.roles)
    if (other !== configuration.role) {
      const membership = await client.query(
        "SELECT pg_has_role(current_user,$1,'MEMBER') AS allowed",
        [other],
      );
      if (membership.rows[0].allowed)
        throw new Error("Runtime database roles must remain separate.");
    }
  return { ...configuration, database: location.database };
}
