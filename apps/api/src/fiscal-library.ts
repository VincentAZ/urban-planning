import { randomUUID } from "node:crypto";
import {
  fiscalProfileSchema,
  fiscalProfileHash,
  fiscalContentHash,
  type FiscalProfile,
} from "@urban/core";
import { z } from "zod";
import type { DataState, authorize } from "./store.js";
import type {
  FiscalProfileVersionRecord,
  FiscalProfileVersionHeader,
  FiscalProfileVersionView,
  FiscalProfilesPage,
} from "./fiscal-types.js";
import { ApiError } from "./errors.js";
import {
  assertFiscalPrivateUse,
  validateFiscalProfileRights,
  stampFiscalDeclarations,
} from "./fiscal-rights.js";

export const FISCAL_LIBRARY_LIMITS = {
  retainedVersionsPerOrganization: 1000,
  versionsPerProfile: 100,
  profileBytes: 256 * 1024,
  pageSize: 50,
} as const;
export const fiscalProfileSubmissionSchema = z
  .object({
    profile: fiscalProfileSchema,
    profileId: z.string().uuid().optional(),
    expectedLatestVersionId: z.string().uuid().nullable().optional(),
    idempotencyKey: z.string().min(8).max(160),
  })
  .strict();
export type FiscalProfileSubmission = z.infer<
  typeof fiscalProfileSubmissionSchema
>;
export function requireFiscalWorkspace(
  identity: ReturnType<typeof authorize>,
  write = false,
) {
  if (
    identity.membership.scope === "project-only" ||
    (write && !["owner", "editor"].includes(identity.membership.role))
  )
    throw new ApiError(
      403,
      "FISCAL_LIBRARY_FORBIDDEN",
      "The fiscal library requires full workspace membership; adding a version requires an owner or editor.",
    );
}
export function fiscalProfileView(
  row: FiscalProfileVersionHeader,
): FiscalProfileVersionView {
  const {
    organizationId: _o,
    userId: _u,
    idempotencyKey: _i,
    submissionHash: _h,
    ...view
  } = row;
  return view;
}
export function appendFiscalProfile(
  state: DataState,
  input: FiscalProfileSubmission,
  identity: ReturnType<typeof authorize>,
) {
  requireFiscalWorkspace(identity, true);
  const hash = fiscalContentHash(input),
    org = identity.organization.id,
    user = identity.user.id;
  const headers = [
    ...new Map(
      [...state.fiscalProfileHeaders, ...state.fiscalProfiles]
        .filter((r) => r.organizationId === org)
        .map((r) => [r.id, r]),
    ).values(),
  ];
  const replay = headers.find(
    (r) => r.userId === user && r.idempotencyKey === input.idempotencyKey,
  );
  if (replay) {
    if (replay.submissionHash !== hash)
      throw new ApiError(
        409,
        "FISCAL_IDEMPOTENCY_CONFLICT",
        "This request key already belongs to a different fiscal profile submission.",
      );
    return replay;
  }
  assertFiscalPrivateUse(input.profile);
  if (headers.length >= FISCAL_LIBRARY_LIMITS.retainedVersionsPerOrganization)
    throw new ApiError(
      429,
      "FISCAL_LIBRARY_CAPACITY",
      "The workspace's retained fiscal library is full. Existing evidence remains available.",
    );
  const family = input.profileId
    ? headers.filter((r) => r.profileId === input.profileId)
    : [];
  const latest = family.sort((a, b) => b.version - a.version)[0];
  if (input.profileId && !latest)
    throw new ApiError(404, "NOT_FOUND", "Fiscal profile family not found.");
  if ((latest?.id ?? null) !== (input.expectedLatestVersionId ?? null))
    throw new ApiError(
      409,
      "FISCAL_PROFILE_VERSION_CHANGED",
      "A newer fiscal profile version exists. Review it before appending another version.",
    );
  if (family.length >= FISCAL_LIBRARY_LIMITS.versionsPerProfile)
    throw new ApiError(
      429,
      "FISCAL_LIBRARY_CAPACITY",
      "This profile has reached its retained version limit. No version was removed.",
    );
  validateFiscalProfileRights(
    state.fiscalProfiles
      .filter(
        (p) => p.organizationId === org && p.profileId === input.profileId,
      )
      .map((p) => p.profile),
    input.profile,
  );
  const now = new Date().toISOString(),
    profile: FiscalProfile = stampFiscalDeclarations(input.profile, user, now);
  const record: FiscalProfileVersionRecord = {
    id: randomUUID(),
    organizationId: org,
    userId: user,
    profileId: input.profileId ?? randomUUID(),
    version: (latest?.version ?? 0) + 1,
    previousVersionId: latest?.id ?? null,
    profileHash: fiscalProfileHash(profile),
    name: profile.name,
    jurisdictionName: profile.jurisdiction.name,
    fiscalYear: profile.fiscalYear,
    createdAt: now,
    idempotencyKey: input.idempotencyKey,
    submissionHash: hash,
    profile,
  };
  state.fiscalProfiles.push(record);
  return record;
}
export function fiscalLibraryPage(
  rows: FiscalProfileVersionHeader[],
  org: string,
  query: unknown,
  profileId?: string,
): FiscalProfilesPage {
  const parsed = z
    .object({ cursor: z.string().max(1024).optional() })
    .strict()
    .safeParse(query);
  if (!parsed.success)
    throw new ApiError(
      422,
      "FISCAL_CURSOR_INVALID",
      "Invalid fiscal library cursor or query.",
    );
  let after: { createdAt: string; id: string } | undefined;
  if (parsed.data.cursor)
    try {
      const raw = parsed.data.cursor;
      if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw 0;
      const c = z
        .object({
          version: z.literal(1),
          org: z.string(),
          profileId: z.string().nullable(),
          createdAt: z.string().datetime(),
          id: z.string().uuid(),
        })
        .strict()
        .parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
      if (c.org !== org || c.profileId !== (profileId ?? null)) throw 0;
      after = c;
    } catch {
      throw new ApiError(
        422,
        "FISCAL_CURSOR_INVALID",
        "The fiscal library cursor belongs to another workspace or profile.",
      );
    }
  let selected = rows.filter(
    (r) =>
      r.organizationId === org && (!profileId || r.profileId === profileId),
  );
  if (!profileId) {
    const latest = new Map<string, FiscalProfileVersionHeader>();
    for (const r of selected)
      if ((latest.get(r.profileId)?.version ?? 0) < r.version)
        latest.set(r.profileId, r);
    selected = [...latest.values()];
  }
  selected = selected
    .filter(
      (r) =>
        !after ||
        r.createdAt < after.createdAt ||
        (r.createdAt === after.createdAt && r.id < after.id),
    )
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id > b.id
          ? -1
          : a.id < b.id
            ? 1
            : 0
        : a.createdAt > b.createdAt
          ? -1
          : 1,
    );
  const page = selected.slice(0, FISCAL_LIBRARY_LIMITS.pageSize),
    last = page.at(-1);
  return {
    profiles: page.map(fiscalProfileView),
    nextCursor:
      selected.length > page.length && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              org,
              profileId: profileId ?? null,
              createdAt: last.createdAt,
              id: last.id,
            }),
          ).toString("base64url")
        : null,
  };
}
