import {
  canonicalJSON,
  housingSourcePermissionIssues,
  housingAffordabilityReferences,
  housingAffordabilityScenarioSchema,
  housingIncomeLimitCatalogSchema,
  housingIncomeLimitPackHash,
  type HousingAffordabilityScenario,
  type HousingIncomeLimitCatalog,
  type HousingIncomeLimitPack,
  type Project,
  type Scenario,
  type Source,
} from "@urban/core";
import { ApiError } from "./errors";
import type { HousingCatalog } from "./housing-catalog";
import type { HousingSourceRecord } from "./housing-types";

export const housingGroups = (a?: HousingAffordabilityScenario) => [
  ...(a?.baselineGroups ?? []),
  ...(a?.proposalGroups ?? []),
];
export const projectHousingGroups = (p: Project) =>
  housingAffordabilityReferences(p).flatMap(housingGroups);
export const projectHousingHashes = (p: Project) => [
  ...new Set(
    projectHousingGroups(p)
      .filter((g) => g.areaOrigin === "server-catalog")
      .map((g) => g.areaHash),
  ),
];
const sourceKeys = (s: Source, pack?: HousingIncomeLimitPack) => [
  `id:${s.id}`,
  ...(s.url ? [`url:${s.url}`] : []),
  ...(pack?.files
    .filter((f) => f.sourceId === s.id)
    .map((f) => `sha:${f.sha256}`) ?? []),
];
function allSources(
  p: Pick<Project, "housingIncomeLimits"> &
    Partial<Pick<Project, "scenarios" | "history" | "undone">>,
) {
  return [
    ...Object.values(p.housingIncomeLimits ?? {}).flatMap((pack) =>
      pack.sources.map((source) => ({ source, pack })),
    ),
    ...(p.scenarios
      ? housingAffordabilityReferences(p as Project).flatMap((a) =>
          a.sources.map((source) => ({ source, pack: undefined })),
        )
      : []),
  ];
}
function denied(
  s: Source,
  permission: "private" | "export" | "publicRedistribution",
) {
  return housingSourcePermissionIssues([s], permission).length > 0;
}
export function validateHousingProject(project: Project) {
  housingIncomeLimitCatalogSchema.parse(project.housingIncomeLimits ?? {});
  for (const a of housingAffordabilityReferences(project)) {
    housingAffordabilityScenarioSchema.parse(a);
    for (const g of housingGroups(a))
      if (!project.housingIncomeLimits?.[g.areaHash])
        throw new ApiError(
          422,
          "HOUSING_PACK_MISSING",
          "Every current and historical housing group requires its retained income-limit pack.",
        );
  }
  if (allSources(project).some(({ source }) => denied(source, "private")))
    throw new ApiError(
      422,
      "HOUSING_PRIVATE_USE_RESTRICTED",
      "Housing evidence requires private processing, display and historical retention permission.",
    );
}
export function validateHousingAuthority(
  project: Project,
  registered: HousingSourceRecord[],
  previous?: Project,
) {
  validateHousingProject(project);
  for (const [key, pack] of Object.entries(previous?.housingIncomeLimits ?? {}))
    if (
      canonicalJSON(project.housingIncomeLimits?.[key]) !== canonicalJSON(pack)
    )
      throw new ApiError(
        422,
        "HOUSING_CATALOG_IMMUTABLE",
        "Previously captured housing packs must remain byte-identical, including unused historical evidence.",
      );
  const priorTrusted = new Set(previous ? projectHousingHashes(previous) : []);
  for (const key of projectHousingHashes(project)) {
    const pack = project.housingIncomeLimits![key];
    if (
      priorTrusted.has(key) &&
      canonicalJSON(previous?.housingIncomeLimits?.[key]) ===
        canonicalJSON(pack)
    )
      continue;
    if (
      canonicalJSON(registered.find((r) => r.id === key)?.pack) !==
      canonicalJSON(pack)
    )
      throw new ApiError(
        422,
        "HOUSING_SOURCE_UNVERIFIED",
        "Server-catalog income limits must exactly match an operator-verified source. Restore other evidence explicitly as imported.",
      );
  }
  const declarations = new Set(
    allSources(project)
      .filter(({ source }) => source.rights)
      .flatMap(({ source, pack }) => sourceKeys(source, pack)),
  );
  const trusted = new Set(projectHousingHashes(project));
  for (const { source, pack } of allSources(project)) {
    if (
      source.rights ||
      (pack && trusted.has(housingIncomeLimitPackHash(pack)))
    )
      continue;
    if (sourceKeys(source, pack).some((k) => declarations.has(k)))
      throw new ApiError(
        422,
        "HOUSING_RIGHTS_ERASED",
        "Retained housing source permissions cannot be erased under a new source or pack identity. Retain or explicitly review the declaration.",
      );
  }
  if (previous) {
    const nextDeclarations = new Set(
      allSources(project)
        .filter(({ source }) => source.rights)
        .flatMap(({ source, pack }) => sourceKeys(source, pack)),
    );
    for (const { source, pack } of allSources(previous))
      if (
        source.rights &&
        !sourceKeys(source, pack).some((k) => nextDeclarations.has(k))
      )
        throw new ApiError(
          422,
          "HOUSING_RIGHTS_ERASED",
          "Previously declared housing source rights must remain in current or historical evidence.",
        );
  }
}
export async function validateConfiguredHousing(
  project: Project,
  catalog: HousingCatalog,
  previous?: Project,
) {
  const prior = new Set(previous ? projectHousingHashes(previous) : []);
  for (const key of projectHousingHashes(project)) {
    if (
      prior.has(key) &&
      canonicalJSON(previous?.housingIncomeLimits?.[key]) ===
        canonicalJSON(project.housingIncomeLimits?.[key])
    )
      continue;
    if (
      canonicalJSON((await catalog.get(key)).pack) !==
      canonicalJSON(project.housingIncomeLimits?.[key])
    )
      throw new ApiError(
        422,
        "HOUSING_SOURCE_UNVERIFIED",
        "The selected housing evidence differs from the configured source.",
      );
  }
}
export function selectedHousingPacks(
  project: Pick<Project, "housingIncomeLimits">,
  scenario: Pick<Scenario, "affordability">,
): HousingIncomeLimitCatalog | undefined {
  if (!scenario.affordability) return undefined;
  const selected: HousingIncomeLimitCatalog = {};
  for (const g of housingGroups(scenario.affordability)) {
    const pack = project.housingIncomeLimits?.[g.areaHash];
    if (!pack)
      throw new ApiError(
        422,
        "HOUSING_PACK_MISSING",
        "Selected housing evidence is missing.",
      );
    selected[g.areaHash] = pack;
  }
  return selected;
}
function permission(
  project: Project,
  scenario: Pick<Scenario, "affordability"> | undefined,
  kind: "export" | "publicRedistribution",
) {
  const packs = scenario
    ? selectedHousingPacks(project, scenario)
    : project.housingIncomeLimits;
  const sources = [
    ...Object.values(packs ?? {}).flatMap((pack) =>
      pack.sources.map((source) => ({ source, pack })),
    ),
    ...(scenario
      ? (scenario.affordability?.sources ?? []).map((source) => ({
          source,
          pack: undefined,
        }))
      : housingAffordabilityReferences(project).flatMap((a) =>
          a.sources.map((source) => ({ source, pack: undefined })),
        )),
  ];
  const restricted = new Set(
    allSources(project)
      .filter(({ source }) => denied(source, kind))
      .flatMap(({ source, pack }) => sourceKeys(source, pack)),
  );
  for (const { source, pack } of sources)
    if (
      denied(source, kind) ||
      (!source.rights &&
        sourceKeys(source, pack).some((k) => restricted.has(k)))
    )
      throw new ApiError(
        422,
        kind === "export"
          ? "HOUSING_EXPORT_RESTRICTED"
          : "HOUSING_PUBLICATION_RESTRICTED",
        "Housing sources do not authorize this disclosure.",
      );
}
export const assertHousingExport = (
  project: Project,
  scenario?: Pick<Scenario, "affordability">,
) => permission(project, scenario, "export");
export const assertHousingPublication = (
  project: Project,
  scenario: Pick<Scenario, "affordability">,
) => permission(project, scenario, "publicRedistribution");
