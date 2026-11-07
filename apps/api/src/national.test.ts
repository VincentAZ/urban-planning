import {
  enableReviewedBudgetForFixture,
  preparationCapacityFixture,
  reviewBudgetForFixture,
} from "./budget-test-fixture.js";
import { recordBudgetAdjustment } from "./budget.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Place } from "@urban/core";
import {
  baselineIdentity,
  buildingWithinStudyArea,
  lineWithinStudyArea,
} from "@urban/core";
import { buildingPreset } from "@urban/models";
import { buildApp } from "./app.js";
import { FileStore } from "./store.js";
import { ApiError } from "./errors.js";
import { PlaceCatalog } from "./places.js";
import { CensusPlaces } from "./data/census-places.js";
import { boundedJson } from "./data/public-fetch.js";
import {
  convertOsm,
  validateOsmResponse,
  type OsmResponse,
} from "./data/osm.js";
import {
  NationalPreparationService,
  type WritableCatalog,
  type prepareZcta,
} from "./national-preparation.js";

const ring: Place["boundary"] = [
  [-112.075, 33.45],
  [-112.065, 33.45],
  [-112.065, 33.46],
  [-112.075, 33.46],
  [-112.075, 33.45],
];
const place: Place = {
  id: "zcta-85004-2020",
  name: "Test ZIP area",
  city: "Census ZIP area",
  state: "US",
  zip: "85004",
  center: [-112.07, 33.455],
  bounds: [-112.075, 33.45, -112.065, 33.46],
  boundary: ring,
  studyArea: { type: "Polygon", coordinates: [ring] },
  geography: { type: "zcta", code: "85004", boundaryVintage: "2020" },
  buildings: [
    { ...buildingPreset("multifamily", [-112.07, 33.455]), id: "existing" },
  ],
  roads: [],
  sources: [
    {
      id: "test",
      name: "Test boundary",
      url: "https://example.com",
      vintage: "2020",
      license: "Test fixture",
      kind: "user-supplied",
    },
  ],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00.000Z",
  extentLabel: "Test exact ZCTA fixture",
};
const resources: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) await resource.close();
});
function memoryCatalog(): WritableCatalog & { saved: Place[] } {
  const saved: Place[] = [];
  return {
    saved,
    list: async () => structuredClone(saved),
    get: async (id) => {
      const found = saved.find((p) => p.id === id);
      if (!found) throw new ApiError(404, "NOT_FOUND", "No place");
      return structuredClone(found);
    },
    put: async (value) => {
      saved.push(structuredClone(value));
      return baselineIdentity(value);
    },
  };
}
const successfulPreparation = (async (zip, options) => {
  await options.progress("osm", 25);
  return {
    place: { ...place, id: `zcta-${zip}-2020`, zip },
    warnings: ["Fixture only"],
    source: { fixture: true },
  };
}) as typeof prepareZcta;
function properties(zip = "85004") {
  return {
    ZCTA5: zip,
    GEOID: zip,
    NAME: `ZCTA5 ${zip}`,
    INTPTLAT: "33.455",
    INTPTLON: "-112.07",
  };
}

describe("official-source adapter boundaries", () => {
  it("resolves ZIP, address, city, and map point with hardcoded official endpoints and caches repeats", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.hostname === "geocoding.geo.census.gov")
        return Response.json({
          result: {
            addressMatches: [
              {
                matchedAddress: "100 MAIN ST, PHOENIX, AZ, 85004",
                coordinates: { x: -112.07, y: 33.455 },
              },
            ],
          },
        });
      if (url.pathname.includes("Places_CouSub"))
        return Response.json({
          features: url.pathname.includes("/4/")
            ? [
                {
                  attributes: {
                    GEOID: "0455000",
                    STATE: "04",
                    NAME: "Phoenix city",
                    INTPTLAT: "33.455",
                    INTPTLON: "-112.07",
                  },
                },
              ]
            : [],
        });
      return Response.json({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: properties(),
            attributes: properties(),
            geometry: { type: "Polygon", coordinates: [ring] },
          },
        ],
      });
    }) as typeof fetch;
    const census = new CensusPlaces(fetcher, 0);
    expect((await census.search("85004")).candidates[0]).toMatchObject({
      kind: "zcta",
      zip: "85004",
      prepared: false,
      placeId: place.id,
    });
    await census.search("85004");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).searchParams.get("returnGeometry")).toBe("false");
    await census.zcta("85004");
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]).searchParams.get("returnGeometry")).toBe("true");
    expect(
      (await census.search("100 Main St, Phoenix, AZ")).candidates[0].kind,
    ).toBe("address");
    expect((await census.search("Phoenix, AZ")).candidates[0].label).toBe(
      "Phoenix city, AZ",
    );
    expect((await census.locate([-112.07, 33.455])).candidates[0].zip).toBe(
      "85004",
    );
    expect(
      calls.every((url) =>
        ["tigerweb.geo.census.gov", "geocoding.geo.census.gov"].includes(
          new URL(url).hostname,
        ),
      ),
    ).toBe(true);
    await expect(
      census.search("Phoenix';DROP TABLE cities;--"),
    ).rejects.toMatchObject({ code: "CITY_SEARCH_INVALID" });
  });
  it("evicts older provider entries when their aggregate serialized bytes exceed the cache budget", async () => {
    const calls: string[] = [];
    const census = new CensusPlaces(
      (async (input: RequestInfo | URL) => {
        const zip = new URL(String(input)).searchParams
          .get("where")!
          .match(/\d{5}/)![0];
        calls.push(zip);
        return Response.json({
          features: [{ attributes: properties(zip) }],
          padding: "x".repeat(400),
        });
      }) as typeof fetch,
      0,
      { cacheBytes: 1200 },
    );
    await census.search("85004");
    await census.search("85004");
    expect(calls).toEqual(["85004"]);
    await census.search("60601");
    await census.search("85004");
    expect(calls).toEqual(["85004", "60601", "85004"]);
  });
  it("bounds the provider backlog and cancels a queued preparation without waiting for the active lookup", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const census = new CensusPlaces(
      (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        await gate;
        return Response.json({ features: [{ attributes: properties() }] });
      }) as typeof fetch,
      0,
      { pendingRequests: 2, queueWaitMs: 1000 },
    );
    const first = census.search("85004");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const controller = new AbortController();
    const queued = census.zcta("60601", controller.signal);
    const cancelled = expect(queued).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(census.search("10001")).rejects.toMatchObject({
      code: "CENSUS_BUSY",
    });
    controller.abort();
    await cancelled;
    expect(calls).toHaveLength(1);
    release();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
  });
  it("expires queued lookups before dispatch when an upstream request stalls", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const census = new CensusPlaces(
      (async () => {
        calls++;
        await gate;
        return Response.json({ features: [{ attributes: properties() }] });
      }) as typeof fetch,
      0,
      { queueWaitMs: 20 },
    );
    const first = census.search("85004");
    await vi.waitFor(() => expect(calls).toBe(1));
    await expect(census.search("60601")).rejects.toMatchObject({
      code: "CENSUS_BUSY",
    });
    release();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });
  it("distinguishes an unmapped postal ZIP and rejects a truncated analytical geometry", async () => {
    const missing = new CensusPlaces(
      (async () => Response.json({ features: [] })) as typeof fetch,
      0,
    );
    const result = await missing.search("99999");
    expect(result.candidates).toEqual([]);
    expect(result.warnings[0]).toContain("No Census");
    const truncated = new CensusPlaces(
      (async () =>
        Response.json({
          features: [],
          exceededTransferLimit: true,
        })) as typeof fetch,
      0,
    );
    await expect(truncated.zcta("85004")).rejects.toMatchObject({
      code: "CENSUS_RESULT_TRUNCATED",
    });
  });
  it("finds Brooklyn through official county-subdivision data without inventing a ZIP", async () => {
    const census = new CensusPlaces(
      (async (input: RequestInfo | URL) =>
        Response.json({
          features: String(input).includes("/MapServer/1/query")
            ? [
                {
                  attributes: {
                    GEOID: "3604710022",
                    STATE: "36",
                    NAME: "Brooklyn borough",
                    INTPTLAT: "+40.6350451",
                    INTPTLON: "-073.9506398",
                  },
                },
              ]
            : [],
        })) as typeof fetch,
      0,
    );
    const result = await census.search("Brooklyn, NY");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      kind: "city",
      label: "Brooklyn borough, NY",
      coordinates: [-73.9506398, 40.6350451],
      prepared: false,
    });
    expect(result.candidates[0].zip).toBeUndefined();
    expect(result.candidates[0].detail).toContain("Borough");
  });
  it("rejects incomplete Overpass results instead of manufacturing zero buildings", () => {
    const valid: OsmResponse = {
      osm3s: { timestamp_osm_base: "2026-11-05T00:00:00Z" },
      elements: [
        {
          type: "way",
          id: 1,
          tags: { highway: "residential" },
          geometry: [
            { lat: 33.45, lon: -112.07 },
            { lat: 33.455, lon: -112.07 },
          ],
        },
        { type: "count", id: 0, tags: { total: "1" } },
      ],
    };
    expect(validateOsmResponse(valid)).toBe(valid);
    expect(() =>
      validateOsmResponse({
        ...valid,
        remark: "runtime error: query timed out",
      }),
    ).toThrow("incomplete");
    expect(() =>
      validateOsmResponse({ ...valid, elements: valid.elements.slice(0, 1) }),
    ).toThrow("completion count");
    expect(() =>
      validateOsmResponse({
        ...valid,
        elements: [{ type: "count", id: 0, tags: { total: "0" } }],
      }),
    ).toThrow("not evidence");
  });
  it("enforces streamed response limits, not just Content-Length", async () => {
    const fetcher = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"large":"'));
            controller.enqueue(new TextEncoder().encode("x".repeat(100)));
            controller.close();
          },
        }),
      )) as typeof fetch;
    await expect(
      boundedJson("https://example.com", { fetcher, maxBytes: 20 }),
    ).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
  });
  it("clips roads to the complete study area and labels all attribute inference", () => {
    const building = place.buildings[0];
    const data: OsmResponse = {
      osm3s: { timestamp_osm_base: "2026-11-05T00:00:00Z" },
      elements: [
        {
          type: "way",
          id: 1,
          tags: { building: "apartments", "building:levels": "3" },
          geometry: building.footprint!.map(([lon, lat]) => ({ lon, lat })),
        },
        {
          type: "way",
          id: 2,
          tags: { highway: "residential" },
          geometry: [
            { lon: -112.08, lat: 33.455 },
            { lon: -112.06, lat: 33.455 },
          ],
        },
        { type: "count", id: 0, tags: { total: "2" } },
      ],
    };
    const result = convertOsm(data, place, "osm-test", "inferred-test");
    expect(result.buildings).toHaveLength(1);
    expect(result.roads).toHaveLength(1);
    expect(buildingWithinStudyArea(result.buildings[0].footprint!, place)).toBe(
      true,
    );
    expect(lineWithinStudyArea(result.roads[0].coordinates, place)).toBe(true);
    expect(result.buildings[0]).toMatchObject({
      sourceId: "osm-test",
      attributeSourceId: "inferred-test",
      estimated: true,
    });
  });
});

describe("durable bounded preparation queue", () => {
  it("reauthorizes the real caller session inside enqueue, cancel and retry writes", async () => {
    const store = await reviewedStore(),
      catalog = memoryCatalog();
    catalog.saved.push(place);
    await store.transaction((state) => {
      state.users.push({
        id: "caller",
        name: "Caller",
        email: "caller@example.test",
        createdAt: "2026-11-05",
      });
      state.organizations.push({
        id: "caller-org",
        name: "Caller workspace",
        createdAt: "2026-11-05",
      });
      state.memberships.push({
        userId: "caller",
        organizationId: "caller-org",
        role: "owner",
      });
      state.sessions.push({
        hash: "real-session",
        userId: "caller",
        organizationId: "caller-org",
        csrfToken: "test",
        expiresAt: "2099-01-01T00:00:00Z",
      });
    });
    const service = new NationalPreparationService(
      store,
      catalog,
      new CensusPlaces(),
      false,
    );
    resources.push(service, store);
    await expect(
      service.enqueue(
        "85004",
        "wrong-caller-key",
        "different-user",
        "caller-org",
        "real-session",
      ),
    ).rejects.toMatchObject({ code: "PREPARATION_IDENTITY_CHANGED" });
    const accepted = await service.enqueue(
      "85004",
      "accepted-caller-key",
      "caller",
      "caller-org",
      "real-session",
    );
    expect(accepted.status).toBe("completed");
    // The HTTP preflight has already succeeded; revoke the session before the actual operation.
    await store.transaction((state) => {
      state.sessions = [];
    });
    await expect(
      service.enqueue(
        "85004",
        "revoked-caller-key",
        "caller",
        "caller-org",
        "real-session",
      ),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(
      service.cancel(accepted.id, "caller", "real-session"),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(
      service.retry(accepted.id, "revoked-retry-key", "caller", "real-session"),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(await store.read((state) => state.preparationJobs.length)).toBe(1);
  });

  it("deduplicates requests and publishes only a completed immutable bundle", async () => {
    const store = await reviewedStore();
    const catalog = memoryCatalog();
    let executions = 0;
    const prepare = (async (...args: Parameters<typeof prepareZcta>) => {
      executions++;
      return successfulPreparation(...args);
    }) as typeof prepareZcta;
    const service = new NationalPreparationService(
      store,
      catalog,
      new CensusPlaces(),
      true,
      prepare,
      0,
      preparationCapacityFixture,
    );
    resources.push(service);
    const a = await service.enqueue(
      "85004",
      "request-one-0001",
      "user1",
      "org1",
    );
    const b = await service.enqueue(
      "85004",
      "request-one-0001",
      "user1",
      "org1",
    );
    expect(a.id).toBe(b.id);
    await expect(
      service.enqueue("60601", "request-one-0001", "user1", "org1"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await vi.waitFor(
      async () =>
        expect(await store.read((s) => s.preparationJobs[0].status)).toBe(
          "completed",
        ),
      { timeout: 5000 },
    );
    expect(executions).toBe(1);
    expect(catalog.saved).toHaveLength(1);
    const completed = await store.read((s) => s.preparationJobs[0]);
    expect(completed.baselineIdentity).toEqual(
      await baselineIdentity(catalog.saved[0]),
    );
    const cached = await service.enqueue(
      "85004",
      "cached-request-01",
      "user2",
      "org2",
    );
    expect(cached.status).toBe("completed");
    expect(executions).toBe(1);
  });
  it("enforces one global running job across independent worker services", async () => {
    const store = await reviewedStore();
    const catalog = memoryCatalog();
    let active = 0,
      maxActive = 0;
    const prepare = (async (
      zip: string,
      options: Parameters<typeof prepareZcta>[1],
    ) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await successfulPreparation(zip, options);
      active--;
      return result;
    }) as typeof prepareZcta;
    const a = new NationalPreparationService(
      store,
      catalog,
      new CensusPlaces(),
      true,
      prepare,
      0,
      preparationCapacityFixture,
    );
    const b = new NationalPreparationService(
      store,
      catalog,
      new CensusPlaces(),
      true,
      prepare,
      0,
      preparationCapacityFixture,
    );
    resources.push(a, b);
    await a.enqueue("85004", "global-request-a", "user-a", "org-a");
    await b.enqueue("60601", "global-request-b", "user-b", "org-b");
    await vi.waitFor(
      async () =>
        expect(
          await store.read(
            (s) =>
              s.preparationJobs.filter((j) => j.status === "completed").length,
          ),
        ).toBe(2),
      { timeout: 6000 },
    );
    expect(maxActive).toBe(1);
  });
  it("enforces global daily admission even when multiple accounts have remaining requests", async () => {
    const store = await reviewedStore();
    const catalog = memoryCatalog();
    let executions = 0;
    await store.transaction((s) => {
      s.preparationControl.requests = Array.from({ length: 10 }, (_, i) => ({
        at: new Date().toISOString(),
        userId: `other-${i}`,
      }));
    });
    const service = new NationalPreparationService(
      store,
      catalog,
      new CensusPlaces(),
      true,
      (async (...args: Parameters<typeof prepareZcta>) => {
        executions++;
        return successfulPreparation(...args);
      }) as typeof prepareZcta,
      0,
      preparationCapacityFixture,
    );
    resources.push(service);
    await service.enqueue(
      "85004",
      "daily-limit-request",
      "fresh-user",
      "fresh-org",
    );
    await vi.waitFor(
      async () =>
        expect(await store.read((s) => s.preparationJobs[0])).toMatchObject({
          status: "failed",
          error: { code: "PREPARATION_DAILY_LIMIT", retryable: true },
        }),
      { timeout: 4000 },
    );
    expect(executions).toBe(0);
    expect(catalog.saved).toHaveLength(0);
  });
  it("cancels running source work without publishing and supports explicit retry", async () => {
    const store = await reviewedStore();
    const catalog = memoryCatalog();
    let attempts = 0;
    const prepare = (async (
      zip: string,
      options: Parameters<typeof prepareZcta>[1],
    ) => {
      attempts++;
      if (attempts === 1)
        await new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        });
      return successfulPreparation(zip, options);
    }) as typeof prepareZcta;
    const service = new NationalPreparationService(
      store,
      catalog,
      new CensusPlaces(),
      true,
      prepare,
      0,
      preparationCapacityFixture,
    );
    resources.push(service);
    const job = await service.enqueue(
      "85004",
      "cancel-request-01",
      "user1",
      "org1",
    );
    await vi.waitFor(
      async () =>
        expect(await store.read((s) => s.preparationJobs[0].status)).toBe(
          "running",
        ),
      { timeout: 4000 },
    );
    await service.cancel(job.id, "user1");
    await vi.waitFor(async () =>
      expect(await store.read((s) => s.preparationJobs[0].status)).toBe(
        "cancelled",
      ),
    );
    expect(catalog.saved).toHaveLength(0);
    await service.retry(job.id, "retry-request-001", "user1");
    await vi.waitFor(
      async () =>
        expect(await store.read((s) => s.preparationJobs[0].status)).toBe(
          "completed",
        ),
      { timeout: 5000 },
    );
    expect(attempts).toBe(2);
  });
  it("recovers a durable interrupted job after restart and refuses oversized-source retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-prepare-"));
    const filename = join(directory, "state.json");
    const store = await reviewedStore(filename);
    const catalog = memoryCatalog();
    const service = new NationalPreparationService(
      store,
      catalog,
      new CensusPlaces(),
      true,
      successfulPreparation,
      0,
      preparationCapacityFixture,
    );
    try {
      const job = await service.enqueue(
        "85004",
        "restart-request-01",
        "user1",
        "org1",
      );
      await service.close();
      await store.transaction((s) => {
        s.preparationJobs[0].status = "running";
        s.preparationJobs[0].attempt = 1;
        s.preparationJobs[0].workerId = "dead-worker";
        s.preparationJobs[0].leaseExpiresAt = "2020-01-01T00:00:00Z";
      });
      await store.close();
      const reopened = new FileStore(filename);
      const recovered = new NationalPreparationService(
        reopened,
        catalog,
        new CensusPlaces(),
        true,
        successfulPreparation,
        0,
        preparationCapacityFixture,
      );
      resources.push(recovered);
      recovered.start();
      await vi.waitFor(
        async () =>
          expect(await reopened.read((s) => s.preparationJobs[0].status)).toBe(
            "completed",
          ),
        { timeout: 5000 },
      );
      expect((await reopened.read((s) => s.preparationJobs[0])).id).toBe(
        job.id,
      );
      await recovered.close();
      await reopened.close();
      const failedStore = await reviewedStore();
      const failedCatalog = memoryCatalog();
      const failed = new NationalPreparationService(
        failedStore,
        failedCatalog,
        new CensusPlaces(),
        true,
        (async () => {
          throw new ApiError(422, "STUDY_AREA_TOO_LARGE", "Too large");
        }) as typeof prepareZcta,
        0,
        preparationCapacityFixture,
      );
      resources.push(failed);
      const large = await failed.enqueue(
        "12345",
        "too-large-request",
        "user2",
        "org2",
      );
      await vi.waitFor(
        async () =>
          expect(
            await failedStore.read((s) => s.preparationJobs[0]),
          ).toMatchObject({
            status: "failed",
            error: { code: "STUDY_AREA_TOO_LARGE", retryable: false },
          }),
        { timeout: 4000 },
      );
      await expect(
        failed.retry(large.id, "retry-large-0001", "user2"),
      ).rejects.toMatchObject({ code: "PREPARATION_NOT_RETRYABLE" });
      expect(failedCatalog.saved).toHaveLength(0);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("archives source provenance and keeps previous source versions readable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-catalog-"));
    try {
      const catalog = new PlaceCatalog(directory);
      const first = await catalog.put(place, {
        retrievedAt: "first",
        source: "fixture",
      });
      const changed = {
        ...place,
        loadedAt: "2026-11-06T00:00:00Z",
        name: "Changed source",
      };
      const second = await catalog.put(changed, {
        retrievedAt: "second",
        source: "fixture",
      });
      expect(first.sha256).not.toBe(second.sha256);
      expect((await catalog.getSnapshot(place.id, first.sha256)).name).toBe(
        place.name,
      );
      expect((await catalog.get(place.id)).name).toBe("Changed source");
      const manifest = JSON.parse(
        await readFile(
          join(directory, "manifests", `${first.sha256}.json`),
          "utf8",
        ),
      );
      expect(manifest.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("requires free-account authentication and CSRF, and isolates preparation ownership", async () => {
    const store = await reviewedStore();
    const catalog = memoryCatalog();
    catalog.saved.push(place);
    const app = await buildApp({
      store,
      catalog,
      nationalPreparationEnabled: false,
    });
    resources.push(app);
    async function account(email: string) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: {
          email,
          password: "test national account password",
          name: "Planner",
        },
      });
      return {
        cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
        "x-csrf-token": response.json().csrfToken,
      };
    }
    const owner = await account("prep-owner@example.com");
    const outsider = await account("prep-other@example.com");
    const payload = { zip: "85004", idempotencyKey: "protected-request" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/places/preparations",
          payload,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/places/preparations",
          headers: { cookie: owner.cookie },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/places/preparations",
      headers: owner,
      payload,
    });
    expect(response.statusCode).toBe(200);
    const job = response.json().job;
    expect(job).not.toHaveProperty("userId");
    expect(job.status).toBe("completed");
    expect(
      (
        await app.inject({
          url: `/api/v1/places/preparations/${job.id}`,
          headers: outsider,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/places/preparations/${job.id}/cancel`,
          headers: outsider,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/places/preparations",
          headers: outsider,
        })
      ).json().jobs,
    ).toEqual([]);
    expect((await app.inject(`/api/v1/places/${place.id}`)).statusCode).toBe(
      200,
    );
  });
});

async function reviewedStore(filename?: string) {
  const store = new FileStore(filename);
  await store.transaction((state) =>
    enableReviewedBudgetForFixture(state.budget),
  );
  return store;
}

describe("preparation operating-cost admission", () => {
  it("requires declared capacity and fresh evidence, rechecks before source work, and preserves cached exploration", async () => {
    const store = new FileStore(),
      catalog = memoryCatalog();
    await store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = false;
    });
    let executions = 0;
    const prepare = (async (...args: Parameters<typeof prepareZcta>) => {
      executions++;
      return successfulPreparation(...args);
    }) as typeof prepareZcta;
    const unconfigured = new NationalPreparationService(
      store,
      catalog,
      new CensusPlaces(),
      true,
      prepare,
      0,
    );
    const service = new NationalPreparationService(
      store,
      catalog,
      new CensusPlaces(),
      true,
      prepare,
      0,
      preparationCapacityFixture,
    );
    resources.push(unconfigured, service, store);
    await expect(
      unconfigured.enqueue("85004", "missing-cost-model", "user", "org"),
    ).rejects.toMatchObject({ code: "PREPARATION_COST_MODEL_UNCONFIGURED" });
    await expect(
      service.enqueue("85004", "missing-cost-review", "user", "org"),
    ).rejects.toMatchObject({ code: "OPERATING_COST_REVIEW_REQUIRED" });
    expect(await store.read((s) => s.preparationJobs)).toEqual([]);
    await store.transaction((s) => reviewBudgetForFixture(s.budget));
    const queued = await service.enqueue(
      "85004",
      "reviewed-first-queue",
      "user",
      "org",
    );
    expect(queued).not.toHaveProperty("costAdmissions");
    await store.transaction((s) =>
      recordBudgetAdjustment(
        s.budget,
        {
          idempotencyKey: "new-unreviewed-cost",
          amountCents: 100,
          category: "variable",
          reason: "Fixture external cost changed after queue admission",
        },
        "fixture-budget-admin",
      ),
    );
    await vi.waitFor(
      async () =>
        expect(await store.read((s) => s.preparationJobs[0])).toMatchObject({
          status: "failed",
          attempt: 0,
          error: { code: "OPERATING_COST_REVIEW_REQUIRED", retryable: true },
        }),
      { timeout: 4000 },
    );
    expect(executions).toBe(0);
    expect(await store.read((s) => s.preparationControl.requests)).toEqual([]);
    await store.transaction((s) => reviewBudgetForFixture(s.budget));
    await service.retry(queued.id, "explicit-reviewed-retry", "user");
    await vi.waitFor(
      async () =>
        expect(await store.read((s) => s.preparationJobs[0].status)).toBe(
          "completed",
        ),
      { timeout: 5000 },
    );
    expect(executions).toBe(1);
    await store.transaction((s) => {
      s.budget.policy.paidOperationsPaused = true;
    });
    const cached = await service.enqueue(
      "85004",
      "cached-while-paused",
      "another-user",
      "another-org",
    );
    expect(cached.status).toBe("completed");
    expect(executions).toBe(1);
    expect(cached).not.toHaveProperty("costAdmissions");
  });
});
