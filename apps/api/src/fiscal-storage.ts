import {
  canonicalJSON,
  fiscalContentHash,
  fiscalProfileHash,
  fiscalProfileSchema,
  fiscalProjectIssues,
} from "@urban/core";
import type { StoreChanges } from "./storage-core.js";
import type { StoreScope, CollectionName } from "./store-scope.js";
import {
  assertFiscalPrivateUse,
  assertFiscalPublication,
} from "./fiscal-rights.js";
import { projectAccess } from "./project-access.js";
export function assertFiscalStorageChanges(
  changes: StoreChanges,
  scope: StoreScope | undefined,
  read: (collection: CollectionName, id: string) => any,
  headers: (
    collection: "fiscalProfiles" | "fiscalStudyCreations",
    org: string,
  ) => any[],
) {
  if (!scope) return;
  const relevant = changes.upserts.filter((r) =>
    [
      "fiscalProfiles",
      "fiscalStudyCreations",
      "projects",
      "published",
    ].includes(r.collection),
  );
  if (!relevant.length) return;
  const deny = (message: string): never => {
    throw new Error(message);
  };
  const session = scope.auth?.sessionHash
    ? read("sessions", scope.auth.sessionHash)
    : undefined;
  const user = session ? read("users", session.userId) : undefined;
  const member = session
    ? read(
        "memberships",
        JSON.stringify([session.userId, session.organizationId]),
      )
    : undefined;
  const workspace = () => {
    if (
      scope.security ||
      !session ||
      !user ||
      !member ||
      member.scope === "project-only" ||
      !["owner", "editor"].includes(member.role) ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= Date.now() ||
      (session.credentialVersion ?? 0) !== (user.credentialVersion ?? 0)
    )
      deny("Fiscal library writes require a current workspace editor session.");
    return { userId: session.userId, organizationId: session.organizationId };
  };
  const current = (collection: CollectionName, id: string) => {
    const pending = changes.upserts.find(
      (r) => r.collection === collection && r.id === id,
    );
    return pending
      ? { ...pending.header, ...((pending.payload as object) ?? {}) }
      : read(collection, id);
  };
  const admitted: { collection: string; header: any }[] = [];
  const retainedHeaders = (
    collection: "fiscalProfiles" | "fiscalStudyCreations",
    org: string,
  ) => [
    ...headers(collection, org),
    ...admitted
      .filter(
        (r) => r.collection === collection && r.header.organizationId === org,
      )
      .map((r) => r.header),
  ];
  for (const row of relevant) {
    if (row.collection === "fiscalProfiles") {
      const i = workspace(),
        h = row.header as any,
        p = (row.payload as any)?.profile;
      if (
        read("fiscalProfiles", row.id) ||
        row.id !== h.id ||
        h.organizationId !== i.organizationId ||
        h.userId !== i.userId ||
        row.indexes.organizationId !== i.organizationId ||
        row.indexes.userId !== i.userId
      )
        deny("Fiscal profile identity is immutable and workspace scoped.");
      const profile = fiscalProfileSchema.parse(p);
      assertFiscalPrivateUse(profile);
      if (
        profile.sources.some(
          (s) =>
            s.rights?.declaredBy !== i.userId ||
            s.rights?.declaredAt !== h.createdAt,
        )
      )
        deny(
          "New fiscal attestations must identify the authenticated submitter and version time.",
        );
      if (
        h.profileHash !== fiscalProfileHash(profile) ||
        h.name !== profile.name ||
        h.jurisdictionName !== profile.jurisdiction.name ||
        h.fiscalYear !== profile.fiscalYear ||
        !Number.isFinite(Date.parse(h.createdAt)) ||
        Math.abs(Date.parse(h.createdAt) - Date.now()) > 30000 ||
        typeof h.idempotencyKey !== "string" ||
        h.idempotencyKey.length < 8 ||
        h.idempotencyKey.length > 160 ||
        !/^[a-f0-9]{64}$/.test(h.submissionHash ?? "")
      )
        deny("Invalid fiscal profile version content.");
      const all = retainedHeaders("fiscalProfiles", i.organizationId),
        family = all
          .filter((p) => p.profileId === h.profileId)
          .sort((a, b) => b.version - a.version),
        previous = family[0];
      if (
        all.length >= 1000 ||
        family.length >= 100 ||
        all.some(
          (p) => p.userId === i.userId && p.idempotencyKey === h.idempotencyKey,
        ) ||
        !Number.isInteger(h.version) ||
        h.version !== (previous?.version ?? 0) + 1 ||
        h.previousVersionId !== (previous?.id ?? null) ||
        typeof h.profileId !== "string"
      )
        deny("Fiscal versions must append to the current immutable family.");
    } else if (row.collection === "fiscalStudyCreations") {
      const i = workspace(),
        h = row.header as any;
      const source = read("projects", h.sourceProjectId),
        target = current("projects", h.projectId);
      if (
        read("fiscalStudyCreations", row.id) ||
        row.payload !== null ||
        h.id !== row.id ||
        h.organizationId !== i.organizationId ||
        h.userId !== i.userId ||
        row.indexes.projectId !== h.projectId ||
        source?.organizationId !== i.organizationId ||
        target?.organizationId !== i.organizationId ||
        target?.createdBy !== i.userId ||
        target?.version !== 1 ||
        !changes.upserts.some(
          (r) =>
            r.collection === "projects" &&
            r.id === h.projectId &&
            r.ordinal === 0,
        ) ||
        source?.version !== h.sourceVersion
      )
        deny(
          "A fiscal creation receipt must accompany its exact new project and source version.",
        );
      if (
        !projectAccess(source, i.userId, member)?.canEdit ||
        row.indexes.organizationId !== i.organizationId ||
        row.indexes.userId !== i.userId ||
        typeof h.idempotencyKey !== "string" ||
        h.idempotencyKey.length < 8 ||
        h.idempotencyKey.length > 160 ||
        !/^[a-f0-9]{64}$/.test(h.submissionHash ?? "") ||
        !Number.isFinite(Date.parse(h.createdAt)) ||
        Math.abs(Date.parse(h.createdAt) - Date.now()) > 30000 ||
        !Number.isSafeInteger(h.sourceVersion) ||
        h.sourceVersion < 1 ||
        !Number.isSafeInteger(h.sourceRevision) ||
        h.sourceRevision < 0 ||
        retainedHeaders("fiscalStudyCreations", i.organizationId).some(
          (r) =>
            r.projectId === h.projectId ||
            (r.userId === i.userId && r.idempotencyKey === h.idempotencyKey),
        )
      )
        deny("Invalid or replayed fiscal creation identity or source access.");
      if (h.libraryVersionId) {
        const library = read("fiscalProfiles", h.libraryVersionId);
        if (
          library?.organizationId !== i.organizationId ||
          library.profileHash !== h.profileHash ||
          canonicalJSON(library.profile) !==
            canonicalJSON(target.project.fiscalStudy?.profile)
        )
          deny("Fiscal library version differs from frozen new study.");
      }
      const sourceScenario = source.project.scenarios.find(
          (s: any) => s.id === h.sourceScenarioId,
        ),
        study = target.project.fiscalStudy;
      if (
        sourceScenario?.revision !== h.sourceRevision ||
        study?.profileHash !== h.profileHash ||
        study?.lineage.projectId !== h.sourceProjectId ||
        study?.lineage.scenarioId !== h.sourceScenarioId ||
        study?.lineage.projectHash !== fiscalContentHash(source.project) ||
        study?.lineage.scenarioHash !== fiscalContentHash(sourceScenario)
      )
        deny("Fiscal study lineage differs from its selected source.");
    } else if (row.collection === "projects" && row.payload !== undefined) {
      const project = (row.payload as any)?.project,
        old = read("projects", row.id);
      if (
        old &&
        canonicalJSON(old.project.fiscalStudy ?? null) !==
          canonicalJSON(project.fiscalStudy ?? null)
      )
        deny(
          "A fiscal study profile cannot be replaced or added to an existing project.",
        );
      const issues = fiscalProjectIssues(project);
      if (issues.length) deny(issues.join(" "));
      if (project.fiscalStudy) {
        if (project.fiscalStudy.placeHash !== row.baselineHash)
          deny("Fiscal study belongs to another immutable baseline.");
        assertFiscalPrivateUse(project.fiscalStudy.profile);
      }
    } else if (row.collection === "published" && row.payload !== undefined) {
      const payload = row.payload as any,
        source = current("projects", String(row.header.projectId));
      if (
        canonicalJSON(payload.fiscalStudy ?? null) !==
        canonicalJSON(source?.project.fiscalStudy ?? null)
      )
        deny("Publication must retain its exact fiscal study profile.");
      if (payload.fiscalStudy)
        assertFiscalPublication({ fiscalStudy: payload.fiscalStudy });
    }
    admitted.push({ collection: row.collection, header: row.header });
  }
}
