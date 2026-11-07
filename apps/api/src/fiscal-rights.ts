import {
  canonicalJSON,
  type FiscalProfile,
  type Project,
  type Source,
} from "@urban/core";
import { assertSourceMetadataPrivacy } from "./source-metadata-privacy.js";
import { ApiError } from "./errors.js";

function assertRights(
  profile: FiscalProfile | undefined,
  permission: "private" | "export" | "public",
) {
  if (!profile) return;
  assertSourceMetadataPrivacy(profile, "fiscal");
  const restricted = profile.sources.filter(
    (s) =>
      !s.rights ||
      (permission === "public"
        ? !s.rights.publicRedistribution
        : permission === "export"
          ? !s.rights.privateUse || !s.rights.privateDisplay || !s.rights.export
          : !s.rights.privateUse ||
            !s.rights.cache ||
            !s.rights.analyze ||
            !s.rights.privateDisplay ||
            !s.rights.historicalRetention),
  );
  if (restricted.length)
    throw new ApiError(
      422,
      permission === "public"
        ? "FISCAL_PUBLICATION_RESTRICTED"
        : permission === "export"
          ? "FISCAL_EXPORT_RESTRICTED"
          : "FISCAL_SOURCE_PERMISSION_REQUIRED",
      "The fiscal profile requires explicit source permissions for this use. Retain every citation and record the applicable permission declaration.",
    );
}
export const assertFiscalPrivateUse = (profile: FiscalProfile) =>
  assertRights(profile, "private");
export const assertFiscalExport = (project: Pick<Project, "fiscalStudy">) =>
  assertRights(project.fiscalStudy?.profile, "export");
export const assertFiscalPublication = (
  project: Pick<Project, "fiscalStudy">,
) => assertRights(project.fiscalStudy?.profile, "public");
export function validateFiscalRightsTransition(
  previous: Project,
  next: Project,
) {
  if (
    canonicalJSON(previous.fiscalStudy ?? null) !==
    canonicalJSON(next.fiscalStudy ?? null)
  )
    throw new ApiError(
      409,
      "FISCAL_STUDY_IMMUTABLE",
      "A saved fiscal study retains its original profile, review and lineage. Create a separate study to use another profile.",
    );
}
/** New library versions may update explicit attestations, never silently erase them. */
export function validateFiscalProfileRights(
  previous: FiscalProfile[],
  next: FiscalProfile,
) {
  const linked = (a: Source, b: Source) =>
    a.id === b.id ||
    Boolean(a.url && a.url === b.url) ||
    previous.some(
      (p) =>
        p.sources.includes(a) &&
        p.files.some(
          (f) =>
            f.sourceId === a.id &&
            next.files.some(
              (n) => n.sourceId === b.id && n.sha256 === f.sha256,
            ),
        ),
    );
  if (
    previous
      .flatMap((p) => p.sources)
      .some(
        (old) =>
          old.rights && next.sources.some((s) => linked(old, s) && !s.rights),
      )
  )
    throw new ApiError(
      422,
      "FISCAL_SOURCE_RIGHTS_REMOVED",
      "A prior fiscal citation's permissions must be retained or replaced with an explicit current declaration.",
    );
  assertFiscalPrivateUse(next);
}

/** Records the authenticated submitter's attestation; this is not a license verification. */
export function stampFiscalDeclarations(
  profile: FiscalProfile,
  actorId: string,
  at: string,
): FiscalProfile {
  assertFiscalPrivateUse(profile);
  const result = structuredClone(profile);
  for (const source of result.sources)
    source.rights = { ...source.rights!, declaredBy: actorId, declaredAt: at };
  return result;
}
