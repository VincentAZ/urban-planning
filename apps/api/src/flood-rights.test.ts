import { describe, it, expect } from "vitest";
import { floodFixture } from "../../../tests/fixtures/flood";
import { floodDatasetHash } from "@urban/core";
import {
  assertFloodExport,
  assertFloodPublication,
  validateFloodAuthority,
} from "./flood-validation";
import { assertFloodRightsTransition } from "./flood-rights";
async function setup() {
  const f = await floodFixture();
  const d = structuredClone(f.dataset);
  d.sources[0].rights = {
    version: 1,
    privateUse: true,
    cache: true,
    analyze: true,
    privateDisplay: true,
    export: false,
    historicalRetention: true,
    publicRedistribution: false,
    declaredBy: "test",
    declaredAt: "2026-11-06T00:00:00Z",
  };
  const hash = await floodDatasetHash(d);
  f.project.floodDatasets = { [hash]: d };
  f.project.scenarios[1].flood = {
    version: 1,
    datasetHash: hash,
    origin: "imported",
  };
  return { ...f, d, hash };
}
describe("flood source rights provenance across distinct dataset hashes", () => {
  it.each(["id", "url", "receipt"] as const)(
    "retains restrictions across a cloned pack linked by %s",
    async (mode) => {
      const f = await setup();
      if (mode === "url") {
        f.d.sources[0].url = "https://example.test/original-study";
        const h = await floodDatasetHash(f.d);
        f.project.floodDatasets = { [h]: f.d };
        f.project.scenarios[1].flood!.datasetHash = h;
      }
      const previous = structuredClone(f.project),
        next = structuredClone(previous),
        clone = structuredClone(f.d);
      delete clone.sources[0].rights;
      if (mode !== "id") {
        clone.sources[0].id = "new-id";
        clone.files.forEach((file) => (file.sourceId = "new-id"));
      }
      if (mode === "url") {
        clone.files.forEach((file) => (file.sha256 = "c".repeat(64)));
      }
      const hash = await floodDatasetHash(clone);
      next.floodDatasets![hash] = clone;
      next.scenarios[1].flood = {
        version: 1,
        datasetHash: hash,
        origin: "imported",
      };
      expect(() => validateFloodAuthority(next, f.place, [], previous)).toThrow(
        /erase retained permissions/,
      );
      expect(() => assertFloodPublication(next, next.scenarios[1])).toThrow(
        /public redistribution/,
      );
      expect(() => assertFloodExport(next, next.scenarios[1])).toThrow(
        /permit export/,
      );
    },
  );
  it("allows a complete explicit new attestation, without changing the original restricted bytes", async () => {
    const f = await setup(),
      previous = structuredClone(f.project),
      clone = structuredClone(f.d);
    clone.sources[0].rights!.publicRedistribution = true;
    clone.sources[0].rights!.export = true;
    clone.sources[0].rights!.declaredBy = "new explicit review";
    const hash = await floodDatasetHash(clone);
    f.project.floodDatasets![hash] = clone;
    f.project.scenarios[1].flood = {
      version: 1,
      datasetHash: hash,
      origin: "imported",
    };
    expect(() =>
      validateFloodAuthority(f.project, f.place, [], previous),
    ).not.toThrow();
    expect(() =>
      assertFloodPublication(f.project, f.project.scenarios[1]),
    ).not.toThrow();
    expect(() =>
      assertFloodExport(f.project, f.project.scenarios[1]),
    ).not.toThrow();
    expect(
      f.project.floodDatasets![f.hash].sources[0].rights!.publicRedistribution,
    ).toBe(false);
  });
  it("does not let an unverified private import override independently verified public catalog authority", async () => {
    const f = await setup();
    f.project.floodDatasets![f.datasetHash] = f.dataset;
    f.project.scenarios[1].flood = {
      version: 1,
      datasetHash: f.datasetHash,
      origin: "server-catalog",
    };
    expect(() =>
      assertFloodRightsTransition(
        f.project,
        undefined,
        new Set([f.datasetHash]),
      ),
    ).not.toThrow();
    expect(() =>
      assertFloodPublication(f.project, f.project.scenarios[1]),
    ).not.toThrow();
  });
});
