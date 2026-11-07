import { assertMediaStorageChanges } from "./media-storage.js";
import { assertFiscalStorageChanges } from "./fiscal-storage.js";
import { assertBudgetStorageChanges } from "./budget-storage.js";
import { assertStoredAccessibilityAdmission } from "./accessibility-storage-guard.js";
import { assertFloodStorageChanges } from "./flood-storage-guard";
import { assertIdentityStorageChanges } from "./identity-storage.js";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Place } from "@urban/core";
import { emptyState, type DataState, type Store } from "./store.js";
import type { EntityName, IndexField, StoreScope } from "./store-scope.js";
import { legacyNativeCapacity } from "./native-capacity.js";
import { encodeRecord } from "./storage-core.js";
import { assertStoredTrafficAdmission } from "./traffic-storage-guard.js";
import {
  assertSynchronousStoreResult,
  digest,
  diffScopedState,
  encodeState,
  loadScopedState,
  stateFingerprint,
  type ResolvedFilter,
  type ScopeReader,
  type StoredRow,
  type StoreChanges,
} from "./storage-core.js";

const columns: Record<IndexField, string> = {
  id: "entity_id",
  organizationId: "organization_id",
  userId: "user_id",
  projectId: "project_id",
  snapshotId: "snapshot_id",
  email: "email",
};
// DatabaseSync cannot wait on another connection's suspended JS transaction in the same process.
// Serialize those connections locally; SQLite's own locks protect separate processes.
const queues = new Map<string, Promise<void>>();
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}
const bytesHash = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");
function parsePreservedJSON(
  document: string,
  label: "Legacy database" | "Storage migration metadata",
): unknown {
  try {
    return JSON.parse(document);
  } catch {
    throw new Error(`${label} JSON is invalid; original data is unchanged.`);
  }
}
export interface StorageDiagnostics {
  queries: number;
  rows: number;
  payloadBytes: number;
  baselineLoads: number;
  baselineBytes: number;
}

/** Transactional development adapter. The original JSON remains untouched; scoped records live in <filename>.sqlite. */
export class FileStore implements Store {
  kind: Store["kind"];
  readonly databasePath: string;
  private key: string;
  private database?: DatabaseSync;
  private closed = false;
  private counters: StorageDiagnostics = {
    queries: 0,
    rows: 0,
    payloadBytes: 0,
    baselineLoads: 0,
    baselineBytes: 0,
  };
  constructor(private filename?: string) {
    this.kind = filename ? "development-file" : "memory";
    this.databasePath = filename ? `${resolve(filename)}.sqlite` : ":memory:";
    this.key = filename ? this.databasePath : randomUUID();
  }
  diagnostics(reset = false) {
    const result = { ...this.counters };
    if (reset)
      this.counters = {
        queries: 0,
        rows: 0,
        payloadBytes: 0,
        baselineLoads: 0,
        baselineBytes: 0,
      };
    return result;
  }
  private async legacy() {
    if (!this.filename) return null;
    try {
      return await readFile(this.filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async open() {
    if (this.closed) throw new Error("Store is closed.");
    if (this.database) return this.database;
    if (this.filename)
      await mkdir(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.databasePath);
    this.database = database;
    try {
      if (this.filename) await chmod(this.databasePath, 0o600);
      // DELETE journal avoids requiring WAL/version-specific behavior in the experimental Node22 binding.
      database.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
      );
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS baseline_blobs (hash TEXT PRIMARY KEY, document TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS records (
            collection TEXT NOT NULL, entity_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
            organization_id TEXT, user_id TEXT, project_id TEXT, snapshot_id TEXT, email TEXT,
            header TEXT NOT NULL, payload TEXT, baseline_hash TEXT REFERENCES baseline_blobs(hash),
            PRIMARY KEY(collection, entity_id)
          );
          CREATE INDEX IF NOT EXISTS records_order ON records(collection, ordinal);
          CREATE INDEX IF NOT EXISTS records_organization ON records(collection, organization_id, ordinal);
          CREATE INDEX IF NOT EXISTS records_user ON records(collection, user_id, ordinal);
          CREATE INDEX IF NOT EXISTS records_project ON records(collection, project_id, ordinal);
          CREATE INDEX IF NOT EXISTS records_snapshot ON records(collection, snapshot_id, ordinal);
          CREATE INDEX IF NOT EXISTS records_email ON records(collection, email);
          CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON records(email) WHERE collection='users';
          CREATE TABLE IF NOT EXISTS project_versions (
            project_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
            baseline_hash TEXT NOT NULL REFERENCES baseline_blobs(hash), PRIMARY KEY(project_id, version)
          );
        `);
        const marker = database
          .prepare("SELECT value FROM storage_meta WHERE key='migration'")
          .get() as { value: string } | undefined;
        const original = await this.legacy();
        if (marker) {
          const metadata = parsePreservedJSON(
            marker.value,
            "Storage migration metadata",
          ) as {
            version: number;
            legacySha256: string | null;
          };
          if (metadata.version !== 2)
            throw new Error("Unsupported development storage version.");
          if (
            (original === null ? null : bytesHash(original)) !==
            metadata.legacySha256
          )
            throw new Error(
              "The preserved legacy JSON changed after migration. Stop legacy writers and reconcile the files before reopening; the SQLite data is unchanged.",
            );
        } else {
          const legacyState =
            original === null
              ? {}
              : (parsePreservedJSON(original, "Legacy database") as DataState);
          const state = { ...emptyState(), ...legacyState } as DataState;
          if (!Object.hasOwn(legacyState, "nativeCapacity"))
            state.nativeCapacity = legacyNativeCapacity([
              ...state.mediaJobs.map((job) => ({
                ...job,
                kind: "media" as const,
              })),
              ...state.accessibilityJobs.map((job) => ({
                ...job,
                kind: "accessibility" as const,
              })),
              ...state.gisJobs.map((job) => ({ ...job, kind: "gis" as const })),
              ...state.workforceJobs.map((job) => ({
                ...job,
                kind: "workforce" as const,
              })),
              ...state.trafficJobs.map((job) => ({
                ...job,
                kind: "traffic" as const,
              })),
            ]);
          const encoded = encodeState(state);
          if (
            (
              database.prepare("SELECT count(*) AS n FROM records").get() as {
                n: number;
              }
            ).n
          )
            throw new Error(
              "Unmarked storage contains records; refusing an ambiguous migration.",
            );
          this.apply(
            { upserts: encoded.rows, deletes: [], blobs: encoded.blobs },
            true,
          );
          const restored = await loadScopedState(undefined, this.reader());
          if (stateFingerprint(restored.state) !== stateFingerprint(state))
            throw new Error(
              "Migration verification failed; the original JSON is unchanged.",
            );
          if ((await this.legacy()) !== original)
            throw new Error(
              "Legacy data changed during migration; stop its writer and retry.",
            );
          database
            .prepare(
              "INSERT INTO storage_meta(key,value) VALUES('migration',?)",
            )
            .run(
              JSON.stringify({
                version: 2,
                legacySha256: original === null ? null : bytesHash(original),
                stateSha256: stateFingerprint(state),
                records: encoded.rows.length,
                baselines: encoded.blobs.size,
                migratedAt: new Date().toISOString(),
              }),
            );
        }
        // Add the new independent capacity record without touching preserved legacy bytes.
        if (
          !database
            .prepare("SELECT 1 FROM records WHERE collection='nativeCapacity'")
            .get()
        )
          this.apply(
            {
              upserts: [
                encodeRecord(
                  "nativeCapacity",
                  legacyNativeCapacity(
                    (
                      database
                        .prepare(
                          "SELECT collection,header FROM records WHERE collection IN ('gisJobs','workforceJobs','trafficJobs','accessibilityJobs','mediaJobs') AND json_extract(header,'$.status')='running'",
                        )
                        .all() as { collection: string; header: string }[]
                    ).map((r) => ({
                      ...JSON.parse(r.header),
                      kind:
                        r.collection === "mediaJobs"
                          ? "media"
                          : r.collection === "accessibilityJobs"
                            ? "accessibility"
                            : r.collection === "gisJobs"
                              ? "gis"
                              : r.collection === "workforceJobs"
                                ? "workforce"
                                : "traffic",
                    })),
                  ),
                ).row,
              ],
              deletes: [],
              blobs: new Map(),
            },
            true,
          );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return database;
    } catch (error) {
      database.close();
      this.database = undefined;
      throw error;
    }
  }
  private reader(): ScopeReader {
    return {
      query: async (collection, filters, projection) =>
        this.query(collection, filters, projection),
      baselines: async (hashes) => {
        const result = new Map<string, Place>();
        const query = this.database!.prepare(
          "SELECT hash,document FROM baseline_blobs WHERE hash IN (SELECT value FROM json_each(?))",
        );
        for (const row of query.all(JSON.stringify(hashes)) as {
          hash: string;
          document: string;
        }[]) {
          this.counters.baselineLoads++;
          this.counters.baselineBytes += Buffer.byteLength(row.document);
          result.set(row.hash, JSON.parse(row.document) as Place);
        }
        return result;
      },
    };
  }
  private query(
    collection: EntityName,
    filters: ResolvedFilter[] | "all",
    projection: "full" | "header",
  ): StoredRow[] {
    this.counters.queries++;
    const parameters: string[] = [collection];
    let condition = "";
    if (filters !== "all") {
      const clauses = filters.map((filter) => {
        const fields = Object.entries(filter);
        if (!fields.length) return "0";
        return fields
          .map(([field, values]) => {
            const column = columns[field as IndexField];
            if (!column || !Array.isArray(values))
              throw new Error("Invalid storage selector.");
            parameters.push(JSON.stringify(values));
            return `${column} IN (SELECT value FROM json_each(?))`;
          })
          .join(" AND ");
      });
      condition = ` AND (${clauses.length ? clauses.map((clause) => `(${clause})`).join(" OR ") : "0"})`;
    }
    const rows = this.database!.prepare(
      `SELECT collection,entity_id,ordinal,organization_id,user_id,project_id,snapshot_id,email,header,baseline_hash${projection === "full" ? ",payload" : ""} FROM records WHERE collection=?${condition} ORDER BY ordinal`,
    ).all(...parameters);
    this.counters.rows += rows.length;
    return rows.map((value) => {
      const row = value as Record<string, string | number | null>;
      const indexes: StoredRow["indexes"] = { id: String(row.entity_id) };
      for (const [field, column] of Object.entries(columns))
        if (typeof row[column] === "string")
          indexes[field as IndexField] = row[column] as string;
      this.counters.payloadBytes +=
        typeof row.payload === "string" ? Buffer.byteLength(row.payload) : 0;
      return {
        collection,
        id: String(row.entity_id),
        ordinal: Number(row.ordinal),
        indexes,
        header: JSON.parse(String(row.header)),
        ...(projection === "full"
          ? {
              payload:
                row.payload === null ? null : JSON.parse(String(row.payload)),
            }
          : {}),
        ...(row.baseline_hash
          ? { baselineHash: String(row.baseline_hash) }
          : {}),
      };
    });
  }
  private apply(changes: StoreChanges, migration = false) {
    const database = this.database!;
    for (const [hash, value] of changes.blobs) {
      if (digest(value) !== hash)
        throw new Error("Invalid baseline content hash.");
      database
        .prepare(
          "INSERT INTO baseline_blobs(hash,document) VALUES(?,?) ON CONFLICT(hash) DO NOTHING",
        )
        .run(hash, JSON.stringify(value));
      const existing = database
        .prepare("SELECT document FROM baseline_blobs WHERE hash=?")
        .get(hash) as { document: string };
      if (digest(JSON.parse(existing.document)) !== hash)
        throw new Error("Stored baseline is corrupt; write rolled back.");
    }
    for (const row of changes.deletes)
      database
        .prepare("DELETE FROM records WHERE collection=? AND entity_id=?")
        .run(row.collection, row.id);
    let nextOrdinal = Number(
      (
        database
          .prepare("SELECT coalesce(max(ordinal),0) AS n FROM records")
          .get() as { n: number }
      ).n,
    );
    for (const row of changes.upserts) {
      if (!migration)
        assertStoredAccessibilityAdmission(row, (jobId) => {
          const job = database
            .prepare(
              "SELECT header FROM records WHERE collection='accessibilityJobs' AND entity_id=?",
            )
            .get(jobId) as { header: string } | undefined;
          const decoded = job ? JSON.parse(job.header) : undefined;
          const artifact = decoded?.result?.artifactId
            ? (database
                .prepare(
                  "SELECT header FROM records WHERE collection='accessibilityArtifacts' AND entity_id=?",
                )
                .get(decoded.result.artifactId) as
                | { header: string }
                | undefined)
            : undefined;
          return {
            job: decoded,
            artifact: artifact ? JSON.parse(artifact.header) : undefined,
          };
        });
      if (!migration)
        assertStoredTrafficAdmission(row, (captureId, jobId) => {
          const artifact = database
            .prepare(
              "SELECT header FROM records WHERE collection='trafficArtifacts' AND entity_id=?",
            )
            .get(captureId) as { header: string } | undefined;
          const job = database
            .prepare(
              "SELECT header FROM records WHERE collection='trafficJobs' AND entity_id=?",
            )
            .get(jobId) as { header: string } | undefined;
          return {
            artifact: artifact ? JSON.parse(artifact.header) : undefined,
            job: job ? JSON.parse(job.header) : undefined,
          };
        });
      const existing = database
        .prepare(
          "SELECT ordinal FROM records WHERE collection=? AND entity_id=?",
        )
        .get(row.collection, row.id) as { ordinal: number } | undefined;
      if (existing && row.ordinal === 0)
        throw new Error(
          "A new record conflicts with an unselected existing record; no data was overwritten.",
        );
      if (!existing && row.payload === undefined)
        throw new Error("Cannot update an absent header.");
      if (
        !existing &&
        row.collection === "projects" &&
        database
          .prepare("SELECT 1 FROM project_versions WHERE project_id=? LIMIT 1")
          .get(row.id)
      )
        throw new Error("A retired project ID cannot be reused.");
      const ordinal =
        existing?.ordinal ??
        (migration && row.ordinal > 0 ? row.ordinal : ++nextOrdinal);
      if (row.payload === undefined) {
        database
          .prepare(
            "UPDATE records SET header=? WHERE collection=? AND entity_id=?",
          )
          .run(JSON.stringify(row.header), row.collection, row.id);
      } else {
        database
          .prepare(
            `INSERT INTO records(collection,entity_id,ordinal,organization_id,user_id,project_id,snapshot_id,email,header,payload,baseline_hash)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(collection,entity_id) DO UPDATE SET
          organization_id=excluded.organization_id,user_id=excluded.user_id,project_id=excluded.project_id,snapshot_id=excluded.snapshot_id,email=excluded.email,header=excluded.header,payload=excluded.payload,baseline_hash=excluded.baseline_hash`,
          )
          .run(
            row.collection,
            row.id,
            ordinal,
            row.indexes.organizationId ?? null,
            row.indexes.userId ?? null,
            row.indexes.projectId ?? null,
            row.indexes.snapshotId ?? null,
            row.indexes.email ?? null,
            JSON.stringify(row.header),
            row.payload === null ? null : JSON.stringify(row.payload),
            row.baselineHash ?? null,
          );
        if (row.collection === "projects") {
          const version = row.header.version;
          if (
            typeof version !== "number" ||
            !Number.isSafeInteger(version) ||
            version < 1
          )
            throw new Error(
              "A project version must be a positive safe integer.",
            );
          const payload = JSON.stringify(row.payload);
          const prior = database
            .prepare(
              "SELECT payload,baseline_hash FROM project_versions WHERE project_id=? AND version=?",
            )
            .get(row.id, version) as
            | { payload: string; baseline_hash: string }
            | undefined;
          if (
            prior &&
            (digest(JSON.parse(prior.payload)) !== digest(row.payload) ||
              prior.baseline_hash !== row.baselineHash)
          )
            throw new Error(
              "A saved project content version is immutable; increment its version before changing content.",
            );
          database
            .prepare(
              "INSERT INTO project_versions(project_id,version,payload,baseline_hash) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
            )
            .run(row.id, version, payload, row.baselineHash!);
        }
      }
    }
  }
  read<T>(operation: (state: DataState) => T, scope?: StoreScope): Promise<T> {
    return enqueue(this.key, async () => {
      const database = await this.open();
      database.exec("BEGIN");
      try {
        const loaded = await loadScopedState(scope, this.reader());
        const result = operation(loaded.state);
        assertSynchronousStoreResult(result);
        const detached = structuredClone(result);
        database.exec("COMMIT");
        return detached;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }
  transaction<T>(
    operation: (state: DataState) => T,
    scope?: StoreScope,
  ): Promise<T> {
    return enqueue(this.key, async () => {
      const database = await this.open();
      database.exec("BEGIN IMMEDIATE");
      try {
        const loaded = await loadScopedState(scope, this.reader());
        const result = operation(loaded.state);
        assertSynchronousStoreResult(result);
        const detached = structuredClone(result);
        const changes = diffScopedState(loaded);
        assertFiscalStorageChanges(
          changes,
          scope,
          (collection, id) => {
            const row = database
              .prepare(
                "SELECT header,payload FROM records WHERE collection=? AND entity_id=?",
              )
              .get(collection, id);
            return row
              ? {
                  ...JSON.parse(String(row.header)),
                  ...(row.payload ? JSON.parse(String(row.payload)) : {}),
                }
              : undefined;
          },
          (collection, org) =>
            database
              .prepare(
                "SELECT header FROM records WHERE collection=? AND organization_id=?",
              )
              .all(collection, org)
              .map((r) => JSON.parse(String(r.header))),
        );
        assertFloodStorageChanges(
          changes,
          scope,
          (collection, id) => {
            const pending = changes.upserts.find(
              (r) => r.collection === collection && r.id === id,
            );
            // Prior project content is required for immutability checks; source records are installed separately.
            const raw = database
              .prepare(
                "SELECT collection,entity_id,ordinal,header,payload,baseline_hash,organization_id,project_id FROM records WHERE collection=? AND entity_id=?",
              )
              .get(collection, id) as Record<string, unknown> | undefined;
            if (!raw)
              return collection === "floodSources" ? pending : undefined;
            return {
              collection: collection as import("./store-scope").EntityName,
              id,
              ordinal: Number(raw.ordinal),
              header: JSON.parse(String(raw.header)),
              payload: raw.payload ? JSON.parse(String(raw.payload)) : null,
              indexes: {
                id,
                ...(raw.organization_id
                  ? { organizationId: String(raw.organization_id) }
                  : {}),
                ...(raw.project_id
                  ? { projectId: String(raw.project_id) }
                  : {}),
              },
              ...(raw.baseline_hash
                ? { baselineHash: String(raw.baseline_hash) }
                : {}),
            };
          },
          (hash) => {
            const pending = changes.blobs.get(hash);
            if (pending) return pending;
            const raw = database
              .prepare("SELECT document FROM baseline_blobs WHERE hash=?")
              .get(hash) as { document: string } | undefined;
            return raw ? (JSON.parse(raw.document) as Place) : undefined;
          },
        );
        assertBudgetStorageChanges(changes, scope, () =>
          JSON.parse(
            String(
              database
                .prepare("SELECT header FROM records WHERE collection='budget'")
                .get()?.header,
            ),
          ),
        );
        assertMediaStorageChanges(changes, scope, (collection) =>
          database
            .prepare(
              collection === "projects"
                ? "SELECT header,NULL AS payload,baseline_hash FROM records WHERE collection=?"
                : "SELECT header,payload,baseline_hash FROM records WHERE collection=?",
            )
            .all(collection)
            .map((r) => ({
              ...JSON.parse(String(r.header)),
              ...(r.payload ? JSON.parse(String(r.payload)) : {}),
              ...(collection === "projects"
                ? { _baselineHash: r.baseline_hash }
                : {}),
            })),
        );
        assertIdentityStorageChanges(changes, scope, (collection) =>
          database
            .prepare("SELECT header,payload FROM records WHERE collection=?")
            .all(collection)
            .map((r) => ({
              ...JSON.parse(String(r.header)),
              ...(r.payload ? JSON.parse(String(r.payload)) : {}),
            })),
        );
        this.apply(changes);
        database.exec("COMMIT");
        return detached;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }
  close(): Promise<void> {
    return enqueue(this.key, async () => {
      this.database?.close();
      this.database = undefined;
      this.closed = true;
    });
  }
}

/** Trusted recovery/QA export. Runtime API handlers must use explicit scopes instead. */
export async function readPersistedState(filename: string): Promise<DataState> {
  const store = new FileStore(filename);
  try {
    return await store.read((state) => state);
  } finally {
    await store.close();
  }
}
