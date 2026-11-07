import { describe, expect, it } from "vitest";
import {
  applyCommand,
  canonicalJSON,
  projectWithImportVersion,
  type Place,
  type Project,
  type Source,
} from "@urban/core";
import { buildingPreset, createProject } from "@urban/models";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce";
import { buildApp } from "./app";
import { FileStore } from "./store";
import {
  scenarioForPublication,
  validateSourceRightsTransition,
} from "./retail-publication";

const place: Place = structuredClone(workforcePlaceFixture);
const source: Source = {
  id: "private-gis-source",
  name: "Synthetic privately permitted GIS source",
  url: "",
  vintage: "2026",
  license: "Synthetic test data; authorized private use",
  kind: "user-supplied",
  rights: {
    version: 1,
    privateUse: true,
    cache: true,
    analyze: true,
    privateDisplay: true,
    export: true,
    historicalRetention: true,
    publicRedistribution: false,
    declaredBy: "fixture-uploader",
    declaredAt: "2026-11-06T00:00:00Z",
  },
};
const imported = () => ({
  ...buildingPreset("office", place.center),
  id: "private-imported-building",
  sourceId: source.id,
  geometrySourceId: source.id,
});
function fixture(publicPermission = false) {
  const project = createProject(place),
    before = structuredClone(project.scenarios[1]),
    declaration = structuredClone(source);
  declaration.rights!.publicRedistribution = publicPermission;
  const command = {
    type: "buildings.import" as const,
    buildings: [imported()],
    source: declaration,
    mode: "append" as const,
  };
  const after = applyCommand(before, command);
  project.scenarios[1] = after;
  project.history = [
    {
      id: "fixture-history",
      actor: "fixture-uploader",
      at: "2026-11-06T00:00:00Z",
      label: "Import reviewed footprint",
      command,
      before,
      after: structuredClone(after),
    },
  ];
  return projectWithImportVersion(project, place);
}
function stripAll(project: Project, keepSource = false): Project {
  const next = structuredClone(project);
  next.history = [];
  next.undone = [];
  for (const scenario of next.scenarios) {
    if (scenario.id === "baseline") continue;
    scenario.sources = keepSource
      ? scenario.sources?.map(
          ({ rights: _rights, import: _import, ...rest }) => rest,
        )
      : [];
    scenario.revision++;
  }
  return next;
}

describe("retained import source permissions", () => {
  it.each(["omitted", "stripped"])(
    "blocks publication when current source permissions are %s but private history remains",
    (mutation) => {
      const project = fixture(),
        scenario = project.scenarios[1];
      scenario.sources =
        mutation === "omitted"
          ? []
          : scenario.sources!.map(({ rights: _rights, ...rest }) => rest);
      const unchanged = canonicalJSON(project);
      expect(() => scenarioForPublication(project, place, scenario)).toThrow(
        /public redistribution permission/i,
      );
      expect(canonicalJSON(project)).toBe(unchanged);
    },
  );
  it.each([false, true])(
    "rejects whole-save removal of retained permission records (keep stripped source=%s)",
    (keepSource) => {
      const previous = fixture();
      expect(() =>
        validateSourceRightsTransition(
          previous,
          stripAll(previous, keepSource),
          place,
        ),
      ).toThrow(/cannot be erased/);
    },
  );
  it("accepts undo/deletion when the source is safely retained in command history, and removes unused private metadata from a public copy", () => {
    const previous = fixture(),
      next = structuredClone(previous);
    next.scenarios[1] = structuredClone(next.history[0].before);
    next.history[0].after.sources = [];
    next.undone = [next.history[0]];
    next.history = [];
    expect(() =>
      validateSourceRightsTransition(previous, next, place),
    ).not.toThrow();
    const published = scenarioForPublication(next, place, next.scenarios[1]);
    expect(published.sources ?? []).toEqual([]);
    expect(next.undone[0].command).toMatchObject({ source });
  });
  it("restores permitted retained attribution into a public copy without mutating the private scenario", () => {
    const project = fixture(true),
      scenario = project.scenarios[1];
    scenario.sources = [];
    const published = scenarioForPublication(project, place, scenario);
    expect(published.sources).toEqual([
      project.history[0].command.type === "buildings.import"
        ? project.history[0].command.source
        : null,
    ]);
    expect(published.sources![0].rights?.publicRedistribution).toBe(true);
    expect(scenario.sources).toEqual([]);
  });
  it("permits an explicit current public attestation and preserves legacy undeclared sources", () => {
    const previous = fixture(),
      next = stripAll(previous, true);
    next.scenarios[1].sources = [
      {
        ...source,
        rights: {
          ...source.rights!,
          publicRedistribution: true,
          declaredAt: "2026-11-06T01:00:00Z",
        },
      },
    ];
    expect(() =>
      validateSourceRightsTransition(previous, next, place),
    ).not.toThrow();
    expect(
      scenarioForPublication(next, place, next.scenarios[1]).sources![0].rights
        ?.publicRedistribution,
    ).toBe(true);
    const legacy = stripAll(previous, true);
    expect(() =>
      validateSourceRightsTransition(legacy, stripAll(legacy), place),
    ).not.toThrow();
    expect(
      scenarioForPublication(legacy, place, legacy.scenarios[1]).buildingEdits[
        imported().id
      ],
    ).toBeTruthy();
  });
  it("does not let another scenario's public attestation authorize this scenario's retained private input", () => {
    const project = fixture();
    project.scenarios.push({
      ...structuredClone(project.scenarios[1]),
      id: "other",
      sources: [
        {
          ...source,
          rights: { ...source.rights!, publicRedistribution: true },
        },
      ],
    });
    project.scenarios[1].sources = [];
    expect(() =>
      scenarioForPublication(project, place, project.scenarios[1]),
    ).toThrow(/public redistribution permission/i);
  });
  it("does not override a private frozen baseline inventory with scenario-level permission", () => {
    const project = fixture(true);
    expect(() =>
      scenarioForPublication(
        project,
        { ...place, sources: [source] },
        project.scenarios[1],
      ),
    ).toThrow(/public redistribution permission/i);
  });
});

it("does not resolve conflicting current declarations by array order", () => {
  for (const reverse of [false, true]) {
    const project = fixture(),
      scenario = project.scenarios[1];
    scenario.sources!.push({
      ...source,
      rights: { ...source.rights!, publicRedistribution: true },
    });
    if (reverse) scenario.sources!.reverse();
    expect(() => scenarioForPublication(project, place, scenario)).toThrow(
      /public redistribution permission/i,
    );
  }
});

it("rejects source-rights erasure through save→publish HTTP requests without mutating the saved version, while explicit permission remains publishable", async () => {
  const app = await buildApp({
    store: new FileStore(),
    catalog: {
      list: async () => [place],
      get: async () => structuredClone(place),
    },
    nationalPreparationEnabled: false,
  });
  try {
    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        name: "Rights fixture",
        email: "rights-fixture@example.test",
        password: "isolated long source rights fixture password",
      },
    });
    expect(registration.statusCode, registration.body).toBe(201);
    const headers = {
      cookie: `${registration.cookies[0].name}=${registration.cookies[0].value}`,
      "x-csrf-token": registration.json().csrfToken,
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { placeId: place.id },
    });
    expect(created.statusCode, created.body).toBe(201);
    let saved = created.json<{ project: Project; version: number }>();
    const path = `/api/v1/projects/${saved.project.id}`;
    const command = await app.inject({
      method: "POST",
      url: `${path}/scenarios/${saved.project.activeScenarioId}/commands`,
      headers,
      payload: {
        expectedVersion: saved.version,
        expectedRevision: 0,
        command: {
          type: "buildings.import",
          buildings: [imported()],
          source,
          mode: "append",
        },
      },
    });
    expect(command.statusCode, command.body).toBe(200);
    saved = command.json();
    for (const keepSource of [false, true]) {
      const response = await app.inject({
        method: "PUT",
        url: path,
        headers,
        payload: {
          expectedVersion: saved.version,
          project: stripAll(saved.project, keepSource),
        },
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.code).toBe("SOURCE_RIGHTS_REMOVED");
      const retained = await app.inject({ url: path, headers });
      expect(retained.json().version).toBe(saved.version);
      expect(retained.json().project).toEqual(saved.project);
    }
    const publish = async () =>
      app.inject({
        method: "POST",
        url: `${path}/publish`,
        headers,
        payload: {
          scenarioId: saved.project.activeScenarioId,
          expectedVersion: saved.version,
          expectedRevision: saved.project.scenarios.find(
            (s) => s.id === saved.project.activeScenarioId,
          )!.revision,
        },
      });
    const denied = await publish();
    expect(denied.statusCode, denied.body).toBe(422);
    expect(denied.json().error.code).toBe("SOURCE_PUBLICATION_RESTRICTED");
    const omitted = structuredClone(saved.project),
      active = omitted.scenarios.find(
        (s) => s.id === omitted.activeScenarioId,
      )!;
    active.sources = [];
    active.revision++;
    const savedHistory = await app.inject({
      method: "PUT",
      url: path,
      headers,
      payload: { expectedVersion: saved.version, project: omitted },
    });
    expect(savedHistory.statusCode, savedHistory.body).toBe(200);
    saved = savedHistory.json();
    expect((await publish()).statusCode).toBe(422);
    const permitted = stripAll(saved.project),
      current = permitted.scenarios.find(
        (s) => s.id === permitted.activeScenarioId,
      )!;
    current.sources = [
      {
        ...source,
        rights: {
          ...source.rights!,
          publicRedistribution: true,
          declaredBy: registration.json().user.id,
          declaredAt: new Date().toISOString(),
        },
      },
    ];
    const accepted = await app.inject({
      method: "PUT",
      url: path,
      headers,
      payload: { expectedVersion: saved.version, project: permitted },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    saved = accepted.json();
    const published = await publish();
    expect(published.statusCode, published.body).toBe(201);
    const publicSnapshot = await app.inject({
      url: `/api/v1/published/${published.json().id}`,
    });
    expect(publicSnapshot.statusCode, publicSnapshot.body).toBe(200);
    expect(
      publicSnapshot.json().scenario.sources[0].rights.publicRedistribution,
    ).toBe(true);
    expect(publicSnapshot.json().scenario.buildingEdits[imported().id]).toEqual(
      imported(),
    );
  } finally {
    await app.close();
  }
});
