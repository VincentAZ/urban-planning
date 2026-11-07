import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { PostgresStore } from "../apps/api/src/postgres-store.js";

if (existsSync(".env")) loadEnvFile(".env");
const connection = process.env.DATABASE_MIGRATION_URL;
if (!connection)
  throw new Error(
    "Set DATABASE_MIGRATION_URL to the separate operator connection before applying migrations.",
  );
const requiredRole = (key: string) => {
  const role = process.env[key];
  if (!role || !/^[a-z_][a-z0-9_]{0,62}$/.test(role))
    throw new Error(
      `Set ${key} to the provisioned restricted database role name.`,
    );
  return role;
};
const security = {
  webRole: requiredRole("DATABASE_WEB_ROLE"),
  authRole: requiredRole("DATABASE_AUTH_ROLE"),
  workerRole: requiredRole("DATABASE_WORKER_ROLE"),
  platformAdminUserIds: (process.env.PLATFORM_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
};
const store = new PostgresStore(connection, { mode: "operator" });
try {
  await store.migrate(security);
  process.stdout.write(
    "PostGIS, scoped persistence, and restricted-role security migrations verified.\n",
  );
} catch {
  process.stderr.write(
    "Database migration failed; transaction rolled back. Review the private database logs and configuration.\n",
  );
  process.exitCode = 1;
} finally {
  await store.close();
}
