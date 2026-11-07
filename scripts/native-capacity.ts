import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import pg from "pg";
import { FileStore, type Store } from "../apps/api/src/store.js";
import { PostgresStore } from "../apps/api/src/postgres-store.js";
import { recoverNativeCapacity } from "../apps/api/src/native-capacity.js";

const { values } = parseArgs({
  options: {
    inspect: { type: "boolean" },
    recover: { type: "boolean" },
    "database-file": { type: "string" },
    token: { type: "string" },
    revision: { type: "string" },
    operator: { type: "string" },
    confirmation: { type: "string" },
    "all-native-processing-confirmed-stopped": { type: "boolean" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  process.stdout.write(
    "Inspect: tsx scripts/native-capacity.ts --inspect --database-file /explicit/path/state.json\nRecover: tsx scripts/native-capacity.ts --recover --database-file /explicit/path/state.json --token TOKEN --revision N --operator NAME --confirmation 'What was stopped and how termination was confirmed' --all-native-processing-confirmed-stopped\nFor PostgreSQL omit --database-file and set DATABASE_MIGRATION_URL to the trusted operator connection. This tool does not terminate processes or migrate databases.\n",
  );
} else {
  if (Boolean(values.inspect) === Boolean(values.recover))
    throw new Error("Choose exactly one of --inspect or --recover.");
  if (values["database-file"] && process.env.DATABASE_MIGRATION_URL)
    throw new Error("Choose one explicit database target, not both.");
  if (values.inspect && values["database-file"]) {
    // Opening the development adapter can initialize/migrate a store. Inspection must never do that.
    const database = new DatabaseSync(
      `${resolve(values["database-file"])}.sqlite`,
      { readOnly: true },
    );
    try {
      const row = database
        .prepare(
          "SELECT header FROM records WHERE collection='nativeCapacity' AND entity_id='nativeCapacity'",
        )
        .get() as { header: string } | undefined;
      if (!row)
        throw new Error(
          "No initialized native-capacity record exists; inspect the configured application database after its explicit upgrade.",
        );
      process.stdout.write(
        JSON.stringify(JSON.parse(row.header), null, 2) + "\n",
      );
    } finally {
      database.close();
    }
  } else {
    if (process.env.DATABASE_MIGRATION_URL) {
      const pool = new pg.Pool({
        connectionString: process.env.DATABASE_MIGRATION_URL,
        max: 1,
      });
      try {
        const result = await pool.query("SELECT app_security_kind() AS kind");
        if (result.rows[0]?.kind !== "owner")
          throw new Error(
            "Native recovery tooling requires the configured trusted migration role, never application credentials.",
          );
      } finally {
        await pool.end();
      }
    }
    let store: Store;
    if (values["database-file"]) store = new FileStore(values["database-file"]);
    else if (process.env.DATABASE_MIGRATION_URL)
      store = new PostgresStore(process.env.DATABASE_MIGRATION_URL, {
        mode: "operator",
      });
    else
      throw new Error(
        "An explicit --database-file or DATABASE_MIGRATION_URL is required.",
      );
    try {
      if (values.inspect)
        process.stdout.write(
          JSON.stringify(
            await store.read((s) => s.nativeCapacity, { nativeCapacity: true }),
            null,
            2,
          ) + "\n",
        );
      else {
        const revision = Number(values.revision);
        if (
          !values["all-native-processing-confirmed-stopped"] ||
          !values.token ||
          !values.operator ||
          !values.confirmation ||
          !Number.isSafeInteger(revision) ||
          revision < 0
        )
          throw new Error(
            "Recovery requires the exact token/revision, identified operator, termination confirmation and explicit stopped-processing acknowledgement.",
          );
        await store.transaction(
          (s) =>
            recoverNativeCapacity(s, {
              expectedRevision: revision,
              token: values.token!,
              operator: values.operator!,
              confirmation: values.confirmation!,
            }),
          { nativeCapacity: true },
        );
        process.stdout.write(
          "Native capacity recovered. The operator confirmation was retained; interrupted jobs still require an explicit retry.\n",
        );
      }
    } finally {
      await store.close();
    }
  }
}
