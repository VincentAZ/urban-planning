import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { baselineIdentity, type Place } from "@urban/core";
import { buildApp } from "./app.js";
import { FileStore, type DataState, type Store } from "./store.js";
import type { StoreScope } from "./store-scope.js";

const place: Place = {
  id: "scope-fixture",
  name: "Scoped source",
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
  extentLabel: "Scoped test fixture",
};
/** Runtime requests must declare indexed scope; trusted full-mode is reserved for migration/test seeding. */
class ScopedOnlyStore implements Store {
  readonly kind = "memory" as const;
  constructor(readonly managesMembershipPruning = false) {}
  readonly calls: { kind: "read" | "transaction"; scope: StoreScope }[] = [];
  private backing = new FileStore();
  private record(kind: "read" | "transaction", scope?: StoreScope) {
    if (!scope) throw new Error("Runtime used unscoped storage.");
    if (
      Object.entries(scope).some(
        ([name, selection]) =>
          selection &&
          typeof selection === "object" &&
          "all" in selection &&
          // Identity admission inspects only encrypted-mail metadata to enforce global queue limits.
          !(
            name === "identityOutboxHeaders" &&
            scope.security?.mode === "auth" &&
            [
              "challenge-issue",
              "challenge-consume",
              "password-change",
              "invitation-manage",
            ].includes(scope.security.purpose)
          ),
      )
    )
      throw new Error("Runtime used a full collection scan.");
    this.calls.push({ kind, scope: structuredClone(scope) });
    return scope;
  }
  read<T>(operation: (state: DataState) => T, scope?: StoreScope) {
    return this.backing.read(operation, this.record("read", scope));
  }
  transaction<T>(operation: (state: DataState) => T, scope?: StoreScope) {
    return this.backing.transaction(
      operation,
      this.record("transaction", scope),
    );
  }
  close() {
    return this.backing.close();
  }
}
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup(managesMembershipPruning = false) {
  const store = new ScopedOnlyStore(managesMembershipPruning);
  const mail = new FixtureIdentityMail();
  const app = await buildApp({
    store,
    identityMail: mail,
    catalog: { get: async () => place, list: async () => [place] },
    nationalPreparationEnabled: false,
  });
  attachIdentityTestMail(app, mail);
  apps.push(app);
  const register = async (name: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        name,
        email: `${name}@example.com`,
        password: "a scoped storage password",
      },
    });
    expect(response.statusCode).toBe(201);
    return {
      email: `${name}@example.com`,
      user: response.json().user,
      organization: response.json().organization,
      headers: {
        cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
        "x-csrf-token": response.json().csrfToken,
      },
    };
  };
  const owner = await register("owner");
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { placeId: place.id },
  });
  expect(created.statusCode).toBe(201);
  return { app, store, owner, register, created: created.json() };
}

describe("explicit main API storage scopes", () => {
  it("rejects ordinary accounts before trying to hydrate the RLS-hidden budget singleton", async () => {
    const s = await setup();
    for (const [method, url] of [
      ["GET", "/api/v1/admin/budget"],
      ["PATCH", "/api/v1/admin/budget"],
      ["POST", "/api/v1/admin/budget/adjustments"],
    ] as const) {
      s.store.calls.length = 0;
      const response = await s.app.inject({
        method,
        url,
        headers: s.owner.headers,
        ...(method === "GET" ? {} : { payload: {} }),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("PLATFORM_ADMIN_REQUIRED");
      expect(s.store.calls).toEqual([
        { kind: "read", scope: { auth: { sessionHash: expect.any(String) } } },
      ]);
    }
  });

  it("uses separate credential/bootstrap contexts and never promotes selected user IDs into normal request authority", async () => {
    const s = await setup();
    expect(s.store.calls[0].scope.security).toEqual({
      mode: "auth",
      purpose: "register",
      email: "owner@example.com",
      userId: s.owner.user.id,
      organizationId: s.owner.organization.id,
      sessionHash: expect.any(String),
    });
    s.store.calls.length = 0;
    const login = await s.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "owner@example.com",
        password: "a scoped storage password",
      },
    });
    expect(login.statusCode).toBe(200);
    expect(s.store.calls.map((call) => call.scope.security)).toEqual([
      { mode: "auth", purpose: "lookup", email: "owner@example.com" },
      {
        mode: "auth",
        purpose: "login",
        credentialVersion: 0,
        email: "owner@example.com",
        userId: s.owner.user.id,
        sessionHash: expect.any(String),
      },
    ]);
    expect(s.store.calls[1].scope.auth).toEqual({ userId: s.owner.user.id });
    s.store.calls.length = 0;
    await s.app.inject({
      url: "/api/v1/auth/session",
      headers: s.owner.headers,
    });
    expect(s.store.calls[0].scope.security).toBeUndefined();
    expect(s.store.calls[0].scope.auth).toEqual({
      sessionHash: expect.any(String),
    });
  });

  it("supplies validated membership targets while leaving foreign-session pruning to capable database adapters", async () => {
    const s = await setup(true),
      recipient = await s.register("recipient");
    const base = `/api/v1/projects/${s.created.project.id}/members`;
    s.store.calls.length = 0;
    const granted = await acceptIdentityTestInvitation(
      s.app,
      s.owner,
      recipient,
      "viewer",
      s.created.project.id,
    );
    expect(granted.aclVersion).toBe(2);
    const management = s.store.calls.find(
      (call) =>
        call.kind === "transaction" &&
        call.scope.security?.mode === "auth" &&
        call.scope.security.purpose === "invitation-manage",
    )!.scope;
    expect(management).toMatchObject({
      projectId: s.created.project.id,
      security: {
        mode: "auth",
        purpose: "invitation-manage",
        userId: s.owner.user.id,
        email: s.owner.email,
      },
    });
    expect(management.projectHeaders).toEqual({
      where: [
        {
          id: s.created.project.id,
          organizationId: { auth: "organizationId" },
        },
      ],
    });
    expect(management.identityInvitations).toEqual({
      where: [
        {
          organizationId: { auth: "organizationId" },
          projectId: s.created.project.id,
        },
      ],
    });
    expect(management.identityOutbox).toEqual({ append: true });
    expect(management.projects).toBeUndefined();
    const acceptance = s.store.calls.find(
      (call) =>
        call.kind === "transaction" &&
        call.scope.security?.mode === "auth" &&
        call.scope.security.purpose === "invitation-accept",
    )!.scope;
    expect(acceptance.security).toEqual({
      mode: "auth",
      purpose: "invitation-accept",
      email: recipient.email,
      userId: recipient.user.id,
      invitationId: expect.any(String),
      invitationVersion: 1,
      tokenHash: expect.any(String),
    });
    expect(acceptance.auth).toEqual({ sessionHash: expect.any(String) });
    expect(acceptance.projectHeaders).toEqual({
      where: [
        { id: s.created.project.id, organizationId: s.owner.organization.id },
      ],
    });
    expect(acceptance.projects).toBeUndefined();
    s.store.calls.length = 0;
    const removed = await s.app.inject({
      method: "DELETE",
      url: `${base}/${recipient.user.id}`,
      headers: s.owner.headers,
      payload: { expectedAclVersion: 2 },
    });
    expect(removed.statusCode).toBe(200);
    const scope = s.store.calls[0].scope;
    expect(scope.projectHeaders).toEqual({
      where: [
        {
          id: s.created.project.id,
          organizationId: { auth: "organizationId" },
        },
      ],
    });
    expect(scope.memberships).toEqual({
      where: [{ organizationId: { auth: "organizationId" } }],
    });
    expect(scope.sessions).toBeUndefined();
    // This probe verifies only adapter selection; real SQL trigger behavior has separate integration coverage.
  });

  it("auth, project list and access use headers; loading, publication and records retain exact scoped behavior", async () => {
    const s = await setup();
    const projectId = s.created.project.id;
    const url = `/api/v1/projects/${projectId}`;
    s.store.calls.length = 0;
    expect(
      (
        await s.app.inject({
          url: "/api/v1/auth/session",
          headers: s.owner.headers,
        })
      ).json().user.id,
    ).toBe(s.owner.user.id);
    expect(s.store.calls).toHaveLength(1);
    expect(s.store.calls[0].scope).toEqual({
      auth: { sessionHash: expect.any(String) },
    });
    s.store.calls.length = 0;
    const listed = await s.app.inject({
      url: "/api/v1/projects",
      headers: s.owner.headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().projects).toHaveLength(1);
    expect(s.store.calls[0].scope.projectHeaders).toBeDefined();
    expect(s.store.calls[0].scope.projects).toBeUndefined();
    s.store.calls.length = 0;
    expect(
      (await s.app.inject({ url: `${url}/access`, headers: s.owner.headers }))
        .statusCode,
    ).toBe(200);
    expect(s.store.calls[0].scope.projectHeaders).toBeDefined();
    expect(s.store.calls[0].scope.projects).toBeUndefined();
    s.store.calls.length = 0;
    const loaded = await s.app.inject({ url, headers: s.owner.headers });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().baseline).toEqual(place);
    expect(s.store.calls[0].scope.projects).toEqual({
      where: [{ id: projectId, organizationId: { auth: "organizationId" } }],
    });
    const scenario = s.created.project.scenarios.find(
      (p: { id: string }) => p.id === s.created.project.activeScenarioId,
    );
    const published = await s.app.inject({
      method: "POST",
      url: `${url}/publish`,
      headers: s.owner.headers,
      payload: {
        scenarioId: scenario.id,
        expectedRevision: scenario.revision,
        feedbackEnabled: true,
      },
    });
    expect(published.statusCode).toBe(201);
    const snapshotId = published.json().id;
    s.store.calls.length = 0;
    expect(
      (await s.app.inject(`/api/v1/published/${snapshotId}`)).json().place,
    ).toEqual(place);
    expect(s.store.calls[0].scope.publicSnapshotId).toBe(snapshotId);
    expect(s.store.calls[0].scope.security).toBeUndefined();
    s.store.calls.length = 0;
    expect(
      (await s.app.inject(`/api/v1/published/${snapshotId}/engagement`))
        .statusCode,
    ).toBe(200);
    expect(s.store.calls[0].scope.publicSnapshotId).toBe(snapshotId);
    s.store.calls.length = 0;
    const records = await s.app.inject({
      url: `${url}/exports?format=records`,
      headers: s.owner.headers,
    });
    expect(records.statusCode).toBe(200);
    expect(records.json().baseline).toEqual(place);
    expect(records.json().engagement).toHaveLength(1);
    expect(s.store.calls).toHaveLength(1);
    expect(s.store.calls[0].scope.published).toBeUndefined();
    expect(s.store.calls[0].scope.publishedHeaders).toBeDefined();
    const revoked = await s.app.inject({
      method: "DELETE",
      url: `/api/v1/published/${snapshotId}`,
      headers: s.owner.headers,
    });
    expect(revoked.statusCode).toBe(200);
    expect(
      (await s.app.inject(`/api/v1/published/${snapshotId}`)).statusCode,
    ).toBe(404);
    expect(
      (
        await s.app.inject({
          url: `${url}/engagement/${snapshotId}`,
          headers: s.owner.headers,
        })
      ).json().snapshot.revokedAt,
    ).toBeDefined();
  });

  it("allocates cloud IDs without reading another tenant's project payload", async () => {
    const s = await setup();
    const second = await s.register("second");
    const hash = await baselineIdentity(place);
    s.store.calls.length = 0;
    const created = await s.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: second.headers,
      payload: { project: s.created.project, baselineHash: hash.sha256 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().project.id).not.toBe(s.created.project.id);
    const transaction = s.store.calls.find(
      (call) => call.kind === "transaction",
    )!;
    expect(transaction.scope.projectHeaders).toBeUndefined();
    expect(transaction.scope.projects).toEqual({ append: true });
    const inaccessible = await s.app.inject({
      url: `/api/v1/projects/${s.created.project.id}`,
      headers: second.headers,
    });
    expect(inaccessible.statusCode).toBe(404);
    const listed = await s.app.inject({
      url: "/api/v1/projects",
      headers: second.headers,
    });
    expect(
      listed
        .json()
        .projects.map((p: { project: { id: string } }) => p.project.id),
    ).toEqual([created.json().project.id]);
    expect(
      (
        await s.app.inject({
          url: `/api/v1/projects/${s.created.project.id}`,
          headers: s.owner.headers,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("restores a deleted draft under a fresh cloud ID without attaching retained reviews, publications or audit", async () => {
    const s = await setup();
    const original = s.created.project;
    const originalUrl = `/api/v1/projects/${original.id}`;
    const scenario = original.scenarios.find(
      (entry: { id: string }) => entry.id === original.activeScenarioId,
    );
    const comment = await s.app.inject({
      method: "POST",
      url: `${originalUrl}/comments`,
      headers: s.owner.headers,
      payload: {
        scenarioId: scenario.id,
        expectedVersion: 1,
        expectedRevision: scenario.revision,
        text: "Review retained for the deleted project only.",
        target: { kind: "project" },
        idempotencyKey: "deleted-draft-review",
      },
    });
    expect(comment.statusCode).toBe(201);
    const published = await s.app.inject({
      method: "POST",
      url: `${originalUrl}/publish`,
      headers: s.owner.headers,
      payload: { scenarioId: scenario.id, expectedRevision: scenario.revision },
    });
    expect(published.statusCode).toBe(201);
    const removed = await s.app.inject({
      method: "DELETE",
      url: originalUrl,
      headers: s.owner.headers,
      payload: { expectedVersion: 1 },
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (await s.app.inject(`/api/v1/published/${published.json().id}`))
        .statusCode,
    ).toBe(404);
    const restored = await s.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: s.owner.headers,
      payload: {
        project: original,
        baselineHash: (await baselineIdentity(place)).sha256,
      },
    });
    expect(restored.statusCode).toBe(201);
    expect(restored.json().project.id).not.toBe(original.id);
    expect(restored.json().project.scenarios).toEqual(original.scenarios);
    const restoredRecords = await s.app.inject({
      url: `/api/v1/projects/${restored.json().project.id}/exports?format=records`,
      headers: s.owner.headers,
    });
    expect(restoredRecords.statusCode).toBe(200);
    const records = restoredRecords.json();
    expect(records.comments).toEqual([]);
    expect(records.publicFeedback).toEqual([]);
    expect(records.engagement).toEqual([]);
    expect(
      records.audit.map((entry: { action: string }) => entry.action),
    ).toEqual(["project.created"]);
    expect(
      (await s.app.inject({ url: originalUrl, headers: s.owner.headers }))
        .statusCode,
    ).toBe(404);
  });
});
