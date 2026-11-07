import { afterEach, describe, expect, it, vi } from "vitest";
import type { Place } from "@urban/core";
import { communityDemographicsSchema } from "@urban/core";
import {
  ACS_MEASURES,
  ACS_VARIABLES,
  ACS_VINTAGE,
  enrichPlaceDemographics,
  fetchZctaCommunityProfile,
  parseCensusValue,
  parseCommunityProfile,
} from "./acs";

// Deliberately synthetic values: these verify parsing and must never ship as community data.
function fixture(zip = "85004") {
  const columns = [...ACS_VARIABLES, "zip code tabulation area"];
  const values: Record<string, unknown> = {
    NAME: `ZCTA5 ${zip}`,
    "zip code tabulation area": zip,
  };
  for (const [key, { variable }] of Object.entries(ACS_MEASURES)) {
    values[variable] =
      key === "population"
        ? "1000"
        : key === "medianHouseholdIncome"
          ? "60000"
          : variable.endsWith("PE")
            ? "25.5"
            : "400";
    values[variable.replace(/E$/, "M")] = variable.endsWith("PE")
      ? "3.2"
      : "40";
    values[`${variable}A`] = null;
    values[`${variable.replace(/E$/, "M")}A`] = null;
  }
  return [columns, columns.map((column) => values[column])];
}
function place(): Place {
  return {
    id: "fixture",
    name: "Synthetic fixture",
    city: "Test",
    state: "AZ",
    zip: "85004",
    center: [-112, 33],
    bounds: [-112, 33, -111.99, 33.01],
    boundary: [
      [-112, 33],
      [-111.99, 33],
      [-111.99, 33.01],
      [-112, 33],
    ],
    buildings: [],
    roads: [],
    sources: [],
    coverage: [],
    loadedAt: "2026-11-05T00:00:00Z",
    extentLabel: "Synthetic test boundary",
  };
}
const response = (payload: unknown) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      }),
    );
afterEach(() => vi.unstubAllEnvs());

describe("published ACS values and annotations", () => {
  it("distinguishes a published zero from absent, suppressed, and negative sentinels", () => {
    expect(parseCensusValue("0", null, "estimate")).toMatchObject({
      value: 0,
      status: "available",
    });
    for (const value of [null, undefined, "", "null", "-123", "NaN"])
      expect(parseCensusValue(value, null, "estimate")).toMatchObject({
        value: null,
        status: "missing",
      });
    expect(parseCensusValue("-999999999", "N", "estimate")).toMatchObject({
      value: null,
      raw: "-999999999",
      annotation: "N",
      status: "suppressed",
    });
    expect(parseCensusValue("-888888888", "(X)", "estimate").status).toBe(
      "not-applicable",
    );
    for (const sentinel of ["-666666666", "-222222222", "-333333333"])
      expect(parseCensusValue(sentinel, null, "moe").status).toBe(
        "uncomputable",
      );
  });
  it("keeps bounded medians out of arithmetic and labels controlled MOEs explicitly", () => {
    expect(parseCensusValue("250001", "250,000+", "estimate")).toMatchObject({
      value: null,
      status: "bounded",
      annotation: "250,000+",
    });
    expect(parseCensusValue("-555555555", "*****", "moe")).toMatchObject({
      value: 0,
      status: "controlled",
    });
    expect(
      parseCensusValue("-555555555", "*****", "estimate").value,
    ).toBeNull();
    expect(parseCensusValue("12.3", null, "moe")).toMatchObject({
      value: 12.3,
      status: "available",
    });
  });
  it("records the verified explicit vintage, variables, universe, geography, and 90% margins", () => {
    const result = parseCommunityProfile(
      fixture(),
      "85004",
      "2026-11-05T00:00:00Z",
    );
    expect(result).toMatchObject({
      vintage: 2024,
      period: { start: 2020, end: 2024 },
      confidenceLevel: 90,
      geography: { id: "85004", relationshipToStudyArea: "context-only" },
      source: { kind: "published-estimate" },
    });
    expect(result.measures.population).toMatchObject({
      estimate: { value: 1000 },
      marginOfError: { value: 40 },
      variables: { estimate: "DP05_0001E", marginOfError: "DP05_0001M" },
    });
    expect(result.measures.povertyPercent).toMatchObject({
      unit: "percent",
      estimate: { value: 25.5 },
      marginOfError: { value: 3.2 },
    });
    expect(result.measures.bachelorsOrHigherPercent.universe).toContain("25");
    expect(result.measures.medianHouseholdIncome.universe).toContain(
      "2024 inflation-adjusted",
    );
  });
  it("rejects geographic mismatches, omitted annotation columns, duplicates, and invalid profile semantics", () => {
    expect(() => parseCommunityProfile(fixture("11201"), "85004")).toThrow(
      "does not match",
    );
    const omitted = fixture();
    omitted[0].splice(2, 1);
    omitted[1].splice(2, 1);
    expect(() => parseCommunityProfile(omitted, "85004")).toThrow("omitted");
    const duplicate = fixture();
    duplicate[0][2] = duplicate[0][1];
    expect(() => parseCommunityProfile(duplicate, "85004")).toThrow("column");
    const profile = parseCommunityProfile(fixture(), "85004");
    profile.measures.population.estimate.value = -1;
    expect(communityDemographicsSchema.safeParse(profile).success).toBe(false);
  });
});

describe("Census HTTP provider", () => {
  it("uses one explicit-vintage ZCTA query, requests annotations, and never stores the key", async () => {
    const fetcher = response(fixture());
    const result = await fetchZctaCommunityProfile("85004", {
      apiKey: "fixture-key-only",
      fetcher,
    });
    const request = new URL(String(fetcher.mock.calls[0][0]));
    expect(request.pathname).toBe(`/data/${ACS_VINTAGE}/acs/acs5/profile`);
    expect(request.searchParams.get("for")).toBe(
      "zip code tabulation area:85004",
    );
    expect(request.searchParams.get("get")?.split(",")).toHaveLength(25);
    expect(request.searchParams.get("get")).toContain("DP03_0128PMA");
    expect(JSON.stringify(result)).not.toContain("fixture-key-only");
  });
  it("reports the free-key prerequisite and Census HTML errors without invented estimates", async () => {
    vi.stubEnv("CENSUS_API_KEY", "");
    const fetcher = response(fixture());
    await expect(
      fetchZctaCommunityProfile("85004", { fetcher }),
    ).rejects.toMatchObject({ code: "CENSUS_KEY_REQUIRED" });
    expect(fetcher).not.toHaveBeenCalled();
    const html = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("<html><title>Missing Key</title></html>"),
      );
    await expect(
      fetchZctaCommunityProfile("85004", {
        apiKey: "rejected-key",
        fetcher: html,
      }),
    ).rejects.toMatchObject({ code: "CENSUS_KEY_REQUIRED" });
    const missing = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      fetchZctaCommunityProfile("00000", {
        apiKey: "fixture",
        fetcher: missing,
      }),
    ).rejects.toMatchObject({ code: "CENSUS_GEOGRAPHY_MISSING" });
  });
  it("enriches exact ZCTAs while preserving geometry/housing and keeps partial areas context-only", async () => {
    const original = place();
    const partial = await enrichPlaceDemographics(original, undefined, {
      apiKey: "fixture",
      fetcher: response(fixture()),
    });
    expect(partial.demographics?.geography.relationshipToStudyArea).toBe(
      "context-only",
    );
    expect(partial.population).toBeUndefined();
    expect(partial.buildings).toEqual(original.buildings);
    expect(partial.boundary).toEqual(original.boundary);
    const exact = await enrichPlaceDemographics(
      {
        ...original,
        geography: { type: "zcta", code: "85004", boundaryVintage: "2020" },
      },
      undefined,
      { apiKey: "fixture", fetcher: response(fixture()) },
    );
    expect(exact.demographics?.geography.relationshipToStudyArea).toBe(
      "same-area",
    );
    expect(exact.sources).toHaveLength(1);
    expect(original.demographics).toBeUndefined();
  });
  it("keeps preparation usable with explicit missing-data coverage and honors cancellation", async () => {
    vi.stubEnv("CENSUS_API_KEY", "");
    vi.stubEnv("ACS_SUMMARY_PATH", "/__missing_urban_test__/acs.json");
    const result = await enrichPlaceDemographics(place());
    expect(result.demographics).toBeUndefined();
    expect(result.coverage).toEqual([
      expect.objectContaining({
        status: "unavailable",
        description: expect.stringContaining("free Census API key"),
      }),
    ]);
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("Aborted", "AbortError"));
    await expect(
      enrichPlaceDemographics(place(), controller.signal, {
        apiKey: "fixture",
        fetcher,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("uses the validated official cache when the optional API key or upstream service fails", async () => {
    for (const upstream of [
      new Response("<html><title>Invalid Key</title></html>"),
      new Response("Unavailable", { status: 503 }),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(upstream);
      const result = await enrichPlaceDemographics(place(), undefined, {
        apiKey: "never-retain-this-fixture-key",
        fetcher,
      });
      expect(result.demographics?.dataset).toBe("acs/acs5");
      expect(result.demographics?.measures.population.estimate.value).toBe(
        12408,
      );
      expect(result.demographics?.notes[0]).toContain("API was unavailable");
      expect(result.demographics?.measures.povertyPercent.method?.kind).toBe(
        "derived",
      );
      expect(JSON.stringify(result)).not.toContain(
        "never-retain-this-fixture-key",
      );
    }
  });
});
