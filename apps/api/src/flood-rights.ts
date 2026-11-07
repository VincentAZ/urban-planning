import type {
  FloodDataset,
  FloodDatasetCatalog,
  Project,
  Source,
} from "@urban/core";
import { ApiError } from "./errors";
/** Flood citations are a separate namespace. Raw receipts retain identity across renamed citation IDs. */
export function floodSourceKeys(
  dataset: FloodDataset,
  source: Source,
): string[] {
  return [
    `id:${source.id}`,
    ...(source.url ? [`url:${source.url}`] : []),
    ...dataset.files
      .filter((f) => f.sourceId === source.id)
      .map((f) => `sha:${f.sha256}`),
  ];
}
function declarationKeys(
  catalog: FloodDatasetCatalog | undefined,
  permission?: "export" | "publicRedistribution",
) {
  const keys = new Set<string>();
  for (const d of Object.values(catalog ?? {}))
    for (const s of d.sources)
      if (
        s.rights &&
        (!permission || !s.rights.privateUse || !s.rights[permission])
      )
        for (const k of floodSourceKeys(d, s)) keys.add(k);
  return keys;
}
export function assertFloodRightsTransition(
  project: Pick<Project, "floodDatasets">,
  previous: Pick<Project, "floodDatasets"> | undefined,
  trustedPublicHashes: Set<string>,
) {
  const declared = declarationKeys(project.floodDatasets);
  for (const [hash, d] of Object.entries(project.floodDatasets ?? {})) {
    if (previous?.floodDatasets?.[hash] || trustedPublicHashes.has(hash))
      continue;
    if (
      d.sources.some(
        (s) => !s.rights && floodSourceKeys(d, s).some((k) => declared.has(k)),
      )
    )
      throw new ApiError(
        422,
        "FLOOD_RIGHTS_ERASED",
        "A new imported flood pack cannot erase retained permissions for the same citation or raw source receipts. Preserve the declaration or supply an explicit current permission attestation.",
      );
  }
}
export function floodPermissionDenied(
  catalog: FloodDatasetCatalog | undefined,
  dataset: FloodDataset,
  permission: "export" | "publicRedistribution",
  trustedPublic = false,
): boolean {
  const retained = declarationKeys(catalog, permission);
  return dataset.sources.some((s) =>
    s.rights
      ? !s.rights.privateUse || !s.rights[permission]
      : !trustedPublic &&
        floodSourceKeys(dataset, s).some((k) => retained.has(k)),
  );
}
