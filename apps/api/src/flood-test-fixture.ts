import { expect } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  canonicalJSON,
  baselineIdentity,
  floodDatasetHash,
  FLOOD_METHOD_VERSION,
  FLOOD_LEGACY_METHOD_VERSION,
  type Project,
} from "@urban/core";
import { floodFixture } from "../../../tests/fixtures/flood";
import { FloodCatalog, installFloodCatalog } from "./flood-catalog";
import { buildApp } from "./app";
import type { Store } from "./store";
export async function floodApiFixture(store: Store, operator: Store = store) {
  const f = await floodFixture();
  const entry = {
    id: "test-effective",
    label: "Synthetic test mapping",
    datasetHash: f.datasetHash,
    studyAreaHash: f.dataset.studyAreaHash,
    capturedAt: f.dataset.capturedAt,
    bytes: Buffer.byteLength(canonicalJSON(f.dataset)),
    dataset: f.dataset,
    sourceManifestHash: "a".repeat(64),
  };
  const catalog = new FloodCatalog(undefined, [entry]);
  await installFloodCatalog(operator, catalog);
  const app = await buildApp({
    store,
    floodCatalog: catalog,
    nationalPreparationEnabled: false,
    catalog: { list: async () => [f.place], get: async () => f.place },
  });
  return { ...f, entry, catalog, app };
}
export async function registerFloodUser(app: FastifyInstance, name: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name,
      email: `${name}@flood.test`,
      password: "flood isolated testing password",
    },
  });
  expect(r.statusCode, r.body).toBe(201);
  return {
    cookie: `${r.cookies[0].name}=${r.cookies[0].value}`,
    "x-csrf-token": r.json().csrfToken as string,
  };
}
export async function exerciseFloodApi(
  f: Awaited<ReturnType<typeof floodApiFixture>>,
) {
  const { app } = f,
    owner = await registerFloodUser(app, "owner"),
    outsider = await registerFloodUser(app, "outsider");
  const catalog = await app.inject(
    `/api/v1/flood/catalog?studyAreaHash=${f.dataset.studyAreaHash}`,
  );
  expect(catalog.statusCode, catalog.body).toBe(200);
  expect(catalog.json().datasets).toHaveLength(1);
  expect(catalog.body).not.toContain("directory");
  expect(
    (
      await app.inject(`/api/v1/flood/catalog?studyAreaHash=${"0".repeat(64)}`)
    ).json().datasets,
  ).toEqual([]);
  const data = await app.inject(`/api/v1/flood/datasets/${f.datasetHash}`);
  expect(data.statusCode).toBe(200);
  expect(data.json().dataset).toEqual(f.dataset);
  expect(
    (await app.inject(`/api/v1/flood/datasets/${"0".repeat(64)}`)).statusCode,
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
    input = {
      scenarioId: initial.project.activeScenarioId,
      expectedVersion: 1,
      expectedRevision: 0,
      datasetHash: f.datasetHash,
    };
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${base}/flood/adopt`,
        headers: outsider,
        payload: input,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${base}/flood/adopt`,
        headers: { cookie: owner.cookie },
        payload: input,
      })
    ).statusCode,
  ).toBe(403);
  const adopted = await app.inject({
    method: "POST",
    url: `${base}/flood/adopt`,
    headers: owner,
    payload: input,
  });
  expect(adopted.statusCode, adopted.body).toBe(200);
  const saved = adopted.json();
  expect(saved.version).toBe(2);
  expect(saved.project.schemaVersion).toBe(11);
  expect(saved.project.history[0].command.flood.origin).toBe("server-catalog");
  expect(saved.project.history[0].command.flood.methodVersion).toBe(
    FLOOD_METHOD_VERSION,
  );
  expect(saved.project.history[0].after.flood.datasetHash).toBe(f.datasetHash);
  expect(saved.project.history[0].after.floodDatasets).toBeUndefined();
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${base}/flood/adopt`,
        headers: owner,
        payload: input,
      })
    ).statusCode,
  ).toBe(409);
  const mutated = structuredClone(saved.project) as Project;
  mutated.floodDatasets![f.datasetHash].notes.push("forged");
  expect(
    (
      await app.inject({
        method: "PUT",
        url: base,
        headers: owner,
        payload: { project: mutated, expectedVersion: 2 },
      })
    ).statusCode,
  ).toBe(422);
  const removed = structuredClone(saved.project) as Project;
  delete removed.floodDatasets;
  expect(
    (
      await app.inject({
        method: "PUT",
        url: base,
        headers: owner,
        payload: { project: removed, expectedVersion: 2 },
      })
    ).statusCode,
  ).toBe(400);
  const publication = await app.inject({
    method: "POST",
    url: `${base}/publish`,
    headers: owner,
    payload: { scenarioId: input.scenarioId, expectedRevision: 1 },
  });
  expect(publication.statusCode, publication.body).toBe(201);
  const published = publication.json();
  const token = published.snapshot?.id ?? published.id;
  const read = await app.inject(`/api/v1/published/${token}`);
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json().floodDataset).toEqual(f.dataset);
  expect(read.json().project).toBeUndefined();
  const csv = await app.inject({
    url: `${base}/exports?scenarioId=${input.scenarioId}&format=flood-csv`,
    headers: owner,
  });
  expect(csv.statusCode, csv.body).toBe(200);
  expect(csv.body).toContain(f.datasetHash);
  const guest = structuredClone(f.project);
  guest.scenarios[1].flood!.origin = "server-catalog";
  const guestSave = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner,
    payload: {
      project: guest,
      baselineHash: (await baselineIdentity(f.place)).sha256,
    },
  });
  expect(guestSave.statusCode, guestSave.body).toBe(201);
  const privatePack = structuredClone(f.dataset);
  privatePack.sources[0].rights = {
    version: 1,
    privateUse: true,
    cache: true,
    analyze: true,
    privateDisplay: true,
    export: false,
    historicalRetention: true,
    publicRedistribution: false,
    declaredBy: "test",
    declaredAt: "2026-11-06T00:00:00Z",
  };
  const privateHash = await floodDatasetHash(privatePack),
    privateProject = structuredClone(f.project);
  privateProject.floodDatasets = { [privateHash]: privatePack };
  privateProject.scenarios[1].flood = {
    version: 1,
    datasetHash: privateHash,
    origin: "imported",
  };
  privateProject.history = [];
  privateProject.undone = [];
  const imported = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner,
    payload: {
      project: privateProject,
      baselineHash: (await baselineIdentity(f.place)).sha256,
    },
  });
  expect(imported.statusCode, imported.body).toBe(201);
  const denied = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${imported.json().project.id}/publish`,
    headers: owner,
    payload: {
      scenarioId: privateProject.activeScenarioId,
      expectedRevision: privateProject.scenarios[1].revision,
    },
  });
  expect(denied.statusCode, denied.body).toBe(422);
  const privateSaved = imported.json();
  const privateBase = `/api/v1/projects/${privateSaved.project.id}`;
  expect(
    (
      await app.inject({
        url: `${privateBase}/exports?scenarioId=${privateProject.activeScenarioId}&format=flood-csv`,
        headers: owner,
      })
    ).statusCode,
  ).toBe(422);
  for (const rename of [false, true]) {
    const clone = structuredClone(privatePack);
    delete clone.sources[0].rights;
    if (rename) {
      clone.sources[0].id = "renamed-source";
      clone.files.forEach((file) => (file.sourceId = "renamed-source"));
    }
    const hash = await floodDatasetHash(clone),
      next = structuredClone(privateSaved.project);
    next.floodDatasets[hash] = clone;
    next.scenarios[1].revision++;
    next.scenarios[1].flood = {
      version: 1,
      datasetHash: hash,
      origin: "imported",
    };
    const response = await app.inject({
      method: "PUT",
      url: privateBase,
      headers: owner,
      payload: { project: next, expectedVersion: 1 },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().error.code).toBe("FLOOD_RIGHTS_ERASED");
  }
  const permitted = structuredClone(privatePack);
  permitted.sources[0].rights = {
    ...permitted.sources[0].rights!,
    export: true,
    publicRedistribution: true,
    declaredBy: "explicit-new-review",
    declaredAt: "2026-11-06T01:00:00Z",
  };
  const permittedHash = await floodDatasetHash(permitted),
    reviewed = structuredClone(privateSaved.project);
  reviewed.floodDatasets[permittedHash] = permitted;
  reviewed.scenarios[1].revision++;
  reviewed.scenarios[1].flood = {
    version: 1,
    datasetHash: permittedHash,
    origin: "imported",
  };
  const reviewedSave = await app.inject({
    method: "PUT",
    url: privateBase,
    headers: owner,
    payload: { project: reviewed, expectedVersion: 1 },
  });
  expect(reviewedSave.statusCode, reviewedSave.body).toBe(200);
  const reviewedPublish = await app.inject({
    method: "POST",
    url: `${privateBase}/publish`,
    headers: owner,
    payload: {
      scenarioId: reviewed.activeScenarioId,
      expectedRevision: reviewed.scenarios[1].revision,
    },
  });
  expect(reviewedPublish.statusCode, reviewedPublish.body).toBe(201);
  return { owner, outsider, base, saved, privateSaved: reviewedSave.json() };
}

/** The same source bytes support independently frozen legacy/current calculations. */
export async function exerciseFloodMethodApi(
  f: Awaited<ReturnType<typeof floodApiFixture>>,
) {
  const owner = await registerFloodUser(f.app, "method-owner"),
    project = structuredClone(f.project);
  delete project.scenarios[1].flood!.methodVersion;
  const sourceBytes = canonicalJSON(project.floodDatasets);
  const created = await f.app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner,
    payload: {
      project,
      baselineHash: (await baselineIdentity(f.place)).sha256,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const saved = created.json(),
    base = `/api/v1/projects/${saved.project.id}`,
    scenario = saved.project.scenarios[1];
  expect(Object.hasOwn(scenario.flood, "methodVersion")).toBe(false);
  const publication = await f.app.inject({
    method: "POST",
    url: `${base}/publish`,
    headers: owner,
    payload: { scenarioId: scenario.id, expectedRevision: scenario.revision },
  });
  expect(publication.statusCode, publication.body).toBe(201);
  const legacyBefore = await f.app.inject(
    `/api/v1/published/${publication.json().id}`,
  );
  expect(legacyBefore.statusCode, legacyBefore.body).toBe(200);
  expect(
    Object.hasOwn(legacyBefore.json().scenario.flood, "methodVersion"),
  ).toBe(false);
  expect(
    legacyBefore
      .json()
      .results.metrics.find((m: any) => m.id === "environment.flood")
      .methodVersion,
  ).toBe(FLOOD_LEGACY_METHOD_VERSION);
  const upgraded = await f.app.inject({
    method: "POST",
    url: `${base}/scenarios/${scenario.id}/commands`,
    headers: owner,
    payload: {
      expectedVersion: 1,
      expectedRevision: scenario.revision,
      command: {
        type: "scenario.flood",
        flood: { ...scenario.flood, methodVersion: FLOOD_METHOD_VERSION },
      },
      label: "Explicitly update flood calculation method",
    },
  });
  expect(upgraded.statusCode, upgraded.body).toBe(200);
  const next = upgraded.json();
  expect(next.version).toBe(2);
  expect(next.project.scenarios[1].revision).toBe(scenario.revision + 1);
  expect(canonicalJSON(next.project.floodDatasets)).toBe(sourceBytes);
  const history = next.project.history.at(-1);
  expect(Object.hasOwn(history.before.flood, "methodVersion")).toBe(false);
  expect(history.after.flood.methodVersion).toBe(FLOOD_METHOD_VERSION);
  expect(history.command.flood.methodVersion).toBe(FLOOD_METHOD_VERSION);
  for (const methodVersion of ["flood-footprint-999.0.0", null, 17]) {
    const rejected = await f.app.inject({
      method: "POST",
      url: `${base}/scenarios/${scenario.id}/commands`,
      headers: owner,
      payload: {
        expectedVersion: 2,
        expectedRevision: scenario.revision + 1,
        command: {
          type: "scenario.flood",
          flood: { ...scenario.flood, methodVersion },
        },
      },
    });
    expect(rejected.statusCode, rejected.body).toBe(400);
  }
  const invalidHistory = structuredClone(next.project);
  invalidHistory.history.at(-1).before.flood.methodVersion = "unsupported";
  const invalidSave = await f.app.inject({
    method: "PUT",
    url: base,
    headers: owner,
    payload: { project: invalidHistory, expectedVersion: 2 },
  });
  expect(invalidSave.statusCode, invalidSave.body).toBe(400);
  const csv = await f.app.inject({
    url: `${base}/exports?scenarioId=${scenario.id}&format=flood-csv`,
    headers: owner,
  });
  expect(csv.statusCode, csv.body).toBe(200);
  expect(csv.body).toContain(FLOOD_METHOD_VERSION);
  const currentPublication = await f.app.inject({
    method: "POST",
    url: `${base}/publish`,
    headers: owner,
    payload: {
      scenarioId: scenario.id,
      expectedRevision: scenario.revision + 1,
    },
  });
  expect(currentPublication.statusCode, currentPublication.body).toBe(201);
  const current = await f.app.inject(
    `/api/v1/published/${currentPublication.json().id}`,
  );
  expect(current.json().scenario.flood.methodVersion).toBe(
    FLOOD_METHOD_VERSION,
  );
  expect(
    current
      .json()
      .results.metrics.find((m: any) => m.id === "environment.flood")
      .methodVersion,
  ).toBe(FLOOD_METHOD_VERSION);
  const legacyAfter = await f.app.inject(
    `/api/v1/published/${publication.json().id}`,
  );
  expect(legacyAfter.json()).toEqual(legacyBefore.json());
  const omitted = structuredClone(next.project);
  delete omitted.scenarios[1].flood.methodVersion;
  omitted.scenarios[1].revision++;
  const roundTrip = await f.app.inject({
    method: "PUT",
    url: base,
    headers: owner,
    payload: { project: omitted, expectedVersion: 2 },
  });
  expect(roundTrip.statusCode, roundTrip.body).toBe(200);
  expect(
    Object.hasOwn(roundTrip.json().project.scenarios[1].flood, "methodVersion"),
  ).toBe(false);
  const explicitLegacy = await f.app.inject({
    method: "POST",
    url: `${base}/scenarios/${scenario.id}/commands`,
    headers: owner,
    payload: {
      expectedVersion: 3,
      expectedRevision: scenario.revision + 2,
      command: {
        type: "scenario.flood",
        flood: {
          ...scenario.flood,
          methodVersion: FLOOD_LEGACY_METHOD_VERSION,
        },
      },
    },
  });
  expect(explicitLegacy.statusCode, explicitLegacy.body).toBe(200);
  const legacyCsv = await f.app.inject({
    url: `${base}/exports?scenarioId=${scenario.id}&format=flood-csv`,
    headers: owner,
  });
  expect(legacyCsv.statusCode, legacyCsv.body).toBe(200);
  expect(legacyCsv.body).toContain(FLOOD_LEGACY_METHOD_VERSION);
  const currentAfter = await f.app.inject(
    `/api/v1/published/${currentPublication.json().id}`,
  );
  expect(currentAfter.json()).toEqual(current.json());
  return {
    owner,
    projectId: saved.project.id,
    legacyPublicationId: publication.json().id,
    currentPublicationId: currentPublication.json().id,
  };
}
