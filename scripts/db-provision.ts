/** Operator-only provisioning for a NEW dedicated schema and three runtime logins. */
import pg from "pg";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { resolve, dirname, join } from "node:path";

if (existsSync(".env")) loadEnvFile(".env");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--schema" || args[2] !== "--out")
  throw new Error(
    "Usage: tsx scripts/db-provision.ts --schema urban_app --out .local/database-config",
  );
const schema = args[1];
if (!/^[a-z][a-z0-9_]{0,39}$/.test(schema) || schema.startsWith("pg_"))
  throw new Error(
    "Choose a new schema name using 1–40 lowercase letters, digits, or underscores; pg_ is reserved.",
  );
const operatorConnection = process.env.DATABASE_MIGRATION_URL;
if (!operatorConnection)
  throw new Error(
    "DATABASE_MIGRATION_URL must identify the separate database operator.",
  );
const destination = resolve(args[3]);
const roles = {
  web: `${schema}_web`,
  auth: `${schema}_auth`,
  worker: `${schema}_worker`,
};
const passwords = Object.fromEntries(
  Object.keys(roles).map((role) => [role, randomBytes(32).toString("hex")]),
);
const operatorURL = new URL(operatorConnection);
operatorURL.searchParams.set("options", `-c search_path=${schema},public`);
const runtimeURL = (kind: keyof typeof roles) => {
  const url = new URL(operatorURL);
  url.username = roles[kind];
  url.password = passwords[kind];
  return url.toString();
};
const env = (settings: Record<string, string>) =>
  Object.entries(settings)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n";
async function privateFile(name: string, contents: string) {
  const handle = await open(join(destination, name), "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
const pool = new pg.Pool({ connectionString: operatorConnection, max: 1 });
let createdDirectory = false;
let committed = false;
let client: pg.PoolClient | undefined;
try {
  // Never overwrite a previous credential bundle, role, or application schema.
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  createdDirectory = true;
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA ${pg.escapeIdentifier(schema)}`);
  for (const [kind, role] of Object.entries(roles)) {
    await client.query(
      `CREATE ROLE ${pg.escapeIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${pg.escapeLiteral(passwords[kind])}`,
    );
  }
  await privateFile(
    "runtime.env",
    env({
      DATABASE_URL: runtimeURL("web"),
      DATABASE_AUTH_URL: runtimeURL("auth"),
      DATABASE_WORKER_URL: runtimeURL("worker"),
      DATABASE_WEB_ROLE: roles.web,
      DATABASE_AUTH_ROLE: roles.auth,
      DATABASE_WORKER_ROLE: roles.worker,
    }),
  );
  await privateFile(
    "operator.env",
    env({
      DATABASE_MIGRATION_URL: operatorURL.toString(),
      DATABASE_WEB_ROLE: roles.web,
      DATABASE_AUTH_ROLE: roles.auth,
      DATABASE_WORKER_ROLE: roles.worker,
    }),
  );
  const directory = await open(destination, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  await client.query("COMMIT");
  committed = true;
  process.stdout.write(
    "Created a new schema, three restricted login roles, and private runtime/operator configuration files. Apply migrations using operator.env before starting the API with runtime.env. Keep operator.env out of application containers.\n",
  );
} catch {
  if (client && !committed)
    await client.query("ROLLBACK").catch(() => undefined);
  if (createdDirectory && !committed)
    await rm(destination, { recursive: true, force: true });
  process.stderr.write(
    "Provisioning failed; no existing schema or credentials were replaced. Review private database logs/configuration before retrying.\n",
  );
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
