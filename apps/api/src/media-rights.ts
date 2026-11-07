import {
  materializeBuildings,
  materializeParcels,
  materializeRoads,
  type Place,
  type Project,
  type Scenario,
  type Source,
} from "@urban/core";
import { ApiError } from "./errors.js";
import { assertFiscalExport } from "./fiscal-rights.js";
import { assertFloodExport } from "./flood-validation.js";

export { assertSourceMetadataPrivacy as assertMediaMetadataPrivacy } from "./source-metadata-privacy.js";

/** Retained declarations cannot be erased by omitting a current citation before exporting its geometry. */
export function assertMediaPrivateExport(
  project: Project,
  place: Place,
  scenario: Scenario,
) {
  assertFiscalExport(project);
  assertFloodExport(project, scenario);
  const retained: Source[] = [
    ...place.sources,
    ...project.scenarios.flatMap((s) => s.sources ?? []),
    ...[...project.history, ...project.undone].flatMap((e) => [
      ...(e.before.sources ?? []),
      ...(e.after.sources ?? []),
      ...("source" in e.command && e.command.source ? [e.command.source] : []),
      ...("sources" in e.command ? (e.command.sources ?? []) : []),
    ]),
  ];
  const references = new Set<string>(
    [...place.sources, ...(scenario.sources ?? [])].map((s) => s.id),
  );
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if ((k === "sourceId" || k.endsWith("SourceId")) && typeof x === "string")
        references.add(x);
      else if (k === "sourceIds" && Array.isArray(x)) {
        for (const id of x) if (typeof id === "string") references.add(id);
      } else walk(x);
    }
  };
  walk([
    ...materializeBuildings(place, scenario),
    ...materializeRoads(place, scenario),
    ...materializeParcels(place, scenario),
    scenario.activity,
  ]);
  for (const old of retained.filter((s) => s.rights && references.has(s.id))) {
    const current = [...place.sources, ...(scenario.sources ?? [])].filter(
      (s) => s.id === old.id,
    );
    if (!current.length)
      throw new ApiError(
        422,
        "MEDIA_SOURCE_ATTRIBUTION_REQUIRED",
        "A geometry source with retained permissions is missing from the current source inventory. Restore its citation before export.",
      );
    const declarations = (scenario.sources ?? []).filter(
      (s) => s.id === old.id && s.rights,
    );
    const applicable = declarations.length ? declarations : [old];
    if (
      applicable.some(
        (s) =>
          s.rights &&
          (!s.rights.privateUse ||
            !s.rights.privateDisplay ||
            !s.rights.export),
      )
    )
      throw new ApiError(
        422,
        "MEDIA_EXPORT_RESTRICTED",
        "A retained source declaration does not permit private display and export. Record an explicit current permission declaration before exporting.",
      );
  }
}
