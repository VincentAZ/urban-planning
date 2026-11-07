import { describe, it, expect } from "vitest";
import { housingFixture } from "../../../packages/models/src/housing-fixture";
import { housingIncomeLimitPackHash, type Project } from "@urban/core";
import { encodeRecord, type StoredRow } from "./storage-core";
import { assertHousingStorageChanges } from "./housing-storage";
import { validateConfiguredHousing } from "./housing-validation";
import { HousingCatalog } from "./housing-catalog";
function fixture() {
  const f = housingFixture();
  for (const g of [
    ...f.scenario.affordability!.baselineGroups,
    ...f.scenario.affordability!.proposalGroups,
  ])
    g.areaOrigin = "server-catalog";
  const record = {
    project: f.project,
    baseline: f.place,
    organizationId: "org",
    version: 1,
    createdBy: "user",
    createdAt: f.review.reviewedAt,
  };
  const registry = encodeRecord("housingSources", {
    id: f.areaHash,
    pack: f.pack,
    registeredAt: f.review.reviewedAt,
    sourceManifestHash: "a".repeat(64),
  }).row;
  const run =
    (p: Project, prior?: StoredRow, registered = true) =>
    () =>
      assertHousingStorageChanges(
        {
          upserts: [encodeRecord("projects", { ...record, project: p }).row],
          deletes: [],
          blobs: new Map(),
        },
        undefined,
        (c, id) =>
          c === "projects"
            ? prior
            : c === "housingSources" && registered && id === registry.id
              ? registry
              : undefined,
      );
  return { ...f, record, registry, run };
}
describe("housing SQLite source authority", () => {
  it("requires exact operator registration for every current/historical origin and preserves imported evidence", () => {
    const f = fixture();
    expect(f.run(f.project, undefined, false)).toThrow(/operator-verified/);
    expect(f.run(f.project)).not.toThrow();
    for (const a of [f.project.scenarios[1].affordability!])
      for (const g of [...a.baselineGroups, ...a.proposalGroups])
        g.areaOrigin = "imported";
    expect(f.run(f.project, undefined, false)).not.toThrow();
    const forged = structuredClone(f.project),
      before = structuredClone(forged.scenarios[1]),
      after = structuredClone(before);
    after.affordability!.proposalGroups[0].areaOrigin = "server-catalog";
    forged.history = [
      {
        id: "history",
        at: f.review.reviewedAt,
        actor: "test",
        label: "Historical authority",
        command: {
          type: "scenario.affordability",
          affordability: after.affordability!,
        },
        before,
        after,
      },
    ];
    expect(f.run(forged, undefined, false)).toThrow(/operator-verified/);
  });
  it("retains old pack bytes and prior trust when configuration is retired", async () => {
    const f = fixture(),
      prior = encodeRecord("projects", f.record).row;
    expect(f.run(f.project, prior, false)).not.toThrow();
    await expect(
      validateConfiguredHousing(f.project, new HousingCatalog(), f.project),
    ).resolves.toBeUndefined();
    const changed = structuredClone(f.project);
    delete changed.housingIncomeLimits![f.areaHash];
    expect(f.run(changed, prior)).toThrow();
  });
  it("rejects missing rights on renamed imported pack and cost citations", () => {
    const f = fixture(),
      p = structuredClone(f.project),
      pack = structuredClone(f.pack);
    delete pack.sources[0].rights;
    pack.sources[0].id = "renamed";
    pack.files[0].sourceId = "renamed";
    const hash = housingIncomeLimitPackHash(pack);
    p.housingIncomeLimits![hash] = pack;
    p.scenarios[1].affordability!.proposalGroups[0].areaHash = hash;
    p.scenarios[1].affordability!.proposalGroups[0].areaOrigin = "imported";
    expect(f.run(p)).toThrow(/permission/);
    const costs = structuredClone(f.project);
    delete costs.scenarios[1].affordability!.sources[0].rights;
    expect(f.run(costs)).toThrow(/permission/);
  });
  it("requires project-bound selected-only packs at publication", () => {
    const f = fixture(),
      p = encodeRecord("projects", f.record).row;
    const published = encodeRecord("published", {
      id: "public",
      projectId: f.project.id,
      organizationId: "org",
      projectName: "test",
      placeId: f.place.id,
      baseline: f.place,
      scenario: f.scenario,
      results: {},
      createdAt: f.review.reviewedAt,
      feedbackEnabled: false,
      housingIncomeLimits: f.project.housingIncomeLimits,
    }).row;
    const run = (row: StoredRow) => () =>
      assertHousingStorageChanges(
        { upserts: [row], deletes: [], blobs: new Map() },
        undefined,
        () => p,
      );
    expect(run(published)).not.toThrow();
    const forged = structuredClone(published);
    forged.indexes.organizationId = "other";
    expect(run(forged)).toThrow(/exact project/);
    const omitted = structuredClone(published);
    delete (omitted.payload as any).housingIncomeLimits;
    expect(run(omitted)).toThrow(/exact project/);
  });
});
