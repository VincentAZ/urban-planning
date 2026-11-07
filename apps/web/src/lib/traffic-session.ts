import { canonicalJSON } from "@urban/core";
import type { TrafficDraftValue } from "./traffic-draft";
import type { TrafficSaveBody, TrafficUpload } from "./traffic-api";

/** A retry of the same logical action retains its original version guards as well as its key. */
export class TrafficAttempts {
  private values = new Map<string, unknown>();
  for<T extends object>(key: string, body: T): T & { idempotencyKey: string } {
    const previous = this.values.get(key);
    if (previous) return previous as T & { idempotencyKey: string };
    const value = structuredClone({
      ...body,
      idempotencyKey: crypto.randomUUID(),
    });
    this.values.set(key, value);
    return value;
  }
  complete(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
export async function trafficUploadKey(
  file: { name: string; size: number },
  sha256: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalJSON([file.name, file.size, sha256]),
  );
  return `traffic-csv-${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Replace only source identifiers. Exact raw observation IDs, values, mappings and geometry remain intact. */
export function admittedTrafficDraft(
  draft: TrafficDraftValue,
  uploads: Map<string, TrafficUpload>,
): Pick<
  TrafficSaveBody,
  | "request"
  | "sourceDeclarations"
  | "mappingReviews"
  | "uploadBindings"
  | "planningRoadReviews"
  | "planningSourceDeclarations"
> {
  const aliases = new Map<string, string>();
  const uploadBindings = draft.stagedFiles.map((staged) => {
    const upload = uploads.get(staged.sourceId);
    if (
      !upload ||
      upload.sha256 !== staged.sha256 ||
      upload.bytes !== staged.bytes
    )
      throw new Error(
        "A CSV upload does not match the exact file reviewed. The configuration was not saved.",
      );
    if (aliases.has(staged.sourceId))
      throw new Error("Each staged CSV requires a unique source declaration.");
    aliases.set(staged.sourceId, upload.sourceId);
    return {
      uploadId: upload.id,
      sourceId: upload.sourceId,
      mapping: staged.mapping,
      useAnalysisPeriod: staged.useAnalysisPeriod,
      kind: staged.kind,
      batchId: staged.batchId,
    };
  });
  const sourceId = (id: string) => aliases.get(id) ?? id;
  const ids = (values: string[]) => values.map(sourceId);
  const countPack = structuredClone(draft.countPack),
    demand = structuredClone(draft.demand);
  countPack.sources = countPack.sources.map((source) => ({
    ...source,
    id: sourceId(source.id),
  }));
  countPack.files = countPack.files.map((file) => ({
    ...file,
    sourceId: sourceId(file.sourceId),
  }));
  countPack.counts = countPack.counts.map((count) => ({
    ...count,
    sourceIds: ids(count.sourceIds),
  }));
  countPack.annualCounts = countPack.annualCounts.map((count) => ({
    ...count,
    sourceIds: ids(count.sourceIds),
  }));
  demand.sources = demand.sources.map((source) => ({
    ...source,
    id: sourceId(source.id),
  }));
  demand.rows = demand.rows.map((row) => ({
    ...row,
    sourceIds: ids(row.sourceIds),
  }));
  demand.candidateRoutes = demand.candidateRoutes.map((route) => ({
    ...route,
    sourceIds: ids(route.sourceIds),
  }));
  return {
    request: {
      version: 1,
      networkHash: draft.networkHash,
      countPack,
      demand,
      ...(draft.commute === undefined
        ? {}
        : { commute: structuredClone(draft.commute) }),
      period: structuredClone(draft.period),
      seed: draft.seed,
      overlays: structuredClone(draft.overlays),
      ...(draft.signalTimings === undefined
        ? {}
        : { signalTimings: structuredClone(draft.signalTimings) }),
      calibrationPlan: draft.calibrationPlan
        ? {
            ...structuredClone(draft.calibrationPlan),
            sourceIds: ids(draft.calibrationPlan.sourceIds),
          }
        : null,
      unsupportedChanges: [],
    },
    sourceDeclarations: draft.sourceDeclarations.map((source) => ({
      ...source,
      sourceId: sourceId(source.sourceId),
    })),
    mappingReviews: structuredClone(draft.mappingReviews),
    ...(draft.planningRoadReviews === undefined
      ? {}
      : { planningRoadReviews: structuredClone(draft.planningRoadReviews) }),
    ...(draft.planningSourceDeclarations === undefined
      ? {}
      : {
          planningSourceDeclarations: structuredClone(
            draft.planningSourceDeclarations,
          ),
        }),
    uploadBindings,
  };
}

export interface TrafficScope {
  accountScope: string;
  projectId: string;
  scenarioId: string;
  projectVersion: number;
  scenarioRevision: number;
}
export function sameTrafficMutationScope(
  captured: TrafficScope,
  current: TrafficScope,
  canEdit: boolean,
  hasUnsavedChanges: boolean,
): boolean {
  return (
    canEdit &&
    !hasUnsavedChanges &&
    captured.accountScope === current.accountScope &&
    captured.projectId === current.projectId &&
    captured.scenarioId === current.scenarioId &&
    captured.projectVersion === current.projectVersion &&
    captured.scenarioRevision === current.scenarioRevision
  );
}
