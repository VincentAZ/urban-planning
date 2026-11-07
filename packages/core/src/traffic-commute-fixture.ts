import type { CensusValue } from "./demographics";
import type {
  TrafficCommuteRecipe,
  TrafficCommuteSourcePack,
} from "./traffic-commute";
import { trafficFixturePeriod, trafficFixtureSource } from "./traffic-fixture";

/** Synthetic, official-shaped records only. Never presented as captured Census data. */
export function trafficCommuteFixture(): {
  pack: TrafficCommuteSourcePack;
  recipe: TrafficCommuteRecipe;
} {
  const value = (n: number): CensusValue => ({
    value: n,
    raw: String(n),
    annotation: null,
    status: "available",
  });
  const roles = [
    "lodes-main",
    "lodes-aux",
    "lodes-rac",
    "lodes-wac",
    "lodes-crosswalk",
    "acs",
    "geography",
    "block-points",
    "reconciliation",
  ] as const;
  const files = roles.map((role, i) => ({
    role,
    sourceId: trafficFixtureSource.id,
    url: "",
    sha256: (i + 1).toString(16).repeat(64),
    bytes: 1,
    retrievedAt: "2026-11-06T00:00:00Z",
  }));
  const sha = (role: (typeof roles)[number]) =>
    files.find((f) => f.role === role)!.sha256;
  const tract = "04013000100",
    home1 = "040130001001001",
    home2 = "040130001001002";
  const work1 = "040130002001001",
    work2 = "040130002001002";
  const blocks = [home1, home2, work1, work2].map((geoid, i) => ({
    geoid,
    position: [-112 + i * 0.001, 33] as [number, number],
    pointFileSha256: sha("block-points"),
    tractJoin: {
      status: "verified" as const,
      tractGeoid: geoid.slice(0, 11),
      evidenceFileSha256: sha("geography"),
    },
  }));
  const job = (
    blockGeoid: string,
    jobs: number,
    role: "lodes-rac" | "lodes-wac",
    sourceRow: number,
  ) => ({
    blockGeoid,
    jobs,
    sourceFileSha256: sha(role),
    sourceRow,
    raw: {
      [role === "lodes-rac" ? "h_geocode" : "w_geocode"]: blockGeoid,
      C000: String(jobs),
      createdate: "20251202",
    },
  });
  const flow = (
    id: string,
    homeBlockGeoid: string,
    workBlockGeoid: string,
    jobs: number,
    sourceRow: number,
  ) => ({
    id,
    homeBlockGeoid,
    workBlockGeoid,
    jobs,
    sourceRow,
    part: "main" as const,
    sourceFileSha256: sha("lodes-main"),
    raw: {
      h_geocode: homeBlockGeoid,
      w_geocode: workBlockGeoid,
      S000: String(jobs),
      createdate: "20251202",
    },
  });
  return {
    pack: {
      version: 1,
      id: "synthetic-commute-fixture",
      lodes: {
        dataYear: 2023,
        jobType: "JT01",
        blockVintage: "2020",
        formatVersion: "synthetic-test",
        dataVintage: "synthetic-test",
      },
      acs: {
        dataset: "acs/acs5",
        vintage: 2024,
        period: { start: 2020, end: 2024 },
        table: "B08132",
        geography: "tract",
        boundaryVintage: "2024",
        confidenceLevel: 90,
      },
      coverage: {
        stateFips: "04",
        label: "Synthetic one-tract cohort",
        residentTractGeoids: [tract],
        rac: "complete-for-declared-tracts",
        odMain: "complete-for-declared-tracts",
        notes: ["Unit-test fixture, not actual Census evidence."],
      },
      reconciliation: {
        evidenceFileSha256: sha("reconciliation"),
        residentJobs: 100,
        mainJobs: 80,
        auxiliaryJobs: 7,
        workplaceJobs: 87,
        unresolvedOutboundJobs: 20,
        auxiliaryFlowCount: 2,
        negativeResidenceResidualBlocks: 0,
        workplaceMismatchBlocks: 0,
      },
      sources: [structuredClone(trafficFixtureSource)],
      files,
      blocks,
      residences: [
        job(home1, 50, "lodes-rac", 2),
        job(home2, 50, "lodes-rac", 3),
      ],
      workplaces: [
        job(work1, 40, "lodes-wac", 2),
        job(work2, 40, "lodes-wac", 3),
      ],
      flows: [
        flow("flow-a", home1, work1, 40, 2),
        flow("flow-b", home2, work2, 40, 3),
      ],
      tracts: [
        {
          geoid: tract,
          name: "Synthetic tract",
          sourceFileSha256: sha("acs"),
          cells: Object.fromEntries(
            Array.from({ length: 90 }, (_, i) => [
              `B08132_${String(i + 1).padStart(3, "0")}`,
              {
                estimate: value(i + 1 === 22 ? 10 : i + 1 === 23 ? 20 : 0),
                marginOfError: value(4),
              },
            ]),
          ),
        },
      ],
      notes: [
        "Synthetic fixture; all source hashes and coordinates are test values.",
      ],
    },
    recipe: {
      version: 1,
      method: "acs-drive-alone-allocated-by-lodes-primary-destinations",
      originTractGeoids: [tract],
      departureCellIds: ["B08132_022", "B08132_023"],
      period: {
        ...trafficFixturePeriod,
        beginSeconds: 25200,
        endSeconds: 28800,
      },
      homeClocks: [
        {
          tractGeoid: tract,
          timeZone: "America/Phoenix",
          utcOffsetMinutes: -420,
        },
      ],
      withinBin: "uniform",
      sourceIds: [trafficFixtureSource.id],
      notes: ["Reviewed synthetic origin cohort for tests only."],
    },
  };
}
