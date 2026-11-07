import {
  canonicalJSON,
  floodDatasetCatalogSchema,
  floodDatasetHashSync,
  floodStudyAreaHash,
  floodReferenceSchema,
  type Project,
  type FloodReference,
  type FloodDataset,
  type Place,
} from "@urban/core";
import {
  assertFloodRightsTransition,
  floodPermissionDenied,
} from "./flood-rights";
import { validateFloodDatasetsInWorker } from "./flood-normalization-worker";
import { ApiError } from "./errors";
import type { FloodSourceRecord } from "./flood-types";
import type { FloodCatalog } from "./flood-catalog";
export function projectFloodReferences(project: Project): FloodReference[] {
  return [
    ...project.scenarios,
    ...project.history.flatMap((e) => [e.before, e.after]),
    ...project.undone.flatMap((e) => [e.before, e.after]),
  ]
    .flatMap((s) => (s.flood ? [s.flood] : []))
    .concat(
      [...project.history, ...project.undone].flatMap((e) =>
        e.command.type === "scenario.flood" && e.command.flood
          ? [e.command.flood]
          : [],
      ),
    );
}
export function projectFloodHashes(project: Project) {
  return [
    ...new Set(
      projectFloodReferences(project)
        .filter((r) => r.origin === "server-catalog")
        .map((r) => r.datasetHash),
    ),
  ];
}
export function validateFloodAuthority(
  project: Project,
  place: Place,
  registered: FloodSourceRecord[],
  previous?: Project,
) {
  for (const reference of projectFloodReferences(project))
    floodReferenceSchema.parse(reference);
  for (const [hash, dataset] of Object.entries(previous?.floodDatasets ?? {}))
    if (canonicalJSON(project.floodDatasets?.[hash]) !== canonicalJSON(dataset))
      throw new ApiError(
        422,
        "FLOOD_CATALOG_IMMUTABLE",
        "Previously captured flood datasets must remain byte-identical in the project catalog, including unused history.",
      );
  assertFloodRightsTransition(
    project,
    previous,
    new Set(projectFloodHashes(project)),
  );
  const previousTrusted = new Set(previous ? projectFloodHashes(previous) : []);
  for (const hash of projectFloodHashes(project)) {
    const dataset = project.floodDatasets?.[hash];
    if (
      previousTrusted.has(hash) &&
      canonicalJSON(previous?.floodDatasets?.[hash]) === canonicalJSON(dataset)
    )
      continue;
    const record = registered.find((r) => r.id === hash);
    if (!record || canonicalJSON(record.dataset) !== canonicalJSON(dataset))
      throw new ApiError(
        422,
        "FLOOD_SOURCE_UNVERIFIED",
        "Server-catalog flood evidence must exactly match an operator-verified registered dataset. Restore other evidence explicitly as imported.",
      );
  }
}
export function selectedFloodDataset(
  project: Project,
  scenario: { flood?: FloodReference },
): FloodDataset | undefined {
  return scenario.flood
    ? project.floodDatasets?.[scenario.flood.datasetHash]
    : undefined;
}
export function assertFloodPublication(
  project: Project,
  scenario: { flood?: FloodReference },
) {
  const dataset = selectedFloodDataset(project, scenario);
  if (scenario.flood && !dataset)
    throw new ApiError(
      422,
      "FLOOD_DATASET_MISSING",
      "The selected flood dataset is missing.",
    );
  if (
    dataset &&
    floodPermissionDenied(
      project.floodDatasets,
      dataset,
      "publicRedistribution",
      scenario.flood?.origin === "server-catalog",
    )
  )
    throw new ApiError(
      422,
      "FLOOD_PUBLICATION_RESTRICTED",
      "The selected flood source is not authorized for public redistribution.",
    );
}

export async function validateConfiguredFlood(
  project: Project,
  catalog: FloodCatalog,
  previous?: Project,
) {
  const retained = new Set(previous ? projectFloodHashes(previous) : []);
  for (const hash of projectFloodHashes(project)) {
    if (
      retained.has(hash) &&
      canonicalJSON(previous?.floodDatasets?.[hash]) ===
        canonicalJSON(project.floodDatasets?.[hash])
    )
      continue;
    const entry = await catalog.get(hash);
    if (
      canonicalJSON(entry.dataset) !==
      canonicalJSON(project.floodDatasets?.[hash])
    )
      throw new ApiError(
        422,
        "FLOOD_SOURCE_UNVERIFIED",
        "The new trusted flood reference does not match the configured captured source.",
      );
  }
}

export async function validateFloodProject(project: Project, place: Place) {
  try {
    const catalog = project.floodDatasets ?? {};
    floodDatasetCatalogSchema.parse(catalog);
    const studyHash = await floodStudyAreaHash(place);
    for (const [hash, dataset] of Object.entries(catalog))
      if (
        floodDatasetHashSync(dataset) !== hash ||
        dataset.studyAreaHash !== studyHash ||
        (await floodStudyAreaHash(dataset.studyArea)) !== studyHash
      )
        throw new Error("Flood content/boundary mismatch.");
    for (const ref of projectFloodReferences(project)) {
      floodReferenceSchema.parse(ref);
      if (!Object.hasOwn(catalog, ref.datasetHash))
        throw new Error("Missing flood dataset.");
    }
    for (const s of [
      ...project.scenarios,
      ...[...project.history, ...project.undone].flatMap((e) => [
        e.before,
        e.after,
      ]),
    ])
      if (s.id === "baseline" && s.flood)
        throw new Error("Baseline cannot select flood evidence.");
    for (const dataset of Object.values(project.floodDatasets ?? {}))
      for (const source of dataset.sources) {
        const r = source.rights;
        if (
          r &&
          (!r.privateUse ||
            !r.cache ||
            !r.analyze ||
            !r.privateDisplay ||
            !r.historicalRetention)
        )
          throw new Error("Flood source usage permissions are incomplete.");
      }
    await validateFloodDatasetsInWorker(Object.values(catalog));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      422,
      "FLOOD_INVALID",
      "Flood source geometry, content hashes or scenario references do not match the immutable project baseline.",
    );
  }
}

export function assertFloodExport(
  project: Pick<Project, "floodDatasets">,
  scenario?: { flood?: FloodReference },
) {
  const datasets = scenario?.flood
    ? [project.floodDatasets?.[scenario.flood.datasetHash]]
    : Object.values(project.floodDatasets ?? {});
  if (
    datasets.some(
      (d) =>
        d &&
        floodPermissionDenied(
          project.floodDatasets,
          d,
          "export",
          Boolean(
            scenario?.flood?.origin === "server-catalog" &&
              project.floodDatasets?.[scenario.flood.datasetHash] === d,
          ),
        ),
    )
  )
    throw new ApiError(
      422,
      "FLOOD_EXPORT_RESTRICTED",
      "The selected flood source does not permit export.",
    );
}
