import { enableReviewedBudgetForFixture } from "../../../apps/api/src/budget-test-fixture.js";
import { floodDatasetHash } from "../../../packages/core/src/index";
import { floodFixture } from "../../fixtures/flood";
import {
  FloodCatalog,
  installFloodCatalog,
} from "../../../apps/api/src/flood-catalog";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { buildApp } from "../../../apps/api/src/app";
import { FileStore } from "../../../apps/api/src/store";
import { PlaceCatalog } from "../../../apps/api/src/places";
import { buildingPreset } from "../../../packages/models/src/index";
import type { Place } from "../../../packages/core/src/index";
import { AccessibilityJobService } from "../../../apps/api/src/accessibility-jobs";
import { FixtureAccessibilityExecutor } from "../../../apps/api/src/accessibility-jobs-fixture";
import { WorkforceJobService } from "../../../apps/api/src/workforce-jobs";
import { FixtureWorkforceExecutor } from "../../../apps/api/src/workforce-jobs-fixture";
import { GisJobService } from "../../../apps/api/src/gis-jobs";
import { GisRuntime } from "../../../apps/api/src/gis-runtime";
import { FixtureGisRuntime } from "../../../apps/api/src/gis-jobs-fixture";
import { TrafficJobService } from "../../../apps/api/src/traffic/jobs";
import { TrafficCatalog } from "../../../apps/api/src/traffic/catalog";
import { TrafficRuntime } from "../../../apps/api/src/traffic/runtime";
import { MediaJobService } from "../../../apps/api/src/media-jobs";
import { MediaRuntime } from "../../../apps/api/src/media-runtime";
import { seedMediaHistoryFixture } from "../../../apps/api/src/media-history-fixture";
import {
  createIdentityMailRuntime,
  type IdentityMailContent,
} from "../../../apps/api/src/identity-mail";

const [directory, browserOrigin, placeFile, ...modes] = process.argv.slice(2);
if (!directory || !browserOrigin || !process.send)
  throw new Error("Start through the isolated collaboration test harness.");
// The source bundle is synthetic QA geography. Auth, sessions, roles, grants,
// comments, revisions, exports and durable writes use the unmodified real API.
const fixture: Place = {
  id: "collaboration-qa",
  name: "Collaboration QA area",
  city: "Synthetic QA place",
  state: "AZ",
  zip: "85004",
  center: [-112.0715, 33.455],
  bounds: [-112.078, 33.45, -112.065, 33.46],
  boundary: [
    [-112.078, 33.45],
    [-112.065, 33.45],
    [-112.065, 33.46],
    [-112.078, 33.46],
    [-112.078, 33.45],
  ],
  buildings: [
    {
      ...buildingPreset("multifamily", [-112.073, 33.455]),
      id: "qa-apartments",
      name: "QA apartments",
      sourceId: "qa-source",
    },
    {
      ...buildingPreset("office", [-112.07, 33.4535]),
      id: "qa-office",
      name: "QA office",
      sourceId: "qa-source",
    },
  ],
  roads: [
    {
      id: "qa-road",
      name: "QA street",
      coordinates: [
        [-112.076, 33.455],
        [-112.067, 33.455],
      ],
      lanes: 2,
      speedMph: 25,
      oneWay: false,
      kind: "residential",
      sourceId: "qa-source",
    },
  ],
  sources: [
    {
      id: "qa-source",
      name: "Synthetic collaboration test fixture",
      url: "",
      vintage: "2026",
      license: "Synthetic QA data only",
      kind: "user-supplied",
      description:
        "Fabricated source geometry for isolated application tests. Not observed real-world information.",
    },
  ],
  coverage: [
    {
      layer: "Test source",
      status: "available",
      description:
        "Two synthetic buildings and one synthetic street for browser tests.",
    },
  ],
  loadedAt: "2026-11-05T00:00:00.000Z",
  extentLabel: "Synthetic collaboration QA reference area",
};
// An optional real bundle keeps full-geometry account regression isolated from
// the developer's retained projects without shrinking or transforming its source.
const flood = modes.includes("--flood-fixture") ? await floodFixture() : null;
if (flood && modes.includes("--flood-partial")) {
  flood.place.buildings[0].units = null;
  flood.place.buildings[0].attributeProvenance = {
    version: 1,
    fields: { units: { status: "missing", sourceId: "flood-fixture" } },
  };
  flood.dataset.zones = flood.dataset.zones.filter(
    (z) => z.classification === "sfha",
  );
  flood.datasetHash = await floodDatasetHash(flood.dataset);
}
const place: Place = flood
  ? flood.place
  : placeFile
    ? JSON.parse(await readFile(placeFile, "utf8"))
    : fixture;
const catalog = new PlaceCatalog(join(directory, "catalog"));
await catalog.put(place, {
  fixture: placeFile
    ? "Unmodified captured source bundle"
    : "Synthetic collaboration source only",
});
const store = new FileStore(join(directory, "state.json"));
const floodCatalog = flood
  ? new FloodCatalog(undefined, [
      {
        id: "synthetic-flood",
        label: "Synthetic flood map · QA only",
        datasetHash: flood.datasetHash,
        studyAreaHash: flood.dataset.studyAreaHash,
        capturedAt: flood.dataset.capturedAt,
        bytes: Buffer.byteLength(JSON.stringify(flood.dataset)),
        dataset: flood.dataset,
        sourceManifestHash: "a".repeat(64),
      },
    ])
  : undefined;
if (floodCatalog) await installFloodCatalog(store, floodCatalog);
// Explicit process-local sink exercises encryption, leases and validity checks without sending email.
// Tokens are accessible only to the parent test process over private IPC, never an HTTP route.
const identityInbox: IdentityMailContent[] = [];
const identityKey = Buffer.from(
  process.env.URBAN_IDENTITY_FIXTURE_KEY ?? "",
  "base64",
);
const identityMail = createIdentityMailRuntime({
  store,
  config: {
    mode: "local-test",
    keyId: "isolated-browser",
    keys: { "isolated-browser": identityKey },
    recipientHashKey: identityKey,
    maximumAttemptCents: 1,
    recipientCooldownSeconds: 0,
    recipientDailyLimit: 100,
    dailyLimit: 1000,
    pollMilliseconds: 25,
  },
  transport: {
    send: async (message) => {
      identityInbox.push(message);
    },
  },
});
const workforceService = modes.includes("--workforce-fixture")
  ? new WorkforceJobService(store, {
      enabled: true,
      executor: new FixtureWorkforceExecutor(),
      archiveDirectory: join(directory, "workforce-archive"),
      automaticWorker: true,
      capacity: {
        mode: "fixed-capacity",
        environment: "local-development",
        statement:
          "Synthetic isolated browser-test capacity; no native routing or provider charges.",
      },
    })
  : undefined;
const accessibilityService = modes.includes("--accessibility-fixture")
  ? new AccessibilityJobService(store, {
      enabled: true,
      executor: new FixtureAccessibilityExecutor(),
      archiveDirectory: join(directory, "accessibility-archive"),
      automaticWorker: true,
      capacity: {
        mode: "fixed-capacity",
        environment: "local-development",
        statement:
          "Synthetic isolated browser-test capacity; no native routing or provider charges.",
      },
    })
  : undefined;
const gisService =
  modes.includes("--gis-native") || modes.includes("--gis-fixture")
    ? new GisJobService(store, {
        enabled: true,
        runtime: modes.includes("--gis-native")
          ? new GisRuntime({
              workRoot: join(directory, "gis-work"),
              allowedInputRoot: join(directory, "gis-archive"),
            })
          : new FixtureGisRuntime(),
        archiveDirectory: join(directory, "gis-archive"),
        automaticWorker: true,
        capacity: {
          mode: "fixed-capacity",
          environment: "local-development",
          statement: modes.includes("--gis-native")
            ? "Existing local pinned offline GDAL capacity for isolated browser verification; no deployment-cost or throughput claim."
            : "Synthetic converter used only to exercise real API idempotency and UI delivery races; no native conversion claim.",
        },
      })
    : undefined;
const trafficService = modes.includes("--traffic-native")
  ? new TrafficJobService(store, {
      enabled: true,
      catalog: new TrafficCatalog(
        resolve(
          modes
            .find((value) => value.startsWith("--traffic-registry="))
            ?.slice("--traffic-registry=".length) ??
            ".local/traffic/registry.json",
        ),
      ),
      runtime: new TrafficRuntime({
        workRoot: join(directory, "traffic-work"),
        allowedInputRoot: resolve(".local/traffic"),
      }),
      archiveDirectory: join(directory, "traffic-archive"),
      capacity: {
        mode: "fixed-capacity",
        environment: "local-development",
        statement:
          "Existing pinned offline SUMO capacity for isolated full-study browser verification; authored demand, no calibration or production-cost claim.",
      },
    })
  : undefined;
const mediaService = modes.includes("--media-native")
  ? new MediaJobService(store, {
      enabled: true,
      executor: new MediaRuntime({
        image: (
          await readFile(resolve(".local/qa/media/runtime-image.id"), "utf8")
        ).trim(),
        rendererDirectory: resolve("dist/media-render"),
        workRoot: join(directory, "media-work"),
      }),
      archiveDirectory: join(directory, "media-archive"),
      automaticWorker: !modes.includes("--media-manual-worker"),
      capacity: {
        mode: "fixed-capacity",
        environment: "local-development",
        statement:
          "Existing pinned offline Chromium/FFmpeg capacity for isolated synthetic scene QA. Real renderer and encoder; no production throughput or hosting-invoice claim.",
      },
    })
  : undefined;
if (
  workforceService ||
  accessibilityService ||
  gisService ||
  trafficService ||
  mediaService
)
  await store.transaction((state) => {
    enableReviewedBudgetForFixture(state.budget);
  });
const app = await buildApp({
  floodCatalog,
  identityMail: modes.includes("--identity-disabled")
    ? undefined
    : identityMail,
  store,
  workforceService,
  accessibilityService,
  gisService,
  trafficService,
  mediaService,
  catalog,
  origin: browserOrigin,
  production: false,
  platformAdminUserIds: [],
  nationalPreparationEnabled: false,
});
app.get("/data/phoenix.json", async () => place);
const origin = await app.listen({ host: "127.0.0.1", port: 0 });
process.send({ origin });
process.on("message", (raw) => {
  const request = raw as {
    type?: string;
    id?: string;
    kind?: string;
    email?: string;
    completedJobId?: string;
  };
  if (
    request.type === "media-seed-history" &&
    request.id &&
    request.completedJobId &&
    mediaService &&
    modes.includes("--media-native")
  ) {
    void seedMediaHistoryFixture(store, request.completedJobId).then(
      (result) =>
        process.send?.({
          type: "media-history-seeded",
          id: request.id,
          result,
        }),
      (error: unknown) =>
        process.send?.({
          type: "media-history-seeded",
          id: request.id,
          error:
            error instanceof Error ? error.message : "History fixture failed.",
        }),
    );
    return;
  }
  if (
    request.type === "media-run" &&
    request.id &&
    mediaService &&
    modes.includes("--media-manual-worker")
  ) {
    void mediaService.runOne().then(
      () => process.send?.({ type: "media-ran", id: request.id }),
      (error: unknown) =>
        process.send?.({
          type: "media-ran",
          id: request.id,
          error:
            error instanceof Error ? error.message : "Native worker failed.",
        }),
    );
    return;
  }
  if (request.type !== "identity-token" || !request.id) return;
  const message = [...identityInbox]
    .reverse()
    .find(
      (m) =>
        m.to === request.email &&
        m.text.includes(`#identity=${request.kind}&token=`),
    );
  const token = message?.text.match(
    /token=([0-9a-f-]+\.[A-Za-z0-9_-]{43})/,
  )?.[1];
  process.send?.({ type: "identity-token", id: request.id, token });
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("disconnect", () => void close());
