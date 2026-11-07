/** Real PostgreSQL security fixture: unique schema and actual restricted LOGINs.
 * Administrative credentials are used only to provision/verify this test schema.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PostgresStore } from "./postgres-store.js";
import { emptyState, type DataState } from "./store.js";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export async function createPostgresSecurityFixture(
  connectionString: string,
  options: { state?: DataState; platformAdminUserIds?: string[] } = {},
) {
  const suffix = randomUUID().replaceAll("-", "");
  const schema = `urban_security_${suffix}`;
  const roles = {
    webRole: `urban_web_${suffix}`,
    authRole: `urban_auth_${suffix}`,
    workerRole: `urban_worker_${suffix}`,
  };
  const operator = new pg.Pool({ connectionString, max: 1 });
  const rolePasswords = new Map<string, string>();
  const createdRoles: string[] = [];
  const scoped = (role?: string) => {
    const url = new URL(connectionString);
    url.searchParams.set("options", `-c search_path=${schema},public`);
    if (role) {
      url.username = role;
      url.password = rolePasswords.get(role)!;
    }
    return url.toString();
  };
  const operatorURL = scoped();
  const admin = new pg.Pool({ connectionString: operatorURL, max: 2 });
  const operatorStore = new PostgresStore(operatorURL, { mode: "operator" });
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await operatorStore.close();
    await admin.end();
    try {
      await operator.query(
        `DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`,
      );
      for (const role of createdRoles) {
        await operator.query(`DROP OWNED BY ${identifier(role)}`);
        await operator.query(`DROP ROLE ${identifier(role)}`);
      }
    } finally {
      await operator.end();
    }
  }
  try {
    const operatorRole = String(
      (await operator.query("SELECT current_user AS role")).rows[0].role,
    );
    await operator.query(`CREATE SCHEMA ${identifier(schema)}`);
    for (const role of Object.values(roles)) {
      const password = randomUUID();
      rolePasswords.set(role, password);
      // The password is generated locally and never returned in diagnostics.
      await operator.query(
        `CREATE ROLE ${identifier(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      createdRoles.push(role);
    }
    await admin.query(
      await readFile(
        new URL("../migrations/001-foundation.sql", import.meta.url),
        "utf8",
      ),
    );
    await admin.query(
      "INSERT INTO app_state(id,document) VALUES(1,$1::jsonb)",
      [JSON.stringify(options.state ?? emptyState())],
    );
    await operatorStore.migrate({
      ...roles,
      platformAdminUserIds: options.platformAdminUserIds ?? [],
    });
    return {
      schema,
      roles,
      operatorURL,
      operatorRole,
      webURL: scoped(roles.webRole),
      authURL: scoped(roles.authRole),
      workerURL: scoped(roles.workerRole),
      admin,
      operatorStore,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
