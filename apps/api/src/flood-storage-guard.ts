import { createHash } from "node:crypto";
import {
  canonicalJSON,
  floodDatasetHashSync,
  floodDatasetSchema,
  floodDatasetCatalogSchema,
  floodReferenceSchema,
  studyAreaGeometry,
  type Place,
  type Project,
  type FloodDataset,
} from "@urban/core";
import type { StoreChanges, StoredRow } from "./storage-core";
import type { StoreScope } from "./store-scope";
import {
  assertFloodRightsTransition,
  floodPermissionDenied,
} from "./flood-rights";
import { projectFloodReferences } from "./flood-validation";
type Lookup = (collection: string, id: string) => StoredRow | undefined;
/** The SQLite adapter enforces the same immutable source authority as PostgreSQL. */
export function assertFloodStorageChanges(
  changes: StoreChanges,
  scope: StoreScope | undefined,
  lookup: Lookup,
  baseline: (hash: string) => Place | undefined,
) {
  for (const d of changes.deletes)
    if (d.collection === "floodSources")
      throw new Error(
        "Registered flood sources are immutable; retire runtime configuration instead of deleting retained authority.",
      );
  for (const row of changes.upserts) {
    if (row.collection === "floodSources") {
      if (scope?.auth || scope?.security)
        throw new Error(
          "Flood source registration requires a trusted operator store.",
        );
      const prior = lookup("floodSources", row.id),
        dataset = (row.payload as { dataset?: FloodDataset })?.dataset;
      floodDatasetSchema.parse(dataset);
      if (
        !dataset ||
        floodDatasetHashSync(dataset) !== row.id ||
        row.header.studyAreaHash !== dataset.studyAreaHash ||
        !/^[a-f0-9]{64}$/.test(String(row.header.sourceManifestHash))
      )
        throw new Error("Invalid registered flood source identity.");
      if (
        prior &&
        (canonicalJSON(prior.header) !== canonicalJSON(row.header) ||
          canonicalJSON(prior.payload) !== canonicalJSON(row.payload))
      )
        throw new Error("Registered flood source cannot change.");
      continue;
    }
    if (
      row.payload === undefined ||
      !["projects", "published"].includes(row.collection)
    )
      continue;
    const payload = row.payload as {
      project?: Project;
      scenario?: { id?: string; flood?: import("@urban/core").FloodReference };
      floodDataset?: FloodDataset;
    };
    if (row.collection === "projects") {
      const p = payload.project!;
      if (p.floodDatasets) {
        floodDatasetCatalogSchema.parse(p.floodDatasets);
        const place = baseline(row.baselineHash!);
        if (!place) throw new Error("Flood baseline is missing.");
        for (const dataset of Object.values(p.floodDatasets))
          if (
            canonicalJSON(dataset.studyArea) !==
              canonicalJSON(studyAreaGeometry(place)) ||
            dataset.studyAreaHash !==
              createHash("sha256")
                .update(canonicalJSON(dataset.studyArea))
                .digest("hex")
          )
            throw new Error("Flood source study-area hash/boundary mismatch.");
      }
      const prior = (
        lookup("projects", row.id)?.payload as { project?: Project } | undefined
      )?.project;
      for (const [hash, dataset] of Object.entries(prior?.floodDatasets ?? {}))
        if (canonicalJSON(p.floodDatasets?.[hash]) !== canonicalJSON(dataset))
          throw new Error("Existing flood catalog content is immutable.");
      for (const [hash, dataset] of Object.entries(p.floodDatasets ?? {})) {
        if (floodDatasetHashSync(dataset) !== hash)
          throw new Error("Flood catalog hash mismatch.");
      }
      assertFloodRightsTransition(
        p,
        prior,
        new Set(
          projectFloodReferences(p)
            .filter((r) => r.origin === "server-catalog")
            .map((r) => r.datasetHash),
        ),
      );
      const oldTrusted = new Set(
        prior
          ? projectFloodReferences(prior)
              .filter((r) => r.origin === "server-catalog")
              .map((r) => r.datasetHash)
          : [],
      );
      for (const ref of projectFloodReferences(p)) {
        floodReferenceSchema.parse(ref);
        const dataset = p.floodDatasets?.[ref.datasetHash];
        if (!dataset) throw new Error("Missing referenced flood dataset.");
        if (ref.origin === "imported") continue;
        if (ref.origin !== "server-catalog")
          throw new Error("Invalid flood evidence origin.");
        if (
          oldTrusted.has(ref.datasetHash) &&
          canonicalJSON(prior?.floodDatasets?.[ref.datasetHash]) ===
            canonicalJSON(dataset)
        )
          continue;
        const source = lookup("floodSources", ref.datasetHash);
        if (
          !source ||
          canonicalJSON(
            (source.payload as { dataset?: FloodDataset })?.dataset,
          ) !== canonicalJSON(dataset)
        )
          throw new Error(
            "Unregistered flood source cannot claim server-catalog authority.",
          );
      }
    } else {
      const ref = payload.scenario?.flood,
        dataset = payload.floodDataset;
      if (!ref) {
        if (dataset)
          throw new Error("Unselected flood source cannot be published.");
        continue;
      }
      floodReferenceSchema.parse(ref);
      const project = lookup("projects", String(row.indexes.projectId)),
        p = (project?.payload as { project?: Project })?.project;
      if (
        !dataset ||
        floodDatasetHashSync(dataset) !== ref.datasetHash ||
        project?.indexes.organizationId !== row.indexes.organizationId ||
        canonicalJSON(p?.floodDatasets?.[ref.datasetHash]) !==
          canonicalJSON(dataset) ||
        !p?.scenarios.some(
          (s) =>
            s.id === payload.scenario?.id &&
            canonicalJSON(s.flood) === canonicalJSON(ref),
        )
      )
        throw new Error(
          "Published flood evidence must match the selected project source.",
        );
      if (
        floodPermissionDenied(
          p?.floodDatasets,
          dataset,
          "publicRedistribution",
          ref.origin === "server-catalog",
        )
      )
        throw new Error("Private flood source cannot be published.");
    }
  }
}
