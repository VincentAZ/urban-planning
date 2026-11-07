import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  EngagementConfig,
  EngagementReport,
  Place,
  Project,
} from "@urban/core";
import { buildApp } from "./app.js";
import { FileStore, type DataState } from "./store.js";
import type { StoreScope } from "./store-scope.js";
import { assertEngagementReport } from "./engagement-report.js";
import {
  FixtureIdentityMail,
  attachIdentityTestMail,
  acceptIdentityTestInvitation,
} from "./identity-test-fixture.js";

const outer: Place["boundary"] = [
  [0, 0],
  [0.02, 0],
  [0.02, 0.02],
  [0, 0.02],
  [0, 0],
];
const hole: Place["boundary"] = [
  [0.005, 0.005],
  [0.007, 0.005],
  [0.007, 0.007],
  [0.005, 0.007],
  [0.005, 0.005],
];
const island: Place["boundary"] = [
  [0.03, 0.01],
  [0.035, 0.01],
  [0.035, 0.015],
  [0.03, 0.015],
  [0.03, 0.01],
];
const place: Place = {
  id: "engagement-fixture",
  name: "Exact frozen study area",
  city: "Fixture",
  state: "AZ",
  zip: "85004",
  center: [0.01, 0.01],
  boundary: outer,
  bounds: [0, 0, 0.035, 0.02],
  studyArea: { type: "MultiPolygon", coordinates: [[outer, hole], [island]] },
  buildings: [],
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
  loadedAt: "2026-11-05T00:00:00Z",
  extentLabel: "Exact multipart fixture",
};
const config: EngagementConfig = {
  introduction: "Tell us what matters.",
  comments: true,
  votes: true,
  pins: true,
  questions: [
    {
      id: "priority",
      prompt: "Which priority?",
      type: "single-choice",
      required: true,
      options: ["Homes", "Parks"],
    },
    { id: "why", prompt: "Why?", type: "text", required: false },
  ],
};
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
type Account = {
  id: string;
  email: string;
  organizationId: string;
  headers: Record<string, string>;
};
async function account(app: FastifyInstance, name: string): Promise<Account> {
  const result = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email: `${name}@example.com`,
      name,
      password: "an excellent secret for engagement",
    },
  });
  expect(result.statusCode).toBe(201);
  const data = result.json();
  return {
    id: data.user.id,
    email: data.user.email,
    organizationId: data.organization.id,
    headers: {
      cookie: `${result.cookies[0].name}=${result.cookies[0].value}`,
      "x-csrf-token": data.csrfToken,
    },
  };
}
async function setup(store = new FileStore()) {
  const mail = new FixtureIdentityMail();
  const app = await buildApp({
    store,
    identityMail: mail,
    catalog: { get: async () => place, list: async () => [place] },
    nationalPreparationEnabled: false,
  });
  apps.push(app);
  attachIdentityTestMail(app, mail);
  const owner = await account(app, "owner");
  const resident = await account(app, "resident");
  const saved = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers: owner.headers,
    payload: { placeId: place.id },
  });
  expect(saved.statusCode).toBe(201);
  const project = saved.json().project as Project;
  const base = `/api/v1/projects/${project.id}`;
  const publish = async (
    engagement: EngagementConfig | undefined = config,
    legacy = false,
  ) => {
    const scenario = project.scenarios.find(
      (s) => s.id === project.activeScenarioId,
    )!;
    const response = await app.inject({
      method: "POST",
      url: `${base}/publish`,
      headers: owner.headers,
      payload: {
        scenarioId: scenario.id,
        expectedRevision: scenario.revision,
        ...(legacy ? { feedbackEnabled: true } : { engagement }),
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  };
  const snapshotId = await publish();
  const path = `${base}/engagement/${snapshotId}`;
  let sequence = 0;
  const submit = (
    payload: Record<string, unknown>,
    user = resident,
    id = snapshotId,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/published/${id}/feedback`,
      headers: user.headers,
      payload: {
        expectedCollectionVersion: 1,
        idempotencyKey: `submission-${++sequence}`,
        ...payload,
      },
    });
  const detail = () => app.inject({ url: path, headers: owner.headers });
  const moderate = (
    feedbackId: string,
    status: "included" | "excluded",
    expectedVersion = 1,
  ) =>
    app.inject({
      method: "PATCH",
      url: `${path}/feedback/${feedbackId}`,
      headers: owner.headers,
      payload: {
        status,
        reason: "Documented moderation reason",
        expectedVersion,
      },
    });
  const collection = (status: "open" | "closed", expectedVersion = 1) =>
    app.inject({
      method: "PATCH",
      url: `${path}/collection`,
      headers: owner.headers,
      payload: { status, expectedVersion },
    });
  return {
    app,
    store,
    owner,
    resident,
    project,
    base,
    snapshotId,
    path,
    publish,
    submit,
    detail,
    moderate,
    collection,
  };
}
async function grant(
  app: FastifyInstance,
  base: string,
  owner: Account,
  recipient: Account,
  role: string,
) {
  const current = await app.inject({
    url: `${base}/members`,
    headers: owner.headers,
  });
  if (
    current
      .json()
      .members.some(
        (member: { userId: string }) => member.userId === recipient.id,
      )
  ) {
    const result = await app.inject({
      method: "PATCH",
      url: `${base}/members/${recipient.id}`,
      headers: owner.headers,
      payload: { role, expectedAclVersion: current.json().access.aclVersion },
    });
    expect(result.statusCode).toBe(200);
  } else
    await acceptIdentityTestInvitation(
      app,
      owner,
      recipient,
      role,
      base.split("/").at(-1),
    );
  const switched = await app.inject({
    method: "POST",
    url: "/api/v1/auth/organization",
    headers: recipient.headers,
    payload: { organizationId: owner.organizationId },
  });
  expect(switched.statusCode).toBe(200);
}
const vote = { kind: "vote", vote: "support" };

describe("frozen public engagement and private accountable aggregation", () => {
  it("freezes validated survey definitions and exposes no private records, flags, or identities", async () => {
    const s = await setup();
    await s.submit({ kind: "comment", text: "A visible concern" });
    const publicView = (
      await s.app.inject(`/api/v1/published/${s.snapshotId}`)
    ).json();
    expect(publicView.engagement.config).toEqual(config);
    for (const key of [
      "organizationId",
      "projectId",
      "publicFeedback",
      "records",
      "audit",
      "engagementRequiresVersion",
    ])
      expect(publicView[key]).toBeUndefined();
    const meta = (
      await s.app.inject(`/api/v1/published/${s.snapshotId}/engagement`)
    ).json();
    expect(Object.keys(meta).sort()).toEqual(["collection", "config"]);
    expect(JSON.stringify(meta)).not.toContain(s.resident.id);
    const privateDetail = (await s.detail()).json();
    expect(privateDetail.records[0].respondentLabel).toBe("Account 1");
    expect(privateDetail.records[0].userId).toBeUndefined();
    expect(JSON.stringify(privateDetail)).not.toContain(s.resident.email);
    expect(JSON.stringify(privateDetail)).not.toContain(s.resident.id);
    const mutateConfig = await s.app.inject({
      method: "PATCH",
      url: `${s.path}/collection`,
      headers: s.owner.headers,
      payload: {
        expectedVersion: 1,
        status: "closed",
        config: { ...config, introduction: "Changed" },
      },
    });
    expect(mutateConfig.statusCode).toBe(400);
    const changedProject = await s.store.transaction((state) => {
      const record = state.projects[0];
      record.version++;
      record.project.name = "Later project name";
      record.project.scenarios.find(
        (r) => r.id === record.project.activeScenarioId,
      )!.name = "Later scenario name";
      return record.project;
    });
    expect(changedProject.name).toBe("Later project name");
    expect((await s.detail()).json().snapshot.projectName).not.toBe(
      "Later project name",
    );
    expect((await s.detail()).json().snapshot.engagement.config).toEqual(
      config,
    );
    const scenario = s.project.scenarios.find(
      (r) => r.id === s.project.activeScenarioId,
    )!;
    for (const engagement of [
      { ...config, questions: [...config.questions, config.questions[0]] },
      {
        ...config,
        questions: [{ ...config.questions[0], options: ["Same", "Same"] }],
      },
      { ...config, questions: [{ ...config.questions[0], options: ["Only"] }] },
      { ...config, questions: [{ ...config.questions[0], id: "__proto__" }] },
      {
        ...config,
        questions: Array.from({ length: 6 }, (_, i) => ({
          ...config.questions[0],
          id: `question${i}`,
        })),
      },
    ]) {
      const response = await s.app.inject({
        method: "POST",
        url: `${s.base}/publish`,
        headers: s.owner.headers,
        payload: {
          scenarioId: scenario.id,
          expectedRevision: scenario.revision,
          engagement,
        },
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("rejects object-prototype question IDs and safely skips absent optional answers in old data", async () => {
    const s = await setup();
    const scenario = s.project.scenarios.find(
      (r) => r.id === s.project.activeScenarioId,
    )!;
    for (const id of [
      ...Object.getOwnPropertyNames(Object.prototype),
      "prototype",
    ]) {
      const response = await s.app.inject({
        method: "POST",
        url: `${s.base}/publish`,
        headers: s.owner.headers,
        payload: {
          scenarioId: scenario.id,
          expectedRevision: scenario.revision,
          engagement: {
            ...config,
            questions: [
              {
                id,
                prompt: "Optional question",
                type: "text",
                required: false,
              },
            ],
          },
        },
      });
      expect(response.statusCode, `reserved question ID: ${id}`).toBe(400);
    }
    expect(
      (await s.submit({ kind: "survey", answers: { priority: "Homes" } }))
        .statusCode,
    ).toBe(201);
    const normal = (await s.detail())
      .json()
      .snapshot.aggregate.survey.questions.find(
        (q: { id: string }) => q.id === "why",
      );
    expect(normal).toMatchObject({
      answeredAccounts: 0,
      skippedAccounts: 1,
      textResponses: [],
    });
    // Old persisted definitions are still readable: inherited properties are never treated as actual answers.
    const legacyId = `legacy-${s.snapshotId}`;
    await s.store.transaction((state) => {
      const legacy = structuredClone(
        state.published.find((p) => p.id === s.snapshotId)!,
      );
      legacy.id = legacyId;
      legacy.engagement!.config.questions.push({
        id: "toString",
        prompt: "Legacy optional question",
        type: "text",
        required: false,
      });
      state.published.push(legacy);
      state.publicFeedback.push(
        ...state.publicFeedback
          .filter((record) => record.snapshotId === s.snapshotId)
          .map((record) => ({
            ...structuredClone(record),
            id: `legacy-${record.id}`,
            snapshotId: legacyId,
          })),
      );
    });
    const legacy = await s.app.inject({
      url: `${s.base}/engagement/${legacyId}`,
      headers: s.owner.headers,
    });
    expect(legacy.statusCode).toBe(200);
    expect(
      legacy
        .json()
        .snapshot.aggregate.survey.questions.find(
          (q: { id: string }) => q.id === "toString",
        ),
    ).toMatchObject({
      answeredAccounts: 0,
      skippedAccounts: 1,
      textResponses: [],
    });
  });

  it("requires authentication, CSRF, versions and idempotency, and handles close/reopen/revocation honestly", async () => {
    const s = await setup();
    const endpoint = `/api/v1/published/${s.snapshotId}/feedback`;
    expect(
      (await s.app.inject({ method: "POST", url: endpoint, payload: vote }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: endpoint,
          headers: { cookie: s.resident.headers.cookie },
          payload: vote,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: endpoint,
          headers: { ...s.resident.headers, origin: "https://evil.example" },
          payload: vote,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await s.app.inject({
          method: "POST",
          url: endpoint,
          headers: s.resident.headers,
          payload: vote,
        })
      ).json().error.code,
    ).toBe("ENGAGEMENT_VERSION_REQUIRED");
    const payload = { ...vote, idempotencyKey: "stable-retry-key" };
    const first = await s.submit(payload);
    expect(first.statusCode).toBe(201);
    expect((await s.collection("closed")).statusCode).toBe(200);
    const retry = await s.submit(payload);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      id: first.json().id,
      alreadySubmitted: true,
      collection: { status: "closed", version: 2 },
    });
    expect(
      (await s.submit({ ...payload, vote: "concern" })).json().error.code,
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect((await s.submit(vote)).json().error.code).toBe(
      "COLLECTION_CONFLICT",
    );
    expect(
      (await s.submit({ ...vote, expectedCollectionVersion: 2 })).json().error
        .code,
    ).toBe("COLLECTION_CLOSED");
    expect((await s.collection("open", 1)).json().error.code).toBe(
      "COLLECTION_CONFLICT",
    );
    expect(
      (await s.collection("open", 2)).json().engagement.collection.version,
    ).toBe(3);
    expect(
      (await s.submit({ ...vote, expectedCollectionVersion: 3 })).statusCode,
    ).toBe(201);
    expect(
      (
        await s.app.inject({
          method: "DELETE",
          url: `/api/v1/published/${s.snapshotId}`,
          headers: s.owner.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await s.submit({ ...vote, expectedCollectionVersion: 3 })).statusCode,
    ).toBe(404);
    expect(
      (await s.app.inject(`/api/v1/published/${s.snapshotId}/engagement`))
        .statusCode,
    ).toBe(404);
    expect((await s.collection("open", 4)).json().error.code).toBe(
      "PUBLICATION_REVOKED",
    );
    expect((await s.detail()).json().snapshot).toMatchObject({
      revokedAt: expect.any(String),
      engagement: { collection: { status: "closed" } },
    });
    expect(
      (
        await s.app.inject({
          url: `${s.path}/export?format=json`,
          headers: s.owner.headers,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("checks enabled controls, required/known answers, and exact multipart pins including holes", async () => {
    const s = await setup();
    for (const answers of [
      {},
      { priority: "" },
      { priority: "Invalid" },
      { priority: "Homes", invented: "answer" },
    ])
      expect((await s.submit({ kind: "survey", answers })).statusCode).toBe(
        400,
      );
    expect(
      (
        await s.submit({
          kind: "survey",
          answers: { priority: "Homes", why: "  Good streets  " },
        })
      ).json().response.answers,
    ).toEqual({ priority: "Homes", why: "Good streets" });
    for (const position of [
      [0.006, 0.006],
      [0.025, 0.012],
      [0.5, 0.5],
    ])
      expect(
        (await s.submit({ kind: "comment", text: "Here", position })).json()
          .error.code,
      ).toBe("PIN_OUTSIDE_STUDY_AREA");
    for (const position of [
      [0.01, 0.01],
      [0.032, 0.012],
    ])
      expect(
        (await s.submit({ kind: "comment", text: "Inside", position }))
          .statusCode,
      ).toBe(201);
    const pinsOnly = await s.publish({
      introduction: "Pins only",
      comments: false,
      votes: false,
      pins: true,
      questions: [],
    });
    expect((await s.submit(vote, s.resident, pinsOnly)).json().error.code).toBe(
      "FEEDBACK_DISABLED",
    );
    expect(
      (
        await s.submit(
          { kind: "comment", text: "No pin" },
          s.resident,
          pinsOnly,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await s.submit(
          { kind: "comment", text: "Pin", position: [0.01, 0.01] },
          s.resident,
          pinsOnly,
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await s.submit(
          { kind: "survey", answers: { priority: "Homes" } },
          s.resident,
          pinsOnly,
        )
      ).statusCode,
    ).toBe(403);
    const disabled = await s.publish({
      introduction: "Read only",
      comments: false,
      votes: false,
      pins: false,
      questions: [],
    });
    expect(
      (
        await s.app.inject({
          method: "PATCH",
          url: `${s.base}/engagement/${disabled}/collection`,
          headers: s.owner.headers,
          payload: { status: "open", expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await s.app.inject({
          url: `${s.base}/engagement`,
          headers: s.owner.headers,
        })
      ).json().snapshots,
    ).toHaveLength(3);
  });

  it("isolates project/tenant access and restricts moderation/lifecycle to current project owners", async () => {
    const s = await setup();
    const outsider = await account(s.app, "outsider");
    const comment = (
      await s.submit({ kind: "comment", text: "Please consider shade" })
    ).json();
    const readRoutes = [
      s.path,
      `${s.base}/engagement`,
      `${s.path}/export?format=json`,
      `${s.base}/feedback`,
    ];
    for (const url of readRoutes)
      expect(
        (await s.app.inject({ url, headers: outsider.headers })).statusCode,
      ).toBe(404);
    await grant(s.app, s.base, s.owner, s.resident, "viewer");
    for (const url of readRoutes)
      expect(
        (await s.app.inject({ url, headers: s.resident.headers })).statusCode,
      ).toBe(200);
    for (const request of [
      {
        url: `${s.path}/collection`,
        payload: { status: "closed", expectedVersion: 1 },
      },
      {
        url: `${s.path}/feedback/${comment.id}`,
        payload: { status: "excluded", reason: "A reason", expectedVersion: 1 },
      },
    ])
      expect(
        (
          await s.app.inject({
            method: "PATCH",
            headers: s.resident.headers,
            ...request,
          })
        ).statusCode,
      ).toBe(403);
    await grant(s.app, s.base, s.owner, s.resident, "editor");
    expect(
      (
        await s.app.inject({
          method: "PATCH",
          url: `${s.path}/collection`,
          headers: s.resident.headers,
          payload: { status: "closed", expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(403);
    await grant(s.app, s.base, s.owner, s.resident, "owner");
    expect(
      (
        await s.app.inject({
          method: "PATCH",
          url: `${s.path}/collection`,
          headers: s.resident.headers,
          payload: { status: "closed", expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(200);
    const members = (
      await s.app.inject({ url: `${s.base}/members`, headers: s.owner.headers })
    ).json();
    expect(
      (
        await s.app.inject({
          method: "DELETE",
          url: `${s.base}/members/${s.resident.id}`,
          headers: s.owner.headers,
          payload: { expectedAclVersion: members.access.aclVersion },
        })
      ).statusCode,
    ).toBe(200);
    for (const url of readRoutes)
      expect(
        (await s.app.inject({ url, headers: s.resident.headers })).statusCode,
      ).toBe(404);
    const second = (
      await s.app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: s.owner.headers,
        payload: { placeId: place.id },
      })
    ).json();
    expect(
      (
        await s.app.inject({
          url: `/api/v1/projects/${second.project.id}/engagement/${s.snapshotId}`,
          headers: s.owner.headers,
        })
      ).statusCode,
    ).toBe(404);
    const otherSnapshot = await s.publish();
    expect(
      (
        await s.app.inject({
          method: "PATCH",
          url: `${s.base}/engagement/${otherSnapshot}/feedback/${comment.id}`,
          headers: s.owner.headers,
          payload: {
            status: "excluded",
            reason: "Cross snapshot",
            expectedVersion: 1,
          },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await s.app.inject({
          url: `/api/v1/published/${s.snapshotId}/feedback/mine`,
          headers: outsider.headers,
        })
      ).json().responses,
    ).toEqual([]);
  });

  it("counts latest included account responses, retains moderation history, and exports complete frozen evidence", async () => {
    const s = await setup();
    const second = await account(s.app, "second");
    await s.submit(vote);
    const newVote = (await s.submit({ kind: "vote", vote: "concern" })).json();
    await s.submit(vote, second);
    await s.submit({
      kind: "survey",
      answers: { priority: "Parks", why: "Old response" },
    });
    const currentSurvey = (
      await s.submit({
        kind: "survey",
        answers: { priority: "Homes", why: "" },
      })
    ).json();
    await s.submit(
      { kind: "survey", answers: { priority: "Parks", why: "Shade" } },
      second,
    );
    await s.submit({
      kind: "comment",
      text: "First concern",
      position: [0.01, 0.01],
    });
    await s.submit({ kind: "comment", text: "Second concern" });
    let detail = (await s.detail()).json();
    expect(detail.snapshot.aggregate).toMatchObject({
      participatingAccounts: 2,
      includedRecords: 6,
      pendingIncludedRecords: 6,
      supersededRecords: 2,
      totalHistoricalRecords: 8,
      votes: { accounts: 2, support: 1, concern: 1, neutral: 0 },
      comments: { count: 2, accounts: 1, pinnedCount: 1 },
      survey: { accounts: 2 },
    });
    expect(detail.snapshot.aggregate.survey.questions[1]).toMatchObject({
      answeredAccounts: 1,
      skippedAccounts: 1,
      textResponses: [{ text: "Shade" }],
    });
    expect((await s.moderate(newVote.id, "excluded")).statusCode).toBe(200);
    expect(
      (await s.moderate(newVote.id, "included", 1)).json().error.code,
    ).toBe("MODERATION_CONFLICT");
    detail = (await s.detail()).json();
    expect(detail.snapshot.aggregate.votes).toEqual({
      accounts: 1,
      support: 1,
      concern: 0,
      neutral: 0,
    });
    expect(detail.snapshot.aggregate.excludedCurrentRecords).toBe(1);
    expect(detail.snapshot.aggregate.supersededRecords).toBe(2);
    expect((await s.moderate(newVote.id, "included", 2)).statusCode).toBe(200);
    expect((await s.moderate(currentSurvey.id, "excluded")).statusCode).toBe(
      200,
    );
    detail = (await s.detail()).json();
    expect(detail.records).toHaveLength(8);
    expect(detail.snapshot.aggregate.survey.accounts).toBe(1);
    expect(detail.snapshot.aggregate.survey.questions[0].options).toEqual([
      { option: "Homes", count: 0 },
      { option: "Parks", count: 1 },
    ]);
    expect(
      detail.audit.filter(
        (event: { action: string }) =>
          event.action === "engagement.response.moderated",
      ),
    ).toHaveLength(3);
    expect(
      detail.audit.find(
        (event: { details: { previous?: { status: string } } }) =>
          event.details.previous?.status === "excluded",
      ).details.moderation.status,
    ).toBe("included");
    const own = (
      await s.app.inject({
        url: `/api/v1/published/${s.snapshotId}/feedback/mine`,
        headers: s.resident.headers,
      })
    ).json();
    expect(own.responses).toHaveLength(6);
    expect(
      own.responses.find((r: { id: string }) => r.id === currentSurvey.id)
        .moderation,
    ).toMatchObject({ status: "excluded", version: 2 });
    expect(JSON.stringify(own)).not.toContain("Documented moderation reason");
    const report = (
      await s.app.inject({
        url: `${s.path}/export?format=json`,
        headers: s.owner.headers,
      })
    ).json() as EngagementReport;
    assertEngagementReport(report);
    expect(report.aggregate).toEqual(detail.snapshot.aggregate);
    expect(report.responses).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain(s.resident.id);
    expect(JSON.stringify(report)).not.toContain(s.resident.email);
    const csv = await s.app.inject({
      url: `${s.path}/export?format=csv`,
      headers: s.owner.headers,
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain("First concern");
    expect(csv.body).not.toContain("Old response");
    const pdf = await s.app.inject({
      url: `${s.path}/export?format=pdf`,
      headers: s.owner.headers,
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
    const records = (
      await s.app.inject({
        url: `${s.base}/exports?format=records`,
        headers: s.owner.headers,
      })
    ).json();
    expect(records.publicFeedback).toHaveLength(8);
    expect(
      records.publicFeedback.some(
        (r: { userId: string }) => r.userId === s.resident.id,
      ),
    ).toBe(true);
    expect(records.engagement[0].engagement.config).toEqual(config);
  });

  it("atomically admits retries and versioned moderation under concurrent requests", async () => {
    const s = await setup();
    const results = await Promise.all([
      s.submit({ ...vote, idempotencyKey: "same-request-key" }),
      s.submit({ ...vote, idempotencyKey: "same-request-key" }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    const more = await Promise.all([
      s.submit({ kind: "vote", vote: "concern" }),
      s.submit({ kind: "vote", vote: "neutral" }),
    ]);
    expect(more.every((r) => r.statusCode === 201)).toBe(true);
    expect((await s.detail()).json().snapshot.aggregate.votes.accounts).toBe(1);
    const current = more[1].json().id;
    const moderation = await Promise.all([
      s.moderate(current, "excluded"),
      s.moderate(current, "included"),
    ]);
    expect(moderation.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const collection = await Promise.all([
      s.collection("closed"),
      s.collection("closed"),
    ]);
    expect(collection.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await s.detail()).json().records).toHaveLength(3);
  });

  it("keeps each publication independent and revokes every publication when its project is deleted", async () => {
    const s = await setup();
    const second = await s.publish({
      ...config,
      questions: [
        {
          id: "different",
          prompt: "A different question",
          type: "text",
          required: true,
        },
      ],
    });
    await s.submit(vote);
    await s.submit({ kind: "vote", vote: "concern" }, s.resident, second);
    await s.collection("closed");
    expect(
      (
        await s.submit(
          { kind: "survey", answers: { different: "Answer" } },
          s.resident,
          second,
        )
      ).statusCode,
    ).toBe(201);
    const snapshots = (
      await s.app.inject({
        url: `${s.base}/engagement`,
        headers: s.owner.headers,
      })
    ).json().snapshots;
    expect(
      snapshots.find((p: { id: string }) => p.id === s.snapshotId).aggregate
        .votes.support,
    ).toBe(1);
    expect(
      snapshots.find((p: { id: string }) => p.id === second).aggregate.votes
        .concern,
    ).toBe(1);
    await s.app.inject({
      method: "DELETE",
      url: `/api/v1/published/${s.snapshotId}`,
      headers: s.owner.headers,
    });
    expect(
      (
        await s.app.inject({
          method: "DELETE",
          url: s.base,
          headers: s.owner.headers,
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(200);
    for (const id of [s.snapshotId, second])
      expect((await s.app.inject(`/api/v1/published/${id}`)).statusCode).toBe(
        404,
      );
    expect(await s.store.read((state) => state.publicFeedback.length)).toBe(3);
  });

  it("preserves legacy publications and durable moderation across reopen without inventing survey definitions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "urban-engagement-"));
    try {
      const path = join(dir, "state.json");
      const s = await setup(new FileStore(path));
      const legacyId = `legacy-${s.snapshotId}`;
      await s.store.transaction((state) => {
        const snapshot = structuredClone(
          state.published.find((p) => p.id === s.snapshotId)!,
        );
        snapshot.id = legacyId;
        snapshot.feedbackEnabled = true;
        delete snapshot.engagement;
        delete snapshot.engagementRequiresVersion;
        state.published.push(snapshot);
        state.publicFeedback.push({
          id: "legacy-survey",
          snapshotId: legacyId,
          userId: s.resident.id,
          kind: "survey",
          answers: { oldQuestion: "Legacy answer" },
          createdAt: "2026-11-01T00:00:00Z",
        });
      });
      const legacyVote = await s.app.inject({
        method: "POST",
        url: `/api/v1/published/${legacyId}/feedback`,
        headers: s.resident.headers,
        payload: vote,
      });
      expect(legacyVote.statusCode).toBe(201);
      const legacyPath = `${s.base}/engagement/${legacyId}`;
      expect(
        (
          await s.app.inject({
            method: "PATCH",
            url: `${legacyPath}/feedback/legacy-survey`,
            headers: s.owner.headers,
            payload: {
              expectedVersion: 1,
              status: "included",
              reason: "Retain historical evidence",
            },
          })
        ).statusCode,
      ).toBe(200);
      await s.app.close();
      apps.splice(apps.indexOf(s.app), 1);
      const reopened = await buildApp({
        store: new FileStore(path),
        catalog: { get: async () => place, list: async () => [place] },
        nationalPreparationEnabled: false,
      });
      apps.push(reopened);
      const detail = (
        await reopened.inject({ url: legacyPath, headers: s.owner.headers })
      ).json();
      expect(detail.snapshot.engagement.config).toEqual({
        introduction: "",
        comments: true,
        votes: true,
        pins: true,
        questions: [],
      });
      expect(
        detail.records.find((r: { id: string }) => r.id === "legacy-survey")
          .moderation,
      ).toMatchObject({
        status: "included",
        version: 2,
        reason: "Retain historical evidence",
      });
      const report = (
        await reopened.inject({
          url: `${legacyPath}/export?format=json`,
          headers: s.owner.headers,
        })
      ).json();
      assertEngagementReport(report);
      expect(
        report.notes.some((note: string) => note.includes("Legacy free-form")),
      ).toBe(true);
      expect(report.aggregate.survey.questions).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks logical legacy replacements as noncurrent without inventing timestamps", async () => {
    const s = await setup();
    await s.store.transaction((state) => {
      for (const [id, vote] of [
        ["legacy-first", "support"],
        ["legacy-second", "concern"],
      ] as const)
        state.publicFeedback.push({
          id,
          snapshotId: s.snapshotId,
          userId: s.resident.id,
          kind: "vote",
          vote,
          createdAt: "2026-11-01T00:00:00Z",
        });
    });
    const detail = (await s.detail()).json();
    expect(detail.snapshot.aggregate.votes).toEqual({
      accounts: 1,
      support: 0,
      concern: 1,
      neutral: 0,
    });
    expect(detail.snapshot.aggregate.supersededRecords).toBe(1);
    expect(detail.records[0]).toMatchObject({
      id: "legacy-first",
      current: false,
    });
    expect(detail.records[0].supersededAt).toBeUndefined();
    expect(detail.records[1].current).toBe(true);
    const own = (
      await s.app.inject({
        url: `/api/v1/published/${s.snapshotId}/feedback/mine`,
        headers: s.resident.headers,
      })
    ).json();
    expect(own.userId).toBe(s.resident.id);
    expect(own.responses.map((r: { current: boolean }) => r.current)).toEqual([
      false,
      true,
    ]);
    const report = (
      await s.app.inject({
        url: `${s.path}/export?format=json`,
        headers: s.owner.headers,
      })
    ).json();
    assertEngagementReport(report);
    expect(report.responses).toHaveLength(1);
  });

  it("protects moderation and collection writes with CSRF and rejects oversized reports explicitly", async () => {
    const s = await setup();
    const comment = (
      await s.submit({ kind: "comment", text: "A suggestion" })
    ).json();
    const headers = { cookie: s.owner.headers.cookie };
    expect(
      (
        await s.app.inject({
          method: "PATCH",
          url: `${s.path}/collection`,
          headers,
          payload: { status: "closed", expectedVersion: 1 },
        })
      ).json().error.code,
    ).toBe("CSRF_REQUIRED");
    expect(
      (
        await s.app.inject({
          method: "PATCH",
          url: `${s.path}/feedback/${comment.id}`,
          headers,
          payload: { status: "excluded", reason: "Reason", expectedVersion: 1 },
        })
      ).json().error.code,
    ).toBe("CSRF_REQUIRED");
    await s.store.transaction((state) => {
      for (let i = 0; i < 751; i++)
        state.publicFeedback.push({
          id: `bounded-comment-${i}`,
          snapshotId: s.snapshotId,
          userId: s.resident.id,
          kind: "comment",
          text: "Bounded report fixture",
          createdAt: "2026-11-01T00:00:00Z",
        });
    });
    const pdf = await s.app.inject({
      url: `${s.path}/export?format=pdf`,
      headers: s.owner.headers,
    });
    expect(pdf.statusCode).toBe(413);
    expect(pdf.json().error.code).toBe("ENGAGEMENT_REPORT_TOO_LARGE");
    const json = await s.app.inject({
      url: `${s.path}/export?format=json`,
      headers: s.owner.headers,
    });
    expect(json.statusCode).toBe(200);
    expect(json.json().comments).toHaveLength(752);
    expect((await s.detail()).json().records).toHaveLength(752);
  });

  it("captures report definitions, records, totals and moderation in one authorized read", async () => {
    class InterleavingStore extends FileStore {
      afterRead?: (state: DataState) => void;
      override async read<T>(
        operation: (state: DataState) => T,
        scope?: StoreScope,
      ): Promise<T> {
        const result = await super.read(operation, scope);
        const hook = this.afterRead;
        this.afterRead = undefined;
        if (hook) await super.transaction(hook);
        return result;
      }
    }
    const store = new InterleavingStore();
    const s = await setup(store);
    const submitted = (await s.submit(vote)).json();
    store.afterRead = (state) => {
      const r = state.publicFeedback.find((r) => r.id === submitted.id)!;
      r.moderation = {
        status: "excluded",
        version: 2,
        reason: "Concurrent moderation",
      };
    };
    const report = (
      await s.app.inject({
        url: `${s.path}/export?format=json`,
        headers: s.owner.headers,
      })
    ).json();
    assertEngagementReport(report);
    expect(report.aggregate.votes.accounts).toBe(1);
    expect(report.responses).toHaveLength(1);
    expect((await s.detail()).json().snapshot.aggregate.votes.accounts).toBe(0);
  });
});

describe("engagement scoped record loading", () => {
  it("keeps polling metadata-only and limits own history to the authenticated account and publication", async () => {
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
    const s = await setup(store);
    const other = await account(s.app, "unrelated-responder");
    expect((await s.submit(vote)).statusCode).toBe(201);
    expect(
      (
        await s.submit(
          { kind: "comment", text: "Another account's private response" },
          other,
        )
      ).statusCode,
    ).toBe(201);
    const otherSnapshot = await s.publish();
    expect(
      (
        await s.submit(
          { kind: "comment", text: "My other publication response" },
          s.resident,
          otherSnapshot,
        )
      ).statusCode,
    ).toBe(201);
    let checked = false;
    store.nextRead = (state) => {
      checked = true;
      expect(state.publishedHeaders.map((record) => record.id)).toEqual([
        s.snapshotId,
      ]);
      expect(state.publishedHeaders[0].baseline).not.toHaveProperty(
        "buildings",
      );
      expect(() => state.published).toThrow("not selected");
      expect(() => state.publicFeedback).toThrow("not selected");
      expect(() => state.sessions).toThrow("not selected");
    };
    const metadata = await s.app.inject({
      url: `/api/v1/published/${s.snapshotId}/engagement`,
    });
    expect(metadata.statusCode).toBe(200);
    expect(checked).toBe(true);
    store.nextRead = (state) => {
      expect(() => state.published).toThrow("not selected");
      expect(() => state.projects).toThrow("not selected");
      expect(
        state.publicFeedback.map((record) => [
          record.snapshotId,
          record.userId,
        ]),
      ).toEqual([[s.snapshotId, s.resident.id]]);
    };
    const mine = await s.app.inject({
      url: `/api/v1/published/${s.snapshotId}/feedback/mine`,
      headers: s.resident.headers,
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().responses).toHaveLength(1);
    store.nextRead = (state) => {
      expect(() => state.projects).toThrow("not selected");
      expect(() => state.published).toThrow("not selected");
      expect(state.publishedHeaders.map((record) => record.id)).toEqual([
        s.snapshotId,
      ]);
      expect(state.publicFeedback).toHaveLength(2);
      expect(
        state.publicFeedback.every(
          (record) => record.snapshotId === s.snapshotId,
        ),
      ).toBe(true);
    };
    const report = await s.app.inject({
      url: `${s.path}/export?format=json`,
      headers: s.owner.headers,
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().aggregate.participatingAccounts).toBe(2);
    expect(report.json().sources[0].id).toBe("fixture");
  });
});
