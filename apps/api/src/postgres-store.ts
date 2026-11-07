import { legacyNativeCapacity } from "./native-capacity.js";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { canonicalJSON, type Place } from "@urban/core";
import type { Store, DataState } from "./store.js";
import type { StorageDiagnostics } from "./file-store.js";
import { emptyState } from "./store.js";
import {
  installPostgresSecurity,
  assertPostgresRuntimeRole,
  type PostgresSecurityConfig,
} from "./postgres-security.js";
import type { EntityName, IndexField, StoreScope } from "./store-scope.js";
import {
  loadScopedState,
  diffScopedState,
  encodeState,
  stateFingerprint,
  assertSynchronousStoreResult,
  type ScopeReader,
  type StoredRow,
  type ResolvedFilter,
  type StoreChanges,
} from "./storage-core.js";

const tables: Record<EntityName, string> = {
  fiscalProfiles: "app_fiscal_profiles",
  fiscalStudyCreations: "app_fiscal_study_creations",
  identityChallenges: "app_identity_challenges",
  identityInvitations: "app_identity_invitations",
  identityOutbox: "app_identity_outbox",
  users: "app_users",
  organizations: "app_organizations",
  memberships: "app_memberships",
  sessions: "app_sessions",
  projects: "app_projects",
  audit: "app_audit",
  comments: "app_comments",
  published: "app_published",
  publicFeedback: "app_public_feedback",
  imports: "app_imports",
  preparationJobs: "app_preparation_jobs",
  workforceJobs: "app_workforce_jobs",
  mediaJobs: "app_media_jobs",
  mediaArtifacts: "app_media_artifacts",
  accessibilityJobs: "app_accessibility_jobs",
  floodSources: "app_flood_sources",
  accessibilityArtifacts: "app_accessibility_artifacts",
  gisJobs: "app_gis_jobs",
  workforceArtifacts: "app_workforce_artifacts",
  trafficConfigs: "app_traffic_configs",
  trafficUploads: "app_traffic_uploads",
  trafficJobs: "app_traffic_jobs",
  trafficArtifacts: "app_traffic_artifacts",
  nativeCapacity: "app_native_capacity",
  budget: "app_budget",
  preparationControl: "app_preparation_control",
};
const columns: Record<IndexField, string> = {
  id: "id",
  organizationId: "organization_id",
  userId: "user_id",
  projectId: "project_id",
  snapshotId: "snapshot_id",
  email: "email",
};
const migrationLock = 752188018,
  writeLock = 752188019;
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJSON(value)).digest("hex");
interface DatabaseRow {
  id: string;
  ordinal: string;
  organization_id: string | null;
  user_id: string | null;
  project_id: string | null;
  snapshot_id: string | null;
  email: string | null;
  header: Record<string, unknown>;
  payload?: unknown;
  baseline_hash: string | null;
}

export type PostgresStoreOptions =
  | { mode: "operator"; poolMax?: number }
  | {
      mode?: "runtime";
      authConnectionString: string;
      workerConnectionString: string;
      poolMax?: number;
    };

/** Entity persistence with scoped hydration. A conservative global write gate remains
 * during this migration to preserve callback-wide predicate invariants. */
export class PostgresStore implements Store {
  kind = "postgres" as const;
  private pool: pg.Pool;
  private authPool?: pg.Pool;
  private workerPool?: pg.Pool;
  private operator: boolean;
  private secured = false;
  private ready = false;
  get managesMembershipPruning() {
    return this.secured;
  }
  private counters: StorageDiagnostics = {
    queries: 0,
    rows: 0,
    payloadBytes: 0,
    baselineLoads: 0,
    baselineBytes: 0,
  };
  constructor(connectionString: string, options: PostgresStoreOptions) {
    this.operator = options.mode === "operator";
    this.pool = new pg.Pool({ connectionString, max: options.poolMax ?? 10 });
    if (options.mode !== "operator") {
      if (!options.authConnectionString || !options.workerConnectionString)
        throw new Error(
          "PostgreSQL runtime requires separate authentication and worker connections.",
        );
      this.authPool = new pg.Pool({
        connectionString: options.authConnectionString,
        max: options.poolMax ?? 3,
      });
      this.workerPool = new pg.Pool({
        connectionString: options.workerConnectionString,
        max: options.poolMax ?? 3,
      });
    }
  }

  /** Runtime credentials never run migrations or inherit the table owner. */
  async initialize(platformAdminUserIds?: string[]) {
    if (this.operator)
      throw new Error(
        "Operator stores cannot initialize as application runtime.",
      );
    this.ready = false;
    let target: string | undefined;
    for (const [pool, role] of [
      [this.pool, "web"],
      [this.authPool!, "auth"],
      [this.workerPool!, "worker"],
    ] as const) {
      const client = await pool.connect();
      try {
        const configuration = await assertPostgresRuntimeRole(client, role);
        const identity = canonicalJSON({
          database: configuration.database,
          schema: configuration.schema,
          owner: configuration.owner,
          roles: configuration.roles,
        });
        if (target && identity !== target)
          throw new Error(
            "Runtime database connections do not share the same application security configuration.",
          );
        target = identity;
        if (role === "web" && platformAdminUserIds) {
          const result = await client.query<{ matches: boolean }>(
            "SELECT app_security_admin_ids_match($1::text[]) AS matches",
            [platformAdminUserIds],
          );
          if (!result.rows[0]?.matches)
            throw new Error(
              "Application administrator configuration differs from the operator-managed database allowlist.",
            );
        }
      } finally {
        client.release();
      }
    }
    this.secured = true;
    this.ready = true;
  }

  private connectionPool(scope?: StoreScope) {
    if (this.operator) return this.pool;
    if (!this.ready)
      throw new Error("PostgreSQL runtime security has not been verified.");
    if (!scope)
      throw new Error("Runtime database operations require an explicit scope.");
    return scope.security?.mode === "auth"
      ? this.authPool!
      : scope.security?.mode === "worker"
        ? this.workerPool!
        : this.pool;
  }

  private async context(client: pg.PoolClient, scope?: StoreScope) {
    if (this.operator) return;
    const auth = scope?.security?.mode === "auth" ? scope.security : undefined;
    const context = {
      "urban.session_hash": scope?.auth?.sessionHash ?? "",
      "urban.public_snapshot_id": scope?.publicSnapshotId ?? "",
      "urban.member_email": scope?.memberLookupEmail ?? "",
      "urban.project_id": scope?.projectId ?? "",
      "urban.purpose": scope?.security
        ? `${scope.security.mode}.${scope.security.purpose}`
        : "",
      "urban.identity_outbox_id":
        scope?.security?.mode === "worker"
          ? (scope.security.outboxId ?? "")
          : "",
      "urban.identity_lease_token":
        scope?.security?.mode === "worker"
          ? (scope.security.leaseToken ?? "")
          : "",
      "urban.auth_email": auth && "email" in auth ? auth.email : "",
      "urban.auth_user_id": auth && "userId" in auth ? auth.userId : "",
      "urban.auth_organization_id":
        auth && "organizationId" in auth ? auth.organizationId : "",
      "urban.auth_credential_version":
        auth && "credentialVersion" in auth
          ? String(auth.credentialVersion ?? 0)
          : "0",
      "urban.identity_challenge_id":
        auth && "challengeId" in auth ? auth.challengeId : "",
      "urban.identity_invitation_id":
        auth && "invitationId" in auth ? auth.invitationId : "",
      "urban.identity_invitation_version":
        auth && "invitationVersion" in auth
          ? String(auth.invitationVersion)
          : "",
      "urban.identity_token_hash":
        auth && "tokenHash" in auth ? auth.tokenHash : "",
      "urban.identity_password_hash":
        auth && "expectedPasswordHash" in auth ? auth.expectedPasswordHash : "",
      "urban.auth_session_hash":
        auth && "sessionHash" in auth ? auth.sessionHash : "",
    };
    // Set every known key, including empty values, on every attempt. These settings
    // disappear on COMMIT/ROLLBACK and cannot leak across a reused connection.
    await client.query(
      "SELECT set_config(key, value, true) FROM jsonb_each_text($1::jsonb)",
      [JSON.stringify(context)],
    );
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

  private reader(client: pg.PoolClient, scope?: StoreScope): ScopeReader {
    const gis =
      this.secured &&
      scope?.security?.mode === "worker" &&
      scope.security.purpose === "gis";
    const traffic =
      this.secured &&
      scope?.security?.mode === "worker" &&
      scope.security.purpose === "traffic";
    return {
      query: async (
        collection: EntityName,
        filters: ResolvedFilter[] | "all",
        projection: "full" | "header",
      ) => {
        if (!Object.hasOwn(tables, collection))
          throw new Error("Unknown entity collection.");
        const values: string[][] = [];
        const where =
          filters === "all"
            ? "TRUE"
            : filters
                .map((filter) => {
                  const clauses = Object.entries(filter).map(
                    ([field, matches]) => {
                      if (!Object.hasOwn(columns, field))
                        throw new Error("Unknown entity index.");
                      if (!matches?.length) return "FALSE";
                      values.push(matches);
                      return `${columns[field as IndexField]}=ANY($${values.length}::text[])`;
                    },
                  );
                  return clauses.length
                    ? `(${clauses.join(" AND ")})`
                    : "FALSE";
                })
                .join(" OR ") || "FALSE";
        // Header reads deliberately omit payload, avoiding full scenario/history detoasting.
        const result = await client.query<DatabaseRow>(
          `SELECT id,ordinal,organization_id,user_id,project_id,snapshot_id,email,${this.secured && collection === "users" ? "app_security_user_header(id) AS header" : this.secured && collection === "publicFeedback" ? "app_security_feedback_header(id) AS header" : "header"},baseline_hash${projection === "full" ? (this.secured && collection === "identityOutbox" && !this.operator ? ",app_security_identity_outbox_payload(id) AS payload" : (gis || traffic) && collection === "projects" ? `,app_security_${traffic ? "traffic" : "gis"}_project_payload(id) AS payload` : ",payload") : ""} FROM ${tables[collection]} WHERE ${where} ORDER BY ordinal,id`,
          values,
        );
        this.counters.queries++;
        this.counters.rows += result.rows.length;
        for (const row of result.rows)
          if (row.payload != null)
            this.counters.payloadBytes += Buffer.byteLength(
              JSON.stringify(row.payload),
            );
        return result.rows.map(
          (row): StoredRow => ({
            collection,
            id: row.id,
            ordinal: Number(row.ordinal),
            indexes: Object.fromEntries(
              Object.entries(columns).flatMap(([field, column]) =>
                typeof row[column as keyof DatabaseRow] === "string"
                  ? [[field, row[column as keyof DatabaseRow]]]
                  : [],
              ),
            ),
            header: row.header,
            ...(projection === "full" ? { payload: row.payload } : {}),
            ...(row.baseline_hash ? { baselineHash: row.baseline_hash } : {}),
          }),
        );
      },
      baselines: async (hashes: string[]) => {
        const wanted = [...new Set(hashes)];
        if (!wanted.length) return new Map();
        const result = await client.query<{
          sha256: string;
          place_id: string;
          payload: Place;
        }>(
          gis || traffic
            ? `SELECT requested.sha256,value.payload->>'id' AS place_id,value.payload FROM unnest($1::text[]) requested(sha256) CROSS JOIN LATERAL (SELECT app_security_${traffic ? "traffic" : "gis"}_baseline(requested.sha256) AS payload) value`
            : "SELECT sha256,place_id,payload FROM app_baseline_snapshots WHERE sha256=ANY($1::text[])",
          [wanted],
        );
        const found = new Map<string, Place>();
        for (const row of result.rows) {
          this.counters.baselineLoads++;
          this.counters.baselineBytes += Buffer.byteLength(
            JSON.stringify(row.payload),
          );
          if (
            hash(row.payload) !== row.sha256 ||
            row.payload.id !== row.place_id
          )
            throw new Error(
              "An immutable baseline failed its integrity check.",
            );
          found.set(row.sha256, row.payload);
        }
        if (found.size !== wanted.length)
          throw new Error(
            "An immutable baseline is missing. No replacement source was substituted.",
          );
        return found;
      },
    };
  }

  private async putBlob(client: pg.PoolClient, sha256: string, place: Place) {
    const canonical = canonicalJSON(place);
    if (createHash("sha256").update(canonical).digest("hex") !== sha256)
      throw new Error(
        "Baseline content does not match its immutable identity.",
      );
    if (this.secured) {
      await client.query("SELECT app_security_put_baseline($1,$2)", [
        sha256,
        canonical,
      ]);
      return;
    }
    await client.query(
      "INSERT INTO app_baseline_snapshots(sha256,place_id,payload,canonical_bytes) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(sha256) DO NOTHING",
      [sha256, place.id, canonical, Buffer.byteLength(canonical)],
    );
    const existing = await client.query<{ place_id: string; payload: Place }>(
      "SELECT place_id,payload FROM app_baseline_snapshots WHERE sha256=$1",
      [sha256],
    );
    if (
      existing.rows[0]?.place_id !== place.id ||
      hash(existing.rows[0]?.payload) !== sha256
    )
      throw new Error(
        "An existing immutable baseline failed its integrity check.",
      );
  }

  private async archiveProject(client: pg.PoolClient, row: StoredRow) {
    if (row.collection !== "projects" || row.payload === undefined) return;
    const version = row.header.version,
      organizationId = row.indexes.organizationId;
    if (
      !Number.isSafeInteger(version) ||
      Number(version) < 1 ||
      !organizationId ||
      !row.baselineHash
    )
      throw new Error("A project version has incomplete persistence metadata.");
    const contentHash = hash(row.payload);
    await client.query(
      "INSERT INTO app_project_versions(project_id,version,organization_id,baseline_hash,payload,content_sha256) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(project_id,version) DO NOTHING",
      [
        row.id,
        version,
        organizationId,
        row.baselineHash,
        JSON.stringify(row.payload),
        contentHash,
      ],
    );
    const prior = await client.query<{
      content_sha256: string;
      baseline_hash: string;
      organization_id: string;
    }>(
      "SELECT content_sha256,baseline_hash,organization_id FROM app_project_versions WHERE project_id=$1 AND version=$2",
      [row.id, version],
    );
    if (
      prior.rows[0]?.content_sha256 !== contentHash ||
      prior.rows[0]?.baseline_hash !== row.baselineHash ||
      prior.rows[0]?.organization_id !== organizationId
    )
      throw new Error(
        "A saved project content version cannot be silently replaced.",
      );
  }

  private async apply(client: pg.PoolClient, changes: StoreChanges) {
    for (const [sha256, place] of changes.blobs)
      await this.putBlob(client, sha256, place);
    for (const row of changes.upserts) {
      if (!Object.hasOwn(tables, row.collection))
        throw new Error("Unknown entity collection.");
      // New scoped inserts must never overwrite an unseen row with the same identity.
      if (row.ordinal === 0) {
        const existing = await client.query(
          `SELECT 1 FROM ${tables[row.collection]} WHERE id=$1`,
          [row.id],
        );
        if (existing.rowCount)
          throw new Error(
            "A newly appended entity already exists outside the selected scope.",
          );
        if (row.collection === "projects") {
          const retired = await client.query(
            this.secured
              ? "SELECT 1 WHERE app_security_project_id_used($1)"
              : "SELECT 1 FROM app_project_versions WHERE project_id=$1 LIMIT 1",
            [row.id],
          );
          if (retired.rowCount)
            throw new Error("A retired project identity cannot be reused.");
        }
      }
      const values = [
        row.id,
        row.indexes.organizationId ?? null,
        row.indexes.userId ?? null,
        row.indexes.projectId ?? null,
        row.indexes.snapshotId ?? null,
        row.indexes.email ?? null,
        JSON.stringify(row.header),
      ];
      if (row.payload === undefined) {
        const result = await client.query(
          `UPDATE ${tables[row.collection]} SET organization_id=$2,user_id=$3,project_id=$4,snapshot_id=$5,email=$6,header=$7::jsonb,updated_at=now() WHERE id=$1`,
          values,
        );
        if (result.rowCount !== 1)
          throw new Error("A metadata-only update cannot create an entity.");
      } else {
        if (!this.secured) await this.archiveProject(client, row);
        const saved = await client.query(
          row.ordinal > 0 && this.secured
            ? `UPDATE ${tables[row.collection]} SET organization_id=$2,user_id=$3,project_id=$4,snapshot_id=$5,email=$6,header=$7::jsonb,payload=$8::jsonb,baseline_hash=$9,ordinal=$10,updated_at=now() WHERE id=$1`
            : `INSERT INTO ${tables[row.collection]}(id,organization_id,user_id,project_id,snapshot_id,email,header,payload,baseline_hash,ordinal) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,CASE WHEN $10::bigint>0 THEN $10::bigint ELSE nextval('app_entity_ordinal') END)${this.secured ? "" : " ON CONFLICT(id) DO UPDATE SET organization_id=EXCLUDED.organization_id,user_id=EXCLUDED.user_id,project_id=EXCLUDED.project_id,snapshot_id=EXCLUDED.snapshot_id,email=EXCLUDED.email,header=EXCLUDED.header,payload=EXCLUDED.payload,baseline_hash=EXCLUDED.baseline_hash,updated_at=now()"}`,
          [
            ...values,
            JSON.stringify(row.payload),
            row.baselineHash ?? null,
            row.ordinal,
          ],
        );
        if (saved.rowCount !== 1)
          throw new Error("The database did not authorize this entity write.");
      }
    }
    for (const row of changes.deletes) {
      if (!Object.hasOwn(tables, row.collection))
        throw new Error("Unknown entity collection.");
      await client.query(`DELETE FROM ${tables[row.collection]} WHERE id=$1`, [
        row.id,
      ]);
    }
  }

  async migrate(security?: PostgresSecurityConfig) {
    if (!this.operator)
      throw new Error("Migrations require a separate operator connection.");
    const [
      foundation,
      entities,
      workforceEntities,
      gisEntities,
      trafficEntities,
      identityEntities,
      accessibilityEntities,
      floodEntities,
      mediaEntities,
      fiscalEntities,
    ] = await Promise.all([
      readFile(
        new URL("../migrations/001-foundation.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../migrations/002-scoped-entities.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../migrations/004-workforce-entities.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../migrations/006-gis-entities.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../migrations/009-traffic-entities.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../migrations/011-identity-entities.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../migrations/013-accessibility-entities.sql",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL("../migrations/015-flood-entities.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../migrations/019-media-entities.sql", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../migrations/020-fiscal-entities.sql", import.meta.url),
        "utf8",
      ),
    ]);
    const client = await this.pool.connect();
    const previouslySecured = this.secured;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [migrationLock]);
      await client.query("SELECT pg_advisory_xact_lock($1)", [writeLock]);
      await client.query(foundation);
      await client.query("LOCK TABLE app_state IN ACCESS EXCLUSIVE MODE");
      await client.query(entities);
      await client.query(workforceEntities);
      await client.query(gisEntities);
      await client.query(trafficEntities);
      await client.query(identityEntities);
      await client.query(accessibilityEntities);
      await client.query(floodEntities);
      await client.query(mediaEntities);
      await client.query(fiscalEntities);
      const installedSecurity = await client.query<{ installed: boolean }>(
        "SELECT to_regclass(format('%I.app_security_config',current_schema())) IS NOT NULL AS installed",
      );
      this.secured = installedSecurity.rows[0]?.installed === true;
      const migrated = await client.query(
        "SELECT version FROM app_storage_manifest WHERE id=1",
      );
      if (!migrated.rowCount) {
        await client.query(
          "INSERT INTO app_state(id,document) VALUES(1,$1::jsonb) ON CONFLICT(id) DO NOTHING",
          [JSON.stringify(emptyState())],
        );
        const legacy = await client.query<{ document: DataState }>(
          "SELECT document FROM app_state WHERE id=1",
        );
        if (legacy.rows[0]?.document.schemaVersion !== 1)
          throw new Error("Unsupported legacy database version.");
        const state = { ...emptyState(), ...legacy.rows[0].document };
        if (!Object.hasOwn(legacy.rows[0].document, "nativeCapacity"))
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
        const before = stateFingerprint(state),
          encoded = encodeState(state);
        for (const table of Object.values(tables)) {
          const existing = await client.query(`SELECT 1 FROM ${table} LIMIT 1`);
          if (existing.rowCount)
            throw new Error(
              "Unverified normalized rows already exist; migration refused to overwrite them.",
            );
        }
        await this.apply(client, {
          upserts: encoded.rows,
          deletes: [],
          blobs: encoded.blobs,
        });
        const restored = (await loadScopedState(undefined, this.reader(client)))
            .state,
          after = stateFingerprint(restored);
        if (before !== after)
          throw new Error(
            "Normalized storage migration failed complete-state integrity verification.",
          );
        const counts: Record<string, number> = {};
        for (const [collection, table] of Object.entries(tables)) {
          const result = await client.query<{ count: string }>(
            `SELECT count(*) FROM ${table}`,
          );
          counts[collection] = Number(result.rows[0].count);
          if (
            counts[collection] !==
            encoded.rows.filter((row) => row.collection === collection).length
          )
            throw new Error(
              "Normalized storage migration failed entity-count verification.",
            );
        }
        await client.query("SELECT setval('app_entity_ordinal',$1,false)", [
          encoded.rows.reduce((max, row) => Math.max(max, row.ordinal), 0) + 1,
        ]);
        await client.query(
          "INSERT INTO app_storage_manifest(id,version,legacy_fingerprint,verified_fingerprint,entity_counts,baseline_count) VALUES(1,2,$1,$2,$3::jsonb,$4)",
          [before, after, JSON.stringify(counts), encoded.blobs.size],
        );
        await client.query(
          "INSERT INTO app_schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING",
        );
      }
      if (security) {
        const beforeSecurity = stateFingerprint(
          (await loadScopedState(undefined, this.reader(client))).state,
        );
        await installPostgresSecurity(client, security);
        this.secured = true;
        const afterSecurity = stateFingerprint(
          (await loadScopedState(undefined, this.reader(client))).state,
        );
        if (beforeSecurity !== afterSecurity)
          throw new Error(
            "Security migration failed complete-state integrity verification.",
          );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      this.secured = previouslySecured;
      throw error;
    } finally {
      client.release();
    }
  }

  async read<T>(
    operation: (state: DataState) => T,
    scope?: StoreScope,
  ): Promise<T> {
    const client = await this.connectionPool(scope).connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await this.context(client, scope);
      const loaded = await loadScopedState(scope, this.reader(client, scope)),
        result = operation(loaded.state);
      assertSynchronousStoreResult(result);
      const detached = structuredClone(result);
      await client.query("COMMIT");
      return detached;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transaction<T>(
    operation: (state: DataState) => T,
    scope?: StoreScope,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const client = await this.connectionPool(scope).connect();
      let locked = false;
      try {
        // Acquire before BEGIN: a transaction waiting at the gate must not retain
        // a SERIALIZABLE snapshot from before the previous writer committed.
        await client.query("SELECT pg_advisory_lock($1)", [writeLock]);
        locked = true;
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await this.context(client, scope);
        const loaded = await loadScopedState(scope, this.reader(client, scope)),
          result = operation(loaded.state);
        assertSynchronousStoreResult(result);
        const detached = structuredClone(result);
        await this.apply(client, diffScopedState(loaded));
        await client.query("COMMIT");
        return detached;
      } catch (error) {
        await client.query("ROLLBACK");
        if (
          !["40001", "40P01"].includes(
            (error as { code?: string }).code ?? "",
          ) ||
          attempt === 3
        )
          throw error;
      } finally {
        try {
          if (locked)
            await client.query("SELECT pg_advisory_unlock($1)", [writeLock]);
        } catch (error) {
          client.release(true);
          throw error;
        }
        client.release();
      }
    }
    throw new Error("Transaction retry limit exceeded.");
  }
  async close() {
    await Promise.all([
      this.pool.end(),
      this.authPool?.end(),
      this.workerPool?.end(),
    ]);
  }
}
