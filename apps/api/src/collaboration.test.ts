import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Place, Project } from "@urban/core";
import { buildingPreset } from "@urban/models";
import { buildApp } from "./app.js";
import { FileStore, type DataState } from "./store.js";
import type { StoreScope } from "./store-scope.js";
import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
  verifyIdentityTestAccount,
  identityTestMail,
} from "./identity-test-fixture.js";

const boundary: Place["boundary"] = [
  [-112.08, 33.45],
  [-112.06, 33.45],
  [-112.06, 33.47],
  [-112.08, 33.47],
  [-112.08, 33.45],
];
const hole: Place["boundary"] = [
  [-112.079, 33.451],
  [-112.078, 33.451],
  [-112.078, 33.452],
  [-112.079, 33.452],
  [-112.079, 33.451],
];
const place: Place = {
  id: "collaboration-fixture",
  name: "Shared reference",
  city: "Phoenix",
  state: "AZ",
  zip: "85004",
  center: [-112.069, 33.459],
  bounds: [-112.08, 33.45, -112.06, 33.47],
  boundary,
  studyArea: { type: "Polygon", coordinates: [boundary, hole] },
  buildings: [
    {
      ...buildingPreset("multifamily", [-112.069, 33.459]),
      id: "existing-building",
    },
  ],
  roads: [],
  sources: [
    {
      id: "fixture",
      name: "Fixture source",
      url: "https://example.com",
      vintage: "2026",
      license: "Test only",
      kind: "user-supplied",
    },
  ],
  coverage: [],
  loadedAt: "2026-11-05T00:00:00.000Z",
  extentLabel: "Collaboration test fixture",
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
type Account = {
  id: string;
  organizationId: string;
  email: string;
  headers: Record<string, string>;
};
async function setup(store: FileStore = new FileStore()) {
  const mail = new FixtureIdentityMail();
  const app = await buildApp({
    store,
    identityMail: mail,
    catalog: { list: async () => [place], get: async () => place },
  });
  apps.push(app);
  attachIdentityTestMail(app, mail);
  return { app, store };
}
async function account(app: FastifyInstance, name: string): Promise<Account> {
  const email = `${name}@example.com`;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: "a secure collaboration password", name },
  });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().user.id,
    organizationId: response.json().organization.id,
    email,
    headers: {
      cookie: `${response.cookies[0].name}=${response.cookies[0].value}`,
      "x-csrf-token": response.json().csrfToken,
    },
  };
}
async function create(app: FastifyInstance, owner: Account) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { placeId: place.id },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as {
    project: Project;
    version: number;
    access: { aclVersion: number; role: string; mode: string };
    organizationId: string;
  };
}
async function switchTo(
  app: FastifyInstance,
  user: Account,
  organizationId: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/organization",
    headers: user.headers,
    payload: { organizationId },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
async function grant(
  app: FastifyInstance,
  owner: Account,
  projectId: string,
  recipient: Account,
  role = "commenter",
) {
  const current = (
    await app.inject({
      url: `/api/v1/projects/${projectId}/members`,
      headers: owner.headers,
    })
  ).json();
  if (
    !current.members.some(
      (member: { userId: string }) => member.userId === recipient.id,
    )
  ) {
    await acceptIdentityTestInvitation(app, owner, recipient, role, projectId);
    return (
      await app.inject({
        url: `/api/v1/projects/${projectId}/members`,
        headers: owner.headers,
      })
    ).json();
  }
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/members`,
    headers: owner.headers,
    payload: {
      email: recipient.email,
      role,
      expectedAclVersion: current.access.aclVersion,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
async function workspaceGrant(
  app: FastifyInstance,
  owner: Account,
  recipient: Account,
  role = "viewer",
) {
  const roster = await app.inject({
    url: "/api/v1/organization/members",
    headers: owner.headers,
  });
  if (
    !roster
      .json()
      .members.some(
        (member: { userId?: string; id?: string; membershipScope?: string }) =>
          (member.userId ?? member.id) === recipient.id &&
          member.membershipScope !== "project-only",
      )
  ) {
    await acceptIdentityTestInvitation(app, owner, recipient, role);
    return;
  }
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/organization/members",
        headers: owner.headers,
        payload: { email: recipient.email, role },
      })
    ).statusCode,
  ).toBe(200);
}
async function change(
  app: FastifyInstance,
  owner: Account,
  projectId: string,
  recipient: Account,
  role: string,
) {
  const current = (
    await app.inject({
      url: `/api/v1/projects/${projectId}/members`,
      headers: owner.headers,
    })
  ).json();
  return app.inject({
    method: "PATCH",
    url: `/api/v1/projects/${projectId}/members/${recipient.id}`,
    headers: owner.headers,
    payload: { role, expectedAclVersion: current.access.aclVersion },
  });
}
async function remove(
  app: FastifyInstance,
  owner: Account,
  projectId: string,
  recipient: Account,
) {
  const current = (
    await app.inject({
      url: `/api/v1/projects/${projectId}/members`,
      headers: owner.headers,
    })
  ).json();
  return app.inject({
    method: "DELETE",
    url: `/api/v1/projects/${projectId}/members/${recipient.id}`,
    headers: owner.headers,
    payload: { expectedAclVersion: current.access.aclVersion },
  });
}
function commentInput(
  project: Project,
  overrides: Record<string, unknown> = {},
) {
  return {
    scenarioId: project.activeScenarioId,
    expectedVersion: 1,
    expectedRevision: 0,
    text: "Please review this location.",
    target: { kind: "project" },
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}
function importPayload(projectId?: string) {
  const footprint = buildingPreset("office", [-112.068, 33.458]).footprint;
  return {
    projectId,
    sourceName: "Shared local plan",
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [footprint] },
          properties: {
            name: "New local building",
            use: "office",
            height: 12,
            floors: 3,
            units: 0,
            jobs: 10,
            parkingSpaces: 0,
          },
        },
      ],
    },
  };
}

describe("project-scoped authorization", () => {
  it("defaults new projects to private grants while preserving disclosed organization administration", async () => {
    const { app } = await setup();
    const admin = await account(app, "admin");
    const editor = await account(app, "workspace-editor");
    const first = await create(app, admin);
    await workspaceGrant(app, admin, editor, "editor");
    await switchTo(app, editor, admin.organizationId);
    expect(first.access).toMatchObject({
      mode: "private",
      role: "owner",
      aclVersion: 1,
    });
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${first.project.id}`,
          headers: editor.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({ url: "/api/v1/projects", headers: editor.headers })
      ).json().projects,
    ).toEqual([]);
    const theirs = await create(app, editor);
    expect(theirs.access.role).toBe("owner");
    const administrative = await app.inject({
      url: `/api/v1/projects/${theirs.project.id}/access`,
      headers: admin.headers,
    });
    expect(administrative.json().access).toMatchObject({
      role: "owner",
      reason: "organization-admin",
    });
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${theirs.project.id}/members`,
          headers: editor.headers,
        })
      ).json().disclosure,
    ).toContain("Workspace owners retain");
  });
  it("grants one project without exposing siblings, organization administration, or another tenant", async () => {
    const { app } = await setup();
    const owner = await account(app, "owner");
    const guest = await account(app, "guest");
    const a = await create(app, owner),
      b = await create(app, owner);
    await grant(app, owner, a.project.id, guest, "commenter");
    const organizations = (
      await app.inject({ url: "/api/v1/organizations", headers: guest.headers })
    ).json().organizations;
    expect(
      organizations.find((o: { id: string }) => o.id === owner.organizationId),
    ).toMatchObject({ membershipScope: "project-only" });
    expect(
      (await switchTo(app, guest, owner.organizationId)).membershipScope,
    ).toBe("project-only");
    const list = (
      await app.inject({ url: "/api/v1/projects", headers: guest.headers })
    ).json().projects;
    expect(list.map((p: { project: { id: string } }) => p.project.id)).toEqual([
      a.project.id,
    ]);
    expect(list[0].access.role).toBe("commenter");
    for (const suffix of [
      "",
      "/access",
      "/members",
      "/metrics",
      "/comments",
      "/audit",
      "/feedback",
      "/exports?format=records",
    ])
      expect(
        (
          await app.inject({
            url: `/api/v1/projects/${b.project.id}${suffix}`,
            headers: guest.headers,
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/organization/members",
          headers: guest.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/organization/members",
          headers: guest.headers,
          payload: { email: guest.email, role: "editor" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/projects",
          headers: guest.headers,
          payload: { placeId: place.id },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/imports/geojson/preview",
          headers: guest.headers,
          payload: importPayload(b.project.id),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${a.project.id}/members`,
          headers: guest.headers,
          payload: { email: guest.email, role: "owner", expectedAclVersion: 2 },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("uses effective project editor permissions and immediately enforces downgrade/revocation across alternate paths", async () => {
    const { app } = await setup();
    const owner = await account(app, "owner");
    const editor = await account(app, "editor");
    const saved = await create(app, owner);
    await grant(app, owner, saved.project.id, editor, "editor");
    await switchTo(app, editor, owner.organizationId);
    const edited = structuredClone(saved.project);
    edited.name = "Edited by a project-only member";
    const update = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: editor.headers,
      payload: { project: edited, expectedVersion: 1 },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().access.role).toBe("editor");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/imports/geojson/preview",
          headers: editor.headers,
          payload: importPayload(),
        })
      ).statusCode,
    ).toBe(403);
    const staged = await app.inject({
      method: "POST",
      url: "/api/v1/imports/geojson/preview",
      headers: editor.headers,
      payload: importPayload(saved.project.id),
    });
    expect(staged.statusCode).toBe(200);
    expect(
      (await change(app, owner, saved.project.id, editor, "viewer")).statusCode,
    ).toBe(200);
    const access = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/access`,
      headers: editor.headers,
    });
    expect(access.json()).toMatchObject({
      version: 2,
      access: { role: "viewer", canEdit: false, canComment: false },
    });
    const deniedWrites = [
      {
        method: "PUT" as const,
        url: `/api/v1/projects/${saved.project.id}`,
        payload: { project: edited, expectedVersion: 2 },
      },
      {
        method: "POST" as const,
        url: `/api/v1/projects/${saved.project.id}/scenarios`,
        payload: {
          name: "Unauthorized",
          parentId: "baseline",
          expectedVersion: 2,
        },
      },
      {
        method: "POST" as const,
        url: `/api/v1/projects/${saved.project.id}/scenarios/${saved.project.activeScenarioId}/commands`,
        payload: {
          command: { type: "scenario.rename", name: "Unauthorized" },
          expectedVersion: 2,
          expectedRevision: 0,
        },
      },
      {
        method: "POST" as const,
        url: `/api/v1/projects/${saved.project.id}/comments`,
        payload: commentInput(saved.project, { expectedVersion: 2 }),
      },
      {
        method: "POST" as const,
        url: `/api/v1/projects/${saved.project.id}/publish`,
        payload: {
          scenarioId: saved.project.activeScenarioId,
          expectedRevision: 0,
        },
      },
      {
        method: "POST" as const,
        url: `/api/v1/projects/${saved.project.id}/imports/${staged.json().importId}/commit`,
        payload: {
          scenarioId: saved.project.activeScenarioId,
          expectedVersion: 2,
          expectedRevision: 0,
          acknowledgeWarnings: true,
        },
      },
      {
        method: "DELETE" as const,
        url: `/api/v1/projects/${saved.project.id}`,
        payload: { expectedVersion: 2 },
      },
    ];
    for (const request of deniedWrites)
      expect(
        (await app.inject({ ...request, headers: editor.headers })).statusCode,
        request.url,
      ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}/exports?format=csv`,
          headers: editor.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await remove(app, owner, saved.project.id, editor)).statusCode,
    ).toBe(200);
    for (const suffix of [
      "",
      "/access",
      "/metrics",
      "/comments",
      "/members",
      "/audit",
      "/exports?format=records",
    ])
      expect(
        (
          await app.inject({
            url: `/api/v1/projects/${saved.project.id}${suffix}`,
            headers: editor.headers,
          })
        ).statusCode,
      ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/session",
          headers: editor.headers,
        })
      ).json().organization.id,
    ).toBe(editor.organizationId);
  });
  it("protects the last explicit owner, detects stale ACL edits, and handles self-removal without stale privileges", async () => {
    const { app } = await setup();
    const owner = await account(app, "owner");
    const coowner = await account(app, "coowner");
    const third = await account(app, "third");
    const saved = await create(app, owner);
    expect(
      (await change(app, owner, saved.project.id, owner, "viewer")).json().error
        .code,
    ).toBe("LAST_PROJECT_OWNER");
    expect(
      (await remove(app, owner, saved.project.id, owner)).json().error.code,
    ).toBe("LAST_PROJECT_OWNER");
    await grant(app, owner, saved.project.id, coowner, "owner");
    await grant(app, owner, saved.project.id, third, "owner");
    await switchTo(app, coowner, owner.organizationId);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/projects/${saved.project.id}/members/${third.id}`,
          headers: owner.headers,
          payload: { role: "viewer", expectedAclVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);
    const selfRemoved = await remove(app, coowner, saved.project.id, coowner);
    expect(selfRemoved.statusCode).toBe(200);
    expect(selfRemoved.json()).toMatchObject({
      access: null,
      accessRevoked: true,
      members: [],
    });
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}/access`,
          headers: coowner.headers,
        })
      ).statusCode,
    ).toBe(404);
    const current = await app.inject({
      url: `/api/v1/projects/${saved.project.id}`,
      headers: owner.headers,
    });
    expect(current.json().version).toBe(1);
  });
  it("revokes one project while retaining access to another in the same active workspace", async () => {
    const { app } = await setup();
    const owner = await account(app, "owner");
    const viewer = await account(app, "viewer");
    const a = await create(app, owner),
      b = await create(app, owner);
    await grant(app, owner, a.project.id, viewer, "viewer");
    await grant(app, owner, b.project.id, viewer, "viewer");
    await switchTo(app, viewer, owner.organizationId);
    expect((await remove(app, owner, a.project.id, viewer)).statusCode).toBe(
      200,
    );
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/session",
          headers: viewer.headers,
        })
      ).json().organization.id,
    ).toBe(owner.organizationId);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${a.project.id}/access`,
          headers: viewer.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${b.project.id}/access`,
          headers: viewer.headers,
        })
      ).json().access.role,
    ).toBe("viewer");
    expect(
      (await app.inject({ url: "/api/v1/projects", headers: viewer.headers }))
        .json()
        .projects.map((p: { project: { id: string } }) => p.project.id),
    ).toEqual([b.project.id]);
  });
  it("preserves legacy workspace access and freezes explicit grants on the first member change", async () => {
    const { app, store } = await setup();
    const owner = await account(app, "owner");
    const regular = await account(app, "regular");
    const recipient = await account(app, "recipient");
    const newRegular = await account(app, "new-regular");
    const saved = await create(app, owner);
    await store.transaction((s) => {
      delete s.projects[0].acl;
    });
    await workspaceGrant(app, owner, regular, "viewer");
    await switchTo(app, regular, owner.organizationId);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}/access`,
          headers: regular.headers,
        })
      ).json().access,
    ).toMatchObject({
      mode: "workspace",
      reason: "legacy-workspace",
      role: "viewer",
      aclVersion: 0,
    });
    const changed = await grant(
      app,
      owner,
      saved.project.id,
      recipient,
      "commenter",
    );
    expect(changed.access.mode).toBe("private");
    expect(
      changed.members.find((m: { userId: string }) => m.userId === regular.id)
        .role,
    ).toBe("viewer");
    await workspaceGrant(app, owner, newRegular, "editor");
    await switchTo(app, newRegular, owner.organizationId);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}`,
          headers: newRegular.headers,
        })
      ).statusCode,
    ).toBe(404);
    const legacySibling = await create(app, owner);
    await store.transaction((s) => {
      delete s.projects.find((p) => p.project.id === legacySibling.project.id)!
        .acl;
    });
    await switchTo(app, recipient, owner.organizationId);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${legacySibling.project.id}`,
          headers: recipient.headers,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("does not let an editor commit another uploader’s staged data or use a revoked grant to revoke published links", async () => {
    const { app } = await setup();
    const owner = await account(app, "owner");
    const editor = await account(app, "editor");
    const saved = await create(app, owner);
    await grant(app, owner, saved.project.id, editor, "editor");
    await switchTo(app, editor, owner.organizationId);
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/imports/geojson/preview",
      headers: owner.headers,
      payload: importPayload(saved.project.id),
    });
    expect(preview.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${saved.project.id}/imports/${preview.json().importId}/commit`,
          headers: editor.headers,
          payload: {
            scenarioId: saved.project.activeScenarioId,
            expectedVersion: 1,
            expectedRevision: 0,
            acknowledgeWarnings: true,
          },
        })
      ).statusCode,
    ).toBe(404);
    const snapshot = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/publish`,
      headers: owner.headers,
      payload: {
        scenarioId: saved.project.activeScenarioId,
        expectedRevision: 0,
      },
    });
    expect(snapshot.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/published/${snapshot.json().id}`,
          headers: editor.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject(`/api/v1/published/${snapshot.json().id}`)).statusCode,
    ).toBe(200);
  });
});

describe("revision-bound review threads", () => {
  it("validates saved buildings, metrics, and exact locations; rejects malformed or stale targets", async () => {
    const { app } = await setup();
    const owner = await account(app, "owner");
    const saved = await create(app, owner);
    const empty = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/comments?scenarioId=${saved.project.activeScenarioId}`,
      headers: owner.headers,
    });
    expect(empty.json()).toMatchObject({
      comments: [],
      projectVersion: 1,
      scenarioRevision: 0,
    });
    for (const target of [
      { kind: "building", id: "not-saved" },
      { kind: "metric", id: "imaginary.metric" },
      { kind: "location", position: [-112.0785, 33.4515] },
      { kind: "location", position: [0, 0] },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/projects/${saved.project.id}/comments`,
            headers: owner.headers,
            payload: commentInput(saved.project, { target }),
          })
        ).statusCode,
      ).toBe(422);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${saved.project.id}/comments`,
          headers: owner.headers,
          payload: commentInput(saved.project, {
            target: { kind: "building", position: place.center },
          }),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${saved.project.id}/comments`,
          headers: owner.headers,
          payload: commentInput(saved.project, { expectedRevision: 3 }),
        })
      ).json().error.code,
    ).toBe("REVIEW_REVISION_CONFLICT");
    const building = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: owner.headers,
      payload: commentInput(saved.project, {
        target: { kind: "building", id: "existing-building" },
      }),
    });
    expect(building.statusCode).toBe(201);
    expect(building.json().comment).toMatchObject({
      scenarioRevision: 0,
      targetLabel: place.buildings[0].name,
      threadVersion: 1,
      stale: false,
    });
    expect(building.json().comment.targetPosition).toHaveLength(2);
    const metric = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: owner.headers,
      payload: commentInput(saved.project, {
        target: { kind: "metric", id: "housing.units" },
      }),
    });
    expect(metric.statusCode).toBe(201);
    expect(metric.json().comment.targetLabel).toBeTruthy();
  });
  it("binds replies to saved revisions, applies resolution permissions, and preserves the full records history", async () => {
    const { app } = await setup();
    const owner = await account(app, "owner");
    const commenter = await account(app, "commenter");
    const other = await account(app, "other");
    const saved = await create(app, owner);
    await grant(app, owner, saved.project.id, commenter, "commenter");
    await grant(app, owner, saved.project.id, other, "commenter");
    await switchTo(app, commenter, owner.organizationId);
    await switchTo(app, other, owner.organizationId);
    const body = commentInput(saved.project);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: commenter.headers,
      payload: body,
    });
    const thread = created.json().comment;
    expect(created.statusCode).toBe(201);
    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: commenter.headers,
      payload: body,
    });
    expect(retry.json().comment.id).toBe(thread.id);
    const replyBody = {
      text: "I reviewed the access assumptions.",
      expectedVersion: 1,
      expectedRevision: 0,
      idempotencyKey: crypto.randomUUID(),
    };
    const reply = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments/${thread.id}/replies`,
      headers: other.headers,
      payload: replyBody,
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().comment).toMatchObject({
      threadVersion: 2,
      replies: [{ scenarioRevision: 0, text: replyBody.text }],
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments/${thread.id}/replies`,
      headers: other.headers,
      payload: replyBody,
    });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/projects/${saved.project.id}/comments/${thread.id}`,
          headers: other.headers,
          payload: { resolved: true, expectedThreadVersion: 2 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/projects/${saved.project.id}/comments/${thread.id}`,
          headers: commenter.headers,
          payload: { resolved: true, expectedThreadVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);
    const resolved = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${saved.project.id}/comments/${thread.id}`,
      headers: commenter.headers,
      payload: { resolved: true, expectedThreadVersion: 2 },
    });
    expect(resolved.json().comment).toMatchObject({
      resolved: true,
      threadVersion: 3,
      resolvedBy: commenter.id,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${saved.project.id}/comments/${thread.id}/replies`,
          headers: other.headers,
          payload: { ...replyBody, idempotencyKey: crypto.randomUUID() },
        })
      ).json().error.code,
    ).toBe("THREAD_RESOLVED");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/projects/${saved.project.id}/comments/${thread.id}`,
          headers: owner.headers,
          payload: { resolved: false, expectedThreadVersion: 3 },
        })
      ).json().comment.resolved,
    ).toBe(false);
    const records = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/exports?format=records`,
        headers: owner.headers,
      })
    ).json();
    expect(records.comments[0].replies).toHaveLength(1);
    expect(records.comments[0].scenarioRevision).toBe(0);
    expect(records.audit.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining([
        "identity.invitation.accepted",
        "comment.created",
        "comment.replied",
        "comment.resolved",
        "comment.reopened",
      ]),
    );
    expect(records.sharing.access.mode).toBe("private");
    expect(
      records.sharing.members.find(
        (m: { userId: string }) => m.userId === commenter.id,
      ).role,
    ).toBe("commenter");
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}/access`,
          headers: commenter.headers,
        })
      ).json().version,
    ).toBe(1);
  });
  it("marks old threads stale, returns idempotent retries without duplicates, and rejects old content versions", async () => {
    const { app } = await setup();
    const owner = await account(app, "owner");
    const saved = await create(app, owner);
    const body = commentInput(saved.project, {
      target: { kind: "building", id: "existing-building" },
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: owner.headers,
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    const changed = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/scenarios/${saved.project.activeScenarioId}/commands`,
      headers: owner.headers,
      payload: {
        command: {
          type: "building.upsert",
          building: {
            ...place.buildings[0],
            units: place.buildings[0].units! + 1,
          },
        },
        expectedRevision: 0,
        expectedVersion: 1,
      },
    });
    expect(changed.statusCode).toBe(200);
    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: owner.headers,
      payload: body,
    });
    expect(retried.json().comment).toMatchObject({
      id: created.json().comment.id,
      stale: true,
      currentRevision: 1,
      scenarioRevision: 0,
    });
    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: owner.headers,
      payload: { ...body, idempotencyKey: crypto.randomUUID() },
    });
    expect(stale.statusCode).toBe(409);
    const spoof = changed.json().project as Project;
    spoof.scenarios.find((s) => s.id === spoof.activeScenarioId)!.name =
      "Changed without advancing revision";
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/projects/${saved.project.id}`,
          headers: owner.headers,
          payload: { project: spoof, expectedVersion: 2 },
        })
      ).json().error.code,
    ).toBe("SCENARIO_REVISION_CONFLICT");
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}/comments`,
          headers: owner.headers,
        })
      ).json().comments,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}/exports?format=records&revision=1&version=1`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}/exports?format=records&revision=1&version=2`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(200);
  });
  it("reserves deleted scenario identifiers with review history while allowing a genuinely new scenario", async () => {
    const { app } = await setup();
    const owner = await account(app, "review-owner");
    const saved = await create(app, owner);
    const reviewed = saved.project.scenarios.find(
      (scenario) => scenario.id === saved.project.activeScenarioId,
    )!;
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: owner.headers,
      payload: commentInput(saved.project),
    });
    expect(created.statusCode).toBe(201);

    const withoutReviewed = structuredClone(saved.project);
    withoutReviewed.scenarios = withoutReviewed.scenarios.filter(
      (scenario) => scenario.id !== reviewed.id,
    );
    withoutReviewed.activeScenarioId = "baseline";
    const removed = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: owner.headers,
      payload: { project: withoutReviewed, expectedVersion: 1 },
    });
    expect(removed.statusCode).toBe(200);

    for (const revision of [reviewed.revision, reviewed.revision + 1]) {
      const replacement = structuredClone(removed.json().project as Project);
      replacement.scenarios.push({
        ...reviewed,
        name: "Different replacement content",
        revision,
      });
      replacement.activeScenarioId = reviewed.id;
      const reused = await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${saved.project.id}`,
        headers: owner.headers,
        payload: { project: replacement, expectedVersion: 2 },
      });
      expect(reused.statusCode).toBe(409);
      expect(reused.json().error.code).toBe("SCENARIO_ID_REUSED");
    }

    const replacement = structuredClone(removed.json().project as Project);
    const newId = crypto.randomUUID();
    replacement.scenarios.push({ ...reviewed, id: newId, name: "New option" });
    replacement.activeScenarioId = newId;
    const savedNew = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${saved.project.id}`,
      headers: owner.headers,
      payload: { project: replacement, expectedVersion: 2 },
    });
    expect(savedNew.statusCode).toBe(200);
    const current = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/comments?scenarioId=${newId}`,
      headers: owner.headers,
    });
    expect(current.json().comments).toEqual([]);
    const records = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=records&version=3`,
      headers: owner.headers,
    });
    expect(records.statusCode).toBe(200);
    expect(records.json().comments).toEqual([
      expect.objectContaining({
        id: created.json().comment.id,
        scenarioId: reviewed.id,
        scenarioRevision: reviewed.revision,
      }),
    ]);
  });
  it("never grants comment authors rights after downgrade, and labels legacy revision gaps honestly", async () => {
    const { app, store } = await setup();
    const owner = await account(app, "owner");
    const author = await account(app, "author");
    const saved = await create(app, owner);
    await grant(app, owner, saved.project.id, author, "commenter");
    await switchTo(app, author, owner.organizationId);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: author.headers,
      payload: commentInput(saved.project),
    });
    const thread = created.json().comment;
    await change(app, owner, saved.project.id, author, "viewer");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/projects/${saved.project.id}/comments/${thread.id}`,
          headers: author.headers,
          payload: { resolved: true, expectedThreadVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);
    await store.transaction((s) => {
      s.comments.push({
        id: "legacy",
        projectId: saved.project.id,
        organizationId: owner.organizationId,
        actorId: owner.id,
        author: "Legacy owner",
        text: "An older unbound comment",
        scenarioId: saved.project.activeScenarioId,
        target: { kind: "building" },
        createdAt: "2020-01-01T00:00:00Z",
      });
    });
    const comments = (
      await app.inject({
        url: `/api/v1/projects/${saved.project.id}/comments`,
        headers: owner.headers,
      })
    ).json().comments;
    expect(
      comments.find((c: { id: string }) => c.id === "legacy"),
    ).toMatchObject({
      scenarioRevision: null,
      stale: true,
      targetLabel: "Legacy comment · original target and revision unverified",
    });
    expect(
      comments.find((c: { id: string }) => c.id === "legacy").targetPosition,
    ).toBeUndefined();
  });
});

describe("collaboration snapshot and mutation consistency", () => {
  it("exports content, review and sharing from one snapshot despite a concurrent committed update", async () => {
    class InterleavingStore extends FileStore {
      afterRead?: () => Promise<void>;
      override async read<T>(
        operation: (state: DataState) => T,
        scope?: StoreScope,
      ): Promise<T> {
        const result = await super.read(operation, scope);
        const callback = this.afterRead;
        this.afterRead = undefined;
        await callback?.();
        return result;
      }
    }
    const store = new InterleavingStore();
    const { app } = await setup(store);
    const owner = await account(app, "snapshot-owner");
    const saved = await create(app, owner);
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${saved.project.id}/comments`,
      headers: owner.headers,
      payload: commentInput(saved.project),
    });
    expect(created.statusCode).toBe(201);
    store.afterRead = () =>
      store.transaction((state) => {
        const record = state.projects.find(
          (p) => p.project.id === saved.project.id,
        )!;
        record.project.name = "Concurrent new version";
        record.version = 2;
        record.acl!.version = 2;
        const scenario = record.project.scenarios.find(
          (s) => s.id === record.project.activeScenarioId,
        )!;
        scenario.name = "Changed after snapshot";
        scenario.revision++;
        const comment = state.comments.find(
          (c) => c.id === created.json().comment.id,
        )!;
        comment.resolved = true;
        comment.threadVersion = 2;
        state.audit.push({
          id: "concurrent-event",
          organizationId: record.organizationId,
          projectId: record.project.id,
          actorId: owner.id,
          action: "test.concurrent",
          at: new Date().toISOString(),
          details: {},
        });
      });
    const exported = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=records&version=1&revision=0`,
      headers: owner.headers,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["x-project-version"]).toBe("1");
    const records = exported.json();
    expect(records.projectVersion).toBe(1);
    expect(records.project.name).toBe(saved.project.name);
    expect(records.comments[0]).toMatchObject({
      resolved: false,
      threadVersion: 1,
    });
    expect(records.sharing.access.aclVersion).toBe(1);
    expect(
      records.audit.some((a: { id: string }) => a.id === "concurrent-event"),
    ).toBe(false);
    const fresh = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/exports?format=records&version=2&revision=1`,
      headers: owner.headers,
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toMatchObject({
      projectVersion: 2,
      project: { name: "Concurrent new version" },
      comments: [{ resolved: true, threadVersion: 2 }],
      sharing: { access: { aclVersion: 2 } },
    });
    expect(
      (
        await app.inject({
          url: `/api/v1/projects/${saved.project.id}/exports?format=records&version=1`,
          headers: owner.headers,
        })
      ).statusCode,
    ).toBe(409);
  });
  it("requires CSRF and trusted origins and serializes competing ACL updates", async () => {
    const { app } = await setup();
    const owner = await account(app, "csrf-owner");
    const a = await account(app, "recipient-a"),
      b = await account(app, "recipient-b");
    const saved = await create(app, owner);
    const route = `/api/v1/projects/${saved.project.id}/members`;
    const payload = { email: a.email, role: "viewer", expectedAclVersion: 1 };
    expect(
      (
        await app.inject({
          method: "POST",
          url: route,
          headers: { cookie: owner.headers.cookie },
          payload,
        })
      ).json().error.code,
    ).toBe("CSRF_REQUIRED");
    expect(
      (
        await app.inject({
          method: "POST",
          url: route,
          headers: { ...owner.headers, origin: "https://untrusted.example" },
          payload,
        })
      ).json().error.code,
    ).toBe("ORIGIN_REJECTED");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${saved.project.id}/comments`,
          headers: { cookie: owner.headers.cookie },
          payload: commentInput(saved.project),
        })
      ).json().error.code,
    ).toBe("CSRF_REQUIRED");
    await verifyIdentityTestAccount(app, owner.headers, owner.email);
    const tokens: string[] = [];
    for (const user of [a, b]) {
      await verifyIdentityTestAccount(app, user.headers, user.email);
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${saved.project.id}/invitations`,
        headers: owner.headers,
        payload: {
          ...payload,
          email: user.email,
          idempotencyKey: `competing-${user.id}`,
        },
      });
      expect(created.statusCode).toBe(201);
      tokens.push(identityTestMail(app).token("invitation", user.email));
    }
    const competing = await Promise.all(
      [a, b].map((user, i) =>
        app.inject({
          method: "POST",
          url: "/api/v1/invitations/accept",
          headers: user.headers,
          payload: {
            token: tokens[i],
            expectedVersion: 1,
            expectedAclVersion: 1,
          },
        }),
      ),
    );
    expect(competing.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const members = (
      await app.inject({ url: route, headers: owner.headers })
    ).json();
    expect(members.access.aclVersion).toBe(2);
    expect(members.members).toHaveLength(2);
  });
});

describe("collaboration scoped record loading", () => {
  it("loads one metadata-only access view and preserves an existing grant profile even if a legacy membership is absent", async () => {
    class ProbeStore extends FileStore {
      nextRead?: (state: DataState) => void;
      override read<T>(
        operation: (state: DataState) => T,
        scope?: StoreScope,
      ): Promise<T> {
        const probe = this.nextRead;
        this.nextRead = undefined;
        return super.read((state) => {
          probe?.(state);
          return operation(state);
        }, scope);
      }
    }
    const store = new ProbeStore();
    const { app } = await setup(store);
    const owner = await account(app, "scoped-owner");
    const unrelated = await account(app, "scoped-unrelated");
    const recipient = await account(app, "legacy-recipient");
    const saved = await create(app, owner);
    await create(app, unrelated);
    await grant(app, owner, saved.project.id, recipient, "viewer");
    await store.transaction((state) => {
      state.memberships = state.memberships.filter(
        (member) =>
          !(
            member.userId === recipient.id &&
            member.organizationId === owner.organizationId
          ),
      );
    });
    let checked = false;
    store.nextRead = (state) => {
      checked = true;
      expect(state.projectHeaders.map((record) => record.project.id)).toEqual([
        saved.project.id,
      ]);
      expect(state.projectHeaders[0]).not.toHaveProperty("baseline");
      expect(state.projectHeaders[0].project).not.toHaveProperty("history");
      expect(() => state.projects).toThrow("not selected");
      expect(() => state.published).toThrow("not selected");
      expect(state.users.map((user) => user.id)).toEqual([owner.id]);
    };
    const access = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/access`,
      headers: owner.headers,
    });
    expect(access.statusCode).toBe(200);
    expect(checked).toBe(true);
    store.nextRead = (state) => {
      expect(() => state.projects).toThrow("not selected");
      expect(state.users.map((user) => user.id)).toContain(recipient.id);
      expect(state.users.map((user) => user.id)).not.toContain(unrelated.id);
    };
    const members = await app.inject({
      url: `/api/v1/projects/${saved.project.id}/members`,
      headers: owner.headers,
    });
    expect(members.statusCode).toBe(200);
    expect(
      members.json().members.map((member: { userId: string }) => member.userId),
    ).toContain(recipient.id);
  });
});
