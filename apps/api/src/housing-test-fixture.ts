import { expect } from "vitest";
import {
  baselineIdentity,
  createHousingAffordabilityScenario,
  housingIncomeLimitPackHash,
  type Project,
} from "@urban/core";
import { housingFixture } from "../../../packages/models/src/housing-fixture";
import { HousingCatalog, installHousingCatalog } from "./housing-catalog";
import { buildApp } from "./app";
import type { Store } from "./store";
import { registerFloodUser } from "./flood-test-fixture";
export async function housingApiFixture(store: Store, operator: Store = store) {
  const f = housingFixture(),
    entry = {
      id: f.areaHash,
      pack: f.pack,
      registeredAt: new Date().toISOString(),
      sourceManifestHash: "a".repeat(64),
    },
    catalog = new HousingCatalog(undefined, [entry]);
  await installHousingCatalog(operator, catalog);
  const app = await buildApp({
    store,
    housingCatalog: catalog,
    nationalPreparationEnabled: false,
    catalog: { list: async () => [f.place], get: async () => f.place },
  });
  return { ...f, entry, catalog, app };
}
export async function exerciseHousingApi(
  f: Awaited<ReturnType<typeof housingApiFixture>>,
) {
  const { app } = f,
    owner = await registerFloodUser(app, "housing-owner"),
    outsider = await registerFloodUser(app, "housing-outsider");
  const list = await app.inject(
    "/api/v1/housing/catalog?state=04&county=04013&q=synthetic",
  );
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json().areas).toHaveLength(1);
  expect(list.body).not.toContain("directory");
  const pack = await app.inject(`/api/v1/housing/packs/${f.areaHash}`);
  expect(pack.statusCode, pack.body).toBe(200);
  expect(pack.json().pack).toEqual(f.pack);
  expect(
    (await app.inject(`/api/v1/housing/packs/${"0".repeat(64)}`)).statusCode,
  ).toBe(404);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner,
    payload: { placeId: f.place.id },
  });
  expect(created.statusCode, created.body).toBe(201);
  const initial = created.json(),
    base = `/api/v1/projects/${initial.project.id}`,
    scenario = initial.project.scenarios[1];
  const affordability = createHousingAffordabilityScenario(
    f.place,
    scenario,
    {
      baselineGroups: [{ ...f.group("b"), areaOrigin: "server-catalog" }],
      proposalGroups: [{ ...f.group("p"), areaOrigin: "server-catalog" }],
      sources: [f.source],
    },
    f.review,
  );
  const input = {
    scenarioId: scenario.id,
    expectedVersion: 1,
    expectedRevision: 0,
    affordability,
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: base + "/housing/adopt",
        headers: outsider,
        payload: input,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "POST",
        url: base + "/housing/adopt",
        headers: { cookie: owner.cookie },
        payload: input,
      })
    ).statusCode,
  ).toBe(403);
  const adopted = await app.inject({
    method: "POST",
    url: base + "/housing/adopt",
    headers: owner,
    payload: input,
  });
  expect(adopted.statusCode, adopted.body).toBe(200);
  const saved = adopted.json();
  expect(saved.version).toBe(2);
  expect(saved.project.schemaVersion).toBe(13);
  expect(saved.project.housingIncomeLimits[f.areaHash]).toEqual(f.pack);
  expect(saved.project.history[0].after.affordability.review.reviewedBy).toBe(
    "housing-owner",
  );
  expect(
    (
      await app.inject({
        method: "POST",
        url: base + "/housing/adopt",
        headers: owner,
        payload: input,
      })
    ).statusCode,
  ).toBe(409);
  const metric = await app.inject({
    url: base + `/metrics?scenarioId=${scenario.id}`,
    headers: owner,
  });
  expect(metric.statusCode, metric.body).toBe(200);
  expect(JSON.stringify(metric.json())).toContain(
    "housing-affordability-1.0.0",
  );
  const publication = await app.inject({
    method: "POST",
    url: base + "/publish",
    headers: owner,
    payload: { scenarioId: scenario.id, expectedRevision: 1 },
  });
  expect(publication.statusCode, publication.body).toBe(201);
  const pub = publication.json();
  const read = await app.inject(
    `/api/v1/published/${pub.snapshot?.id ?? pub.id}`,
  );
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json().housingIncomeLimits).toEqual({ [f.areaHash]: f.pack });
  const csv = await app.inject({
    url: base + `/exports?scenarioId=${scenario.id}&format=housing-csv`,
    headers: owner,
  });
  expect(csv.statusCode, csv.body).toBe(200);
  expect(csv.body).toContain(f.areaHash);
  const changed = structuredClone(saved.project) as Project;
  changed.housingIncomeLimits![f.areaHash].notes.push("tampering");
  expect(
    (
      await app.inject({
        method: "PUT",
        url: base,
        headers: owner,
        payload: { project: changed, expectedVersion: 2 },
      })
    ).statusCode,
  ).toBe(400);
  const imported = structuredClone(f.project);
  const privatePack = structuredClone(f.pack);
  privatePack.sources[0].rights!.export = false;
  privatePack.sources[0].rights!.publicRedistribution = false;
  const privateHash = housingIncomeLimitPackHash(privatePack);
  imported.housingIncomeLimits = { [privateHash]: privatePack };
  for (const g of [
    ...imported.scenarios[1].affordability!.baselineGroups,
    ...imported.scenarios[1].affordability!.proposalGroups,
  ])
    g.areaHash = privateHash;
  const privateSave = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner,
    payload: {
      project: imported,
      baselineHash: (await baselineIdentity(f.place)).sha256,
    },
  });
  expect(privateSave.statusCode, privateSave.body).toBe(201);
  const priv = privateSave.json();
  expect(
    (
      await app.inject({
        url: `/api/v1/projects/${priv.project.id}/exports?scenarioId=${priv.project.activeScenarioId}&format=housing-csv`,
        headers: owner,
      })
    ).statusCode,
  ).toBe(422);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${priv.project.id}/publish`,
        headers: owner,
        payload: {
          scenarioId: priv.project.activeScenarioId,
          expectedRevision: priv.project.scenarios[1].revision,
        },
      })
    ).statusCode,
  ).toBe(422);
  const noRights = structuredClone(f.project);
  delete noRights.scenarios[1].affordability!.sources[0].rights;
  const rejected = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner,
    payload: {
      project: noRights,
      baselineHash: (await baselineIdentity(f.place)).sha256,
    },
  });
  expect(rejected.statusCode, rejected.body).toBe(422);
  return { owner, outsider, saved, base };
}
