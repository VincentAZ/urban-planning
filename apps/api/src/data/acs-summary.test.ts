import { describe, expect, it } from "vitest";
import {
  ACS_SUMMARY_COLUMNS,
  ACS_SUMMARY_TABLES,
  derivePercentage,
  summaryCommunityProfile,
  type AcsSummaryCache,
} from "./acs-summary";
import { parseCensusValue } from "./acs";

const observation = (estimate: string | null, moe: string | null) => ({
  estimate: parseCensusValue(estimate, null, "estimate"),
  marginOfError: parseCensusValue(moe, null, "moe"),
});
function fixture(): AcsSummaryCache {
  const cells: Record<string, string> = {};
  for (const column of ACS_SUMMARY_COLUMNS)
    cells[column] = column.includes("_M") ? "20" : "1000";
  cells.C17002_E002 = "50";
  cells.C17002_E003 = "100";
  for (const line of ["022", "023", "024", "025"])
    cells[`B15003_E${line}`] = "100";
  cells.B19013_E001 = "70000";
  return {
    schemaVersion: 1,
    vintage: 2024,
    retrievedAt: "2026-11-05T00:00:00Z",
    columns: ACS_SUMMARY_COLUMNS,
    sourceFiles: Object.keys(ACS_SUMMARY_TABLES).map((table) => ({
      table,
      url: "https://example.org/synthetic-fixture",
      retrievedAt: "2026-11-05T00:00:00Z",
      sha256: "0".repeat(64),
    })),
    rows: { "85004": ACS_SUMMARY_COLUMNS.map((column) => cells[column]) },
  };
}

describe("official Summary File calculations", () => {
  it("uses Census subset-proportion margin and component-sum approximation", () => {
    const result = derivePercentage(
      [observation("50", "10"), observation("100", "20")],
      observation("1000", "40"),
    );
    expect(result.estimate.value).toBe(15);
    expect(result.marginOfError.value).toBeCloseTo(
      (100 / 1000) * Math.sqrt(10 ** 2 + 20 ** 2 - 0.15 ** 2 * 40 ** 2),
    );
    const ratioFallback = derivePercentage(
      [observation("900", "1")],
      observation("1000", "100"),
    );
    expect(ratioFallback.marginOfError.value).toBeCloseTo(
      0.1 * Math.sqrt(1 + 0.9 ** 2 * 100 ** 2),
    );
  });
  it("does not invent missing margins, turn suppression into zero, or divide by zero", () => {
    expect(
      derivePercentage(
        [observation("-999999999", "20")],
        observation("1000", "40"),
      ).estimate.value,
    ).toBeNull();
    const missingMargin = derivePercentage(
      [observation("100", null)],
      observation("1000", "40"),
    );
    expect(missingMargin.estimate.value).toBe(10);
    expect(missingMargin.marginOfError.value).toBeNull();
    expect(
      derivePercentage([observation("0", "20")], observation("0", "40"))
        .estimate.value,
    ).toBeNull();
    expect(
      derivePercentage([observation("1100", "20")], observation("1000", "40"))
        .estimate.value,
    ).toBeNull();
  });
  it("separates direct Detailed Table values from derived percentages and retains file hashes", () => {
    const profile = summaryCommunityProfile(fixture(), "85004", true);
    expect(profile.dataset).toBe("acs/acs5");
    expect(profile.measures.population).toMatchObject({
      estimate: { value: 1000 },
      marginOfError: { value: 20 },
      variables: { estimate: "B01003_E001" },
    });
    expect(profile.measures.population.method).toBeUndefined();
    expect(profile.measures.povertyPercent).toMatchObject({
      estimate: { value: 15 },
      method: { kind: "derived" },
    });
    expect(profile.measures.bachelorsOrHigherPercent.estimate.value).toBe(40);
    expect(profile.measures.medianHouseholdIncome.estimate.value).toBe(70000);
    expect(profile.sourceFiles).toHaveLength(6);
  });
  it("does not present a top-coded median as an exact income", () => {
    const cache = fixture();
    cache.rows["85004"][cache.columns.indexOf("B19013_E001")] = "250001";
    cache.rows["85004"][cache.columns.indexOf("B19013_M001")] = "-333333333";
    expect(
      summaryCommunityProfile(cache, "85004").measures.medianHouseholdIncome
        .estimate,
    ).toMatchObject({
      value: null,
      status: "bounded",
      annotation: "Open-ended median",
    });
  });
  it("rejects incompatible vintages, missing geography, and incomplete cached rows", () => {
    const cache = fixture();
    expect(() => summaryCommunityProfile(cache, "60601")).toThrow("no ZCTA");
    cache.rows["85004"].pop();
    expect(() => summaryCommunityProfile(cache, "85004")).toThrow("incomplete");
  });
});
