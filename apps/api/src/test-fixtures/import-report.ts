import {
  applyCommand,
  BUILDING_QUANTITY_FIELDS,
  projectWithImportVersion,
  type Building,
  type Place,
  type Source,
} from "@urban/core";
import { buildingPreset, createProject, calculateImpact } from "@urban/models";
import type { ReportSnapshot } from "../exports";
export function importReportFixture(): ReportSnapshot {
  const source: Source = {
    id: "mapped-upload",
    name: "Reviewed building inventory fixture",
    url: "",
    vintage: "2026 fixture",
    license: "Uploader-authorized private planning analysis",
    kind: "user-supplied",
    description:
      "Synthetic verification data for unknown imported attributes; no observed local counts.",
    rights: {
      version: 1,
      privateUse: true,
      cache: true,
      analyze: true,
      privateDisplay: true,
      export: true,
      historicalRetention: true,
      publicRedistribution: false,
      declaredBy: "fixture-author",
      declaredAt: "2026-11-06T00:00:00Z",
    },
    import: {
      version: 1,
      format: "shapefile",
      upload: {
        name: "inventory.zip",
        sha256: "a".repeat(64),
        bytes: 1000,
        members: [
          { name: "inventory.shp", sha256: "b".repeat(64), bytes: 500 },
          { name: "inventory.dbf", sha256: "c".repeat(64), bytes: 500 },
        ],
      },
      selection: { layer: "inventory" },
      crs: {
        source: "EPSG:26912",
        axisOrder: "xy",
        coordinateUnit: "metre",
        target: "OGC:CRS84",
      },
      operation: {
        name: "Reviewed projected coordinates to longitude latitude",
        pipeline: "Explicit source CRS transformation",
        accuracyMeters: null,
      },
      converter: {
        name: "GDAL fixture",
        version: "3.fixture",
        projVersion: "9.fixture",
        imageDigest: "d".repeat(64),
      },
      normalizedSha256: "e".repeat(64),
      recipe: {
        conversion: { sourceCrs: "EPSG:26912" },
        mapping: {
          height: { mode: "missing" },
          floors: { mode: "missing" },
          units: { mode: "field", field: "HOME_COUNT", missing: "unknown" },
          jobs: { mode: "field", field: "JOB_COUNT", missing: "unknown" },
        },
        normalization: { controlTransformResult: null },
      },
      exclusions: [
        { count: 1, reason: "Reviewed exclusion of a line-only drawing layer" },
      ],
    },
  };
  const known = {
    ...buildingPreset("multifamily", [-112, 33]),
    id: "known-building",
    units: 6,
    jobs: 3,
    sourceId: "baseline-source",
  };
  const place: Place = {
    id: "report-import-fixture",
    name: "Mapped inventory review",
    city: "Fixture",
    state: "AZ",
    zip: "85004",
    center: [-112, 33],
    bounds: [-112.01, 32.99, -111.99, 33.01],
    boundary: [
      [-112.01, 32.99],
      [-111.99, 32.99],
      [-111.99, 33.01],
      [-112.01, 33.01],
      [-112.01, 32.99],
    ],
    buildings: [known],
    roads: [],
    sources: [
      {
        ...source,
        id: "baseline-source",
        name: "Captured fixture geometry",
        import: undefined,
        rights: undefined,
      },
    ],
    coverage: [],
    extentLabel: "Synthetic bounded report verification area",
    loadedAt: "2026-11-06T00:00:00Z",
  };
  const missing: Building = {
    ...buildingPreset("office", [-111.998, 33]),
    id: "unknown-import",
    name: "Unreported development quantities",
    sourceId: source.id,
    sourceFeatureId: "source/feature 17",
    height: null,
    floors: null,
    units: null,
    jobs: null,
    parkingSpaces: null,
    attributeProvenance: {
      version: 1,
      fields: Object.fromEntries(
        BUILDING_QUANTITY_FIELDS.map((k) => [
          k,
          {
            status: "missing",
            sourceId: source.id,
            sourceField: k.toUpperCase(),
            rawValue: null,
            method: "Blank mapped cell remains unknown; no fallback estimate",
          },
        ]),
      ),
      use: {
        status: "supplied",
        sourceId: source.id,
        sourceField: "LAND_USE",
        rawValue: "OFFICE",
        method: "Explicit reviewed category mapping",
      },
    },
  };
  const zero: Building = {
    ...missing,
    sourceFeatureId: "0",
    ...buildingPreset("office", [-112.002, 33]),
    units: 0,
    jobs: 0,
    parkingSpaces: 0,
    height: null,
    floors: null,
  };
  zero.id = "zero-import";
  zero.name = "Explicit recorded zeros";
  zero.sourceId = source.id;
  zero.attributeProvenance = structuredClone(missing.attributeProvenance!);
  for (const k of ["units", "jobs", "parkingSpaces"] as const)
    zero.attributeProvenance.fields[k] = {
      status: "supplied",
      sourceId: source.id,
      sourceField: k.toUpperCase(),
      rawValue: 0,
    };
  let project = createProject(place);
  const scenario = applyCommand(project.scenarios[1], {
    type: "buildings.import",
    buildings: [missing, zero],
    source,
    mode: "append",
  });
  project = projectWithImportVersion(
    {
      ...project,
      name: "Mapped building inventory review",
      scenarios: [project.scenarios[0], scenario],
    },
    place,
  );
  const results = calculateImpact(place, scenario);
  results.metrics = results.metrics.filter((m) =>
    [
      "housing.units",
      "economy.jobs",
      "mobility.dailyTrips",
      "mobility.parkingSupply",
      "land.floorArea",
      "land.footprint",
      "fiscal.netAnnual",
    ].includes(m.id),
  );
  return {
    project,
    place,
    scenario,
    results,
    generatedAt: "2026-11-06T00:00:00Z",
    projectVersion: 1,
  };
}
