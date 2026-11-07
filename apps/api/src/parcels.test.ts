import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleParcels,
  baselineIdentity,
  materializeParcels,
  parcelPreset,
  splitParcel,
  USER_PARCEL_SOURCE,
  type Command,
  type Parcel,
  type Place,
  type Position,
  type Project,
  type Scenario,
  type StudyAreaGeometry,
} from "@urban/core";
import { buildingPreset } from "@urban/models";
import { buildApp } from "./app.js";
import { FileStore } from "./store.js";
import { previewGeoJson } from "./imports.js";

function ring(w: number, s: number, e: number, n: number): Position[] {
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
}
const geometry: StudyAreaGeometry = {
  type: "Polygon",
  coordinates: [
    ring(-112.078, 33.452, -112.072, 33.458),
    ring(-112.074, 33.456, -112.073, 33.457),
  ],
};
const islands: StudyAreaGeometry = {
  type: "MultiPolygon",
  coordinates: [
    [ring(-112.07, 33.452, -112.068, 33.454)],
    [ring(-112.066, 33.456, -112.064, 33.458)],
  ],
};
const sourcePlace: Place = {
  id: "parcel-fixture",
  name: "Parcel fixture",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  center: [-112.07, 33.46],
  bounds: [-112.08, 33.45, -112.06, 33.47],
  boundary: ring(-112.08, 33.45, -112.06, 33.47),
  buildings: [
    {
      ...buildingPreset("office", [-112.075, 33.455]),
      id: "office",
      sourceId: "fixture-source",
    },
  ],
  roads: [],
  sources: [
    {
      id: "fixture-source",
      name: "Captured source",
      url: "",
      vintage: "2025",
      license: "Fixture only",
      kind: "user-supplied",
    },
  ],
  loadedAt: "2026-11-05T00:00:00.000Z",
  coverage: [],
  extentLabel: "Parcel QA boundary",
};
interface Saved {
  project: Project;
  version: number;
  baseline: Place;
  baselineIdentity: { sha256: string };
  access: { aclVersion: number };
}
interface Account {
  id: string;
  email: string;
  organizationId: string;
  headers: Record<string, string>;
}
const apps = new Set<FastifyInstance>();
const directories: string[] = [];
async function setup(place = sourcePlace, file?: string) {
  const identityMail = new FixtureIdentityMail();
  const app = await buildApp({
    identityMail,
    store: new FileStore(file),
    catalog: {
      list: async () => [place],
      get: async () => structuredClone(place),
    },
  });
  attachIdentityTestMail(app, identityMail);
  apps.add(app);
  return app;
}
async function account(app: FastifyInstance, name = "owner"): Promise<Account> {
  const email = `${name}@parcel.test`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, name, password: "a secure parcel test password" },
  });
  expect(response.statusCode).toBe(201);
  const data = response.json();
  return {
    id: data.user.id,
    email,
    organizationId: data.organization.id,
    headers: {
      cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
      "x-csrf-token": data.csrfToken,
    },
  };
}
async function create(
  app: FastifyInstance,
  user: Account,
  place = sourcePlace,
): Promise<Saved> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: user.headers,
    payload: { placeId: place.id },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Saved>();
}
const scenario = (saved: Saved) =>
  saved.project.scenarios.find((s) => s.id === saved.project.activeScenarioId)!;
function upload(
  projectId?: string,
  layer: "parcels" | "blocks" = "parcels",
  geometries = [geometry, islands],
) {
  return {
    projectId,
    layer,
    sourceName: "County supplied layer",
    sourceUrl: "https://example.test/parcel-source",
    sourceVintage: "2024",
    sourceLicense: "Fixture attribution",
    publicRedistribution: true,
    geojson: {
      type: "FeatureCollection",
      features: geometries.map((geometry, i) => ({
        type: "Feature",
        id: `APN ${i + 1}/2024`,
        geometry,
        properties: {
          name: `Imported ${layer} ${i + 1}`,
          owner: "Not imported",
          areaSqm: 1,
        },
      })),
    },
  };
}
async function preview(
  app: FastifyInstance,
  user: Account,
  saved: Saved,
  layer: "parcels" | "blocks" = "parcels",
  geometries = [geometry, islands],
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/imports/geojson/preview",
    headers: user.headers,
    payload: {
      ...upload(saved.project.id, layer, geometries),
      scenarioId: scenario(saved).id,
    },
  });
}
async function commit(
  app: FastifyInstance,
  user: Account,
  saved: Saved,
  importId: string,
  overrides = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${saved.project.id}/imports/${importId}/commit`,
    headers: user.headers,
    payload: {
      scenarioId: scenario(saved).id,
      expectedVersion: saved.version,
      expectedRevision: scenario(saved).revision,
      acknowledgeWarnings: true,
      ...overrides,
    },
  });
}
async function command(
  app: FastifyInstance,
  user: Account,
  saved: Saved,
  command: Command,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${saved.project.id}/scenarios/${scenario(saved).id}/commands`,
    headers: user.headers,
    payload: {
      command,
      expectedVersion: saved.version,
      expectedRevision: scenario(saved).revision,
    },
  });
}
afterEach(async () => {
  for (const app of apps) await app.close();
  apps.clear();
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("parcel and block import contract", () => {
  it("retains holes, islands and source references without converting parcel boundaries to buildings", () => {
    const parsed = previewGeoJson(upload("project"));
    expect(parsed.layer).toBe("parcels");
    if (parsed.layer === "buildings") throw new Error("Wrong layer");
    expect(parsed.parcels.map((p) => p.geometry)).toEqual([geometry, islands]);
    expect(parsed.parcels[0]).toMatchObject({
      kind: "parcel",
      sourceFeatureId: "APN 1/2024",
      lineage: { operation: "import", parentIds: [] },
    });
    expect(parsed.parcels[0].id).not.toBe("APN 1/2024");
    expect(parsed.parcels[0]).not.toHaveProperty("owner");
    expect(parsed.parcels[0]).not.toHaveProperty("areaSqm");
    expect(parsed).not.toHaveProperty("buildings");
    expect(parsed.source).toMatchObject({
      vintage: "2024",
      url: "https://example.test/parcel-source",
      license: "Fixture attribution",
      kind: "user-supplied",
    });
    expect(parsed.warnings.join(" ")).toContain(
      "does not establish legal lots",
    );
    const projected = upload("project");
    Object.assign(projected.geojson, {
      crs: { type: "name", properties: { name: "EPSG:26912" } },
    });
    expect(() => previewGeoJson(projected)).toThrow("Reproject");
    expect(() =>
      previewGeoJson({
        ...upload("project"),
        sourceUrl: "javascript:alert(1)",
      }),
    ).toThrow("http or https");
  });
  it("commits an acknowledged layer once, upgrades project format, persists and publishes geometry without changing the baseline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "urban-parcels-"));
    directories.push(dir);
    const file = join(dir, "state.json");
    let app = await setup(sourcePlace, file);
    const owner = await account(app);
    let saved = await create(app, owner);
    const identity = await baselineIdentity(sourcePlace);
    expect(saved.project.schemaVersion).toBe(1);
    const staged = await preview(app, owner, saved);
    expect(staged.statusCode, staged.body).toBe(200);
    const importId = staged.json().importId;
    expect(
      (
        await commit(app, owner, saved, importId, {
          acknowledgeWarnings: false,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await commit(app, owner, saved, importId, { expectedVersion: 99 }))
        .statusCode,
    ).toBe(409);
    const committed = await commit(app, owner, saved, importId);
    expect(committed.statusCode, committed.body).toBe(200);
    saved = committed.json<Saved>();
    expect(saved.project.schemaVersion).toBe(8);
    expect(saved.version).toBe(2);
    expect(scenario(saved).revision).toBe(1);
    const duplicate = await commit(app, owner, saved, importId);
    expect(duplicate.json().alreadyCommitted).toBe(true);
    expect(duplicate.json().version).toBe(2);
    expect(saved.project.history).toHaveLength(1);
    expect(saved.project.history[0].command.type).toBe("parcels.import");
    const beforeBlock = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/metrics`,
        headers: owner.headers,
      })
    ).json();
    const far = beforeBlock.metrics.find(
      (m: { id: string }) => m.id === "land.far",
    );
    expect(far.baseline).toBeNull();
    expect(far.value).toBeGreaterThan(0);
    expect(far.status).toBe("incomplete");
    const block = await preview(app, owner, saved, "blocks", [
      { type: "Polygon", coordinates: [sourcePlace.boundary] },
    ]);
    expect(block.statusCode, block.body).toBe(200);
    saved = (
      await commit(app, owner, saved, block.json().importId)
    ).json<Saved>();
    const afterBlock = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/metrics`,
        headers: owner.headers,
      })
    ).json();
    expect(
      afterBlock.metrics.find((m: { id: string }) => m.id === "land.far").value,
    ).toBe(far.value);
    const publication = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/publish`,
      headers: owner.headers,
      payload: {
        scenarioId: scenario(saved).id,
        expectedRevision: scenario(saved).revision,
      },
    });
    expect(publication.statusCode, publication.body).toBe(201);
    const snapshotId = publication.json().id;
    await app.close();
    apps.delete(app);
    app = await setup(sourcePlace, file);
    const reopened = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}`,
        headers: owner.headers,
      })
    ).json<Saved>();
    expect(reopened.project).toEqual(saved.project);
    expect(reopened.baseline).toEqual(sourcePlace);
    expect(reopened.baselineIdentity.sha256).toBe(identity.sha256);
    expect(reopened.baseline).not.toHaveProperty("parcels");
    const geo = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/exports?format=geojson&version=${saved.version}`,
        headers: owner.headers,
      })
    ).json();
    const areas = geo.features.filter(
      (f: { properties: { featureType: string } }) =>
        ["parcel", "block"].includes(f.properties.featureType),
    );
    expect(areas).toHaveLength(3);
    expect(areas[0].geometry).toEqual(geometry);
    expect(areas[1].geometry).toEqual(islands);
    expect(areas[0].properties.boundaryStatus).toContain(
      "legal status unverified",
    );
    const frozen = (await app.inject(`/api/v1/published/${snapshotId}`)).json();
    expect(frozen.place).toEqual(sourcePlace);
    expect(frozen.scenario).toEqual(scenario(saved));
    const records = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/exports?format=records`,
        headers: owner.headers,
      })
    ).json();
    expect(records.project.history).toHaveLength(2);
    expect(
      records.audit.filter(
        (event: { action: string }) => event.action === "parcels.import",
      ),
    ).toHaveLength(2);
    const downgraded = structuredClone(saved.project);
    downgraded.schemaVersion = 1;
    downgraded.history = [];
    downgraded.undone = [];
    for (const item of downgraded.scenarios) {
      delete item.parcelEdits;
      item.sources = item.sources?.map(
        ({ rights: _rights, import: _import, ...source }) => source,
      );
    }
    const denied = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: owner.headers,
      payload: { project: downgraded, expectedVersion: saved.version },
    });
    expect(denied.statusCode, denied.body).toBe(409);
    expect(denied.json().error.code).toBe("PROJECT_VERSION_DOWNGRADE");
  });
  it("rejects malformed, outside and overlapping imported layers without staging or advancing a project", async () => {
    const app = await setup();
    const owner = await account(app);
    const saved = await create(app, owner);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/imports/geojson/preview",
          headers: owner.headers,
          payload: upload(),
        })
      ).statusCode,
    ).toBe(400);
    for (const geometries of [
      [geometry, geometry],
      [
        {
          type: "Polygon",
          coordinates: [ring(-112.081, 33.452, -112.075, 33.458)],
        } as StudyAreaGeometry,
      ],
      [
        {
          type: "Polygon",
          coordinates: [
            ring(-112.078, 33.452, -112.072, 33.458),
            ring(-112.071, 33.453, -112.07, 33.454),
          ],
        } as StudyAreaGeometry,
      ],
    ]) {
      const response = await preview(app, owner, saved, "parcels", geometries);
      expect(response.statusCode, response.body).toBe(422);
    }
    const reopened = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}`,
        headers: owner.headers,
      })
    ).json<Saved>();
    expect(reopened.version).toBe(1);
    expect(reopened.project).toEqual(saved.project);
  });
  it("keeps project-only import access scoped to its uploader and enforces a downgraded grant at commit", async () => {
    const app = await setup();
    const owner = await account(app),
      editor = await account(app, "editor");
    const saved = await create(app, owner);
    expect((await preview(app, editor, saved)).statusCode).toBe(404);
    const accepted = await acceptIdentityTestInvitation(
      app,
      owner,
      editor,
      "editor",
      saved.project.id,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/organization",
          headers: editor.headers,
          payload: { organizationId: owner.organizationId },
        })
      ).statusCode,
    ).toBe(200);
    const staged = await preview(app, editor, saved);
    expect(staged.statusCode, staged.body).toBe(200);
    expect(
      (await commit(app, owner, saved, staged.json().importId)).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/imports/geojson/preview",
          headers: { cookie: editor.headers.cookie },
          payload: upload(saved.project.id),
        })
      ).statusCode,
    ).toBe(403);
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${saved.project.id}/members/${editor.id}`,
      headers: owner.headers,
      payload: {
        role: "viewer",
        expectedAclVersion: accepted.aclVersion,
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(
      (await commit(app, editor, saved, staged.json().importId)).statusCode,
    ).toBe(403);
    const reopened = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}`,
        headers: owner.headers,
      })
    ).json<Saved>();
    expect(reopened.version).toBe(1);
    expect(scenario(reopened).parcelEdits).toBeUndefined();
  });
});

describe("parcel transformation integrity", () => {
  it("rejects reserved edit identifiers without changing history while preserving arbitrary source references", async () => {
    const app = await setup(),
      owner = await account(app),
      saved = await create(app, owner);
    const parcel = parcelPreset(geometry, "Valid planning parcel");
    for (const id of ["__proto__", "constructor", "toString"]) {
      const rejected = await command(app, owner, saved, {
        type: "parcel.upsert",
        parcel: { ...parcel, id },
        source: USER_PARCEL_SOURCE,
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.json().error.code).toBe("VALIDATION_ERROR");
    }
    const rawProject = structuredClone(saved.project);
    rawProject.schemaVersion = 2;
    rawProject.scenarios.find(
      (entry) => entry.id === rawProject.activeScenarioId,
    )!.parcelEdits = Object.fromEntries([["__proto__", null]]);
    const rawSave = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: { ...owner.headers, "content-type": "application/json" },
      payload: JSON.stringify({
        project: rawProject,
        expectedVersion: saved.version,
      }),
    });
    expect(rawSave.statusCode, rawSave.body).toBe(400);
    const unchanged = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}`,
        headers: owner.headers,
      })
    ).json<Saved>();
    expect(unchanged.version).toBe(saved.version);
    expect(unchanged.project).toEqual(saved.project);
    expect(unchanged.project.history).toHaveLength(0);
    expect(scenario(unchanged).parcelEdits).toBeUndefined();
    const accepted = await command(app, owner, saved, {
      type: "parcel.upsert",
      parcel: { ...parcel, sourceFeatureId: "__proto__" },
      source: USER_PARCEL_SOURCE,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(
      scenario(accepted.json<Saved>()).parcelEdits?.[parcel.id]
        ?.sourceFeatureId,
    ).toBe("__proto__");
  });
  it("validates atomic split and assembly conservation, retains null history and rejects invalid whole-project geometry", async () => {
    const original = {
      ...parcelPreset(geometry, "Source parcel"),
      id: "source-parcel",
      sourceId: "fixture-source",
      geometrySourceId: undefined,
      lineage: undefined,
    };
    const place = { ...sourcePlace, parcels: [original] };
    const app = await setup(place),
      owner = await account(app);
    let saved = await create(app, owner, place);
    const identity = await baselineIdentity(place);
    expect(saved.project.schemaVersion).toBe(2);
    const pieces = splitParcel(original, [
      [-112.075, 33.45],
      [-112.075, 33.46],
    ]);
    const invalid = structuredClone(pieces);
    invalid[0].geometry = {
      type: "Polygon",
      coordinates: [ring(-112.077, 33.452, -112.076, 33.453)],
    };
    const rejected = await command(app, owner, saved, {
      type: "parcels.replace",
      operation: "split",
      removeIds: [original.id],
      parcels: invalid,
      source: USER_PARCEL_SOURCE,
    });
    expect(rejected.statusCode, rejected.body).toBe(422);
    const split = await command(app, owner, saved, {
      type: "parcels.replace",
      operation: "split",
      removeIds: [original.id],
      parcels: pieces,
      source: USER_PARCEL_SOURCE,
    });
    expect(split.statusCode, split.body).toBe(200);
    saved = split.json<Saved>();
    expect(scenario(saved).parcelEdits?.[original.id]).toBeNull();
    expect(materializeParcels(place, scenario(saved))).toEqual(pieces);
    const assembled = assembleParcels(pieces, "Reassembled planning parcel");
    const joined = await command(app, owner, saved, {
      type: "parcels.replace",
      operation: "assemble",
      removeIds: pieces.map((p) => p.id),
      parcels: [assembled],
      source: USER_PARCEL_SOURCE,
    });
    expect(joined.statusCode, joined.body).toBe(200);
    saved = joined.json<Saved>();
    expect(saved.project.history).toHaveLength(2);
    expect(
      saved.project.history.at(-1)?.before.parcelEdits?.[original.id],
    ).toBeNull();
    const duplicate = parcelPreset(assembled.geometry, "Overlapping proposal");
    const corrupt = structuredClone(saved.project);
    const active = corrupt.scenarios.find(
      (s) => s.id === corrupt.activeScenarioId,
    )!;
    active.revision++;
    active.parcelEdits![duplicate.id] = duplicate;
    const save = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: owner.headers,
      payload: { project: corrupt, expectedVersion: saved.version },
    });
    expect(save.statusCode, save.body).toBe(422);
    const corruptHistory = structuredClone(saved.project);
    const outside = parcelPreset(
      {
        type: "Polygon",
        coordinates: [ring(-112.09, 33.452, -112.085, 33.458)],
      },
      "Outside undo target",
    );
    corruptHistory.history[0].after.parcelEdits![outside.id] = outside;
    const invalidHistory = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: owner.headers,
      payload: { project: corruptHistory, expectedVersion: saved.version },
    });
    expect(invalidHistory.statusCode, invalidHistory.body).toBe(422);
    const unauthorized = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/scenarios/${scenario(saved).id}/commands`,
      payload: {
        command: {
          type: "parcel.upsert",
          parcel:
            "invalid geometry should not be parsed for an unauthenticated caller",
        },
      },
    });
    expect(unauthorized.statusCode, unauthorized.body).toBe(401);
    const removed = await command(app, owner, saved, {
      type: "parcel.remove",
      id: assembled.id,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    saved = removed.json<Saved>();
    expect(materializeParcels(place, scenario(saved))).toHaveLength(0);
    const reopened = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}`,
        headers: owner.headers,
      })
    ).json<Saved>();
    expect(reopened.baseline).toEqual(place);
    expect(reopened.baselineIdentity.sha256).toBe(identity.sha256);
    expect(reopened.project.history.at(-1)?.command.type).toBe("parcel.remove");
  });
});
