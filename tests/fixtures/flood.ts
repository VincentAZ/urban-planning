/** Synthetic map evidence only; never a FEMA or property determination. */
import {
  applyCommand,
  buildingGeometryAreaSqm,
  canonicalJSON,
  floodDatasetHash,
  floodStudyAreaHash,
  projectWithFloodDataset,
  type Building,
  type FloodDataset,
  type FloodZoneFeature,
  type Place,
  type StudyAreaGeometry,
} from "@urban/core";
import { createProject } from "@urban/models";
import { createHash } from "node:crypto";
export function floodRectangle(
  w: number,
  s: number,
  e: number,
  n: number,
): StudyAreaGeometry {
  return {
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}
export function floodBuilding(
  id: string,
  geometry: StudyAreaGeometry,
  units: number | null,
): Building {
  const building: Building = {
    id,
    name: id,
    use: "multifamily",
    geometry,
    areaSqm: 100,
    height: 6,
    floors: 2,
    units,
    jobs: 0,
    parkingSpaces: 0,
    sourceId: "flood-fixture",
    estimated: false,
    ...(units === null
      ? {
          attributeProvenance: {
            version: 1 as const,
            fields: {
              units: { status: "missing" as const, sourceId: "flood-fixture" },
            },
          },
        }
      : {}),
  };
  building.areaSqm = buildingGeometryAreaSqm(building);
  return building;
}
export function floodZone(
  id: string,
  geometry: StudyAreaGeometry,
  classification: FloodZoneFeature["classification"],
): FloodZoneFeature {
  return {
    id,
    geometry,
    classification,
    attributes: {
      FLD_AR_ID: id,
      FLD_ZONE:
        classification === "sfha"
          ? "AE"
          : classification === "other-mapped"
            ? "X"
            : "D",
      SFHA_TF: classification === "sfha" ? "T" : "F",
      ZONE_SUBTY:
        classification === "other-mapped"
          ? "AREA OF MINIMAL FLOOD HAZARD"
          : null,
      SOURCE_CIT: "fixture-study",
    },
  };
}
export async function floodFixture() {
  const studyArea = floodRectangle(-112.08, 33.44, -112.06, 33.46),
    source = {
      id: "flood-fixture",
      name: "Synthetic flood test source",
      url: "",
      vintage: "Test only",
      license: "Test",
      kind: "user-supplied" as const,
    };
  const place: Place = {
    id: "flood-test-place",
    name: "Synthetic flood place",
    city: "Test",
    state: "AZ",
    zip: "00000",
    center: [-112.07, 33.45],
    bounds: [-112.08, 33.44, -112.06, 33.46],
    boundary: studyArea.type === "Polygon" ? studyArea.coordinates[0] : [],
    studyArea,
    buildings: [
      floodBuilding(
        "wet",
        floodRectangle(-112.079, 33.441, -112.077, 33.443),
        10,
      ),
      floodBuilding(
        "clear",
        floodRectangle(-112.069, 33.441, -112.067, 33.443),
        5,
      ),
    ],
    roads: [],
    sources: [source],
    coverage: [],
    loadedAt: "2026-11-06T00:00:00Z",
    extentLabel: "Synthetic study area",
  };
  const stamp = "2026-11-06T00:00:00Z",
    fileHash = "a".repeat(64),
    idsHash = createHash("sha256")
      .update(canonicalJSON([1]))
      .digest("hex");
  const dataset: FloodDataset = {
    version: 1,
    kind: "fema-effective-nfhl",
    studyArea,
    studyAreaHash: await floodStudyAreaHash(place),
    capturedAt: stamp,
    sources: [source],
    files: [
      {
        sourceId: source.id,
        url: "",
        sha256: fileHash,
        bytes: 1,
        retrievedAt: stamp,
      },
    ],
    capture: {
      serviceUrl: "https://example.test/fixture-only",
      queryGeometryHash: await floodStudyAreaHash(place),
      complete: true,
      layerReceipts: [0, 1, 3, 28, 29, 41].map((layerId) => ({
        layerId,
        name: `Fixture ${layerId}`,
        objectIds: [1],
        beforeIdsHash: idsHash,
        afterIdsHash: idsHash,
        beforeRecordsHash: fileHash,
        afterRecordsHash: fileHash,
        fileHashes: [fileHash],
      })),
      studyInfo: [{ DFIRM_ID: "fixture-study", DBREV_DATE: 0 }],
      normalization: {
        methodVersion: "synthetic-test-only",
        crs: "OGC:CRS84",
        clipped: true,
      },
    },
    zones: [
      floodZone("sfha", floodRectangle(-112.08, 33.44, -112.07, 33.46), "sfha"),
      floodZone(
        "x",
        floodRectangle(-112.07, 33.44, -112.06, 33.46),
        "other-mapped",
      ),
    ],
    availability: [
      { id: "available", geometry: studyArea, attributes: { STATUS: "TEST" } },
    ],
    panels: [
      {
        id: "panel",
        geometry: studyArea,
        attributes: { EFF_DATE: Date.parse("2013-10-16T00:00:00Z") },
      },
    ],
    revisions: [],
    seclusions: [],
    notes: ["Synthetic fixture, not real flood mapping."],
  };
  const datasetHash = await floodDatasetHash(dataset);
  let project = await projectWithFloodDataset(
    createProject(place),
    dataset,
    place,
  );
  const scenario = applyCommand(project.scenarios[1], {
    type: "scenario.flood",
    flood: { version: 1, datasetHash, origin: "imported" },
  });
  project = { ...project, scenarios: [project.scenarios[0], scenario] };
  return {
    place,
    dataset,
    datasetHash,
    project,
    scenario,
    context: { floodDatasets: project.floodDatasets! },
  };
}
