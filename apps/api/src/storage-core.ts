import { createHash } from "node:crypto";
import { canonicalJSON, type Place } from "@urban/core";
import {
  emptyState,
  type DataState,
  type ProjectRecord,
  type PublishedRecord,
} from "./store.js";
import {
  backingCollection,
  collections,
  type CollectionName,
  type EntityName,
  type IndexField,
  type ProjectHeader,
  type PublishedHeader,
  type Selection,
  type StoreScope,
  type ViewName,
} from "./store-scope.js";

export type ResolvedFilter = Partial<Record<IndexField, string[]>>;
export interface StoredRow {
  collection: EntityName;
  id: string;
  ordinal: number;
  indexes: Partial<Record<IndexField, string>>;
  header: Record<string, unknown>;
  /** Undefined on a header projection; null on entities wholly held in header. */
  payload?: unknown;
  baselineHash?: string;
}
export interface ScopeReader {
  query(
    collection: EntityName,
    filters: ResolvedFilter[] | "all",
    projection: "full" | "header",
  ): Promise<StoredRow[]>;
  baselines(hashes: string[]): Promise<Map<string, Place>>;
}
export interface LoadedState {
  state: DataState;
  rows: Map<
    ViewName | "budget" | "preparationControl" | "nativeCapacity",
    StoredRow[]
  >;
}
export interface StoreChanges {
  upserts: StoredRow[];
  deletes: { collection: EntityName; id: string }[];
  blobs: Map<string, Place>;
}
const views: ViewName[] = [
  ...collections,
  "fiscalProfileHeaders",
  "identityOutboxHeaders",
  "projectHeaders",
  "publishedHeaders",
  "workforceArtifactHeaders",
  "accessibilityArtifactHeaders",
  "gisJobHeaders",
  "trafficConfigHeaders",
  "trafficJobHeaders",
  "trafficArtifactHeaders",
];
export const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJSON(value)).digest("hex");
export function stateFingerprint(state: DataState) {
  const {
    fiscalProfileHeaders: _fp,
    identityOutboxHeaders: _mail,
    projectHeaders: _p,
    publishedHeaders: _s,
    workforceArtifactHeaders: _w,
    accessibilityArtifactHeaders: _a,
    gisJobHeaders: _g,
    trafficConfigHeaders: _tc,
    trafficJobHeaders: _tj,
    trafficArtifactHeaders: _ta,
    ...document
  } = state;
  return digest(document);
}
export function projectHeader(record: ProjectRecord): ProjectHeader {
  const { baseline: _b, project, ...metadata } = record;
  return {
    ...metadata,
    project: {
      id: project.id,
      name: project.name,
      placeId: project.placeId,
      updatedAt: project.updatedAt,
      activeScenarioId: project.activeScenarioId,
      scenarios: project.scenarios.map(({ id, name, revision }) => ({
        id,
        name,
        revision,
      })),
    },
  };
}
export function publishedHeader(record: PublishedRecord): PublishedHeader {
  const {
    baseline,
    scenario,
    results: _r,
    floodDataset: _f,
    fiscalStudy: _fs,
    housingIncomeLimits: _housing,
    ...metadata
  } = record;
  return {
    ...metadata,
    baseline: {
      id: baseline.id,
      name: baseline.name,
      extentLabel: baseline.extentLabel,
      sources: baseline.sources,
    },
    scenario: {
      id: scenario.id,
      name: scenario.name,
      revision: scenario.revision,
      ...(scenario.sources ? { sources: scenario.sources } : {}),
    },
  };
}
export function rowIdentity(collection: EntityName, record: any): string {
  const id =
    collection === "projects"
      ? record.project?.id
      : collection === "sessions"
        ? record.hash
        : collection === "memberships"
          ? JSON.stringify([record.userId, record.organizationId])
          : collection === "budget" ||
              collection === "preparationControl" ||
              collection === "nativeCapacity"
            ? collection
            : record.id;
  if (typeof id !== "string" || !id.length)
    throw new Error(
      `Invalid ${collection} record identity; no data was migrated.`,
    );
  return id;
}
export function encodeRecord(
  collection: EntityName,
  record: any,
  ordinal = 0,
): { row: StoredRow; blobs: Map<string, Place> } {
  const id = rowIdentity(collection, record);
  const indexes: StoredRow["indexes"] = { id };
  for (const field of [
    "organizationId",
    "userId",
    "projectId",
    "snapshotId",
    "email",
  ] as const)
    if (typeof record[field] === "string") indexes[field] = record[field];
  if (collection === "users") indexes.userId = id;
  if (collection === "organizations") indexes.organizationId = id;
  if (collection === "projects") indexes.projectId = id;
  if (collection === "published") indexes.snapshotId = id;
  if (collection === "audit" && typeof record.details?.snapshotId === "string")
    indexes.snapshotId = record.details.snapshotId;
  if (collection === "comments" && typeof record.actorId === "string")
    indexes.userId = record.actorId;
  const blobs = new Map<string, Place>();
  let header: Record<string, unknown> = record,
    payload: unknown = null,
    baselineHash: string | undefined;
  if (collection === "projects" || collection === "published") {
    if (!record.baseline || typeof record.baseline !== "object")
      throw new Error(`Missing immutable baseline for ${collection} record.`);
    baselineHash = digest(record.baseline);
    blobs.set(baselineHash, record.baseline);
    if (collection === "projects") {
      header = projectHeader(record) as unknown as Record<string, unknown>;
      payload = { project: record.project };
    } else {
      header = publishedHeader(record) as unknown as Record<string, unknown>;
      payload = {
        scenario: record.scenario,
        results: record.results,
        ...(record.floodDataset ? { floodDataset: record.floodDataset } : {}),
        ...(record.fiscalStudy ? { fiscalStudy: record.fiscalStudy } : {}),
        ...(record.housingIncomeLimits
          ? { housingIncomeLimits: record.housingIncomeLimits }
          : {}),
      };
    }
  }
  if (collection === "identityOutbox") {
    const { sealed, ...metadata } = record;
    header = metadata;
    payload = { sealed };
  }
  if (collection === "housingSources") {
    const { pack, ...metadata } = record;
    header = metadata;
    payload = { pack };
  }
  if (collection === "floodSources") {
    const { dataset, ...metadata } = record;
    header = metadata;
    payload = { dataset };
  }
  if (collection === "trafficConfigs") {
    const { request, ...metadata } = record;
    header = metadata;
    payload = { request };
  }
  if (collection === "fiscalProfiles") {
    const { profile, ...metadata } = record;
    header = metadata;
    payload = { profile };
  }
  if (collection === "gisJobs") {
    const { inspection, recipe, ...metadata } = record;
    header = metadata;
    payload = {
      ...(inspection === undefined ? {} : { inspection }),
      ...(recipe === undefined ? {} : { recipe }),
    };
  }
  if (
    collection === "workforceArtifacts" ||
    collection === "accessibilityArtifacts"
  ) {
    const { contour, ...metadata } = record;
    header = metadata;
    payload = { contour };
  }
  return {
    row: {
      collection,
      id,
      ordinal,
      indexes,
      header,
      payload,
      ...(baselineHash ? { baselineHash } : {}),
    },
    blobs,
  };
}
export function encodeState(input: DataState): {
  rows: StoredRow[];
  blobs: Map<string, Place>;
} {
  if (input.schemaVersion !== 1)
    throw new Error(
      "Unsupported legacy database version; original data is unchanged.",
    );
  const state = { ...emptyState(), ...input };
  const rows: StoredRow[] = [],
    blobs = new Map<string, Place>();
  let ordinal = 0;
  for (const collection of [
    ...collections,
    "budget",
    "preparationControl",
    "nativeCapacity",
  ] as EntityName[]) {
    const entries =
      collection === "budget" ||
      collection === "preparationControl" ||
      collection === "nativeCapacity"
        ? [state[collection]]
        : state[collection];
    if (!Array.isArray(entries))
      throw new Error(
        `Invalid legacy ${collection}; original data is unchanged.`,
      );
    const keys = new Set<string>();
    for (const record of entries) {
      const encoded = encodeRecord(collection, record, ++ordinal);
      if (keys.has(encoded.row.id))
        throw new Error(
          `Duplicate ${collection} record; migration requires repair, original data is unchanged.`,
        );
      keys.add(encoded.row.id);
      rows.push(encoded.row);
      encoded.blobs.forEach((value, key) => blobs.set(key, value));
    }
  }
  return { rows, blobs };
}
export function matchesFilters(
  row: StoredRow,
  filters: ResolvedFilter[] | "all",
) {
  if (filters === "all") return true;
  return filters.some(
    (filter) =>
      Object.keys(filter).length > 0 &&
      Object.entries(filter).every(([field, values]) =>
        values?.includes(
          field === "id" ? row.id : (row.indexes[field as IndexField] ?? ""),
        ),
      ),
  );
}
const mergeRows = (left: StoredRow[], right: StoredRow[]) =>
  [...new Map([...left, ...right].map((row) => [row.id, row])).values()].sort(
    (a, b) => a.ordinal - b.ordinal,
  );

/** Every authorization dependency and selected row is read from the caller's one consistent snapshot. */
export async function loadScopedState(
  scope: StoreScope | undefined,
  reader: ScopeReader,
): Promise<LoadedState> {
  const rows: LoadedState["rows"] = new Map();
  const authRows = new Map<CollectionName, StoredRow[]>();
  let authUserId: string | undefined, authOrganizationId: string | undefined;
  if (scope?.auth) {
    const sessions = scope.auth.sessionHash
      ? await reader.query(
          "sessions",
          [{ id: [scope.auth.sessionHash] }],
          "full",
        )
      : [];
    const session = sessions[0]?.header;
    authUserId =
      typeof session?.userId === "string" ? session.userId : scope.auth.userId;
    authOrganizationId =
      typeof session?.organizationId === "string"
        ? session.organizationId
        : undefined;
    const users = authUserId
      ? await reader.query("users", [{ id: [authUserId] }], "full")
      : [];
    const memberships = authUserId
      ? await reader.query("memberships", [{ userId: [authUserId] }], "full")
      : [];
    const organizationIds = memberships.flatMap((row) =>
      row.indexes.organizationId ? [row.indexes.organizationId] : [],
    );
    const organizations = organizationIds.length
      ? await reader.query("organizations", [{ id: organizationIds }], "full")
      : [];
    authRows.set("sessions", sessions);
    authRows.set("users", users);
    authRows.set("memberships", memberships);
    authRows.set("organizations", organizations);
  }
  const resolving = new Set<ViewName>();
  const resolveView = async (view: ViewName): Promise<StoredRow[]> => {
    if (rows.has(view)) return rows.get(view)!;
    if (resolving.has(view))
      throw new Error(`Cyclic store scope dependency at ${view}.`);
    resolving.add(view);
    const collection = backingCollection(view);
    const selection: Selection | undefined = scope
      ? scope[view]
      : { all: true };
    const initial = authRows.get(collection) ?? [];
    if (!selection && !authRows.has(collection))
      throw new Error(`Store collection ${view} was not selected.`);
    let selected: StoredRow[] = [];
    if (selection && "all" in selection) {
      selected = await reader.query(
        collection,
        "all",
        view.endsWith("Headers") ? "header" : "full",
      );
    } else if (selection && "where" in selection) {
      const filters: ResolvedFilter[] = [];
      for (const clause of selection.where) {
        const filter: ResolvedFilter = {};
        for (const [field, value] of Object.entries(clause)) {
          if (value === undefined)
            throw new Error(`Undefined filter value for ${view}.${field}.`);
          if (typeof value === "string") filter[field as IndexField] = [value];
          else if (Array.isArray(value)) filter[field as IndexField] = value;
          else if ("auth" in value) {
            const id =
              value.auth === "userId" ? authUserId : authOrganizationId;
            filter[field as IndexField] = id ? [id] : [];
          } else {
            const source = await resolveView(value.from);
            filter[field as IndexField] = source.flatMap((row) => {
              if (value.field === "grantUserIds") {
                const acl = row.header.acl as
                  | { members?: { userId: string }[] }
                  | undefined;
                return acl?.members?.map((member) => member.userId) ?? [];
              }
              const id =
                value.field === "configurationId" || value.field === "createdBy"
                  ? row.header[value.field]
                  : value.field === "id"
                    ? row.id
                    : row.indexes[value.field];
              return typeof id === "string" ? [id] : [];
            });
          }
        }
        filters.push(filter);
      }
      selected = await reader.query(
        collection,
        filters,
        view.endsWith("Headers") ? "header" : "full",
      );
    }
    const result = mergeRows(initial, selected);
    rows.set(view, result);
    resolving.delete(view);
    return result;
  };
  for (const view of views)
    if (!scope || scope[view] || authRows.has(backingCollection(view)))
      await resolveView(view);
  for (const singleton of [
    "budget",
    "preparationControl",
    "nativeCapacity",
  ] as const)
    if (!scope || scope[singleton])
      rows.set(singleton, await reader.query(singleton, "all", "full"));
  const hashes = new Set<string>();
  for (const view of ["projects", "published"] as const)
    for (const row of rows.get(view) ?? [])
      if (row.baselineHash) hashes.add(row.baselineHash);
  const baselines = hashes.size
    ? await reader.baselines([...hashes])
    : new Map<string, Place>();
  for (const hash of hashes) {
    const baseline = baselines.get(hash);
    if (!baseline || digest(baseline) !== hash)
      throw new Error(
        "Stored baseline is missing or corrupt; no saved data was changed.",
      );
  }
  const state = { schemaVersion: 1 } as DataState;
  for (const name of [
    ...views,
    "budget",
    "preparationControl",
    "nativeCapacity",
  ] as const) {
    const selected = rows.get(name);
    if (!selected) {
      Object.defineProperty(state, name, {
        enumerable: true,
        get() {
          throw new Error(`Store collection ${name} was not selected.`);
        },
        set() {
          throw new Error(
            `Store collection ${name} was not selected for writing.`,
          );
        },
      });
      continue;
    }
    if (name === "identityOutbox" && scope && selected.length) {
      const security = scope.security;
      if (
        security?.mode !== "worker" ||
        security.purpose !== "identity-mail" ||
        selected.some(
          (r) =>
            r.id !== security.outboxId ||
            r.header.status !== "sending" ||
            r.header.leaseToken !== security.leaseToken ||
            Date.parse(String(r.header.leaseExpiresAt)) <= Date.now(),
        )
      )
        throw new Error(
          "Sealed identity mail requires its exact live worker lease.",
        );
    }
    const values = selected.map((row) => {
      const value = structuredClone(row.header);
      if (
        name === "fiscalProfiles" ||
        name === "floodSources" ||
        name === "housingSources" ||
        name === "identityOutbox" ||
        name === "workforceArtifacts" ||
        name === "accessibilityArtifacts" ||
        name === "gisJobs" ||
        name === "trafficConfigs"
      ) {
        if (row.payload === undefined)
          throw new Error("Incomplete workforce artifact storage row.");
        Object.assign(value, structuredClone(row.payload));
      }
      if (name === "projects" || name === "published") {
        if (!row.baselineHash || row.payload === undefined)
          throw new Error(`Incomplete ${name} storage row.`);
        Object.assign(value, structuredClone(row.payload), {
          baseline: structuredClone(baselines.get(row.baselineHash)),
        });
      }
      return value;
    });
    if (
      name === "budget" ||
      name === "preparationControl" ||
      name === "nativeCapacity"
    ) {
      if (values.length !== 1)
        throw new Error(`Missing or duplicated ${name} storage singleton.`);
      Object.defineProperty(state, name, {
        enumerable: true,
        configurable: false,
        writable: true,
        value: values[0],
      });
    } else
      Object.defineProperty(state, name, {
        enumerable: true,
        configurable: false,
        writable: true,
        value: values,
      });
  }
  return { state, rows };
}

export async function decodeState(reader: ScopeReader): Promise<DataState> {
  return (await loadScopedState(undefined, reader)).state;
}

/** Async callbacks cannot participate in the captured transaction. Consume their rejection while discarding all mutations. */
export function assertSynchronousStoreResult(value: unknown): void {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    void Promise.resolve(value).catch(() => undefined);
    throw new Error(
      "Store callbacks must be synchronous and free of external side effects.",
    );
  }
}

function assertHeaderPatch(
  view:
    | "identityOutboxHeaders"
    | "projectHeaders"
    | "publishedHeaders"
    | "gisJobHeaders"
    | "trafficJobHeaders",
  before: StoredRow,
  next: Record<string, unknown>,
) {
  const allowed =
    view === "identityOutboxHeaders"
      ? [
          "status",
          "attempts",
          "nextAttemptAt",
          "leaseToken",
          "leaseExpiresAt",
          "sentAt",
          "lastFailure",
          "costReservationId",
        ]
      : view === "projectHeaders"
        ? ["acl"]
        : view === "gisJobHeaders" || view === "trafficJobHeaders"
          ? [
              "version",
              "status",
              "stage",
              "attempt",
              "attempts",
              "cancelRequested",
              "workerId",
              "capacityToken",
              "progress",
              "leaseExpiresAt",
              "error",
              "result",
              "updatedAt",
              "requestKeys",
            ]
          : ["engagement", "revokedAt"];
  const immutable = (header: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(header).filter(([key]) => !allowed.includes(key)),
    );
  if (
    canonicalJSON(immutable(before.header)) !== canonicalJSON(immutable(next))
  )
    throw new Error(
      `Immutable ${view} fields cannot be changed through a projection.`,
    );
  if (view === "publishedHeaders") {
    const oldEngagement = before.header.engagement as
      | Record<string, unknown>
      | undefined;
    const newEngagement = next.engagement as
      | Record<string, unknown>
      | undefined;
    // A legacy boolean publication may materialize its effective questionnaire,
    // but cannot acquire questions or switches that were never published.
    const frozenEngagement = oldEngagement ?? {
      config: {
        introduction: "",
        comments: before.header.feedbackEnabled,
        votes: before.header.feedbackEnabled,
        pins: before.header.feedbackEnabled,
        questions: [],
      },
    };
    const withoutCollection = (engagement: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(engagement).filter(([key]) => key !== "collection"),
      );
    if (
      (oldEngagement != null || newEngagement != null) &&
      canonicalJSON(withoutCollection(frozenEngagement)) !==
        canonicalJSON(
          newEngagement == null ? null : withoutCollection(newEngagement),
        )
    )
      throw new Error("A published questionnaire is immutable.");
  }
}
/** Deletions are restricted to loaded identities; unselected records can never be erased by array assignment. */
export function diffScopedState(loaded: LoadedState): StoreChanges {
  const changes: StoreChanges = { upserts: [], deletes: [], blobs: new Map() };
  const mutations = new Set<string>();
  for (const [view, originals] of loaded.rows) {
    const singleton =
      view === "budget" ||
      view === "preparationControl" ||
      view === "nativeCapacity";
    const headerOnly =
      view === "fiscalProfileHeaders" ||
      view === "identityOutboxHeaders" ||
      view === "projectHeaders" ||
      view === "publishedHeaders" ||
      view === "workforceArtifactHeaders" ||
      view === "accessibilityArtifactHeaders" ||
      view === "gisJobHeaders" ||
      view === "trafficConfigHeaders" ||
      view === "trafficJobHeaders" ||
      view === "trafficArtifactHeaders";
    const collection: EntityName = singleton ? view : backingCollection(view);
    const values = singleton ? [loaded.state[view]] : loaded.state[view];
    if (!Array.isArray(values))
      throw new Error(`Invalid ${view} collection assignment.`);
    const prior = new Map(originals.map((row) => [row.id, row]));
    const seen = new Set<string>();
    for (const value of values) {
      const id = rowIdentity(collection, value);
      if (seen.has(id)) throw new Error(`Duplicate ${view} record identity.`);
      seen.add(id);
      const before = prior.get(id);
      let after: StoredRow;
      let blobs = new Map<string, Place>();
      if (headerOnly) {
        if (!before)
          throw new Error(`New ${view} must be inserted as complete records.`);
        after = {
          ...before,
          header: value as unknown as Record<string, unknown>,
          payload: undefined,
        };
        if (canonicalJSON(before.header) === canonicalJSON(after.header))
          continue;
        if (
          view === "fiscalProfileHeaders" ||
          view === "workforceArtifactHeaders" ||
          view === "accessibilityArtifactHeaders" ||
          view === "trafficConfigHeaders" ||
          view === "trafficArtifactHeaders"
        )
          throw new Error("Captured workforce artifacts are immutable.");
        if (
          view === "trafficJobHeaders" &&
          before.header.status === "completed"
        )
          throw new Error("Completed traffic jobs are immutable.");
        assertHeaderPatch(view, before, after.header);
      } else {
        const encoded = encodeRecord(collection, value, before?.ordinal ?? 0);
        after = encoded.row;
        blobs = encoded.blobs;
        if (before && canonicalJSON(before) === canonicalJSON(after)) continue;
        if (
          before &&
          [
            "fiscalProfiles",
            "fiscalStudyCreations",
            "mediaArtifacts",
            "workforceArtifacts",
            "accessibilityArtifacts",
            "trafficConfigs",
            "trafficUploads",
            "trafficArtifacts",
          ].includes(collection)
        )
          throw new Error(
            "Captured source records and artifacts are immutable.",
          );
        if (
          before &&
          collection === "trafficJobs" &&
          before.header.status === "completed"
        )
          throw new Error("Completed traffic jobs are immutable.");
        if (before?.baselineHash && before.baselineHash !== after.baselineHash)
          throw new Error(
            "An existing project's or publication's captured baseline is immutable.",
          );
        if (before && collection === "imports") {
          const { committed: priorCommit, ...prior } = before.header;
          const { committed: nextCommit, ...next } = after.header;
          if (
            canonicalJSON(prior) !== canonicalJSON(next) ||
            canonicalJSON(before.payload) !== canonicalJSON(after.payload) ||
            (priorCommit !== undefined &&
              canonicalJSON(priorCommit) !== canonicalJSON(nextCommit))
          )
            throw new Error(
              "Staged import geometry, mapping and provenance are immutable.",
            );
        }
        if (before && collection === "published") {
          assertHeaderPatch("publishedHeaders", before, after.header);
          if (canonicalJSON(before.payload) !== canonicalJSON(after.payload))
            throw new Error(
              "A published scenario and its results are immutable.",
            );
        }
      }
      const key = `${collection}:${id}`;
      if (mutations.has(key))
        throw new Error(
          "Conflicting full-record and header writes in one transaction.",
        );
      mutations.add(key);
      changes.upserts.push(after);
      blobs.forEach((blob, hash) => changes.blobs.set(hash, blob));
    }
    for (const before of originals)
      if (!seen.has(before.id)) {
        if (
          headerOnly ||
          singleton ||
          collection === "fiscalProfiles" ||
          collection === "fiscalStudyCreations" ||
          collection === "mediaJobs" ||
          collection === "mediaArtifacts" ||
          collection === "published" ||
          collection === "workforceArtifacts" ||
          collection === "accessibilityArtifacts" ||
          collection === "accessibilityJobs" ||
          collection === "workforceJobs" ||
          collection === "gisJobs" ||
          collection === "trafficConfigs" ||
          collection === "trafficUploads" ||
          collection === "trafficJobs" ||
          collection === "trafficArtifacts" ||
          collection === "imports"
        )
          throw new Error(`${view} cannot be deleted through this scope.`);
        const key = `${collection}:${before.id}`;
        if (mutations.has(key))
          throw new Error("Conflicting scoped record writes.");
        mutations.add(key);
        changes.deletes.push({ collection, id: before.id });
      }
  }
  return changes;
}
