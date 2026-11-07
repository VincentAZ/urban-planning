import { describe, expect, it } from "vitest";
import { buildWorkforceCohortPack } from "./workforce-pack";
import {
  workforceAcsColumns,
  workforceSummaryUrl,
  type WorkforceAcsSubset,
  type WorkforceAcsTable,
} from "./workforce-acs";
import {
  censusBlockSourceUrl,
  type PreparedWorkforceBlocks,
} from "./workforce-blocks";

const group = "040130001001";
const otherGroup = "040130001002";
const retrievedAt = "2026-11-06T00:00:00.000Z";
function table(table: WorkforceAcsTable): WorkforceAcsSubset {
  return {
    version: 1,
    table,
    vintage: 2024,
    state: "04",
    geography: "block-group",
    columns: workforceAcsColumns(table),
    rows: {
      [group]: workforceAcsColumns(table).map(() => "0"),
      [otherGroup]: workforceAcsColumns(table).map(() => "0"),
    },
    source: {
      url: workforceSummaryUrl(table),
      sha256: "a".repeat(64),
      bytes: 1000,
      retrievedAt,
    },
  };
}
function fixture() {
  const blocks: PreparedWorkforceBlocks = {
    schemaVersion: 1,
    stateFips: "04",
    countyGeoids: ["04013"],
    blockGroupGeoids: [group, otherGroup],
    unallocatedBlocks: [],
    populationVintage: 2020,
    blockGeographyVintage: 2020,
    targetGeographyVintage: 2024,
    sourceRelease: "TIGER2024",
    sources: (["tabblock20", "tabblocksufx", "bg"] as const).map((kind) => ({
      kind,
      url: censusBlockSourceUrl("04", kind),
      sha256: "b".repeat(64),
      bytes: 1000,
      retrievedAt,
      archiveEntry: `synthetic-${kind}.dbf`,
      dbfSha256: "c".repeat(64),
      dbfBytes: 500,
      records: 3,
    })),
    geographyMatch: {
      status: "verified",
      method: "census-current-suffixed-block-relationship",
      documentation: "https://www.census.gov/",
      changedBlockGroupIds: 1,
      multipleSuffixPiecesSameGroup: 0,
      unmatchedBlocks: 0,
      ambiguouslySplitBlocks: 0,
      unresolvedPopulation2020: 0,
      missingCurrentBlockGroups: 0,
      unchangedPolygonsAsserted: false,
    },
    completeness: {
      stateBlockRows: 3,
      stateRelationshipRows: 3,
      stateBlockGroupRows: 2,
      missingPopulationCounts: 0,
      missingHousingCounts: 0,
      counties: [
        {
          geoid: "04013",
          blocks: 3,
          blockGroups: 2,
          zeroPopulationBlocks: 1,
          population2020: 40,
          housingUnits2020: 20,
        },
      ],
    },
    notes: ["Synthetic fixture: no actual Census counts or geography."],
    blocks: [
      {
        id: "040130001001001",
        unitGeoid: group,
        blockGroup2020: group,
        position: [-112.1, 33.4],
        population2020: 10,
        housingUnits2020: 5,
      },
      // The mapping, not the original prefix, selects this block's current native unit.
      {
        id: "040130001002001",
        unitGeoid: group,
        blockGroup2020: otherGroup,
        position: [-112.11, 33.41],
        population2020: 30,
        housingUnits2020: 15,
      },
      {
        id: "040130001002002",
        unitGeoid: otherGroup,
        blockGroup2020: otherGroup,
        position: [-112.12, 33.42],
        population2020: 0,
        housingUnits2020: 0,
      },
    ],
  };
  return {
    blocks,
    education: table("B15003"),
    occupation: table("C24010"),
    label: "Synthetic county fixture",
  };
}
describe("workforce evidence pack joins", () => {
  it("uses explicit current-BG relationships and complete population denominators, retaining zero-population evidence", () => {
    const input = fixture();
    input.education.rows[otherGroup][0] = "50";
    const pack = buildWorkforceCohortPack(input);
    expect(pack.origins.map((origin) => origin.weight)).toEqual([
      0.25, 0.75, 0,
    ]);
    expect(pack.origins[1].unitGeoid).toBe(group);
    expect(pack.units[1]).toMatchObject({
      geoid: otherGroup,
      allocationStatus: "unavailable",
    });
    expect(pack.units[1].education.B15003_001.estimate.value).toBe(50);
    expect(pack.files).toHaveLength(5);
    expect(pack.region.complete).toBe(true);
    expect(input.blocks.blocks[1]).not.toHaveProperty("weight");
  });
  it("rejects unmatched native cohorts and never drops a source row to make tables agree", () => {
    const input = fixture();
    delete input.occupation.rows[otherGroup];
    expect(() => buildWorkforceCohortPack(input)).toThrow("inventories differ");
    const more = fixture();
    more.education.rows["040130001003"] = [...more.education.rows[group]];
    more.occupation.rows["040130001003"] = [...more.occupation.rows[group]];
    expect(() => buildWorkforceCohortPack(more)).toThrow(
      "inventories do not match",
    );
  });
  it("rejects duplicate origins and evidence that cannot prove complete county denominators", () => {
    const duplicate = fixture();
    duplicate.blocks.blocks.push(structuredClone(duplicate.blocks.blocks[0]));
    expect(() => buildWorkforceCohortPack(duplicate)).toThrow("duplicated");
    const missing = fixture();
    missing.blocks.blocks.splice(0, 1);
    expect(() => buildWorkforceCohortPack(missing)).toThrow("county counts");
    const changed = fixture();
    changed.blocks.blocks[0].population2020 = 0;
    expect(() => buildWorkforceCohortPack(changed)).toThrow("county counts");
  });
  it("rejects incomplete geographic matches, incorrect vintages, missing provenance and unsafe source substitutions", () => {
    const incomplete = fixture();
    incomplete.blocks.geographyMatch.unmatchedBlocks = 1 as 0;
    expect(() => buildWorkforceCohortPack(incomplete)).toThrow(
      "complete, explicitly matched",
    );
    const vintage = fixture();
    vintage.education.vintage = 2023 as 2024;
    expect(() => buildWorkforceCohortPack(vintage)).toThrow("table contract");
    const missing = fixture();
    missing.blocks.sources.pop();
    expect(() => buildWorkforceCohortPack(missing)).toThrow("All three");
    const substituted = fixture();
    substituted.occupation.source.url = "https://example.invalid/fake.dat";
    expect(() => buildWorkforceCohortPack(substituted)).toThrow("provenance");
  });
  it("retains ambiguous original blocks once and withholds affected allocations without renormalizing", () => {
    const input = fixture();
    input.blocks.unallocatedBlocks.push({
      id: "040130001002003",
      blockGroup2020: otherGroup,
      position: [-112.13, 33.43],
      population2020: 12,
      housingUnits2020: 4,
      candidateUnitGeoids: [group, otherGroup],
      reason: "split-current-geography",
    });
    input.blocks.geographyMatch.ambiguouslySplitBlocks = 1;
    input.blocks.geographyMatch.unresolvedPopulation2020 = 12;
    const county = input.blocks.completeness.counties[0];
    county.blocks++;
    county.population2020 += 12;
    county.housingUnits2020 += 4;
    const pack = buildWorkforceCohortPack(input);
    expect(pack.origins.map((origin) => origin.weight)).toEqual([0, 0, 0]);
    expect(
      pack.units.every((unit) => unit.allocationStatus === "unavailable"),
    ).toBe(true);
    expect(pack.unallocatedOrigins).toHaveLength(1);
    expect(
      pack.origins.reduce((n, origin) => n + origin.population2020, 0) +
        pack.unallocatedOrigins[0].population2020,
    ).toBe(52);
    input.blocks.unallocatedBlocks[0].id = input.blocks.blocks[0].id;
    expect(() => buildWorkforceCohortPack(input)).toThrow(
      "duplicated relationship",
    );
  });
  it("keeps zero-population splits visible without inventing mass or invalidating known population denominators", () => {
    const input = fixture();
    input.blocks.unallocatedBlocks.push({
      id: "040130001002003",
      blockGroup2020: otherGroup,
      position: [-112.13, 33.43],
      population2020: 0,
      housingUnits2020: 0,
      candidateUnitGeoids: [group, otherGroup],
      reason: "split-current-geography",
    });
    input.blocks.geographyMatch.ambiguouslySplitBlocks = 1;
    input.blocks.completeness.counties[0].blocks++;
    input.blocks.completeness.counties[0].zeroPopulationBlocks++;
    const pack = buildWorkforceCohortPack(input);
    expect(pack.origins.map((origin) => origin.weight)).toEqual([
      0.25, 0.75, 0,
    ]);
    expect(pack.units[0].allocationStatus).toBe("complete");
    expect(pack.unallocatedOrigins[0].population2020).toBe(0);
  });
});
