import { randomUUID } from "node:crypto";
import { accessibilityFixture } from "../../../tests/fixtures/accessibility.js";
import { accessibilityContentHash } from "@urban/core";
import { fiscalLibraryPage } from "./fiscal-library.js";
import { tokenHash } from "./security.js";
import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "./store.js";
import { buildApp } from "./app.js";
import { fiscalApiFixture } from "./fiscal-test-fixture.js";
import { fiscalContentHash } from "@urban/core";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup(publicRedistribution = true) {
  const f = fiscalApiFixture(publicRedistribution),
    dir = await mkdtemp(join(tmpdir(), "fiscal-api-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore(join(dir, "state.json")),
    app = await buildApp({
      store,
      nationalPreparationEnabled: false,
      catalog: { list: async () => [f.place], get: async () => f.place },
    });
  cleanup.push(() => app.close());
  const register = async (email: string) => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        name: "Fiscal fixture",
        email,
        password: "synthetic fiscal password",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return {
      headers: {
        cookie: `${r.cookies[0].name}=${r.cookies[0].value}`,
        "x-csrf-token": r.json().csrfToken,
      },
      user: r.json().user,
    };
  };
  const owner = await register("owner@fiscal.test");
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { placeId: f.place.id },
  });
  expect(created.statusCode, created.body).toBe(201);
  return { ...f, app, store, owner, register, saved: created.json() };
}
const library = "/api/v1/fiscal-profiles";
async function saveProfile(
  f: Awaited<ReturnType<typeof setup>>,
  key = "fiscal-profile-first",
) {
  const r = await f.app.inject({
    method: "POST",
    url: library,
    headers: f.owner.headers,
    payload: { profile: f.profile, idempotencyKey: key },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
function studyInput(
  f: Awaited<ReturnType<typeof setup>>,
  versionId: string,
  key = "fiscal-study-first",
) {
  return {
    scenarioId: f.saved.project.activeScenarioId,
    expectedVersion: 1,
    expectedRevision: 0,
    name: "Independent fiscal case",
    libraryVersionId: versionId,
    applicabilityNotes:
      "Synthetic reviewed geography and taxable assessed-value compatibility.",
    idempotencyKey: key,
  };
}
describe("immutable fiscal library and new studies", () => {
  it("versions exact private profiles with CAS and complete scoped reads", async () => {
    const f = await setup(),
      first = await saveProfile(f);
    expect((await saveProfile(f)).version.id).toBe(first.version.id);
    const input = {
      profile: { ...f.profile, name: "Changed authored profile" },
      profileId: first.version.profileId,
      expectedLatestVersionId: first.version.id,
      idempotencyKey: "fiscal-profile-next",
    };
    const second = await f.app.inject({
      method: "POST",
      url: library,
      headers: f.owner.headers,
      payload: input,
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().version.version).toBe(2);
    const conflict = await f.app.inject({
      method: "POST",
      url: library,
      headers: f.owner.headers,
      payload: { ...input, idempotencyKey: "fiscal-profile-stale" },
    });
    expect(conflict.statusCode).toBe(409);
    const list = await f.app.inject({ url: library, headers: f.owner.headers });
    expect(list.json().profiles).toHaveLength(1);
    expect(list.json().profiles[0].version).toBe(2);
    expect(list.json().profiles[0].profile).toBeUndefined();
    const history = await f.app.inject({
      url: `${library}/${first.version.profileId}/versions`,
      headers: f.owner.headers,
    });
    expect(history.json().profiles).toHaveLength(2);
    const exact = await f.app.inject({
      url: `${library}/${first.version.profileId}/versions/${first.version.id}`,
      headers: f.owner.headers,
    });
    expect(exact.json().profile).toEqual(first.profile);
    expect(first.profile.sources[0].rights.declaredBy).toBe(f.owner.user.id);
    const outsider = await f.register("outsider@fiscal.test");
    expect(
      (await f.app.inject({ url: library, headers: outsider.headers })).json()
        .profiles,
    ).toEqual([]);
    expect(
      (
        await f.app.inject({
          url: `${library}/${first.version.profileId}/versions/${first.version.id}`,
          headers: outsider.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect((await f.app.inject({ url: library })).statusCode).toBe(401);
    await expect(
      f.store.transaction((s) => {
        s.fiscalProfiles[0].profile.name = "Tampered";
      }),
    ).rejects.toThrow(/immutable/);
  });
  it("creates a separate frozen study, preserves source, replays exact keys and exports/publicizes same profile", async () => {
    const f = await setup(),
      profile = await saveProfile(f),
      sourceHash = fiscalContentHash(f.saved.project),
      input = studyInput(f, profile.version.id),
      url = `/api/v1/projects/${f.saved.project.id}/fiscal-studies`;
    const r = await f.app.inject({
      method: "POST",
      url,
      headers: f.owner.headers,
      payload: input,
    });
    expect(r.statusCode, r.body).toBe(201);
    const saved = r.json();
    expect(saved.project.id).not.toBe(f.saved.project.id);
    expect(saved.version).toBe(1);
    expect(saved.project.history).toEqual([]);
    expect(saved.project.fiscalStudy.profile).toEqual(profile.profile);
    expect(saved.project.fiscalStudy.lineage.projectHash).toBe(sourceHash);
    const replay = await f.app.inject({
      method: "POST",
      url,
      headers: f.owner.headers,
      payload: input,
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().project.id).toBe(saved.project.id);
    const source = await f.app.inject({
      url: `/api/v1/projects/${f.saved.project.id}`,
      headers: f.owner.headers,
    });
    expect(fiscalContentHash(source.json().project)).toBe(sourceHash);
    const metrics = await f.app.inject({
      url: `/api/v1/projects/${saved.project.id}/metrics?scenarioId=${saved.project.activeScenarioId}`,
      headers: f.owner.headers,
    });
    expect(metrics.statusCode, metrics.body).toBe(200);
    expect(metrics.json().fiscal.profileHash).toBe(
      saved.project.fiscalStudy.profileHash,
    );
    const csv = await f.app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?scenarioId=${saved.project.activeScenarioId}&format=fiscal-csv`,
      headers: f.owner.headers,
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain(saved.project.fiscalStudy.profileHash);
    const published = await f.app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/publish`,
      headers: f.owner.headers,
      payload: {
        scenarioId: saved.project.activeScenarioId,
        expectedRevision: 0,
      },
    });
    expect(published.statusCode, published.body).toBe(201);
    const publicView = await f.app.inject({
      url: `/api/v1/published/${published.json().id}`,
    });
    expect(publicView.statusCode, publicView.body).toBe(200);
    expect(publicView.json().fiscalStudy).toEqual(saved.project.fiscalStudy);
    const changed = structuredClone(saved.project);
    changed.fiscalStudy.profile.name = "A forged replacement";
    const invalid = await f.app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: f.owner.headers,
      payload: { project: changed, expectedVersion: 1 },
    });
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
    const keyConflict = await f.app.inject({
      method: "POST",
      url,
      headers: f.owner.headers,
      payload: { ...input, name: "Changed key input" },
    });
    expect(keyConflict.statusCode).toBe(409);
  });
  it("keeps private fiscal evidence out of publication and requires explicit admission permissions", async () => {
    const f = await setup(false);
    const missing = structuredClone(f.profile);
    delete missing.sources[0].rights;
    const denied = await f.app.inject({
      method: "POST",
      url: library,
      headers: f.owner.headers,
      payload: { profile: missing, idempotencyKey: "missing-fiscal-rights" },
    });
    expect(denied.statusCode, denied.body).toBe(422);
    const p = await saveProfile(f);
    const r = await f.app.inject({
      method: "POST",
      url: `/api/v1/projects/${f.saved.project.id}/fiscal-studies`,
      headers: f.owner.headers,
      payload: studyInput(f, p.version.id),
    });
    expect(r.statusCode, r.body).toBe(201);
    const saved = r.json();
    const pub = await f.app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/publish`,
      headers: f.owner.headers,
      payload: {
        scenarioId: saved.project.activeScenarioId,
        expectedRevision: 0,
      },
    });
    expect(pub.statusCode, pub.body).toBe(422);
    expect(pub.json().error.code).toBe("FISCAL_PUBLICATION_RESTRICTED");
  });
});

describe("fiscal copy permissions and library history", () => {
  it("copies private captured accessibility as imported without losing its rights or original evidence", async () => {
    const f = await setup(),
      a = await accessibilityFixture({
        place: f.place,
        receipt: {
          projectId: f.saved.project.id,
          jobId: "synthetic-retained-job",
        },
      });
    a.evidence.capture.sources[0].rights = {
      ...f.profile.sources[0].rights!,
      publicRedistribution: false,
    };
    a.evidence.captureHash = await accessibilityContentHash(a.evidence.capture);
    // Test-only operator seed of a previously captured source. No native run is represented.
    await f.store.transaction((s) => {
      const p = s.projects.find((p) => p.project.id === f.saved.project.id)!,
        at = new Date().toISOString(),
        artifactId = "synthetic-retained-artifact";
      s.accessibilityJobs.push({
        id: a.evidence.receipt.jobId,
        projectId: p.project.id,
        organizationId: p.organizationId,
        userId: f.owner.user.id,
        scenarioId: p.project.activeScenarioId,
        projectVersion: 1,
        scenarioRevision: 0,
        placeId: f.place.id,
        baselineHash: a.evidence.binding.baselineHash,
        request: a.run.request,
        sourceIdentity: {
          jobsPackHash: a.run.jobsPackHash,
          boundaryHash: a.run.sourceCoverage.boundaryHash!,
          manifestId: a.run.network.id,
          graphHash: a.run.network.graphHash,
          profileHash: a.run.network.profileHash,
          methodVersion: "accessibility-1.0.0",
        },
        queryHash: "a".repeat(64),
        idempotencyKey: "retained-fixture",
        requestKeys: ["retained-fixture"],
        version: 1,
        status: "completed",
        stage: "complete",
        progress: 100,
        attempt: 0,
        attempts: [],
        cancelRequested: false,
        createdAt: at,
        updatedAt: at,
        result: {
          artifactId,
          captureHash: a.evidence.captureHash,
          resultHash: a.evidence.capture.resultHash,
          inputHash: a.evidence.capture.inputHash,
        },
      });
      s.accessibilityArtifacts.push({
        id: artifactId,
        organizationId: p.organizationId,
        projectId: p.project.id,
        scenarioId: p.project.activeScenarioId,
        jobId: a.evidence.receipt.jobId,
        createdAt: at,
        accessibility: a.evidence,
        contour: a.artifact.contour,
        siteSnapMeters: 0,
        rawFileHash: a.evidence.capture.artifactHash,
        rawFileBytes: 1000,
      });
    });
    await f.store.transaction((s) => {
      const p = s.projects.find((p) => p.project.id === f.saved.project.id)!;
      p.project.scenarios.find(
        (s) => s.id === p.project.activeScenarioId,
      )!.accessibility = { version: 1, captures: { car: a.evidence } };
      p.project.schemaVersion = 10;
      p.version++;
    });
    const before = await f.store.read((s) =>
      structuredClone(
        s.projects.find((p) => p.project.id === f.saved.project.id)!.project,
      ),
    );
    const p = await saveProfile(f),
      r = await f.app.inject({
        method: "POST",
        url: `/api/v1/projects/${f.saved.project.id}/fiscal-studies`,
        headers: f.owner.headers,
        payload: { ...studyInput(f, p.version.id), expectedVersion: 2 },
      });
    expect(r.statusCode, r.body).toBe(201);
    const created = r.json(),
      scenario = created.project.scenarios.find(
        (s: { id: string }) => s.id === created.project.activeScenarioId,
      );
    expect(scenario.accessibility.captures.car.origin).toBe("imported");
    expect(scenario.accessibility.captures.car.capture).toEqual(
      a.evidence.capture,
    );
    expect(created.project.history).toEqual([]);
    const after = await f.store.read(
      (s) =>
        s.projects.find((p) => p.project.id === f.saved.project.id)!.project,
    );
    expect(after).toEqual(before);
    expect(created.project.fiscalStudy.lineage.projectHash).toBe(
      fiscalContentHash(before),
    );
    const pub = await f.app.inject({
      method: "POST",
      url: `/api/v1/projects/${created.project.id}/publish`,
      headers: f.owner.headers,
      payload: { scenarioId: scenario.id, expectedRevision: 0 },
    });
    expect(pub.statusCode, pub.body).toBe(422);
    expect(pub.json().error.code).toBe("ACCESSIBILITY_PUBLICATION_RESTRICTED");
    const get = await f.app.inject({
      url: `/api/v1/projects/${created.project.id}`,
      headers: f.owner.headers,
    });
    expect(get.json().project.fiscalStudy).toEqual(created.project.fiscalStudy);
    const csv = await f.app.inject({
      url: `/api/v1/projects/${created.project.id}/exports?scenarioId=${scenario.id}&format=fiscal-csv`,
      headers: f.owner.headers,
    });
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain(created.project.fiscalStudy.profileHash);
  });
  it("stamps inline attestation once, rejects stale source and preserves separate export permissions", async () => {
    const f = await setup();
    f.profile.sources[0].rights!.export = false;
    const input = {
      scenarioId: f.saved.project.activeScenarioId,
      expectedVersion: 1,
      expectedRevision: 0,
      name: "Private inline case",
      profile: f.profile,
      applicabilityNotes: "Synthetic private local applicability review.",
      idempotencyKey: "inline-fiscal-study",
    };
    const url = `/api/v1/projects/${f.saved.project.id}/fiscal-studies`;
    const stale = await f.app.inject({
      method: "POST",
      url,
      headers: f.owner.headers,
      payload: { ...input, expectedRevision: 1 },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const r = await f.app.inject({
      method: "POST",
      url,
      headers: f.owner.headers,
      payload: input,
    });
    expect(r.statusCode, r.body).toBe(201);
    const study = r.json().project;
    expect(study.fiscalStudy.profile.sources[0].rights.declaredBy).toBe(
      f.owner.user.id,
    );
    expect(study.fiscalStudy.applicability.reviewedBy).toBe(f.owner.user.id);
    const replay = await f.app.inject({
      method: "POST",
      url,
      headers: f.owner.headers,
      payload: input,
    });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().project).toEqual(study);
    const csv = await f.app.inject({
      url: `/api/v1/projects/${study.id}/exports?scenarioId=${study.activeScenarioId}&format=fiscal-csv`,
      headers: f.owner.headers,
    });
    expect(csv.statusCode, csv.body).toBe(422);
    expect(csv.json().error.code).toBe("FISCAL_EXPORT_RESTRICTED");
    const raw = await f.store.read((s) =>
      structuredClone(s.fiscalStudyCreations[0]),
    );
    const sessionHash = tokenHash(f.owner.headers.cookie.split("=")[1]);
    await expect(
      f.store.transaction(
        (s) => s.fiscalStudyCreations.push({ ...raw, id: randomUUID() }),
        { auth: { sessionHash }, fiscalStudyCreations: { append: true } },
      ),
    ).rejects.toThrow(/new project|receipt|replayed/);
  });
  it("pages every retained version with tied timestamps and rejects cross-family and malformed cursors", async () => {
    const f = await setup(),
      first = await saveProfile(f);
    let latest = first.version.id;
    for (let i = 2; i <= 53; i++) {
      const r = await f.app.inject({
        method: "POST",
        url: library,
        headers: f.owner.headers,
        payload: {
          profile: { ...f.profile, name: `Authored profile ${i}` },
          profileId: first.version.profileId,
          expectedLatestVersionId: latest,
          idempotencyKey: `profile-history-${i}`,
        },
      });
      expect(r.statusCode, r.body).toBe(201);
      latest = r.json().version.id;
    }
    const url = `${library}/${first.version.profileId}/versions`,
      page1 = await f.app.inject({ url, headers: f.owner.headers }),
      page2 = await f.app.inject({
        url: `${url}?cursor=${page1.json().nextCursor}`,
        headers: f.owner.headers,
      });
    expect(page1.json().profiles).toHaveLength(50);
    expect(page2.json().profiles).toHaveLength(3);
    expect(page2.json().nextCursor).toBeNull();
    expect(
      new Set(
        [...page1.json().profiles, ...page2.json().profiles].map((p) => p.id),
      ).size,
    ).toBe(53);
    const invalid = await f.app.inject({
      url: `${library}?cursor=${page1.json().nextCursor}`,
      headers: f.owner.headers,
    });
    expect(invalid.statusCode).toBe(422);
    expect(
      (
        await f.app.inject({
          url: `${url}?cursor=%%%`,
          headers: f.owner.headers,
        })
      ).statusCode,
    ).toBe(422);
    const rows = await f.store.read((s) =>
        s.fiscalProfiles.map((p) => ({
          ...p,
          createdAt: "2026-11-06T00:00:00.000Z",
        })),
      ),
      org = rows[0].organizationId;
    const a = fiscalLibraryPage(rows, org, {}, first.version.profileId),
      b = fiscalLibraryPage(
        rows,
        org,
        { cursor: a.nextCursor },
        first.version.profileId,
      );
    expect(new Set([...a.profiles, ...b.profiles].map((p) => p.id)).size).toBe(
      53,
    );
  });
});

it("documents the fiscal library, study and CSV contracts in OpenAPI", async () => {
  const f = await setup();
  const response = await f.app.inject({ url: "/api/v1/openapi.json" });
  expect(response.statusCode, response.body).toBe(200);
  const spec = response.json();
  expect(spec.paths["/fiscal-profiles"].post.responses["201"]).toBeDefined();
  expect(
    spec.paths["/projects/{projectId}/fiscal-studies"].post.requestBody,
  ).toBeDefined();
});
