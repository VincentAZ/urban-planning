import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { canonicalJSON } from "@urban/core";

const databaseName = "state.json.sqlite";
const legacyName = "state.json";
const manifestName = "manifest.json";
interface FileIdentity {
  sha256: string;
  bytes: number;
}
interface SnapshotCounts {
  records: number;
  collections: Record<string, number>;
  baselines: number;
  projectVersions: number;
  retiredProjectIds: number;
  metadata: number;
}
export interface DevelopmentBackupManifest {
  format: "urban-development-backup";
  version: 1;
  storageVersion: 2;
  createdAt: string;
  sourceBasename: string;
  sqliteVersion: string;
  files: {
    "state.json.sqlite": FileIdentity;
    "state.json": FileIdentity | null;
  };
  counts: SnapshotCounts;
  migrationMarkerSha256: string;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function parseStoredJson(value: string, message: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(message);
  } // Do not echo potentially private JSON in CLI errors.
}
async function identity(path: string): Promise<FileIdentity> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("Backup inputs must be regular files.");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return { sha256: digest.digest("hex"), bytes: info.size };
}
async function optionalIdentity(path: string) {
  try {
    return await identity(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function inspect(database: DatabaseSync) {
  const integrity = database.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok")
    throw new Error("SQLite integrity verification failed.");
  if (database.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("SQLite foreign-key verification failed.");
  const marker = database
    .prepare("SELECT value FROM storage_meta WHERE key='migration'")
    .get() as { value?: string } | undefined;
  if (typeof marker?.value !== "string")
    throw new Error(
      "Backups require an already migrated development database.",
    );
  const migration = parseStoredJson(
    marker.value,
    "The storage migration marker is invalid.",
  ) as { version?: number; legacySha256?: string | null };
  if (
    migration.version !== 2 ||
    !(
      migration.legacySha256 === null ||
      (typeof migration.legacySha256 === "string" &&
        /^[a-f0-9]{64}$/.test(migration.legacySha256))
    )
  )
    throw new Error("Unsupported or incomplete storage migration marker.");
  const count = (
    table: "records" | "baseline_blobs" | "project_versions" | "storage_meta",
  ) => Number(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  const counts: SnapshotCounts = {
    records: count("records"),
    collections: Object.fromEntries(
      database
        .prepare(
          "SELECT collection,count(*) AS n FROM records GROUP BY collection ORDER BY collection",
        )
        .all()
        .map((row) => [String(row.collection), Number(row.n)]),
    ),
    baselines: count("baseline_blobs"),
    projectVersions: count("project_versions"),
    metadata: count("storage_meta"),
    retiredProjectIds: Number(
      database
        .prepare(
          "SELECT count(DISTINCT v.project_id) AS n FROM project_versions v WHERE NOT EXISTS(SELECT 1 FROM records r WHERE r.collection='projects' AND r.entity_id=v.project_id)",
        )
        .get()!.n,
    ),
  };
  // The whole database is preserved; validate content-addressed geographic blobs too.
  for (const row of database
    .prepare("SELECT hash,document FROM baseline_blobs")
    .iterate()) {
    if (
      hash(
        canonicalJSON(
          parseStoredJson(
            String(row.document),
            "A captured baseline has invalid stored data.",
          ),
        ),
      ) !== row.hash
    )
      throw new Error(
        "A captured baseline failed backup integrity verification.",
      );
  }
  return {
    counts,
    migration,
    migrationMarkerSha256: hash(marker.value),
    sqliteVersion: String(
      database.prepare("SELECT sqlite_version() AS version").get()!.version,
    ),
  };
}
async function syncFile(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** A complete, consistent SQLite image, not a partial DataState export.
 * VACUUM INTO leaves the source unchanged and includes historical version tables.
 * https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause */
export async function createDevelopmentBackup(options: {
  sourceStatePath: string;
  destinationDirectory: string;
}): Promise<DevelopmentBackupManifest> {
  const source = resolve(options.sourceStatePath),
    destination = resolve(options.destinationDirectory);
  // Inspect existence without opening/migrating an absent source database.
  if (!(await lstat(`${source}.sqlite`)).isFile())
    throw new Error("The source database must be a regular file.");
  await mkdir(destination, { mode: 0o700 }); // Existing directories always fail, even empty ones.
  try {
    const output = join(destination, databaseName);
    const database = new DatabaseSync(`${source}.sqlite`, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
      database.prepare("VACUUM INTO ?").run(output);
    } finally {
      database.close();
    }
    await chmod(output, 0o600);
    const snapshot = new DatabaseSync(output, { readOnly: true });
    let captured: ReturnType<typeof inspect>;
    try {
      captured = inspect(snapshot);
    } finally {
      snapshot.close();
    }
    const original = await optionalIdentity(source);
    if ((original?.sha256 ?? null) !== captured.migration.legacySha256)
      throw new Error(
        "The preserved legacy JSON does not match the database migration marker; no usable backup was created.",
      );
    let legacy: FileIdentity | null = null;
    if (original) {
      const legacyOutput = join(destination, legacyName);
      await copyFile(source, legacyOutput, constants.COPYFILE_EXCL);
      await chmod(legacyOutput, 0o600);
      legacy = await identity(legacyOutput);
      if (
        legacy.sha256 !== captured.migration.legacySha256 ||
        (await identity(source)).sha256 !== legacy.sha256
      )
        throw new Error(
          "The legacy JSON changed while its backup was being captured.",
        );
      await syncFile(legacyOutput);
    }
    await syncFile(output);
    const manifest: DevelopmentBackupManifest = {
      format: "urban-development-backup",
      version: 1,
      storageVersion: 2,
      createdAt: new Date().toISOString(),
      sourceBasename: basename(source),
      sqliteVersion: captured.sqliteVersion,
      files: {
        "state.json.sqlite": await identity(output),
        "state.json": legacy,
      },
      counts: captured.counts,
      migrationMarkerSha256: captured.migrationMarkerSha256,
    };
    const handle = await open(join(destination, manifestName), "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await verifyDevelopmentBackup(destination);
    await syncFile(destination);
    return manifest;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Read-only verification. Restore into a new path; never replace a running database. */
export async function verifyDevelopmentBackup(
  directory: string,
): Promise<DevelopmentBackupManifest> {
  const path = resolve(directory);
  const manifest = parseStoredJson(
    await readFile(join(path, manifestName), "utf8"),
    "The backup manifest is invalid.",
  ) as DevelopmentBackupManifest;
  if (!manifest || typeof manifest !== "object")
    throw new Error("The backup manifest is invalid.");
  if (
    manifest.format !== "urban-development-backup" ||
    manifest.version !== 1 ||
    manifest.storageVersion !== 2 ||
    !manifest.files?.[databaseName] ||
    !Object.hasOwn(manifest.files, legacyName)
  )
    throw new Error("Unsupported or incomplete backup manifest.");
  for (const name of [databaseName, legacyName] as const) {
    const actual = await optionalIdentity(join(path, name));
    if (canonicalJSON(actual) !== canonicalJSON(manifest.files[name]))
      throw new Error(`Backup checksum verification failed for ${name}.`);
  }
  const database = new DatabaseSync(join(path, databaseName), {
    readOnly: true,
  });
  try {
    const captured = inspect(database);
    if (
      canonicalJSON(captured.counts) !== canonicalJSON(manifest.counts) ||
      captured.migrationMarkerSha256 !== manifest.migrationMarkerSha256 ||
      captured.migration.legacySha256 !==
        (manifest.files[legacyName]?.sha256 ?? null)
    )
      throw new Error("Backup metadata or record-count verification failed.");
  } finally {
    database.close();
  }
  return manifest;
}
