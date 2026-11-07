import {
  enableReviewedBudgetForFixture,
  preparationCapacityFixture,
} from "../../../apps/api/src/budget-test-fixture.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildApp } from "../../../apps/api/src/app";
import { FileStore } from "../../../apps/api/src/store";
import { PlaceCatalog } from "../../../apps/api/src/places";
import {
  CensusPlaces,
  type ZctaFeature,
} from "../../../apps/api/src/data/census-places";
import {
  NationalPreparationService,
  type prepareZcta,
} from "../../../apps/api/src/national-preparation";
import { ApiError } from "../../../apps/api/src/errors";
import { buildingPreset } from "../../../packages/models/src/index";
import {
  clipLineToStudyArea,
  studyAreaAnchor,
  studyAreaBounds,
  type Place,
  type Polygon,
  type Position,
  type StudyAreaGeometry,
} from "../../../packages/core/src/index";
import type { PlaceSearchResponse } from "../../../packages/core/src/national";

// Only this isolated test process uses synthetic preparation-worker results and
// lookup responses. It exercises the real durable service, API, auth and catalog;
// it does not call the production Census/OSM conversion pipeline.
const [directory, browserOrigin] = process.argv.slice(2);
if (!directory || !browserOrigin || !process.send)
  throw new Error(
    "Start this isolated fixture server through the places test harness.",
  );
const ring = (x: number, y: number, w: number, h = w): Polygon => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
  [x, y],
];
const studyArea: StudyAreaGeometry = {
  type: "MultiPolygon",
  coordinates: [
    [ring(-87.63, 41.885, 0.015), ring(-87.626, 41.889, 0.005)],
    [ring(-87.608, 41.887, 0.006)],
  ],
};
const calls: { kind: string; query?: string; position?: Position }[] = [];
const candidate = (zip: string) => ({
  id: `zcta:${zip}`,
  label: `ZIP area ${zip} · QA fixture`,
  kind: "zcta" as const,
  coordinates: studyAreaAnchor(studyArea),
  zip,
  placeId: `zcta-${zip}-2020`,
  prepared: false,
  detail: "Synthetic provider fixture. Not a real-world Census boundary.",
  sourceName: "Isolated Census provider fixture",
});
class FixtureCensus extends CensusPlaces {
  override async zcta(zip: string): Promise<ZctaFeature> {
    return {
      type: "Feature",
      geometry: studyArea,
      properties: {
        GEOID: zip,
        ZCTA5: zip,
        INTPTLON: -87.628,
        INTPTLAT: 41.887,
      },
    };
  }
  override async search(q: string): Promise<PlaceSearchResponse> {
    calls.push({ kind: "search", query: q });
    return /^\d{5}$/.test(q)
      ? {
          mode: "zip",
          candidates: [candidate(q)],
          warnings: ["Synthetic QA source. No external provider was called."],
          attribution: ["QA fixture"],
        }
      : {
          mode: "city",
          candidates: [
            {
              id: "city:qa-chicago",
              label: "Chicago, IL · QA search fixture",
              kind: "city",
              coordinates: [-87.62, 41.89],
              prepared: false,
              detail:
                "Fixture city reference point; choose to locate its ZIP area.",
              sourceName: "Isolated Census provider fixture",
            },
          ],
          warnings: ["City reference points are not study boundaries."],
          attribution: ["QA fixture"],
        };
  }
  override async locate(position: Position): Promise<PlaceSearchResponse> {
    calls.push({ kind: "locate", position });
    return {
      mode: "point",
      candidates: [candidate("60601")],
      warnings: [
        "Synthetic point-lookup response for browser transport testing.",
      ],
      attribution: ["QA fixture"],
    };
  }
}
const store = new FileStore(join(directory, "state.json")),
  catalog = new PlaceCatalog(join(directory, "catalog"));
const reference = JSON.parse(
  await readFile("public/data/phoenix.json", "utf8"),
) as Place;
await catalog.put(reference, {
  fixture: "Unmodified bundled Phoenix baseline",
});
const attempts = new Map<string, number>();
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
const prepare: typeof prepareZcta = async (zip, options) => {
  attempts.set(zip, (attempts.get(zip) ?? 0) + 1);
  await options.progress("boundary", 10);
  await delay(700, options.signal);
  if (zip === "99999")
    throw new ApiError(
      422,
      "STUDY_AREA_TOO_LARGE",
      "QA fixture exceeds the 50 km² study-area limit. No boundary was simplified or published.",
    );
  if (zip === "99998" && attempts.get(zip) === 1)
    throw new ApiError(
      502,
      "SOURCE_UNAVAILABLE",
      "QA public source is temporarily unavailable. Retry this saved request.",
    );
  await options.progress("osm", 35);
  await delay(zip === "99997" ? 12000 : 1700, options.signal);
  await options.progress("demographics", 75);
  await delay(400, options.signal);
  const footprint = {
    ...buildingPreset("multifamily", [-87.628, 41.887]),
    id: "qa-apartments",
    name: "QA apartments",
    sourceId: "qa-footprints",
  };
  const office = {
    ...buildingPreset("office", [-87.605, 41.89]),
    id: "qa-office",
    name: "QA island office",
    sourceId: "qa-footprints",
  };
  const roads = clipLineToStudyArea(
    [
      [-87.632, 41.891],
      [-87.6, 41.891],
    ],
    studyArea,
  ).map((coordinates, index) => ({
    id: `qa-road-${index}`,
    name: "QA boundary crossing road",
    coordinates,
    lanes: 2,
    speedMph: 25,
    oneWay: false,
    kind: "residential",
    sourceId: "qa-footprints",
  }));
  const place: Place = {
    id: `zcta-${zip}-2020`,
    name: `ZIP area ${zip} · QA fixture`,
    city: "Synthetic Chicago fixture",
    state: "IL",
    zip,
    geography: { type: "zcta", code: zip, boundaryVintage: "2020" },
    center: studyAreaAnchor(studyArea),
    bounds: studyAreaBounds(studyArea),
    boundary: studyArea.coordinates[0][0],
    studyArea,
    buildings: [footprint, office],
    roads,
    sources: [
      {
        id: "qa-boundary",
        name: "Synthetic exact study-area fixture",
        url: "",
        vintage: "2020",
        license: "Synthetic QA data only",
        kind: "user-supplied",
        description:
          "The rings and islands are fabricated solely for isolated application tests. This is not an observed Census boundary.",
      },
      {
        id: "qa-footprints",
        name: "Synthetic footprint and street fixture",
        url: "",
        vintage: "2026",
        license: "Synthetic QA data only",
        kind: "user-supplied",
        description:
          "Deterministic test geometry; no external provider was called.",
      },
    ],
    coverage: [
      {
        layer: "QA geometry",
        status: "available",
        description:
          "Complete synthetic multipolygon with a hole and separate island.",
      },
    ],
    loadedAt: new Date().toISOString(),
    extentLabel: `Synthetic QA ZCTA ${zip} · exact multipolygon fixture`,
  };
  return {
    place,
    warnings: [
      "Synthetic QA provider fixture. Do not use for real-world analysis.",
    ],
    source: { fixture: true, studyArea },
  };
};
await store.transaction((state) =>
  enableReviewedBudgetForFixture(state.budget),
);
const service = new NationalPreparationService(
  store,
  catalog,
  new FixtureCensus(),
  true,
  prepare,
  0,
  preparationCapacityFixture,
);
const app = await buildApp({
  store,
  catalog,
  nationalService: service,
  nationalPreparationEnabled: true,
  origin: browserOrigin,
  production: false,
});
app.get("/__qa__/calls", async () => calls);
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
process.send({ origin });
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void close());
process.on("disconnect", () => void close());
