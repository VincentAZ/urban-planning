import { parseArgs } from "node:util";
import pg from "pg";
import {
  HousingCatalog,
  installHousingCatalog,
} from "../apps/api/src/housing-catalog";
import { FileStore, type Store } from "../apps/api/src/store";
import { PostgresStore } from "../apps/api/src/postgres-store";
const { values } = parseArgs({
  options: {
    catalog: { type: "string" },
    "database-file": { type: "string" },
    "operator-confirm": { type: "boolean" },
  },
});
if (!values.catalog || !values["operator-confirm"])
  throw new Error(
    "Explicit operator action required: --catalog PREPARED_DIRECTORY --operator-confirm plus --database-file ISOLATED_OR_DEPLOYED_FILE or DATABASE_MIGRATION_URL.",
  );
if (
  Boolean(values["database-file"]) ===
  Boolean(process.env.DATABASE_MIGRATION_URL)
)
  throw new Error("Choose exactly one explicit database target.");
let store: Store;
if (values["database-file"]) store = new FileStore(values["database-file"]);
else {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_MIGRATION_URL,
    max: 1,
  });
  try {
    if (
      (await pool.query("SELECT app_security_kind() AS kind")).rows[0]?.kind !==
      "owner"
    )
      throw new Error(
        "Use the trusted operator database role, never runtime credentials.",
      );
  } finally {
    await pool.end();
  }
  store = new PostgresStore(process.env.DATABASE_MIGRATION_URL!, {
    mode: "operator",
  });
}
try {
  console.log(
    JSON.stringify(
      await installHousingCatalog(store, new HousingCatalog(values.catalog)),
      null,
      2,
    ),
  );
} finally {
  await store.close();
}
