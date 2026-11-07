import { assertFiscalPublication } from "./fiscal-rights.js";
import { assertFloodPublication } from "./flood-validation";
import {
  materializeBuildings,
  materializeRoads,
  materializeParcels,
  retailPubliclyRedistributable,
  retailSourceIds,
  canonicalJSON,
  type Place,
  type Project,
  type RetailScenario,
  type Scenario,
  type Source,
} from "@urban/core";
import {
  accessibilityReferences,
  projectAccessibilityReferences,
} from "./accessibility-validation.js";
import { ApiError } from "./errors.js";
import { assertTrafficPublication } from "./traffic/references.js";

/** History and commands retain declarations even after undo or scenario deletion. */
function retainedSources(project: Project, place: Place): Source[] {
  return [
    ...place.sources,
    ...project.scenarios.flatMap((scenario) => scenario.sources ?? []),
    ...[...project.history, ...project.undone].flatMap((entry) => [
      ...(entry.before.sources ?? []),
      ...(entry.after.sources ?? []),
      ...("source" in entry.command && entry.command.source
        ? [entry.command.source]
        : []),
      ...("sources" in entry.command ? (entry.command.sources ?? []) : []),
    ]),
  ];
}

/** A full-save is not permission to silently erase a recorded rights declaration. */
export function validateSourceRightsTransition(
  previous: Project,
  next: Project,
  place: Place,
): void {
  validateAccessibilitySourceRights(previous, next);
  const prior = retainedSources(previous, place).filter(
      (source) => source.rights,
    ),
    retained = retainedSources(next, place),
    declarations = new Set(
      retained
        .filter((source) => source.rights)
        .map((source) => canonicalJSON([source.id, source.rights])),
    ),
    // A current, explicit declaration can replace an earlier attestation. A
    // legacy-shaped record with no rights cannot silently do the same.
    currentDeclarations = new Set(
      next.scenarios.flatMap((scenario) =>
        (scenario.sources ?? [])
          .filter((source) => source.rights)
          .map((source) => source.id),
      ),
    );
  const erased = prior.filter(
    (source) =>
      !declarations.has(canonicalJSON([source.id, source.rights])) &&
      !currentDeclarations.has(source.id),
  );
  if (erased.length)
    throw new ApiError(
      422,
      "SOURCE_RIGHTS_REMOVED",
      `Previously recorded source permissions cannot be erased by a full-project save: ${[...new Set(erased.map((source) => source.name))].join(", ")}. Retain the declaration in the source inventory or history, or record an explicit current permission attestation. Removing imported geometry does not require deleting its source history.`,
    );
}

/** Current references outside the retail pack must never lose their attribution. */
function nonRetailReferences(place: Place, scenario: Scenario): Set<string> {
  const ids = new Set<string>();
  const add = (...values: (string | undefined)[]) => {
    for (const value of values) if (value) ids.add(value);
  };
  for (const building of materializeBuildings(place, scenario)) {
    add(
      building.sourceId,
      building.attributeSourceId,
      building.geometrySourceId,
      building.programSourceId,
    );
    for (const component of building.program?.components ?? [])
      add(
        component.sourceId,
        component.tripRate?.sourceId,
        component.parkingRate?.sourceId,
      );
    for (const evidence of Object.values(
      building.attributeProvenance?.fields ?? {},
    ))
      add(evidence?.sourceId);
    add(building.attributeProvenance?.use?.sourceId);
  }
  for (const road of materializeRoads(place, scenario))
    add(road.sourceId, road.attributeSourceId, road.geometrySourceId);
  for (const parcel of materializeParcels(place, scenario))
    add(
      parcel.sourceId,
      parcel.geometrySourceId,
      ...(parcel.lineage?.sourceIds ?? []),
    );
  const activity = scenario.activity;
  if (activity) {
    for (const reference of Object.values(activity.reference))
      if (reference?.kind === "entered") add(reference.sourceId);
    add(
      activity.demandResponse.sourceId,
      activity.forecast?.sourceId,
      activity.preset?.sourceId,
      activity.vehicleReference?.source.id,
    );
    for (const neighborhood of activity.neighborhoods)
      add(neighborhood.sourceId);
  }
  return ids;
}

/** Never mutate the private saved scenario while preparing its public copy. */
export function scenarioForPublication(
  project: Project,
  place: Place,
  scenario: Scenario,
): Scenario {
  assertFiscalPublication(project);
  assertTrafficPublication(scenario, project);
  assertFloodPublication(project, scenario);
  for (const evidence of accessibilityReferences(scenario.accessibility)) {
    const restricted = evidence.capture.sources.filter(
      (source) => source.rights && !source.rights.publicRedistribution,
    );
    if (restricted.length)
      throw new ApiError(
        422,
        "ACCESSIBILITY_PUBLICATION_RESTRICTED",
        `Accessibility evidence has private source permissions: ${restricted.map((s) => s.name).join(", ")}. Keep it private or remove the captured mode before publication.`,
      );
  }
  if (
    scenario.retail &&
    (!retailPubliclyRedistributable(scenario.retail) ||
      scenario.retail.sourceRights.some(
        (right) => !right.authorizedPrivateUse || !right.publicRedistribution,
      ))
  )
    throw new ApiError(
      422,
      "RETAIL_PUBLICATION_RESTRICTED",
      "This retail analysis includes sources authorized only for private project use. Confirm permission to redistribute the input values and attribution publicly, or remove the retail analysis before publishing.",
    );
  const packs: RetailScenario[] = [
    ...project.scenarios,
    ...project.history.flatMap((entry) => [entry.before, entry.after]),
    ...project.undone.flatMap((entry) => [entry.before, entry.after]),
  ].flatMap((s) => (s.retail ? [s.retail] : []));
  for (const entry of [...project.history, ...project.undone])
    if (entry.command.type === "scenario.retail" && entry.command.retail)
      packs.push(entry.command.retail);
  const restricted = new Set(
    packs.flatMap((pack) =>
      pack.sourceRights
        .filter((right) => !right.publicRedistribution)
        .map((right) => right.sourceId),
    ),
  );
  // A deliberate current declaration can supersede a prior private-use choice.
  for (const right of scenario.retail?.sourceRights ?? [])
    if (right.authorizedPrivateUse && right.publicRedistribution)
      restricted.delete(right.sourceId);
  if (place.sources.some((source) => restricted.has(source.id)))
    throw new ApiError(
      422,
      "RETAIL_PUBLICATION_RESTRICTED",
      "A retail source restricted to private use also appears in the frozen baseline source inventory. Record public redistribution permission before publishing; the captured baseline cannot be redacted or replaced.",
    );
  const required = nonRetailReferences(place, scenario);
  if ([...restricted].some((id) => required.has(id)))
    throw new ApiError(
      422,
      "RETAIL_PUBLICATION_RESTRICTED",
      "A source previously restricted to private retail analysis is still referenced by current geometry or activity inputs. Use a separately permitted source or record its public redistribution permission before publishing.",
    );
  const published = structuredClone(scenario);
  if (published.sources)
    published.sources = published.sources.filter(
      (source) => !restricted.has(source.id),
    );
  // Generic import rights are independent of retail-only declarations. Resolve
  // them against retained history as well: removing current metadata must not
  // turn an already-declared private feature into a legacy unrestricted one.
  const retained = retainedSources(project, place),
    declaredIds = new Set(
      retained.filter((source) => source.rights).map((source) => source.id),
    ),
    privateIds = new Set(
      retained
        .filter(
          (source) => source.rights && !source.rights.publicRedistribution,
        )
        .map((source) => source.id),
    );
  for (const id of privateIds) {
    const currentDeclarations = (scenario.sources ?? []).filter(
      (source) => source.id === id && source.rights,
    );
    if (
      currentDeclarations.length &&
      currentDeclarations.every((source) => source.rights!.publicRedistribution)
    )
      privateIds.delete(id);
  }
  const allReferences = new Set([
    ...required,
    ...(scenario.retail ? retailSourceIds(scenario.retail) : []),
    ...(scenario.retail?.sourceRights.map((right) => right.sourceId) ?? []),
  ]);
  const privateBaseline = place.sources.filter(
    (source) => source.rights && !source.rights.publicRedistribution,
  );
  const referencedPrivate = [...allReferences].filter((id) =>
    privateIds.has(id),
  );
  if (privateBaseline.length || referencedPrivate.length)
    throw new ApiError(
      422,
      "SOURCE_PUBLICATION_RESTRICTED",
      `Public redistribution permission is missing for: ${[...new Set([...privateBaseline.map((source) => source.name), ...referencedPrivate.map((id) => retained.find((source) => source.id === id)?.name ?? id)])].join(", ")}. Keep this project private or record explicit current public permission. Omitting a source record does not remove its prior restriction.`,
    );
  if (published.sources)
    published.sources = published.sources.filter(
      (source) =>
        (!source.rights || source.rights.publicRedistribution) &&
        !privateIds.has(source.id),
    );
  // If a permitted source is retained only in history, include its actual
  // declaration and attribution in the frozen copy instead of leaving a bare ID.
  const current = new Map(
    (published.sources ?? []).map((source) => [source.id, source]),
  );
  for (const id of allReferences) {
    if (
      !declaredIds.has(id) ||
      place.sources.some((source) => source.id === id)
    )
      continue;
    const source = current.get(id);
    if (source?.rights) continue;
    const retainedPublic = [...retained]
      .reverse()
      .find(
        (candidate) =>
          candidate.id === id && candidate.rights?.publicRedistribution,
      );
    if (retainedPublic) current.set(id, structuredClone(retainedPublic));
  }
  if (current.size || published.sources)
    published.sources = [...current.values()];
  return published;
}

/** Nested accessibility citations retain their independent namespace; they never replace planning attribution. */
function validateAccessibilitySourceRights(
  previous: Project,
  next: Project,
): void {
  const references = (project: Project) =>
    projectAccessibilityReferences(project).flatMap((e) =>
      e.capture.sources.map((source) => ({
        key: `${e.capture.request.mode}:${source.id}`,
        source,
      })),
    );
  const retained = new Set(
    references(next)
      .filter((r) => r.source.rights)
      .map((r) => canonicalJSON([r.key, r.source.rights])),
  );
  const explicit = new Set(
    next.scenarios
      .flatMap((s) => accessibilityReferences(s.accessibility))
      .flatMap((e) =>
        e.capture.sources
          .filter((source) => source.rights)
          .map((source) => `${e.capture.request.mode}:${source.id}`),
      ),
  );
  if (
    references(previous).some(
      (r) =>
        r.source.rights &&
        !retained.has(canonicalJSON([r.key, r.source.rights])) &&
        !explicit.has(r.key),
    )
  )
    throw new ApiError(
      422,
      "ACCESSIBILITY_SOURCE_RIGHTS_REMOVED",
      "Previously retained accessibility source permissions cannot be silently removed. Preserve the original source inventory in history or provide an explicit current declaration.",
    );
}
