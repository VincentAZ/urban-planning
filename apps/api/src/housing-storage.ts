import {
  canonicalJSON,
  housingIncomeLimitPackHash,
  validateHousingIncomeLimitPack,
  type HousingIncomeLimitCatalog,
  type Project,
  type Scenario,
} from "@urban/core";
import type { StoredRow, StoreChanges } from "./storage-core";
import type { StoreScope } from "./store-scope";
import {
  assertHousingPublication,
  projectHousingHashes,
  selectedHousingPacks,
  validateHousingAuthority,
} from "./housing-validation";
import type { HousingSourceRecord } from "./housing-types";
type Lookup = (collection: string, id: string) => StoredRow | undefined;
export function assertHousingStorageChanges(
  changes: StoreChanges,
  scope: StoreScope | undefined,
  lookup: Lookup,
) {
  for (const d of changes.deletes)
    if (d.collection === "housingSources")
      throw new Error("Registered housing sources are immutable.");
  for (const row of changes.upserts) {
    if (row.collection === "housingSources") {
      if (scope?.auth || scope?.security)
        throw new Error(
          "Housing source installation requires the trusted operator store.",
        );
      const pack = validateHousingIncomeLimitPack(
          (row.payload as { pack?: unknown })?.pack,
        ),
        prior = lookup("housingSources", row.id);
      if (
        housingIncomeLimitPackHash(pack) !== row.id ||
        !/^[a-f0-9]{64}$/.test(String(row.header.sourceManifestHash)) ||
        row.indexes.organizationId ||
        row.indexes.projectId
      )
        throw new Error("Invalid housing registry identity.");
      if (
        pack.sources.some(
          (s) =>
            !s.rights ||
            !s.rights.privateUse ||
            !s.rights.cache ||
            !s.rights.analyze ||
            !s.rights.privateDisplay ||
            !s.rights.historicalRetention ||
            !s.rights.export ||
            !s.rights.publicRedistribution,
        )
      )
        throw new Error(
          "Public registered housing source requires explicit complete permissions.",
        );
      if (
        prior &&
        (canonicalJSON(prior.header) !== canonicalJSON(row.header) ||
          canonicalJSON(prior.payload) !== canonicalJSON(row.payload))
      )
        throw new Error("Registered housing source cannot change.");
      continue;
    }
    if (
      row.payload === undefined ||
      !["projects", "published"].includes(row.collection)
    )
      continue;
    const payload = row.payload as {
      project?: Project;
      scenario?: Scenario;
      housingIncomeLimits?: HousingIncomeLimitCatalog;
    };
    if (row.collection === "projects") {
      const project = payload.project!,
        previous = (
          lookup("projects", row.id)?.payload as
            | { project?: Project }
            | undefined
        )?.project;
      const sources = projectHousingHashes(project).flatMap((id) => {
        const r = lookup("housingSources", id);
        return r
          ? [
              {
                ...r.header,
                ...(r.payload as object),
              } as unknown as HousingSourceRecord,
            ]
          : [];
      });
      validateHousingAuthority(project, sources, previous);
    } else {
      if (!payload.scenario?.affordability) {
        if (payload.housingIncomeLimits)
          throw new Error("Unselected housing evidence cannot be published.");
        continue;
      }
      const target = lookup("projects", String(row.indexes.projectId)),
        project = (target?.payload as { project?: Project } | undefined)
          ?.project;
      if (
        !project ||
        target?.indexes.organizationId !== row.indexes.organizationId ||
        target?.baselineHash !== row.baselineHash ||
        !project.scenarios.some(
          (s) =>
            s.id === payload.scenario?.id &&
            canonicalJSON(s.affordability) ===
              canonicalJSON(payload.scenario?.affordability),
        ) ||
        canonicalJSON(selectedHousingPacks(project, payload.scenario)) !==
          canonicalJSON(payload.housingIncomeLimits)
      )
        throw new Error(
          "Published housing evidence must match its exact project, scenario and selected source packs.",
        );
      assertHousingPublication(project, payload.scenario);
    }
  }
}
