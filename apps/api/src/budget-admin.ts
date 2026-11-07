/** Trusted operator lookup; grants no role and never changes a user's account. */
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { z } from "zod";
import { FileStore, type Store } from "./store.js";
import { PostgresStore } from "./postgres-store.js";

if (existsSync(".env")) loadEnvFile(".env");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--email")
  throw new Error(
    "Usage: corepack pnpm exec tsx apps/api/src/budget-admin.ts --email owner@example.com",
  );
const email = z.email().parse(args[1].trim().toLowerCase());
let store: Store;
if (process.env.DATABASE_MIGRATION_URL) {
  store = new PostgresStore(process.env.DATABASE_MIGRATION_URL, {
    mode: "operator",
  });
} else {
  if (process.env.NODE_ENV === "production" || process.env.DATABASE_URL)
    throw new Error(
      "Database operator lookup requires DATABASE_MIGRATION_URL.",
    );
  store = new FileStore(
    resolve(process.env.LOCAL_STATE_PATH ?? ".local/api-state.json"),
  );
}
try {
  const user = await store.read(
    (state) => state.users.find((u) => u.email === email),
    { users: { where: [{ email }] } },
  );
  if (!user)
    throw new Error(
      "No registered account matches this email in the configured database.",
    );
  process.stdout.write(
    JSON.stringify(
      {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.createdAt,
        },
        environmentSetting: `PLATFORM_ADMIN_USER_IDS=${user.id}`,
        note: "Verify this is your own registered account. Set the trusted server environment and restart the API. This command grants no role; email addresses are not verified.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await store.close();
}
