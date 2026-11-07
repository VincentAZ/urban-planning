import { describe, expect, it } from "vitest";
import {
  TRAFFIC_COMMUTE_DEPARTURE_BINS,
  trafficCommuteContentHash,
  validateTrafficCommuteSourcePack,
  validateTrafficCommuteRecipe,
} from "@urban/core";
import { trafficCommuteFixture } from "./traffic-commute-fixture";

describe("immutable commute source contracts", () => {
  it("retains all native cells and literal source records without defaults or mutation", async () => {
    const { pack, recipe } = trafficCommuteFixture();
    const before = JSON.stringify(pack),
      hash = await trafficCommuteContentHash(pack);
    validateTrafficCommuteSourcePack(pack);
    validateTrafficCommuteRecipe(recipe, pack);
    expect(JSON.stringify(pack)).toBe(before);
    expect(await trafficCommuteContentHash(pack)).toBe(hash);
    expect(TRAFFIC_COMMUTE_DEPARTURE_BINS).toHaveLength(14);
    expect(TRAFFIC_COMMUTE_DEPARTURE_BINS[0]).toEqual({
      cellId: "B08132_017",
      beginSeconds: 0,
      endSeconds: 18000,
    });
    expect(TRAFFIC_COMMUTE_DEPARTURE_BINS.at(-1)?.endSeconds).toBe(86400);
  });
  it("rejects lost source cells, contradictory parsed values, missing files and duplicate OD pairs", () => {
    const { pack } = trafficCommuteFixture();
    const missing = structuredClone(pack);
    delete missing.tracts[0].cells.B08132_090;
    expect(() => validateTrafficCommuteSourcePack(missing)).toThrow(/90/);
    const value = structuredClone(pack);
    value.flows[0].jobs++;
    expect(() => validateTrafficCommuteSourcePack(value)).toThrow(/S000/);
    const raw = structuredClone(pack);
    raw.residences[0].raw.C000 = "";
    expect(() => validateTrafficCommuteSourcePack(raw)).toThrow(/C000/);
    const file = structuredClone(pack);
    file.files.pop();
    expect(() => validateTrafficCommuteSourcePack(file)).toThrow(/file/);
    const duplicate = structuredClone(pack);
    duplicate.flows.push({ ...pack.flows[0], id: "duplicate" });
    expect(() => validateTrafficCommuteSourcePack(duplicate)).toThrow(
      /Home\/work/,
    );
  });
  it("preserves explicit suppressed estimates and unresolved geographic candidates", () => {
    const { pack } = trafficCommuteFixture();
    pack.tracts[0].cells.B08132_022.estimate = {
      status: "suppressed",
      value: null,
      raw: "-666666666",
      annotation: "**",
    };
    pack.blocks[0].tractJoin = {
      status: "unresolved",
      candidateTractGeoids: [pack.tracts[0].geoid],
      reason: "split-geography",
      evidenceFileSha256: pack.files.find((f) => f.role === "geography")!
        .sha256,
    };
    validateTrafficCommuteSourcePack(pack);
    pack.tracts[0].cells.B08132_022.estimate.value = 0;
    expect(() => validateTrafficCommuteSourcePack(pack)).toThrow(
      /Census cells/,
    );
  });
  it("requires true JT01, state part semantics and reconciled statewide accounting", () => {
    const { pack } = trafficCommuteFixture();
    const wrong = structuredClone(pack);
    (wrong.lodes as { jobType: string }).jobType = "JT00";
    expect(() => validateTrafficCommuteSourcePack(wrong)).toThrow();
    const part = structuredClone(pack);
    part.flows[0].part = "aux";
    part.flows[0].sourceFileSha256 = pack.files.find(
      (f) => f.role === "lodes-aux",
    )!.sha256;
    expect(() => validateTrafficCommuteSourcePack(part)).toThrow(/main\/aux/);
    const reconcile = structuredClone(pack);
    reconcile.reconciliation.unresolvedOutboundJobs = 0;
    expect(() => validateTrafficCommuteSourcePack(reconcile)).toThrow(
      /reconcile/,
    );
  });
  it("requires unique complete clock/tract/cell selection and rejects a DST-changing home day", () => {
    const { pack, recipe } = trafficCommuteFixture();
    const dup = structuredClone(recipe);
    dup.departureCellIds.push(dup.departureCellIds[0]);
    expect(() => validateTrafficCommuteRecipe(dup, pack)).toThrow(/unique/);
    const total = structuredClone(recipe);
    total.departureCellIds = ["B08132_016"];
    expect(() => validateTrafficCommuteRecipe(total, pack)).toThrow(
      /departure cell/,
    );
    const clock = structuredClone(recipe);
    clock.homeClocks = [];
    expect(() => validateTrafficCommuteRecipe(clock, pack)).toThrow();
    const dst = structuredClone(recipe);
    dst.period.date = "2026-03-08";
    dst.homeClocks[0] = { ...dst.homeClocks[0], timeZone: "America/Denver" };
    expect(() => validateTrafficCommuteRecipe(dst, pack)).toThrow(
      /offset|clock|DST|day/i,
    );
  });
});
