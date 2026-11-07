import { describe, expect, it } from "vitest";
import {
  applyCommand,
  reviewTrafficPlanningRoads,
  baselineIdentity,
  canonicalJSON,
  projectWithImportedTraffic,
  projectWithTrafficVersion,
  trafficContentHash,
  type Project,
  type Scenario,
  type TrafficScenario,
  type Source,
  type HistoryEntry,
} from "@urban/core";
import { trafficScenarioFixture } from "../../../../tests/fixtures/traffic";
import { trafficNetworkFixture } from "../../../../packages/core/src/traffic-fixture";
import { planningProposalMetadata } from "./planning-review";
import { trafficCommuteEvidenceFixture } from "../../../../packages/models/src/traffic-commute-evidence-fixture";
import { buildApp } from "../app";
import { FileStore } from "../store";
import {
  projectTrafficReferences,
  commandTrafficReferences,
  validateTrafficReferences,
  verifyTrafficReferenceIntegrity,
  assertTrafficPublication,
  validateTrafficRightsTransition,
  type TrafficArtifactAuthority,
} from "./references";
const rights = (isPublic: boolean): NonNullable<Source["rights"]> => ({
  version: 1,
  privateUse: true,
  cache: true,
  analyze: true,
  privateDisplay: true,
  export: true,
  historicalRetention: true,
  publicRedistribution: isPublic,
  declaredBy: "fixture-author",
  declaredAt: "2026-11-06T00:00:00Z",
});
async function withRights(traffic: TrafficScenario, isPublic: boolean) {
  const copy = structuredClone(traffic);
  copy.origin = "imported";
  copy.capture.sources.forEach((s) => (s.rights = rights(isPublic)));
  copy.captureHash = await trafficContentHash(copy.capture);
  return copy;
}
function history(before: Scenario, after: Scenario): HistoryEntry {
  return {
    id: "traffic-entry",
    at: "2026-11-06T00:00:00Z",
    actor: "fixture",
    label: "Adopt explicit experiment",
    command: {
      type: "scenario.traffic",
      traffic: structuredClone(after.traffic!),
    },
    before: structuredClone(before),
    after: structuredClone(after),
  };
}

describe("traffic receipt and publication boundaries", () => {
  it("retains commute citation and file permissions in a separate namespace, including imported copies", async () => {
    const sample = await trafficScenarioFixture(),
      { summary } = await trafficCommuteEvidenceFixture();
    const traffic = await withRights(sample.traffic, true);
    traffic.capture.originalDemand.commute = structuredClone(summary);
    const source = traffic.capture.originalDemand.commute.sources[0];
    source.kind = "user-supplied";
    source.rights = rights(false);
    expect(summary.files.every((file) => file.sourceId === source.id)).toBe(
      true,
    );
    const current = { ...sample.scenario, traffic },
      previous = {
        ...sample.project,
        scenarios: [sample.project.scenarios[0], current],
      };
    expect(traffic.origin).toBe("imported");
    // Same-ID native permission cannot override the separate commute citation/files.
    expect(
      traffic.capture.sources.find((s) => s.id === source.id)?.rights
        ?.publicRedistribution,
    ).toBe(true);
    expect(() => assertTrafficPublication(current, previous)).toThrow(
      /without a public/,
    );
    const stripped = structuredClone(previous);
    delete stripped.scenarios[1].traffic!.capture.originalDemand.commute!
      .sources[0].rights;
    expect(() => validateTrafficRightsTransition(previous, stripped)).toThrow(
      /cannot be erased/,
    );
    expect(() =>
      assertTrafficPublication(stripped.scenarios[1], previous),
    ).toThrow(/without a public/);
    const declared = structuredClone(previous);
    declared.scenarios[1].traffic!.capture.originalDemand.commute!.sources[0].rights!.publicRedistribution = true;
    expect(() =>
      validateTrafficRightsTransition(previous, declared),
    ).not.toThrow();
    expect(() =>
      assertTrafficPublication(declared.scenarios[1], previous),
    ).not.toThrow();
  });
  it("keeps private planning correspondence permissions separate from a public same-ID native citation and retains their history", async () => {
    const sample = await trafficScenarioFixture(),
      traffic = await withRights(sample.traffic, true);
    const road = sample.place.roads[0];
    sample.scenario.roadEdits[road.id] = { ...road, speedMph: 35 };
    const reviewed = await reviewTrafficPlanningRoads({
      place: sample.place,
      scenario: sample.scenario,
      network: trafficNetworkFixture(),
      reviews: [
        {
          roadId: road.id,
          properties: ["speed"],
          directions: [{ direction: "with-road", edgeIds: ["in"] }],
          extent: "full-road",
          nativeExtensionAcknowledged: true,
          rationale: "Synthetic reviewed source namespace test.",
        },
      ],
      reviewedBy: "reviewer",
      reviewedAt: "2026-11-06T10:00:00Z",
      sourceDeclarations: [
        {
          sourceId: road.sourceId,
          privateUseConfirmed: true,
          publicRedistribution: false,
          declaredBy: "reviewer",
          declaredAt: "2026-11-06T10:00:00Z",
        },
      ],
    });
    traffic.capture.proposal = {
      overlays: reviewed.overlays,
      planningRoadMapping: planningProposalMetadata(
        { ...reviewed },
        sample.scenario,
      ),
    };
    const current = { ...sample.scenario, traffic },
      previous = {
        ...sample.project,
        scenarios: [sample.project.scenarios[0], current],
      };
    expect(
      traffic.capture.sources.find((source) => source.id === road.sourceId)!
        .rights!.publicRedistribution,
    ).toBe(true);
    expect(() => assertTrafficPublication(current, previous)).toThrow(
      /planning-correspondence/,
    );
    const omitted = structuredClone(previous);
    omitted.scenarios[1].traffic!.capture.proposal.planningRoadMapping.correspondence!.sourceDeclarations =
      [];
    expect(() => validateTrafficRightsTransition(previous, omitted)).toThrow(
      /cannot be erased/,
    );
    expect(() =>
      assertTrafficPublication(omitted.scenarios[1], omitted),
    ).toThrow(/without a public/);
    const explicit = structuredClone(previous);
    explicit.scenarios[1].traffic!.capture.proposal.planningRoadMapping.correspondence!.sourceDeclarations[0].publicRedistribution = true;
    expect(() =>
      validateTrafficRightsTransition(previous, explicit),
    ).not.toThrow();
    expect(() =>
      assertTrafficPublication(explicit.scenarios[1], explicit),
    ).not.toThrow();
  });

  it("requires project-owned exact authoritative content rather than caller-supplied hashes or server-run labels", async () => {
    const { traffic } = await trafficScenarioFixture(),
      id = traffic.receipt.projectId;
    expect(() => validateTrafficReferences([traffic], id, [])).toThrow(
      /retained completed run/,
    );
    const authority: TrafficArtifactAuthority = {
      id: traffic.receipt.captureId,
      projectId: id,
      jobId: traffic.receipt.jobId,
      traffic: structuredClone(traffic),
    };
    expect(() =>
      validateTrafficReferences([traffic], id, [authority]),
    ).not.toThrow();
    for (const bad of [
      { ...traffic, receipt: { ...traffic.receipt, jobId: "other-job" } },
      { ...traffic, receipt: { ...traffic.receipt, projectId: "foreign" } },
      { ...traffic, captureHash: "0".repeat(64) },
    ])
      expect(() => validateTrafficReferences([bad], id, [authority])).toThrow(
        /exactly match/,
      );
    expect(() =>
      validateTrafficReferences([traffic], "foreign", [authority]),
    ).toThrow();
  });
  it("scans current, before/after history, undone and command-only references; null removal is not an authority", async () => {
    const { project, scenario, traffic } = await trafficScenarioFixture(),
      after = applyCommand(scenario, { type: "scenario.traffic", traffic }),
      entry = history(scenario, after);
    const p = {
      ...project,
      scenarios: [project.scenarios[0], after],
      history: [entry],
      undone: [entry],
    };
    expect(projectTrafficReferences(p)).toHaveLength(5);
    expect(
      commandTrafficReferences({ type: "scenario.traffic", traffic: null }),
    ).toEqual([]);
    expect(() =>
      validateTrafficReferences(
        projectTrafficReferences({ ...p, scenarios: project.scenarios }),
        project.id,
        [],
      ),
    ).toThrow();
  });
  it("accepts explicitly imported intact captures but rejects altered hashes, baseline identity, and summary semantics", async () => {
    const { place, traffic } = await trafficScenarioFixture(),
      hash = (await baselineIdentity(place)).sha256,
      imported = { ...traffic, origin: "imported" as const };
    expect(() =>
      validateTrafficReferences([imported], "new-project", []),
    ).not.toThrow();
    await expect(
      verifyTrafficReferenceIntegrity([imported, imported], place, hash),
    ).resolves.toBeUndefined();
    const bytes = structuredClone(imported);
    bytes.capture.privateArchive.bytes++;
    await expect(
      verifyTrafficReferenceIntegrity([bytes], place, hash),
    ).rejects.toMatchObject({ code: "TRAFFIC_EVIDENCE_INVALID" });
    const baseline = structuredClone(imported);
    baseline.binding.baselineHash = "0".repeat(64);
    await expect(
      verifyTrafficReferenceIntegrity([baseline], place, hash),
    ).rejects.toMatchObject({ code: "TRAFFIC_EVIDENCE_INVALID" });
    const nulled = structuredClone(imported);
    nulled.capture.comparison.baseline.meanTravelTimeSeconds = null;
    nulled.captureHash = await trafficContentHash(nulled.capture);
    await expect(
      verifyTrafficReferenceIntegrity([nulled], place, hash),
    ).rejects.toMatchObject({ code: "TRAFFIC_EVIDENCE_INVALID" });
  });
  it("blocks every embedded private source, including unused statements, and allows explicit public declarations", async () => {
    const { scenario, traffic } = await trafficScenarioFixture();
    expect(() => assertTrafficPublication({ ...scenario, traffic })).toThrow(
      /privately supplied/,
    );
    const allowed = await withRights(traffic, true);
    expect(() =>
      assertTrafficPublication({ ...scenario, traffic: allowed }),
    ).not.toThrow();
    allowed.capture.sources.push({
      ...allowed.capture.sources[0],
      id: "unused-private",
      rights: rights(false),
    });
    expect(() =>
      assertTrafficPublication({ ...scenario, traffic: allowed }),
    ).toThrow(/privately supplied/);
    expect(() => assertTrafficPublication(scenario)).not.toThrow();
  });
  it("restored copies retain exact numbers and history while dropping any server execution claim", async () => {
    const { place, project, scenario, traffic } =
        await trafficScenarioFixture(),
      after = applyCommand(scenario, { type: "scenario.traffic", traffic }),
      entry = history(scenario, after),
      original = projectWithTrafficVersion({
        ...project,
        scenarios: [project.scenarios[0], after],
        history: [entry],
        undone: [entry],
      });
    const copy = projectWithImportedTraffic(original);
    copy.id = "restored-project";
    expect(
      projectTrafficReferences(copy).every((v) => v.origin === "imported"),
    ).toBe(true);
    expect(
      projectTrafficReferences(original).every(
        (v) => v.origin === "server-run",
      ),
    ).toBe(true);
    for (const v of projectTrafficReferences(copy)) {
      expect(v.captureHash).toBe(traffic.captureHash);
      expect(canonicalJSON(v.capture)).toBe(canonicalJSON(traffic.capture));
    }
    expect(() =>
      validateTrafficReferences(projectTrafficReferences(copy), copy.id, []),
    ).not.toThrow();
    await expect(
      verifyTrafficReferenceIntegrity(
        projectTrafficReferences(copy),
        place,
        (await baselineIdentity(place)).sha256,
      ),
    ).resolves.toBeUndefined();
  });
  it("keeps historical traffic rights separate from same-ID planning sources, while allowing explicit current traffic attestation", async () => {
    const { place, project, scenario, traffic } =
        await trafficScenarioFixture(),
      privateTraffic = await withRights(traffic, false),
      after = applyCommand(scenario, {
        type: "scenario.traffic",
        traffic: privateTraffic,
      }),
      prior = projectWithTrafficVersion({
        ...project,
        scenarios: [project.scenarios[0], after],
        history: [history(scenario, after)],
      });
    const omitted = structuredClone(prior),
      active = omitted.scenarios[1];
    active.traffic!.capture.sources.forEach((s) => {
      delete s.rights;
      s.kind = "published-estimate";
    });
    active.traffic!.captureHash = await trafficContentHash(
      active.traffic!.capture,
    );
    active.sources = active.traffic!.capture.sources.map((s) => ({
      ...s,
      rights: rights(true),
    }));
    expect(() => validateTrafficRightsTransition(prior, omitted)).not.toThrow();
    expect(() => assertTrafficPublication(active, omitted)).toThrow(
      /privately supplied/,
    );
    omitted.history = [];
    omitted.undone = [];
    expect(() => validateTrafficRightsTransition(prior, omitted)).toThrow(
      /cannot be erased/,
    );
    active.traffic = await withRights(privateTraffic, true);
    expect(() => validateTrafficRightsTransition(prior, omitted)).not.toThrow();
    expect(() => assertTrafficPublication(active, omitted)).not.toThrow();
    await expect(
      verifyTrafficReferenceIntegrity(
        [active.traffic],
        place,
        (await baselineIdentity(place)).sha256,
      ),
    ).resolves.toBeUndefined();
  });
});

async function setup() {
  const fixture = await trafficScenarioFixture(),
    store = new FileStore(),
    app = await buildApp({
      store,
      catalog: {
        list: async () => [fixture.place],
        get: async () => structuredClone(fixture.place),
      },
      nationalPreparationEnabled: false,
    });
  const registration = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name: "Traffic reference fixture",
      email: "traffic-reference@example.test",
      password: "isolated traffic evidence fixture password",
    },
  });
  expect(registration.statusCode, registration.body).toBe(201);
  const headers = {
      cookie: `${registration.cookies[0].name}=${registration.cookies[0].value}`,
      "x-csrf-token": registration.json().csrfToken,
    },
    baselineHash = (await baselineIdentity(fixture.place)).sha256;
  return { ...fixture, app, store, headers, baselineHash };
}
function importedProject(
  project: Project,
  scenario: Scenario,
  traffic: TrafficScenario,
) {
  const after = applyCommand(scenario, { type: "scenario.traffic", traffic });
  return projectWithImportedTraffic(
    projectWithTrafficVersion({
      ...project,
      scenarios: [project.scenarios[0], after],
      history: [history(scenario, after)],
    }),
  );
}

describe("traffic evidence through actual API routes without a completed-job registry", () => {
  it("rejects forged server-run create, command and full/history saves; accepts intact imported restore and refuses private publication", async () => {
    const f = await setup();
    try {
      const serverProject = projectWithTrafficVersion({
        ...f.project,
        scenarios: [
          f.project.scenarios[0],
          applyCommand(f.scenario, {
            type: "scenario.traffic",
            traffic: f.traffic,
          }),
        ],
      });
      const forged = await f.app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: f.headers,
        payload: { project: serverProject, baselineHash: f.baselineHash },
      });
      expect(forged.statusCode, forged.body).toBe(422);
      expect(forged.json().error.code).toBe("TRAFFIC_EVIDENCE_UNVERIFIED");
      const restored = importedProject(
        f.project,
        f.scenario,
        await withRights(f.traffic, false),
      );
      const created = await f.app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: f.headers,
        payload: { project: restored, baselineHash: f.baselineHash },
      });
      expect(created.statusCode, created.body).toBe(201);
      const saved = created.json<{ project: Project; version: number }>(),
        path = `/api/v1/projects/${saved.project.id}`,
        active = saved.project.scenarios[1];
      expect(active.traffic!.origin).toBe("imported");
      expect(
        active.traffic!.capture.comparison.baseline.meanTravelTimeSeconds,
      ).toBe(40);
      const fake = {
        ...f.traffic,
        receipt: { ...f.traffic.receipt, projectId: saved.project.id },
      };
      const command = await f.app.inject({
        method: "POST",
        url: `${path}/scenarios/${active.id}/commands`,
        headers: f.headers,
        payload: {
          expectedVersion: saved.version,
          expectedRevision: active.revision,
          command: { type: "scenario.traffic", traffic: fake },
        },
      });
      expect(command.statusCode, command.body).toBe(422);
      expect(command.json().error.code).toBe("TRAFFIC_EVIDENCE_UNVERIFIED");
      for (const location of [
        "current",
        "history",
        "undone",
        "command",
      ] as const) {
        const project = structuredClone(saved.project);
        project.scenarios[1].revision++;
        if (location === "current") project.scenarios[1].traffic = fake;
        if (location === "history") project.history[0].after.traffic = fake;
        if (location === "undone") {
          project.undone = [structuredClone(project.history[0])];
          project.undone[0].after.traffic = fake;
        }
        if (location === "command")
          project.history[0].command = {
            type: "scenario.traffic",
            traffic: fake,
          };
        const result = await f.app.inject({
          method: "PUT",
          url: path,
          headers: f.headers,
          payload: {
            expectedVersion: saved.version,
            project,
            baselineHash: f.baselineHash,
          },
        });
        expect(result.statusCode, result.body).toBe(422);
        expect(result.json().error.code).toBe("TRAFFIC_EVIDENCE_UNVERIFIED");
      }
      const publish = await f.app.inject({
        method: "POST",
        url: `${path}/publish`,
        headers: f.headers,
        payload: {
          scenarioId: active.id,
          expectedVersion: saved.version,
          expectedRevision: active.revision,
        },
      });
      expect(publish.statusCode, publish.body).toBe(422);
      expect(publish.json().error.code).toBe("TRAFFIC_PUBLICATION_RESTRICTED");
      const retained = await f.app.inject({ url: path, headers: f.headers });
      expect(retained.json().version).toBe(saved.version);
      expect(retained.json().project).toEqual(saved.project);
    } finally {
      await f.app.close();
    }
  });
  it("rejects imported hash/baseline tampering through create and command rather than trusting imported labels", async () => {
    const f = await setup();
    try {
      const changed = await withRights(f.traffic, true);
      changed.capture.privateArchive.bytes++;
      const invalid = importedProject(f.project, f.scenario, changed),
        create = await f.app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: f.headers,
          payload: { project: invalid, baselineHash: f.baselineHash },
        });
      expect(create.statusCode, create.body).toBe(422);
      expect(create.json().error.code).toBe("TRAFFIC_EVIDENCE_INVALID");
      const created = await f.app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: f.headers,
        payload: { placeId: f.place.id },
      });
      expect(created.statusCode).toBe(201);
      const saved = created.json<{ project: Project; version: number }>();
      const value = await withRights(f.traffic, true);
      value.binding.baselineHash = "0".repeat(64);
      const response = await f.app.inject({
        method: "POST",
        url: `/api/v1/projects/${saved.project.id}/scenarios/${saved.project.activeScenarioId}/commands`,
        headers: f.headers,
        payload: {
          expectedVersion: saved.version,
          expectedRevision: 0,
          command: { type: "scenario.traffic", traffic: value },
        },
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.code).toBe("TRAFFIC_EVIDENCE_INVALID");
    } finally {
      await f.app.close();
    }
  });
  it("cannot erase an already saved private capture declaration by rewriting every historical copy before publishing", async () => {
    const f = await setup();
    try {
      const restored = importedProject(
          f.project,
          f.scenario,
          await withRights(f.traffic, false),
        ),
        created = await f.app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: f.headers,
          payload: { project: restored, baselineHash: f.baselineHash },
        });
      expect(created.statusCode, created.body).toBe(201);
      const saved = created.json<{ project: Project; version: number }>(),
        next = structuredClone(saved.project);
      next.history = [];
      next.undone = [];
      const active = next.scenarios[1];
      active.revision++;
      active.traffic!.capture.sources.forEach((source) => {
        delete source.rights;
        source.kind = "published-estimate";
      });
      active.traffic!.captureHash = await trafficContentHash(
        active.traffic!.capture,
      );
      const response = await f.app.inject({
        method: "PUT",
        url: `/api/v1/projects/${saved.project.id}`,
        headers: f.headers,
        payload: {
          expectedVersion: saved.version,
          project: next,
          baselineHash: f.baselineHash,
        },
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error.code).toMatch(/RIGHTS/);
      const retained = await f.app.inject({
        url: `/api/v1/projects/${saved.project.id}`,
        headers: f.headers,
      });
      expect(retained.json().version).toBe(saved.version);
      expect(retained.json().project).toEqual(saved.project);
      // Retaining private history permits ordinary edits, but cannot authorize publication.
      next.history = structuredClone(saved.project.history);
      const held = await f.app.inject({
        method: "PUT",
        url: `/api/v1/projects/${saved.project.id}`,
        headers: f.headers,
        payload: {
          expectedVersion: saved.version,
          project: next,
          baselineHash: f.baselineHash,
        },
      });
      expect(held.statusCode, held.body).toBe(200);
      const heldSaved = held.json<{ project: Project; version: number }>(),
        heldActive = heldSaved.project.scenarios[1];
      const denied = await f.app.inject({
        method: "POST",
        url: `/api/v1/projects/${saved.project.id}/publish`,
        headers: f.headers,
        payload: {
          scenarioId: heldActive.id,
          expectedVersion: heldSaved.version,
          expectedRevision: heldActive.revision,
        },
      });
      expect(denied.statusCode, denied.body).toBe(422);
      expect(denied.json().error.code).toBe("TRAFFIC_PUBLICATION_RESTRICTED");
      // A new explicit current permission attestation is a reviewable action, not erasure.
      heldActive.traffic = await withRights(heldActive.traffic!, true);
      heldActive.revision++;
      const attested = await f.app.inject({
        method: "PUT",
        url: `/api/v1/projects/${saved.project.id}`,
        headers: f.headers,
        payload: {
          expectedVersion: heldSaved.version,
          project: heldSaved.project,
          baselineHash: f.baselineHash,
        },
      });
      expect(attested.statusCode, attested.body).toBe(200);
      const attestedSaved = attested.json<{
        project: Project;
        version: number;
      }>();
      const published = await f.app.inject({
        method: "POST",
        url: `/api/v1/projects/${saved.project.id}/publish`,
        headers: f.headers,
        payload: {
          scenarioId: heldActive.id,
          expectedVersion: attestedSaved.version,
          expectedRevision: heldActive.revision,
        },
      });
      expect(published.statusCode, published.body).toBe(201);
      const publicSnapshot = await f.app.inject({
        url: `/api/v1/published/${published.json().id}`,
      });
      expect(publicSnapshot.statusCode).toBe(200);
      expect(publicSnapshot.json().scenario.traffic.origin).toBe("imported");
      expect(
        publicSnapshot.json().scenario.traffic.capture.comparison.baseline
          .meanTravelTimeSeconds,
      ).toBe(40);
    } finally {
      await f.app.close();
    }
  });
});
