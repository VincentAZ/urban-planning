import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { FileStore, emptyState, type Store } from "../apps/api/src/store.js";
import { assertPostgresRuntimeRole } from "../apps/api/src/postgres-security.js";
import { assertSynchronousStoreResult } from "../apps/api/src/storage-core.js";
import {
  identityMailRunningHolds,
  reconcileStoredIdentityMailInvoice,
} from "../apps/api/src/identity-mail-reconciliation.js";

async function main() {
  const { values } = parseArgs({
    options: {
      list: { type: "boolean" },
      invoice: { type: "string" },
      state: { type: "string" },
      database: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "List: tsx scripts/reconcile-identity-mail.ts --list --state /explicit/state.json\nReconcile: tsx scripts/reconcile-identity-mail.ts --invoice /explicit/invoice.json --state /explicit/state.json\nPostgreSQL: replace --state with --database and configure DATABASE_WORKER_URL. No migrations or implicit state target. Invoice: {reference,totalCents,entries:[{reservationId,actualCents}]}.\n",
    );
  } else {
    if (
      Boolean(values.state) === Boolean(values.database) ||
      Boolean(values.list) === Boolean(values.invoice)
    )
      throw new Error(
        "Choose one explicit --state or --database target and one --list or --invoice action.",
      );
    let store: Store | undefined, pool: pg.Pool | undefined;
    try {
      if (values.state) {
        const path = resolve(values.state);
        await stat(`${path}.sqlite`);
        if (values.list) {
          const db = new DatabaseSync(`${path}.sqlite`, { readOnly: true });
          try {
            const row = db
              .prepare(
                "SELECT header FROM records WHERE collection='budget' AND entity_id='budget'",
              )
              .get();
            if (!row) throw new Error("Initialized budget record required.");
            process.stdout.write(
              `${JSON.stringify(identityMailRunningHolds(JSON.parse(String(row.header))), null, 2)}\n`,
            );
          } finally {
            db.close();
          }
        } else store = new FileStore(path);
      } else {
        if (!process.env.DATABASE_WORKER_URL)
          throw new Error(
            "DATABASE_WORKER_URL is required for explicit --database target.",
          );
        pool = new pg.Pool({
          connectionString: process.env.DATABASE_WORKER_URL,
          max: 1,
        });
        const client = await pool.connect();
        try {
          await assertPostgresRuntimeRole(client, "worker");
        } finally {
          client.release();
        }
        const operate = async <T>(
          write: boolean,
          fn: (state: ReturnType<typeof emptyState>) => T,
        ) => {
          const c = await pool!.connect();
          try {
            await c.query(write ? "BEGIN" : "BEGIN READ ONLY");
            await c.query(
              "SELECT set_config('urban.purpose','worker.budget',true)",
            );
            if (write) await c.query("SELECT pg_advisory_xact_lock(752188019)");
            const result = await c.query(
              `SELECT header FROM app_budget WHERE id='budget'${write ? " FOR UPDATE" : ""}`,
            );
            if (result.rows.length !== 1)
              throw new Error("Initialized budget record required.");
            const state = emptyState();
            state.budget = result.rows[0].header;
            const output = fn(state);
            assertSynchronousStoreResult(output);
            if (write)
              await c.query(
                "UPDATE app_budget SET header=$1::jsonb,updated_at=now() WHERE id='budget'",
                [JSON.stringify(state.budget)],
              );
            await c.query("COMMIT");
            return structuredClone(output);
          } catch (error) {
            await c.query("ROLLBACK");
            throw error;
          } finally {
            c.release();
          }
        };
        store = {
          kind: "postgres",
          read: (fn) => operate(false, fn),
          transaction: (fn) => operate(true, fn),
          close: async () => {},
        };
        if (values.list)
          process.stdout.write(
            `${JSON.stringify(await store.read((s) => identityMailRunningHolds(s.budget)), null, 2)}\n`,
          );
      }
      if (values.invoice) {
        const path = resolve(values.invoice);
        if ((await stat(path)).size > 2_000_000)
          throw new Error("Invoice exceeds the 2 MB operator input limit.");
        const result = await reconcileStoredIdentityMailInvoice(
          store!,
          JSON.parse(await readFile(path, "utf8")),
        );
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
    } finally {
      await store?.close();
      await pool?.end();
    }
  }
}
void main().catch(() => {
  process.stderr.write(
    "Identity mail reconciliation failed. Input, stored data and connection details are not printed.\n",
  );
  process.exitCode = 1;
});
