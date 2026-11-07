import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Place, Project } from "@urban/core";
import { buildApp } from "./app.js";
import { PostgresStore } from "./postgres-store.js";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import { BudgetService } from "./budget.js";
import { emptyState } from "./store.js";
import { tokenHash } from "./security.js";
import { randomBytes } from "node:crypto";
import {
  baselineIdentity,
  createRetailScenario,
  createRetailCategory,
  USER_RETAIL_SOURCE,
  splitParcel,
  USER_PARCEL_SOURCE,
  USER_ACTIVITY_SOURCE,
  type ActivityScenario,
  type Parcel,
} from "@urban/core";
import {
  NationalPreparationService,
  type WritableCatalog,
} from "./national-preparation.js";
import { CensusPlaces } from "./data/census-places.js";
import { ApiError } from "./errors.js";
import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";

const connection = process.env.TEST_DATABASE_URL;
const place: Place = {
  id: "secured-api-fixture",
  name: "Private workspace test area",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  center: [-112.07, 33.46],
  bounds: [-112.08, 33.45, -112.06, 33.47],
  boundary: [
    [-112.08, 33.45],
    [-112.06, 33.45],
    [-112.06, 33.47],
    [-112.08, 33.47],
    [-112.08, 33.45],
  ],
  buildings: [],
  roads: [],
  sources: [],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00Z",
  extentLabel: "Synthetic authorization fixture",
};
type Account = {
  id: string;
  organizationId: string;
  email: string;
  headers: Record<string, string>;
};
async function register(app: FastifyInstance, name: string): Promise<Account> {
  const email = `${name}@security.example.test`;
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      name,
      password: "a long isolated database test password",
    },
  });
  expect(result.statusCode, result.body).toBe(201);
  return {
    id: result.json().user.id,
    organizationId: result.json().organization.id,
    email,
    headers: {
      cookie: `${result.cookies[0].name}=${result.cookies[0].value}`,
      "x-csrf-token": result.json().csrfToken,
    },
  };
}

describe.skipIf(!connection)(
  "API workflows through restricted PostgreSQL logins",
  () => {
    it("persists format-6 retail analysis with private/public rights through restricted roles and restart", async () => {
      const fixture = await createPostgresSecurityFixture(connection!);
      const runtime = () =>
        new PostgresStore(fixture.webURL, {
          mode: "runtime",
          authConnectionString: fixture.authURL,
          workerConnectionString: fixture.workerURL,
          poolMax: 1,
        });
      let store = runtime(),
        app: FastifyInstance | undefined;
      const options = {
        catalog: { list: async () => [place], get: async () => place },
        nationalPreparationEnabled: false,
      };
      try {
        await store.initialize();
        app = await buildApp({ ...options, store });
        const owner = await register(app, "retail-owner"),
          outsider = await register(app, "retail-outsider");
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner.headers,
          payload: { placeId: place.id },
        });
        expect(created.statusCode, created.body).toBe(201);
        let saved = created.json<{ project: Project; version: number }>();
        const base = `/api/v1/projects/${saved.project.id}`,
          scenarioId = saved.project.activeScenarioId;
        const retail = createRetailScenario(place, 0),
          category = createRetailCategory("Groceries");
        retail.context.comparabilityConfirmed = true;
        retail.context.disjointCategoriesConfirmed = true;
        const measure = (value: number) => ({
          status: "available" as const,
          value,
          sourceId: USER_RETAIL_SOURCE.id,
        });
        retail.categories = [
          {
            ...category,
            code: "groceries",
            baselineDemand: measure(1000000),
            baselineSales: measure(800000),
            salesPerEstablishment: measure(500000),
            annualSalesCapacity: 200000,
            captureShare: 0.5,
            displacementShare: 0.2,
          },
        ];
        const command = {
          expectedVersion: 1,
          expectedRevision: 0,
          command: { type: "scenario.retail", retail },
        };
        expect(
          (
            await app.inject({
              method: "POST",
              url: `${base}/scenarios/${scenarioId}/commands`,
              headers: outsider.headers,
              payload: command,
            })
          ).statusCode,
        ).toBe(404);
        const applied = await app.inject({
          method: "POST",
          url: `${base}/scenarios/${scenarioId}/commands`,
          headers: owner.headers,
          payload: command,
        });
        expect(applied.statusCode, applied.body).toBe(200);
        saved = applied.json();
        expect(saved.project.schemaVersion).toBe(6);
        const blocked = await app.inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner.headers,
          payload: { scenarioId, expectedRevision: 1 },
        });
        expect(blocked.statusCode, blocked.body).toBe(422);
        expect(blocked.json().error.code).toBe("RETAIL_PUBLICATION_RESTRICTED");
        expect(
          Number(
            (await fixture.admin.query("SELECT count(*) FROM app_published"))
              .rows[0].count,
          ),
        ).toBe(0);
        const full = await app.inject({
          method: "PUT",
          url: base,
          headers: owner.headers,
          payload: {
            project: { ...saved.project, name: "Private retail study" },
            expectedVersion: 2,
          },
        });
        expect(full.statusCode, full.body).toBe(200);
        saved = full.json();
        await app.close();
        app = undefined;
        store = runtime();
        await store.initialize();
        app = await buildApp({ ...options, store });
        const reopened = await app.inject({
          url: base,
          headers: owner.headers,
        });
        expect(reopened.statusCode, reopened.body).toBe(200);
        expect(reopened.json().project).toEqual(saved.project);
        expect(reopened.json().baselineIdentity.sha256).toBe(
          (await baselineIdentity(place)).sha256,
        );
        const csv = await app.inject({
          url: `${base}/exports?format=retail-csv&version=3&revision=1`,
          headers: owner.headers,
        });
        expect(csv.statusCode, csv.body).toBe(200);
        expect(csv.body).toContain('"80000"');
        retail.sourceRights.forEach(
          (right) => (right.publicRedistribution = true),
        );
        const publicEdit = await app.inject({
          method: "POST",
          url: `${base}/scenarios/${scenarioId}/commands`,
          headers: owner.headers,
          payload: {
            expectedVersion: 3,
            expectedRevision: 1,
            command: { type: "scenario.retail", retail },
          },
        });
        expect(publicEdit.statusCode, publicEdit.body).toBe(200);
        const published = await app.inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner.headers,
          payload: { scenarioId, expectedRevision: 2 },
        });
        expect(published.statusCode, published.body).toBe(201);
        const publicUrl = `/api/v1/published/${published.json().id}`,
          frozen = (await app.inject({ url: publicUrl })).json();
        expect(frozen.scenario.retail).toEqual(retail);
        const clear = await app.inject({
          method: "POST",
          url: `${base}/scenarios/${scenarioId}/commands`,
          headers: owner.headers,
          payload: {
            expectedVersion: 4,
            expectedRevision: 2,
            command: { type: "scenario.retail", retail: null },
          },
        });
        expect(clear.statusCode, clear.body).toBe(200);
        expect(clear.json().project.schemaVersion).toBe(6);
        expect((await app.inject({ url: publicUrl })).json()).toEqual(frozen);
        const records = await app.inject({
          url: `${base}/exports?format=records&version=5&revision=3`,
          headers: owner.headers,
        });
        expect(records.statusCode, records.body).toBe(200);
        expect(
          records.json().project.history[0].command.retail.sourceRights[0]
            .publicRedistribution,
        ).toBe(false);
        expect(
          records
            .json()
            .audit.some(
              (row: { action: string }) => row.action === "scenario.retail",
            ),
        ).toBe(true);
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
      }
    });
    it("persists format-5 activity controls and exact neighborhoods through restricted writes, restart and immutable publication", async () => {
      const fixture = await createPostgresSecurityFixture(connection!);
      const runtime = () =>
        new PostgresStore(fixture.webURL, {
          mode: "runtime",
          authConnectionString: fixture.authURL,
          workerConnectionString: fixture.workerURL,
          poolMax: 1,
        });
      let store = runtime(),
        app: FastifyInstance | undefined;
      const options = {
        catalog: { list: async () => [place], get: async () => place },
        nationalPreparationEnabled: false,
      };
      try {
        await store.initialize();
        app = await buildApp({ ...options, store });
        const owner = await register(app, "activity-owner"),
          outsider = await register(app, "activity-outsider");
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner.headers,
          payload: { placeId: place.id },
        });
        expect(created.statusCode, created.body).toBe(201);
        let saved = created.json<{ project: Project; version: number }>();
        const base = `/api/v1/projects/${saved.project.id}`,
          scenarioId = saved.project.activeScenarioId;
        const activity: ActivityScenario = {
          version: 1,
          reference: {
            population: {
              kind: "entered",
              value: 1000,
              sourceId: USER_ACTIVITY_SOURCE.id,
              asOfYear: 2024,
              universe: "Synthetic residents",
            },
            employment: {
              kind: "entered",
              value: 400,
              sourceId: USER_ACTIVITY_SOURCE.id,
              asOfYear: 2024,
              universe: "Synthetic workplace jobs",
            },
            vehicles: {
              kind: "entered",
              value: 800,
              sourceId: USER_ACTIVITY_SOURCE.id,
              asOfYear: 2024,
              universe: "Synthetic household vehicles",
            },
          },
          allocation: {
            population: "uniform-area",
            employment: "uniform-area",
          },
          global: {
            population: { mode: "baseline-percent", percent: 125 },
            householdVehicles: { mode: "absolute", value: 900 },
          },
          neighborhoods: [
            {
              id: "plant-area",
              name: "Plant closure sensitivity",
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [-112.078, 33.452],
                    [-112.072, 33.452],
                    [-112.072, 33.458],
                    [-112.078, 33.458],
                    [-112.078, 33.452],
                  ],
                ],
              },
              employment: { mode: "absolute", value: 0 },
              sourceId: USER_ACTIVITY_SOURCE.id,
            },
          ],
          demandResponse: {
            population: "proportional-residential",
            employment: "proportional-employment",
            vehicles: "replace-residential-with-stock",
            reviewed: true,
            sourceId: USER_ACTIVITY_SOURCE.id,
          },
        };
        const command = {
          expectedVersion: 1,
          expectedRevision: 0,
          command: { type: "scenario.activity", activity, horizon: 10 },
        };
        const denied = await app.inject({
          method: "POST",
          url: `${base}/scenarios/${scenarioId}/commands`,
          headers: outsider.headers,
          payload: command,
        });
        expect(denied.statusCode, denied.body).toBe(404);
        const edited = await app.inject({
          method: "POST",
          url: `${base}/scenarios/${scenarioId}/commands`,
          headers: owner.headers,
          payload: command,
        });
        expect(edited.statusCode, edited.body).toBe(200);
        saved = edited.json();
        expect(saved.project.schemaVersion).toBe(5);
        expect(saved.project.scenarios[1]).toMatchObject({
          horizon: 10,
          activity,
        });
        expect(saved.project.scenarios[0]).not.toHaveProperty("activity");
        const reference = await app.inject({
          url: `${base}/vehicle-reference`,
          headers: owner.headers,
        });
        expect(reference.statusCode, reference.body).toBe(200);
        expect(reference.json()).toMatchObject({
          projectVersion: 2,
          status: "unavailable",
          reference: null,
        });
        const full = await app.inject({
          method: "PUT",
          url: base,
          headers: owner.headers,
          payload: {
            project: { ...saved.project, name: "Saved activity study" },
            expectedVersion: 2,
          },
        });
        expect(full.statusCode, full.body).toBe(200);
        saved = full.json();
        const publication = await app.inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner.headers,
          payload: { scenarioId, expectedRevision: 1 },
        });
        expect(publication.statusCode, publication.body).toBe(201);
        await app.close();
        app = undefined;
        store = runtime();
        await store.initialize();
        app = await buildApp({ ...options, store });
        const reopened = await app.inject({
          url: base,
          headers: owner.headers,
        });
        expect(reopened.statusCode, reopened.body).toBe(200);
        expect(reopened.json().project).toEqual(saved.project);
        expect(reopened.json().baselineIdentity.sha256).toBe(
          (await baselineIdentity(place)).sha256,
        );
        const gis = await app.inject({
          url: `${base}/exports?format=geojson&version=3&revision=1`,
          headers: owner.headers,
        });
        expect(gis.statusCode, gis.body).toBe(200);
        expect(gis.json().metadata.activity).toEqual(activity);
        expect(gis.json().features[0]).toMatchObject({
          geometry: activity.neighborhoods[0].geometry,
          properties: {
            featureType: "activity-neighborhood",
            employment: { mode: "absolute", value: 0 },
          },
        });
        const cleared = await app.inject({
          method: "POST",
          url: `${base}/scenarios/${scenarioId}/commands`,
          headers: owner.headers,
          payload: {
            expectedVersion: 3,
            expectedRevision: 1,
            command: { type: "scenario.activity", activity: null },
          },
        });
        expect(cleared.statusCode, cleared.body).toBe(200);
        expect(cleared.json().project.schemaVersion).toBe(5);
        const frozen = await app.inject(
          `/api/v1/published/${publication.json().id}`,
        );
        expect(frozen.statusCode, frozen.body).toBe(200);
        expect(frozen.json().scenario.activity).toEqual(activity);
        const records = await app.inject({
          url: `${base}/exports?format=records&version=4&revision=2`,
          headers: owner.headers,
        });
        expect(records.statusCode, records.body).toBe(200);
        expect(records.json().project.history[0].command.activity).toEqual(
          activity,
        );
        expect(
          records
            .json()
            .audit.some(
              (r: { action: string }) => r.action === "scenario.activity",
            ),
        ).toBe(true);
        const versions = await fixture.admin.query(
          "SELECT version FROM app_project_versions WHERE project_id=$1 ORDER BY version",
          [saved.project.id],
        );
        expect(versions.rows.map((r) => Number(r.version))).toEqual([
          1, 2, 3, 4,
        ]);
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
      }
    });
    it("persists format-4 authored tours through restricted project commands and immutable public snapshots", async () => {
      const fixture = await createPostgresSecurityFixture(connection!);
      const runtime = () =>
        new PostgresStore(fixture.webURL, {
          mode: "runtime",
          authConnectionString: fixture.authURL,
          workerConnectionString: fixture.workerURL,
          poolMax: 1,
        });
      let store = runtime(),
        app: FastifyInstance | undefined;
      const options = {
        catalog: { list: async () => [place], get: async () => place },
        nationalPreparationEnabled: false,
      };
      try {
        await store.initialize();
        app = await buildApp({ ...options, store });
        const owner = await register(app, "tour-owner"),
          outsider = await register(app, "tour-outsider");
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner.headers,
          payload: { placeId: place.id },
        });
        expect(created.statusCode, created.body).toBe(201);
        let saved = created.json<{ project: Project; version: number }>();
        const base = `/api/v1/projects/${saved.project.id}`,
          scenarioId = saved.project.activeScenarioId;
        const presentation = {
          version: 1,
          title: "A saved council tour",
          stops: [
            {
              id: "overview",
              title: "Context",
              callout: "Authored planning questions",
              camera: {
                center: [-112.07, 33.46],
                zoom: 14,
                pitch: 45,
                bearing: -27,
              },
              view: "3d",
              metricIds: ["housing.units", "future.metric"],
              narration: "Consider the recorded assumptions.",
            },
          ],
        };
        const command = {
          expectedVersion: 1,
          expectedRevision: 0,
          command: { type: "scenario.presentation", presentation },
        };
        const denied = await app.inject({
          method: "POST",
          url: `${base}/scenarios/${scenarioId}/commands`,
          headers: outsider.headers,
          payload: command,
        });
        expect(denied.statusCode, denied.body).toBe(404);
        const edited = await app.inject({
          method: "POST",
          url: `${base}/scenarios/${scenarioId}/commands`,
          headers: owner.headers,
          payload: command,
        });
        expect(edited.statusCode, edited.body).toBe(200);
        saved = edited.json();
        expect(saved.project.schemaVersion).toBe(4);
        expect(saved.project.scenarios[1].presentation).toEqual(presentation);
        expect(saved.project.scenarios[0]).not.toHaveProperty("presentation");
        const fullSave = await app.inject({
          method: "PUT",
          url: base,
          headers: owner.headers,
          payload: {
            project: { ...saved.project, name: "Tour and source evidence" },
            expectedVersion: 2,
          },
        });
        expect(fullSave.statusCode, fullSave.body).toBe(200);
        saved = fullSave.json();
        const published = await app.inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner.headers,
          payload: { scenarioId, expectedRevision: 1 },
        });
        expect(published.statusCode, published.body).toBe(201);
        const publicPath = `/api/v1/published/${published.json().id}`;
        await app.close();
        app = undefined;
        store = runtime();
        await store.initialize();
        app = await buildApp({ ...options, store });
        const reopened = await app.inject({
          url: base,
          headers: owner.headers,
        });
        expect(reopened.statusCode, reopened.body).toBe(200);
        expect(reopened.json().project).toEqual(saved.project);
        expect(reopened.json().baselineIdentity.sha256).toBe(
          (await baselineIdentity(place)).sha256,
        );
        const cleared = await app.inject({
          method: "POST",
          url: `${base}/scenarios/${scenarioId}/commands`,
          headers: owner.headers,
          payload: {
            expectedVersion: 3,
            expectedRevision: 1,
            command: { type: "scenario.presentation", presentation: null },
          },
        });
        expect(cleared.statusCode, cleared.body).toBe(200);
        expect(cleared.json().project.schemaVersion).toBe(4);
        expect(cleared.json().project.scenarios[1]).not.toHaveProperty(
          "presentation",
        );
        const frozen = await app.inject(publicPath);
        expect(frozen.statusCode, frozen.body).toBe(200);
        expect(frozen.json().scenario.presentation).toEqual(presentation);
        const records = await app.inject({
          url: `${base}/exports?format=records&version=4&revision=2`,
          headers: owner.headers,
        });
        expect(records.statusCode, records.body).toBe(200);
        expect(records.json().project.history[0].command.presentation).toEqual(
          presentation,
        );
        expect(
          records
            .json()
            .audit.some(
              (event: { action: string }) =>
                event.action === "scenario.presentation",
            ),
        ).toBe(true);
        const versions = await fixture.admin.query(
          "SELECT version FROM app_project_versions WHERE project_id=$1 ORDER BY version",
          [saved.project.id],
        );
        expect(versions.rows.map((row) => Number(row.version))).toEqual([
          1, 2, 3, 4,
        ]);
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
      }
    });
    it("retains complete building geometry and explicit programs through restricted-role import, save, publication and reopen", async () => {
      const fixture = await createPostgresSecurityFixture(connection!);
      const runtime = () =>
        new PostgresStore(fixture.webURL, {
          mode: "runtime",
          authConnectionString: fixture.authURL,
          workerConnectionString: fixture.workerURL,
          poolMax: 1,
        });
      let store = runtime(),
        app: FastifyInstance | undefined;
      const options = {
        catalog: { list: async () => [place], get: async () => place },
        nationalPreparationEnabled: false,
      };
      try {
        await store.initialize();
        app = await buildApp({ ...options, store });
        const owner = await register(app, "building-owner");
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner.headers,
          payload: { placeId: place.id },
        });
        expect(created.statusCode, created.body).toBe(201);
        let saved = created.json<{ project: Project; version: number }>();
        const base = `/api/v1/projects/${saved.project.id}`,
          scenarioId = saved.project.activeScenarioId;
        const ring = (w: number, s: number, e: number, n: number) => [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ];
        const geometry = {
          type: "MultiPolygon",
          coordinates: [
            [
              ring(-112.077, 33.453, -112.072, 33.458),
              ring(-112.076, 33.454, -112.074, 33.456),
            ],
            [ring(-112.07, 33.454, -112.068, 33.456)],
          ],
        };
        const program = {
          version: 1,
          grossFloorAreaSqm: 5000,
          commonAreaSqm: 500,
          components: [
            {
              id: "care",
              name: "Hospital care",
              use: "healthcare",
              grossFloorAreaSqm: 4500,
              units: 0,
              jobs: 120,
              beds: 45,
              tripRate: { value: 8, basis: "bed", sourceId: "client-claim" },
              parkingRate: {
                value: 1.5,
                basis: "bed",
                sourceId: "client-claim",
              },
            },
          ],
        };
        const preview = await app.inject({
          method: "POST",
          url: "/api/v1/imports/geojson/preview",
          headers: owner.headers,
          payload: {
            projectId: saved.project.id,
            scenarioId,
            layer: "buildings",
            sourceName: "Synthetic hospital program",
            publicRedistribution: true,
            geojson: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  id: "__proto__",
                  geometry,
                  properties: {
                    name: "Courtyard hospital",
                    use: "healthcare",
                    typology: "hospital",
                    height: 15,
                    floors: 4,
                    parkingSpaces: 70,
                    program,
                  },
                },
              ],
            },
          },
        });
        expect(preview.statusCode, preview.body).toBe(200);
        const committed = await app.inject({
          method: "POST",
          url: `${base}/imports/${preview.json().importId}/commit`,
          headers: owner.headers,
          payload: {
            scenarioId,
            expectedVersion: 1,
            expectedRevision: 0,
            acknowledgeWarnings: true,
          },
        });
        expect(committed.statusCode, committed.body).toBe(200);
        saved = committed.json();
        expect(saved.project.schemaVersion).toBe(8);
        const building = Object.values(
          saved.project.scenarios.find((s) => s.id === scenarioId)!
            .buildingEdits,
        )[0]!;
        expect(building.geometry).toEqual(geometry);
        expect(building).not.toHaveProperty("footprint");
        expect(building).toMatchObject({
          units: 0,
          jobs: 120,
          sourceFeatureId: "__proto__",
          programSourceId: preview.json().source.id,
        });
        expect(building.program!.components[0].tripRate!.sourceId).toBe(
          preview.json().source.id,
        );
        const save = await app.inject({
          method: "PUT",
          url: base,
          headers: owner.headers,
          payload: {
            project: { ...saved.project, name: "Hospital alternative" },
            expectedVersion: 2,
          },
        });
        expect(save.statusCode, save.body).toBe(200);
        saved = save.json();
        const published = await app.inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner.headers,
          payload: { scenarioId, expectedRevision: 1, expectedVersion: 3 },
        });
        expect(published.statusCode, published.body).toBe(201);
        const publicPath = `/api/v1/published/${published.json().id}`,
          publicBefore = (await app.inject(publicPath)).json();
        expect(publicBefore.scenario.buildingEdits[building.id]).toEqual(
          building,
        );
        expect(publicBefore.place).toEqual(place);
        await app.close();
        app = undefined;
        store = runtime();
        await store.initialize();
        app = await buildApp({ ...options, store });
        const reopened = await app.inject({
          url: base,
          headers: owner.headers,
        });
        expect(reopened.statusCode, reopened.body).toBe(200);
        expect(reopened.json().project).toEqual(saved.project);
        expect(reopened.json().baselineIdentity.sha256).toBe(
          (await baselineIdentity(place)).sha256,
        );
        expect((await app.inject(publicPath)).json()).toEqual(publicBefore);
        const gis = await app.inject({
          url: `${base}/exports?format=geojson&version=3&revision=1`,
          headers: owner.headers,
        });
        expect(gis.statusCode, gis.body).toBe(200);
        expect(gis.json().features).toHaveLength(1);
        expect(gis.json().features[0]).toMatchObject({
          id: building.id,
          geometry,
          properties: {
            featureType: "building",
            program: building.program,
            geometrySourceId: building.geometrySourceId,
            sourceFeatureId: "__proto__",
          },
        });
        const downgrade = structuredClone(saved.project);
        downgrade.schemaVersion = 2;
        downgrade.history = [];
        downgrade.undone = [];
        downgrade.scenarios.forEach((scenario) => {
          scenario.buildingEdits = {};
          // Simulate an older client that cannot retain format-8 source fields.
          for (const source of scenario.sources ?? []) {
            delete source.import;
            delete source.rights;
          }
        });
        const rejected = await app.inject({
          method: "PUT",
          url: base,
          headers: owner.headers,
          payload: { project: downgrade, expectedVersion: 3 },
        });
        expect(rejected.statusCode, rejected.body).toBe(409);
        expect(rejected.json().error.code).toBe("PROJECT_VERSION_DOWNGRADE");
        const versions = await fixture.admin.query(
          "SELECT version FROM app_project_versions WHERE project_id=$1 ORDER BY version",
          [saved.project.id],
        );
        expect(versions.rows.map((row) => Number(row.version))).toEqual([
          1, 2, 3,
        ]);
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
      }
    });
    it("persists parcel imports and exact split commands under RLS, rejects lost land and reopens the frozen publication", async () => {
      const fixture = await createPostgresSecurityFixture(connection!);
      const runtime = () =>
        new PostgresStore(fixture.webURL, {
          mode: "runtime",
          authConnectionString: fixture.authURL,
          workerConnectionString: fixture.workerURL,
          poolMax: 1,
        });
      let store = runtime(),
        app: FastifyInstance | undefined;
      try {
        await store.initialize();
        const options = {
          catalog: { list: async () => [place], get: async () => place },
          nationalPreparationEnabled: false,
        };
        app = await buildApp({ ...options, store });
        const owner = await register(app, "parcel-owner");
        const created = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: owner.headers,
          payload: { placeId: place.id },
        });
        expect(created.statusCode, created.body).toBe(201);
        let saved = created.json<{ project: Project; version: number }>();
        const base = `/api/v1/projects/${saved.project.id}`,
          scenarioId = saved.project.activeScenarioId;
        const importedGeometry = {
          type: "Polygon",
          coordinates: [
            [
              [-112.077, 33.453],
              [-112.067, 33.453],
              [-112.067, 33.463],
              [-112.077, 33.463],
              [-112.077, 33.453],
            ],
            [
              [-112.073, 33.457],
              [-112.071, 33.457],
              [-112.071, 33.459],
              [-112.073, 33.459],
              [-112.073, 33.457],
            ],
          ],
        };
        const preview = await app.inject({
          method: "POST",
          url: "/api/v1/imports/geojson/preview",
          headers: owner.headers,
          payload: {
            projectId: saved.project.id,
            scenarioId,
            layer: "parcels",
            sourceName: "Synthetic restricted-role parcel layer",
            publicRedistribution: true,
            geojson: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  id: "QA external parcel",
                  geometry: importedGeometry,
                  properties: { name: "Source planning parcel" },
                },
              ],
            },
          },
        });
        expect(preview.statusCode, preview.body).toBe(200);
        const imported = await app.inject({
          method: "POST",
          url: `${base}/imports/${preview.json().importId}/commit`,
          headers: owner.headers,
          payload: {
            scenarioId,
            expectedVersion: 1,
            expectedRevision: 0,
            acknowledgeWarnings: true,
          },
        });
        expect(imported.statusCode, imported.body).toBe(200);
        saved = imported.json();
        expect(saved.project.schemaVersion).toBe(8);
        const parcel = Object.values(
          saved.project.scenarios.find((s) => s.id === scenarioId)!
            .parcelEdits!,
        )[0] as Parcel;
        expect(parcel.geometry).toEqual(importedGeometry);
        const pieces = splitParcel(parcel, [
          [-112.072, 33.452],
          [-112.072, 33.464],
        ]);
        const bad = structuredClone(pieces);
        bad[0].geometry = {
          type: "Polygon",
          coordinates: [
            [
              [-112.076, 33.454],
              [-112.075, 33.454],
              [-112.075, 33.455],
              [-112.076, 33.455],
              [-112.076, 33.454],
            ],
          ],
        };
        const requestCommand = (parcels: Parcel[]) =>
          app!.inject({
            method: "POST",
            url: `${base}/scenarios/${scenarioId}/commands`,
            headers: owner.headers,
            payload: {
              command: {
                type: "parcels.replace",
                operation: "split",
                removeIds: [parcel.id],
                parcels,
                source: USER_PARCEL_SOURCE,
              },
              expectedVersion: 2,
              expectedRevision: 1,
            },
          });
        expect((await requestCommand(bad)).statusCode).toBe(422);
        const split = await requestCommand(pieces);
        expect(split.statusCode, split.body).toBe(200);
        saved = split.json();
        expect(saved.version).toBe(3);
        expect(
          saved.project.scenarios.find((s) => s.id === scenarioId)!
            .parcelEdits![parcel.id],
        ).toBeNull();
        const fullSave = await app.inject({
          method: "PUT",
          url: base,
          headers: owner.headers,
          payload: {
            project: { ...saved.project, name: "Parcel planning alternative" },
            expectedVersion: 3,
          },
        });
        expect(fullSave.statusCode, fullSave.body).toBe(200);
        saved = fullSave.json();
        const published = await app.inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner.headers,
          payload: { scenarioId, expectedRevision: 2, expectedVersion: 4 },
        });
        expect(published.statusCode, published.body).toBe(201);
        const publicPath = `/api/v1/published/${published.json().id}`;
        const publicBefore = (await app.inject(publicPath)).json();
        expect(publicBefore.place).toEqual(place);
        expect(publicBefore.scenario.parcelEdits).toEqual(
          saved.project.scenarios.find((s) => s.id === scenarioId)!.parcelEdits,
        );
        await app.close();
        app = undefined;
        store = runtime();
        await store.initialize();
        app = await buildApp({ ...options, store });
        const reopened = await app.inject({
          url: base,
          headers: owner.headers,
        });
        expect(reopened.statusCode, reopened.body).toBe(200);
        expect(reopened.json().project).toEqual(saved.project);
        expect(reopened.json().baselineIdentity.sha256).toBe(
          (await baselineIdentity(place)).sha256,
        );
        expect((await app.inject(publicPath)).json()).toEqual(publicBefore);
        const gis = await app.inject({
          url: `${base}/exports?format=geojson&version=4&revision=2`,
          headers: owner.headers,
        });
        expect(gis.statusCode, gis.body).toBe(200);
        expect(
          gis
            .json()
            .features.filter(
              (feature: { properties: { featureType: string } }) =>
                feature.properties.featureType === "parcel",
            ),
        ).toHaveLength(pieces.length);
        const audit = await app.inject({
          url: `${base}/audit`,
          headers: owner.headers,
        });
        expect(audit.statusCode, audit.body).toBe(200);
        expect(
          audit.json().audit.map((entry: { action: string }) => entry.action),
        ).toContain("parcels.replace");
        const versions = await fixture.admin.query(
          "SELECT version FROM app_project_versions WHERE project_id=$1 ORDER BY version",
          [saved.project.id],
        );
        expect(versions.rows.map((row) => Number(row.version))).toEqual([
          1, 2, 3, 4,
        ]);
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
      }
    });
    it("registers and signs in, saves and shares only the intended project, and preserves public/private engagement boundaries", async () => {
      const identityMail = new FixtureIdentityMail();
      const fixture = await createPostgresSecurityFixture(connection!);
      const store = new PostgresStore(fixture.webURL, {
        mode: "runtime",
        authConnectionString: fixture.authURL,
        workerConnectionString: fixture.workerURL,
        poolMax: 1,
      });
      let app: FastifyInstance | undefined;
      try {
        await store.initialize();
        app = await buildApp({
          store,
          identityMail,
          catalog: { list: async () => [place], get: async () => place },
          nationalPreparationEnabled: false,
        });
        attachIdentityTestMail(app, identityMail);
        const owner = await register(app, "owner");
        const editor = await register(app, "editor");
        const resident = await register(app, "resident");
        const duplicate = await app.inject({
          method: "POST",
          url: "/api/v1/auth/register",
          payload: {
            email: owner.email,
            name: "Duplicate",
            password: "a long isolated database test password",
          },
        });
        expect(duplicate.statusCode, duplicate.body).toBe(409);
        const create = async () => {
          const result = await app!.inject({
            method: "POST",
            url: "/api/v1/projects",
            headers: owner.headers,
            payload: { placeId: place.id },
          });
          expect(result.statusCode, result.body).toBe(201);
          return result.json() as { project: Project; version: number };
        };
        const saved = await create();
        const sibling = await create();
        const base = `/api/v1/projects/${saved.project.id}`;
        const edited = { ...saved.project, name: "A useful shared proposal" };
        const update = await app.inject({
          method: "PUT",
          url: base,
          headers: owner.headers,
          payload: { project: edited, expectedVersion: 1 },
        });
        expect(update.statusCode, update.body).toBe(200);
        expect(update.json().version).toBe(2);
        expect(
          (
            await app.inject({
              method: "PUT",
              url: base,
              headers: owner.headers,
              payload: { project: edited, expectedVersion: 1 },
            })
          ).statusCode,
        ).toBe(409);
        expect(
          (await app.inject({ url: base, headers: editor.headers })).statusCode,
        ).toBe(404);
        await acceptIdentityTestInvitation(
          app,
          owner,
          editor,
          "editor",
          saved.project.id,
        );
        const switched = await app.inject({
          method: "POST",
          url: "/api/v1/auth/organization",
          headers: editor.headers,
          payload: { organizationId: owner.organizationId },
        });
        expect(switched.statusCode, switched.body).toBe(200);
        expect(
          (await app.inject({ url: base, headers: editor.headers })).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              url: `/api/v1/projects/${sibling.project.id}`,
              headers: editor.headers,
            })
          ).statusCode,
        ).toBe(404);
        const editorSave = await app.inject({
          method: "PUT",
          url: base,
          headers: editor.headers,
          payload: {
            project: { ...edited, name: "Reviewed proposal" },
            expectedVersion: 2,
          },
        });
        expect(editorSave.statusCode, editorSave.body).toBe(200);
        const project = editorSave.json().project as Project;
        const scenario = project.scenarios.find(
          (entry) => entry.id === project.activeScenarioId,
        )!;
        const comment = await app.inject({
          method: "POST",
          url: `${base}/comments`,
          headers: editor.headers,
          payload: {
            text: "Check the walking connection.",
            scenarioId: scenario.id,
            expectedRevision: scenario.revision,
            expectedVersion: 3,
            target: { kind: "project" },
            idempotencyKey: "secured-review-thread",
          },
        });
        expect(comment.statusCode, comment.body).toBe(201);
        const published = await app.inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner.headers,
          payload: {
            scenarioId: scenario.id,
            expectedRevision: scenario.revision,
            feedbackEnabled: true,
          },
        });
        expect(published.statusCode, published.body).toBe(201);
        const snapshotId = published.json().id as string;
        const publicPath = `/api/v1/published/${snapshotId}`;
        const publicView = await app.inject(publicPath);
        expect(publicView.statusCode, publicView.body).toBe(200);
        expect(publicView.json()).not.toHaveProperty("organizationId");
        const feedback = await app.inject({
          method: "POST",
          url: `${publicPath}/feedback`,
          headers: resident.headers,
          payload: {
            kind: "comment",
            text: "Please keep the crossing accessible.",
            expectedCollectionVersion: 1,
            idempotencyKey: "secured-public-comment",
          },
        });
        expect(feedback.statusCode, feedback.body).toBe(201);
        const feedbackId = feedback.json().id as string;
        const moderation = await app.inject({
          method: "PATCH",
          url: `${base}/engagement/${snapshotId}/feedback/${feedbackId}`,
          headers: owner.headers,
          payload: {
            status: "excluded",
            reason: "Private team-only moderation note",
            expectedVersion: 1,
          },
        });
        expect(moderation.statusCode, moderation.body).toBe(200);
        const ownFeedback = await app.inject({
          url: `${publicPath}/feedback/mine`,
          headers: resident.headers,
        });
        expect(ownFeedback.statusCode, ownFeedback.body).toBe(200);
        expect(ownFeedback.body).not.toContain(
          "Private team-only moderation note",
        );
        const revoke = await app.inject({
          method: "DELETE",
          url: `${base}/members/${editor.id}`,
          headers: owner.headers,
          payload: { expectedAclVersion: 2 },
        });
        expect(revoke.statusCode, revoke.body).toBe(200);
        expect(
          (await app.inject({ url: base, headers: editor.headers })).statusCode,
        ).toBe(404);
        // The database trigger prunes only the last project-only workspace membership,
        // and moves that account's active session back to its own workspace.
        expect(
          (
            await app.inject({
              url: "/api/v1/auth/session",
              headers: editor.headers,
            })
          ).json().organization.id,
        ).toBe(editor.organizationId);
        const login = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: {
            email: owner.email,
            password: "a long isolated database test password",
          },
        });
        expect(login.statusCode, login.body).toBe(200);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/v1/auth/login",
              payload: { email: owner.email, password: "incorrect password" },
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (
            await app.inject({
              url: "/api/v1/admin/budget",
              headers: owner.headers,
            })
          ).statusCode,
        ).toBe(403);
        const budget = new BudgetService(store);
        await expect(
          budget.reserve({
            idempotencyKey: "restricted-worker-cost",
            provider: "test",
            operation: "test",
            actorId: "test-worker",
            maximumCents: 100,
          }),
        ).rejects.toMatchObject({ code: "PAID_OPERATIONS_PAUSED" });
        const logout = await app.inject({
          method: "POST",
          url: "/api/v1/auth/logout",
          headers: owner.headers,
        });
        expect(logout.statusCode, logout.body).toBe(200);
        expect(
          (
            await app.inject({
              url: "/api/v1/auth/session",
              headers: owner.headers,
            })
          ).json(),
        ).toEqual({ user: null });
        const archived = await fixture.admin.query(
          "SELECT version FROM app_project_versions WHERE project_id=$1 ORDER BY version",
          [project.id],
        );
        expect(archived.rows.map((row) => Number(row.version))).toEqual([
          1, 2, 3,
        ]);
      } finally {
        if (app) await app.close();
        else await store.close();
        await fixture.close();
      }
    });
    it("lets only the configured administrator adjust the ceiling and confines worker operations to their services", async () => {
      const state = emptyState();
      const userId = "platform-admin",
        organizationId = "admin-workspace";
      state.users.push({
        id: userId,
        email: "admin@security.example.test",
        name: "Administrator",
        passwordHash: "fixture-not-used-for-login",
        createdAt: place.loadedAt,
      });
      state.organizations.push({
        id: organizationId,
        name: "Admin workspace",
        createdAt: place.loadedAt,
      });
      state.memberships.push({ userId, organizationId, role: "owner" });
      const token = randomBytes(32).toString("base64url");
      const session = {
        hash: tokenHash(token),
        csrfToken: "isolated-test-csrf-token",
        userId,
        organizationId,
        expiresAt: "2099-01-01T00:00:00Z",
      };
      state.sessions.push(session);
      const fixture = await createPostgresSecurityFixture(connection!, {
        state,
        platformAdminUserIds: [userId],
      });
      const store = new PostgresStore(fixture.webURL, {
        mode: "runtime",
        authConnectionString: fixture.authURL,
        workerConnectionString: fixture.workerURL,
        poolMax: 1,
      });
      const headers = {
        cookie: `urban_session=${token}`,
        "x-csrf-token": session.csrfToken,
      };
      const places: Place[] = [];
      const catalog: WritableCatalog = {
        list: async () => structuredClone(places),
        get: async (id) => {
          const value = places.find((item) => item.id === id);
          if (!value)
            throw new ApiError(404, "NOT_FOUND", "Fixture not prepared");
          return structuredClone(value);
        },
        put: async (value) => {
          places.push(structuredClone(value));
          return baselineIdentity(value);
        },
      };
      const service = new NationalPreparationService(
        store,
        catalog,
        new CensusPlaces(),
        true,
        async (zip, options) => {
          await options.progress("osm", 25);
          return {
            place: {
              ...place,
              id: `zcta-${zip}-2020`,
              zip,
              geography: { type: "zcta", code: zip, boundaryVintage: "2020" },
            },
            source: { fixture: true },
            warnings: ["Synthetic test fixture"],
          };
        },
        0,
        {
          mode: "fixed-capacity",
          environment: "local-development",
          statement:
            "Isolated PostgreSQL preparation fixture has no paid external source calls.",
        },
      );
      let app: FastifyInstance | undefined;
      try {
        await expect(store.initialize([])).rejects.toThrow(
          "administrator configuration",
        );
        await store.initialize([userId]);
        app = await buildApp({
          store,
          catalog,
          platformAdminUserIds: [userId],
          nationalService: service,
        });
        const dashboard = await app.inject({
          url: "/api/v1/admin/budget",
          headers,
        });
        expect(dashboard.statusCode, dashboard.body).toBe(200);
        expect(dashboard.json().policy.monthlyLimitCents).toBe(30_000);
        const changed = await app.inject({
          method: "PATCH",
          url: "/api/v1/admin/budget",
          headers,
          payload: {
            expectedVersion: 1,
            monthlyLimitCents: 40_000,
            safetyMarginCents: 3_000,
            fixedCostReserveCents: 1_000,
            paidOperationsPaused: false,
          },
        });
        expect(changed.statusCode, changed.body).toBe(200);
        const reviewCosts = async (view: {
          outlook: { basisHash: string; review: { reviewId: string | null } };
        }) => {
          const now = new Date();
          const reviewed = await app!.inject({
            method: "POST",
            url: "/api/v1/admin/budget/reviews",
            headers,
            payload: {
              idempotencyKey: `fixture-cost-review-${randomBytes(12).toString("hex")}`,
              expectedBasisHash: view.outlook.basisHash,
              coveredThrough: now.toISOString(),
              expiresAt: new Date(
                Math.min(
                  now.getTime() + 86_400_000,
                  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
                ),
              ).toISOString(),
              estimatedUnreportedCents: 0,
              futureVariable: { lowCents: 0, expectedCents: 0, highCents: 0 },
              scopeStatement:
                "Synthetic PostgreSQL fixture only; no external provider or unresolved unmetered cost. All reservations are accounted separately.",
              replacesReviewId: view.outlook.review.reviewId,
              includesPriorUnreported: true,
            },
          });
          expect(reviewed.statusCode, reviewed.body).toBe(200);
          return reviewed;
        };
        await reviewCosts(changed.json());
        const budget = new BudgetService(store);
        const reservation = await budget.reserve({
          idempotencyKey: "restricted-service-run",
          maximumCents: 100,
          provider: "fixture",
          operation: "fixture",
          actorId: userId,
        });
        await budget.start(reservation.id);
        await budget.settle(reservation.id, 150);
        const settled = await app.inject({
          url: "/api/v1/admin/budget",
          headers,
        });
        expect(settled.json().policy).toMatchObject({
          monthlyLimitCents: 40_000,
          paidOperationsPaused: true,
        });
        expect(settled.json().totals.recordedVariableCents).toBe(150);
        const pausedPreparation = await app.inject({
          method: "POST",
          url: "/api/v1/places/preparations",
          headers,
          payload: { zip: "85004", idempotencyKey: "paused-place-request" },
        });
        expect(pausedPreparation.statusCode, pausedPreparation.body).toBe(503);
        expect(pausedPreparation.json().error.code).toBe(
          "PREPARATION_CAPACITY_PAUSED",
        );
        const resumed = await app.inject({
          method: "PATCH",
          url: "/api/v1/admin/budget",
          headers,
          payload: {
            expectedVersion: settled.json().policy.version,
            monthlyLimitCents: 40_000,
            safetyMarginCents: 3_000,
            fixedCostReserveCents: 1_000,
            paidOperationsPaused: false,
          },
        });
        expect(resumed.statusCode, resumed.body).toBe(200);
        await reviewCosts(resumed.json());
        const queued = await app.inject({
          method: "POST",
          url: "/api/v1/places/preparations",
          headers,
          payload: { zip: "85004", idempotencyKey: "restricted-place-request" },
        });
        expect(queued.statusCode, queued.body).toBe(202);
        await vi.waitFor(
          async () => {
            const current = await app!.inject({
              url: `/api/v1/places/preparations/${queued.json().job.id}`,
              headers,
            });
            expect(current.statusCode, current.body).toBe(200);
            expect(current.json().job.status).toBe("completed");
          },
          { timeout: 5000, interval: 100 },
        );
        expect(places).toHaveLength(1);
        const privateProject = await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers,
          payload: { placeId: places[0].id },
        });
        expect(privateProject.statusCode, privateProject.body).toBe(201);
        await expect(
          store.read((data) => data.projects, {
            security: { mode: "worker", purpose: "prep" },
            auth: { sessionHash: session.hash },
            projects: { all: true },
          }),
        ).rejects.toThrow(/permission denied/);
        expect(
          await store.read((data) => data.projectHeaders, {
            security: { mode: "worker", purpose: "prep" },
            auth: { sessionHash: session.hash },
            projectHeaders: { all: true },
          }),
        ).toEqual([]);
      } finally {
        await service.close();
        if (app) await app.close();
        else await store.close();
        await fixture.close();
      }
    });
  },
);
