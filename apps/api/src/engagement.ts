import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { canonicalJSON, pointInStudyArea, type Source } from "@urban/core";
import type {
  EngagementAggregate,
  EngagementConfig,
  EngagementDashboard,
  EngagementPrivateRecord,
  EngagementReport,
  EngagementResponseRecord,
  EngagementSnapshotDetail,
  EngagementSnapshotSummary,
  PublicEngagement,
} from "../../../packages/core/src/engagement.js";
import { ApiError, notFound } from "./errors.js";
import {
  addAudit,
  type authorize,
  type DataState,
  type PublishedRecord,
  type PublicFeedbackRecord,
  type Store,
} from "./store.js";
import { projectAccess, findProjectHeader } from "./project-access.js";
import {
  requestScope,
  type PublishedHeader,
  type StoreScope,
} from "./store-scope.js";

type Identity = ReturnType<typeof authorize>;
type EngagementPublication = PublishedRecord | PublishedHeader;
const reservedQuestionIds = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);
const questionId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/)
  .refine(
    (id) => !reservedQuestionIds.has(id),
    "Choose a non-reserved question ID.",
  );
const question = z.discriminatedUnion("type", [
  z
    .object({
      id: questionId,
      prompt: z.string().trim().min(1).max(500),
      type: z.literal("single-choice"),
      required: z.boolean(),
      options: z
        .array(z.string().trim().min(1).max(200))
        .min(2)
        .max(8)
        .refine(
          (options) => new Set(options).size === options.length,
          "Choices must be unique.",
        ),
    })
    .strict(),
  z
    .object({
      id: questionId,
      prompt: z.string().trim().min(1).max(500),
      type: z.literal("text"),
      required: z.boolean(),
    })
    .strict(),
]);
export const engagementConfigSchema = z
  .object({
    introduction: z.string().trim().max(4000),
    comments: z.boolean(),
    votes: z.boolean(),
    pins: z.boolean(),
    questions: z
      .array(question)
      .max(5)
      .refine(
        (questions) =>
          new Set(questions.map((q) => q.id)).size === questions.length,
        "Question IDs must be unique.",
      ),
  })
  .strict();
const submissionCommon = {
  idempotencyKey: z.string().trim().min(8).max(160).optional(),
  expectedCollectionVersion: z.number().int().positive().optional(),
};
export const engagementSubmissionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...submissionCommon,
      kind: z.literal("comment"),
      text: z.string().trim().min(1).max(5000),
      position: z
        .tuple([
          z.number().finite().min(-180).max(180),
          z.number().finite().min(-90).max(90),
        ])
        .optional(),
    })
    .strict(),
  z
    .object({
      ...submissionCommon,
      kind: z.literal("vote"),
      vote: z.enum(["support", "concern", "neutral"]),
    })
    .strict(),
  z
    .object({
      ...submissionCommon,
      kind: z.literal("survey"),
      answers: z
        .record(z.string().max(64), z.string().trim().max(2000))
        .refine(
          (answers) => Object.keys(answers).length <= 5,
          "At most five answers are supported.",
        ),
    })
    .strict(),
]);
export const engagementCollectionSchema = z
  .object({
    status: z.enum(["open", "closed"]),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export const engagementModerationSchema = z
  .object({
    status: z.enum(["included", "excluded"]),
    reason: z.string().trim().min(1).max(1000),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export function engagementEnabled(config: EngagementConfig) {
  return (
    config.comments ||
    config.votes ||
    config.pins ||
    config.questions.length > 0
  );
}
export function initialEngagement(
  config: EngagementConfig | undefined,
  feedbackEnabled: boolean,
  at: string,
): PublicEngagement {
  const frozen = config ?? {
    introduction: "",
    comments: feedbackEnabled,
    votes: feedbackEnabled,
    pins: feedbackEnabled,
    questions: [],
  };
  return {
    config: structuredClone(frozen),
    collection: {
      status: engagementEnabled(frozen) ? "open" : "closed",
      version: 1,
      updatedAt: at,
    },
  };
}
/** Read-time legacy migration leaves original publication content and source hashes untouched. */
export function publicationEngagement(
  snapshot: EngagementPublication,
): PublicEngagement {
  const engagement = structuredClone(
    snapshot.engagement ??
      initialEngagement(
        undefined,
        snapshot.feedbackEnabled,
        snapshot.createdAt,
      ),
  );
  if (snapshot.revokedAt) engagement.collection.status = "closed";
  return engagement;
}
function activePublication(state: DataState, id: string, full = false) {
  const snapshot = (full ? state.published : state.publishedHeaders).find(
    (p) => p.id === id && !p.revokedAt,
  );
  if (!snapshot) throw notFound();
  return snapshot;
}
function responseRecord(
  record: PublicFeedbackRecord,
  privateReason = false,
  current = !record.supersededAt,
): EngagementResponseRecord {
  const moderation = structuredClone(
    record.moderation ?? { status: "pending" as const, version: 1 },
  );
  if (!privateReason) delete moderation.reason;
  return {
    id: record.id,
    snapshotId: record.snapshotId,
    kind: record.kind,
    ...(record.text !== undefined ? { text: record.text } : {}),
    ...(record.position ? { position: record.position } : {}),
    ...(record.vote ? { vote: record.vote } : {}),
    ...(record.answers ? { answers: record.answers } : {}),
    createdAt: record.createdAt,
    current,
    ...(record.supersededAt ? { supersededAt: record.supersededAt } : {}),
    moderation,
  };
}
function feedbackFor(state: DataState, snapshot: EngagementPublication) {
  return state.publicFeedback.filter(
    (record) => record.snapshotId === snapshot.id,
  );
}
/** Latest vote/survey wins even in a legacy document with duplicate unsuperseded records. */
function currentFeedback(records: PublicFeedbackRecord[]) {
  const latest = new Map<string, PublicFeedbackRecord>();
  for (const record of records)
    if (record.kind !== "comment")
      latest.set(`${record.userId}:${record.kind}`, record);
  return records.filter(
    (record) =>
      !record.supersededAt &&
      (record.kind === "comment" ||
        latest.get(`${record.userId}:${record.kind}`) === record),
  );
}
function includedFeedback(records: PublicFeedbackRecord[]) {
  return currentFeedback(records).filter(
    (record) => record.moderation?.status !== "excluded",
  );
}
const aggregationNotes = [
  "Counts describe participating signed-in accounts, not verified people, households, residents, or a representative sample. One person may control more than one account.",
  "Only the latest vote and latest survey from each account for this published snapshot are counted. Comments are individual records; comment accounts are counted separately.",
  "Pending moderation records are included and explicitly counted. Excluded and superseded records remain in private history and the full records export.",
  "Vote percentages use counted voting accounts. Each question uses its answered-account denominator; skipped accounts are counted among current survey participants, not all visitors.",
  "There is no visitor or population denominator, turnout estimate, or claim of representativeness.",
];
export function aggregateEngagement(
  snapshot: EngagementPublication,
  records: PublicFeedbackRecord[],
): EngagementAggregate {
  const current = currentFeedback(records);
  const included = includedFeedback(records);
  const comments = included.filter((r) => r.kind === "comment");
  const votes = included.filter((r) => r.kind === "vote");
  const config = publicationEngagement(snapshot).config;
  const surveys = included.filter((r) => r.kind === "survey");
  return {
    participatingAccounts: new Set(included.map((r) => r.userId)).size,
    includedRecords: included.length,
    pendingIncludedRecords: included.filter(
      (r) => !r.moderation || r.moderation.status === "pending",
    ).length,
    excludedCurrentRecords: current.filter(
      (r) => r.moderation?.status === "excluded",
    ).length,
    supersededRecords: records.length - current.length,
    totalHistoricalRecords: records.length,
    comments: {
      count: comments.length,
      accounts: new Set(comments.map((r) => r.userId)).size,
      pinnedCount: comments.filter((r) => r.position).length,
    },
    votes: {
      accounts: votes.length,
      support: votes.filter((r) => r.vote === "support").length,
      concern: votes.filter((r) => r.vote === "concern").length,
      neutral: votes.filter((r) => r.vote === "neutral").length,
    },
    survey: {
      accounts: surveys.length,
      questions: config.questions.map((q) => {
        const answers = surveys.flatMap((r) => {
          const raw =
            r.answers && Object.hasOwn(r.answers, q.id)
              ? r.answers[q.id]
              : undefined;
          const text = typeof raw === "string" ? raw.trim() : undefined;
          return text && (q.type === "text" || q.options?.includes(text))
            ? [text]
            : [];
        });
        return {
          id: q.id,
          prompt: q.prompt,
          type: q.type,
          answeredAccounts: answers.length,
          skippedAccounts: surveys.length - answers.length,
          ...(q.type === "single-choice"
            ? {
                options: q.options!.map((option) => ({
                  option,
                  count: answers.filter((answer) => answer === option).length,
                })),
              }
            : { textResponses: answers.map((text) => ({ text })) }),
        };
      }),
    },
    notes: [
      ...aggregationNotes,
      ...(included.some((r) => r.kind === "survey") && !config.questions.length
        ? [
            "Legacy free-form survey records have no frozen question definition. They remain in history and are not presented as configured survey results.",
          ]
        : []),
    ],
  };
}
export function engagementSummary(
  state: DataState,
  snapshot: EngagementPublication,
): EngagementSnapshotSummary {
  return {
    id: snapshot.id,
    url: `/shared/${snapshot.id}`,
    projectName: snapshot.projectName,
    placeName: snapshot.baseline.name,
    extentLabel: snapshot.baseline.extentLabel,
    scenarioId: snapshot.scenario.id,
    scenarioName: snapshot.scenario.name,
    scenarioRevision: snapshot.scenario.revision,
    createdAt: snapshot.createdAt,
    ...(snapshot.revokedAt ? { revokedAt: snapshot.revokedAt } : {}),
    engagement: publicationEngagement(snapshot),
    aggregate: aggregateEngagement(snapshot, feedbackFor(state, snapshot)),
  };
}
function respondentLabels(records: PublicFeedbackRecord[]) {
  const labels = new Map<string, string>();
  for (const record of records)
    if (!labels.has(record.userId))
      labels.set(record.userId, `Account ${labels.size + 1}`);
  return labels;
}
function snapshotAccess(
  state: DataState,
  request: FastifyRequest,
  auth: (state: DataState, request: FastifyRequest) => Identity,
  ownerOnly = false,
) {
  const identity = auth(state, request);
  const { id, snapshotId } = request.params as {
    id: string;
    snapshotId: string;
  };
  const record = findProjectHeader(
    state,
    identity.organization.id,
    id,
    identity.user.id,
    ownerOnly ? ["owner"] : undefined,
  );
  const snapshot = state.publishedHeaders.find(
    (p) =>
      p.id === snapshotId &&
      p.projectId === id &&
      p.organizationId === identity.organization.id,
  );
  if (!snapshot) throw notFound();
  return {
    identity,
    record,
    snapshot,
    access: projectAccess(record, identity.user.id, identity.membership)!,
  };
}
function snapshotDetail(
  state: DataState,
  snapshot: EngagementPublication,
  access: EngagementSnapshotDetail["access"],
): EngagementSnapshotDetail {
  const records = feedbackFor(state, snapshot);
  const labels = respondentLabels(records);
  const currentIds = new Set(currentFeedback(records).map((r) => r.id));
  return {
    projectId: snapshot.projectId,
    access,
    snapshot: engagementSummary(state, snapshot),
    records: records.map(
      (record): EngagementPrivateRecord => ({
        ...responseRecord(record, true, currentIds.has(record.id)),
        respondentLabel: labels.get(record.userId)!,
      }),
    ),
    audit: state.audit
      .filter(
        (event) =>
          event.projectId === snapshot.projectId &&
          event.organizationId === snapshot.organizationId &&
          event.details.snapshotId === snapshot.id,
      )
      .map(({ id, actorId, action, at, details }) => ({
        id,
        actorId:
          action === "engagement.submitted"
            ? (labels.get(actorId) ?? "Participant")
            : actorId,
        action,
        at,
        details,
      })),
  };
}
export function captureEngagementReport(
  state: DataState,
  snapshot: EngagementPublication,
): EngagementReport {
  const records = feedbackFor(state, snapshot);
  const included = includedFeedback(records);
  const labels = respondentLabels(records);
  const summary = engagementSummary(state, snapshot);
  const sources = new Map<string, Source>();
  for (const source of [
    ...snapshot.baseline.sources,
    ...(snapshot.scenario.sources ?? []),
  ])
    sources.set(source.id, source);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    snapshot: summary,
    aggregate: summary.aggregate,
    comments: included
      .filter((r) => r.kind === "comment")
      .map((r) => ({
        respondentLabel: labels.get(r.userId)!,
        text: r.text ?? "",
        ...(r.position ? { position: r.position } : {}),
        createdAt: r.createdAt,
        moderation:
          r.moderation?.status === "included" ? "included" : "pending",
      })),
    responses: included
      .filter((r) => r.kind !== "comment")
      .map((r) => ({
        kind: r.kind as "vote" | "survey",
        respondentLabel: labels.get(r.userId)!,
        createdAt: r.createdAt,
        moderation:
          r.moderation?.status === "included" ? "included" : "pending",
        ...(r.vote ? { vote: r.vote } : {}),
        ...(r.answers ? { answers: r.answers } : {}),
      })),
    sources: [...sources.values()],
    notes: [
      ...summary.aggregate.notes,
      "This report captures a single published scenario and its engagement records atomically at the generation time. Closing collection does not alter the frozen scenario or survey questions.",
      "Account labels are pseudonyms local to this publication. Respondent-written comments and answers are retained verbatim and may contain personal information; no automatic personal-information redaction is performed.",
      "Only current included and pending responses appear here. Full private records retain superseded/excluded submissions and moderation history.",
    ],
  };
}
function validateSubmission(
  snapshot: EngagementPublication,
  input: z.infer<typeof engagementSubmissionSchema>,
) {
  const { config } = publicationEngagement(snapshot);
  if (input.kind === "comment") {
    if (input.position ? !config.pins : !config.comments)
      throw new ApiError(
        403,
        "FEEDBACK_DISABLED",
        input.position
          ? "Location comments are disabled for this publication."
          : "General comments are disabled for this publication.",
      );
    if (input.position && !("boundary" in snapshot.baseline))
      throw new Error(
        "A pinned response requires the captured publication boundary scope.",
      );
    if (
      input.position &&
      "boundary" in snapshot.baseline &&
      !pointInStudyArea(input.position, snapshot.baseline)
    )
      throw new ApiError(
        422,
        "PIN_OUTSIDE_STUDY_AREA",
        "Place your pin inside this publication's study boundary; holes and areas between disconnected parts are excluded.",
      );
  } else if (input.kind === "vote") {
    if (!config.votes)
      throw new ApiError(
        403,
        "FEEDBACK_DISABLED",
        "Voting is disabled for this publication.",
      );
  } else {
    if (!config.questions.length)
      throw new ApiError(
        403,
        "FEEDBACK_DISABLED",
        "This publication has no configured survey questions.",
      );
    const ids = new Set(config.questions.map((q) => q.id));
    if (Object.keys(input.answers).some((id) => !ids.has(id)))
      throw new ApiError(
        400,
        "SURVEY_ANSWER_INVALID",
        "Answers must refer only to this publication's questions.",
      );
    for (const q of config.questions) {
      const answer = Object.hasOwn(input.answers, q.id)
        ? input.answers[q.id].trim()
        : "";
      if (q.required && !answer)
        throw new ApiError(
          400,
          "SURVEY_ANSWER_REQUIRED",
          `Answer the required question: ${q.prompt}`,
          { questionId: q.id },
        );
      if (answer && q.type === "single-choice" && !q.options!.includes(answer))
        throw new ApiError(
          400,
          "SURVEY_ANSWER_INVALID",
          "Choose one of the published options.",
          { questionId: q.id },
        );
    }
    if (!Object.values(input.answers).some((answer) => answer.trim()))
      throw new ApiError(
        400,
        "SURVEY_ANSWER_REQUIRED",
        "Provide at least one survey answer.",
      );
  }
}
function publicationScope(
  request: FastifyRequest,
  ownFeedback = false,
  full = false,
  write = false,
): StoreScope {
  const snapshotId = (request.params as { id: string }).id;
  const scope: StoreScope = {
    publicSnapshotId: snapshotId,
    ...(full
      ? { published: { where: [{ id: snapshotId }] } }
      : { publishedHeaders: { where: [{ id: snapshotId }] } }),
    ...(ownFeedback
      ? {
          publicFeedback: {
            where: [{ snapshotId, userId: { auth: "userId" } }],
          },
        }
      : {}),
    ...(write ? { audit: { append: true } } : {}),
  };
  return ownFeedback || write ? requestScope(request, scope) : scope;
}
function projectEngagementScope(
  request: FastifyRequest,
  detail = false,
  audit: "none" | "append" | "history" = "none",
): StoreScope {
  const { id, snapshotId } = request.params as {
    id: string;
    snapshotId?: string;
  };
  return requestScope(request, {
    projectHeaders: {
      where: [{ id, organizationId: { auth: "organizationId" } }],
    },
    publishedHeaders: {
      where: [
        {
          projectId: id,
          organizationId: { auth: "organizationId" },
          ...(detail && snapshotId ? { id: snapshotId } : {}),
        },
      ],
    },
    publicFeedback: {
      where: [{ snapshotId: { from: "publishedHeaders", field: "id" } }],
    },
    ...(audit === "append"
      ? { audit: { append: true } }
      : audit === "history"
        ? {
            audit: {
              where: [
                {
                  projectId: id,
                  organizationId: { auth: "organizationId" },
                  ...(detail && snapshotId ? { snapshotId } : {}),
                },
              ],
            },
          }
        : {}),
  });
}

export function registerEngagementRoutes(
  app: FastifyInstance,
  options: {
    store: Store;
    auth: (state: DataState, request: FastifyRequest) => Identity;
  },
) {
  const { store, auth } = options;
  const prefix = "/api/v1";
  app.get(`${prefix}/published/:id/engagement`, async (request) =>
    store.read(
      (state) =>
        publicationEngagement(
          activePublication(state, (request.params as { id: string }).id),
        ),
      publicationScope(request),
    ),
  );
  app.get(`${prefix}/published/:id/feedback/mine`, async (request) =>
    store.read(
      (state) => {
        const identity = auth(state, request);
        const snapshot = activePublication(
          state,
          (request.params as { id: string }).id,
        );
        const currentIds = new Set(
          currentFeedback(feedbackFor(state, snapshot)).map((r) => r.id),
        );
        return {
          userId: identity.user.id,
          snapshotId: snapshot.id,
          engagement: publicationEngagement(snapshot),
          responses: feedbackFor(state, snapshot)
            .filter((r) => r.userId === identity.user.id)
            .map((r) => responseRecord(r, false, currentIds.has(r.id))),
        };
      },
      publicationScope(request, true),
    ),
  );
  app.post(
    `${prefix}/published/:id/feedback`,
    {
      bodyLimit: 32 * 1024,
      config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const input = engagementSubmissionSchema.parse(request.body);
      const result = await store.transaction(
        (state) => {
          const identity = auth(state, request);
          const snapshot = activePublication(
            state,
            (request.params as { id: string }).id,
            input.kind === "comment" && !!input.position,
          );
          const engagement = publicationEngagement(snapshot);
          if (
            snapshot.engagementRequiresVersion &&
            (!input.idempotencyKey ||
              input.expectedCollectionVersion === undefined)
          )
            throw new ApiError(
              400,
              "ENGAGEMENT_VERSION_REQUIRED",
              "Send the collection version and a unique submission key.",
            );
          const requestHash = createHash("sha256")
            .update(canonicalJSON(input))
            .digest("hex");
          const previous =
            input.idempotencyKey &&
            state.publicFeedback.find(
              (r) =>
                r.snapshotId === snapshot.id &&
                r.userId === identity.user.id &&
                r.idempotencyKey === input.idempotencyKey,
            );
          if (previous) {
            if (previous.requestHash !== requestHash)
              throw new ApiError(
                409,
                "IDEMPOTENCY_CONFLICT",
                "This submission key was already used for different content. Use a new key for a new response.",
              );
            return {
              id: previous.id,
              createdAt: previous.createdAt,
              alreadySubmitted: true,
              collection: engagement.collection,
              response: responseRecord(
                previous,
                false,
                currentFeedback(feedbackFor(state, snapshot)).some(
                  (r) => r.id === previous.id,
                ),
              ),
            };
          }
          if (
            input.expectedCollectionVersion !== undefined &&
            input.expectedCollectionVersion !== engagement.collection.version
          )
            throw new ApiError(
              409,
              "COLLECTION_CONFLICT",
              "Collection settings changed. Review the current status before submitting again.",
              { collection: engagement.collection },
            );
          if (engagement.collection.status !== "open")
            throw new ApiError(
              409,
              "COLLECTION_CLOSED",
              "Feedback collection is closed for this publication.",
              { collection: engagement.collection },
            );
          validateSubmission(snapshot, input);
          const createdAt = new Date().toISOString();
          if (input.kind !== "comment")
            for (const old of state.publicFeedback.filter(
              (r) =>
                r.snapshotId === snapshot.id &&
                r.userId === identity.user.id &&
                r.kind === input.kind &&
                !r.supersededAt,
            ))
              old.supersededAt = createdAt;
          const { expectedCollectionVersion: _version, ...payload } = input;
          const record: PublicFeedbackRecord = {
            ...payload,
            id: randomUUID(),
            snapshotId: snapshot.id,
            userId: identity.user.id,
            createdAt,
            requestHash,
            moderation: { status: "pending", version: 1 },
          };
          state.publicFeedback.push(record);
          // Account identity remains in the private source record; participant names are never copied into project audit.
          addAudit(state, {
            organizationId: snapshot.organizationId,
            projectId: snapshot.projectId,
            actorId: identity.user.id,
            action: "engagement.submitted",
            details: {
              snapshotId: snapshot.id,
              feedbackId: record.id,
              kind: record.kind,
            },
          });
          return {
            id: record.id,
            createdAt,
            alreadySubmitted: false,
            collection: engagement.collection,
            response: responseRecord(record),
          };
        },
        publicationScope(
          request,
          true,
          input.kind === "comment" && !!input.position,
          true,
        ),
      );
      return reply.code(result.alreadySubmitted ? 200 : 201).send(result);
    },
  );
  app.get(`${prefix}/projects/:id/engagement`, async (request) =>
    store.read((state): EngagementDashboard => {
      const identity = auth(state, request);
      const { id } = request.params as { id: string };
      const record = findProjectHeader(
        state,
        identity.organization.id,
        id,
        identity.user.id,
      );
      return {
        projectId: id,
        access: projectAccess(record, identity.user.id, identity.membership)!,
        snapshots: state.publishedHeaders
          .filter(
            (p) =>
              p.projectId === id &&
              p.organizationId === identity.organization.id,
          )
          .map((p) => engagementSummary(state, p))
          .reverse(),
      };
    }, projectEngagementScope(request)),
  );
  app.get(`${prefix}/projects/:id/engagement/:snapshotId`, async (request) =>
    store.read(
      (state) => {
        const { snapshot, access } = snapshotAccess(state, request, auth);
        return snapshotDetail(state, snapshot, access);
      },
      projectEngagementScope(request, true, "history"),
    ),
  );
  app.patch(
    `${prefix}/projects/:id/engagement/:snapshotId/collection`,
    { bodyLimit: 4096 },
    async (request) => {
      const input = engagementCollectionSchema.parse(request.body);
      return store.transaction(
        (state) => {
          const { snapshot, identity } = snapshotAccess(
            state,
            request,
            auth,
            true,
          );
          if (snapshot.revokedAt)
            throw new ApiError(
              409,
              "PUBLICATION_REVOKED",
              "A revoked publication cannot reopen collection. Publish a new snapshot instead.",
            );
          const engagement = publicationEngagement(snapshot);
          if (engagement.collection.version !== input.expectedVersion)
            throw new ApiError(
              409,
              "COLLECTION_CONFLICT",
              "Collection settings changed. Refresh before changing them.",
              { collection: engagement.collection },
            );
          if (input.status === "open" && !engagementEnabled(engagement.config))
            throw new ApiError(
              409,
              "FEEDBACK_DISABLED",
              "This frozen publication has no feedback controls. Publish a new snapshot to add them.",
            );
          const previousStatus = engagement.collection.status;
          engagement.collection = {
            status: input.status,
            version: engagement.collection.version + 1,
            updatedAt: new Date().toISOString(),
          };
          snapshot.engagement = engagement;
          addAudit(state, {
            organizationId: snapshot.organizationId,
            projectId: snapshot.projectId,
            actorId: identity.user.id,
            action: "engagement.collection.changed",
            details: {
              snapshotId: snapshot.id,
              previousStatus,
              status: input.status,
              version: engagement.collection.version,
            },
          });
          return engagementSummary(state, snapshot);
        },
        projectEngagementScope(request, true, "append"),
      );
    },
  );
  app.patch(
    `${prefix}/projects/:id/engagement/:snapshotId/feedback/:feedbackId`,
    { bodyLimit: 8192 },
    async (request) => {
      const input = engagementModerationSchema.parse(request.body);
      return store.transaction(
        (state) => {
          const { snapshot, identity, access } = snapshotAccess(
            state,
            request,
            auth,
            true,
          );
          const { feedbackId } = request.params as { feedbackId: string };
          const record = state.publicFeedback.find(
            (r) => r.id === feedbackId && r.snapshotId === snapshot.id,
          );
          if (!record) throw notFound();
          const previous = record.moderation ?? {
            status: "pending" as const,
            version: 1,
          };
          if (previous.version !== input.expectedVersion)
            throw new ApiError(
              409,
              "MODERATION_CONFLICT",
              "This response was moderated by someone else. Refresh before changing it.",
              { moderation: previous },
            );
          record.moderation = {
            status: input.status,
            reason: input.reason,
            version: previous.version + 1,
            updatedAt: new Date().toISOString(),
          };
          addAudit(state, {
            organizationId: snapshot.organizationId,
            projectId: snapshot.projectId,
            actorId: identity.user.id,
            action: "engagement.response.moderated",
            details: {
              snapshotId: snapshot.id,
              feedbackId,
              previous,
              moderation: record.moderation,
            },
          });
          return snapshotDetail(state, snapshot, access);
        },
        projectEngagementScope(request, true, "history"),
      );
    },
  );
  app.get(
    `${prefix}/projects/:id/engagement/:snapshotId/export`,
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { format } = z
        .object({ format: z.enum(["pdf", "csv", "json"]) })
        .parse(request.query);
      const report = await store.read(
        (state) => {
          const { snapshot } = snapshotAccess(state, request, auth);
          return captureEngagementReport(state, snapshot);
        },
        projectEngagementScope(request, true),
      );
      const name = `urban-planning-engagement-${report.snapshot.id.replace(/[^a-z0-9_-]/gi, "-")}`;
      reply
        .header(
          "Content-Disposition",
          `attachment; filename="${name}.${format}"`,
        )
        .header(
          "X-Collection-Version",
          report.snapshot.engagement.collection.version,
        );
      if (format === "json") return reply.send(report);
      const { renderEngagementPdf, exportEngagementCsv } = await import(
        "./engagement-report.js"
      );
      try {
        return format === "pdf"
          ? reply
              .type("application/pdf")
              .send(await renderEngagementPdf(report))
          : reply
              .type("text/csv; charset=utf-8")
              .send(exportEngagementCsv(report));
      } catch (error) {
        const candidate = error as {
          code?: string;
          statusCode?: number;
          message?: string;
        };
        if (
          candidate.code === "ENGAGEMENT_REPORT_TOO_LARGE" ||
          candidate.code === "ENGAGEMENT_REPORT_BUSY"
        ) {
          if (candidate.code === "ENGAGEMENT_REPORT_BUSY")
            reply.header("Retry-After", "10");
          throw new ApiError(
            candidate.code === "ENGAGEMENT_REPORT_BUSY" ? 503 : 413,
            candidate.code,
            candidate.message ??
              "The engagement report cannot be generated right now.",
          );
        }
        throw error;
      }
    },
  );
  // Backward-compatible private feedback read, now pseudonymous and still subject to current project ACL.
  app.get(`${prefix}/projects/:id/feedback`, async (request) =>
    store.read((state) => {
      const identity = auth(state, request);
      const { id } = request.params as { id: string };
      findProjectHeader(state, identity.organization.id, id, identity.user.id);
      const snapshots = state.publishedHeaders.filter(
        (p) =>
          p.projectId === id && p.organizationId === identity.organization.id,
      );
      return {
        feedback: snapshots.flatMap((snapshot) => {
          const records = feedbackFor(state, snapshot);
          const labels = respondentLabels(records);
          const currentIds = new Set(currentFeedback(records).map((r) => r.id));
          return records.map((record) => ({
            ...responseRecord(record, true, currentIds.has(record.id)),
            respondentLabel: labels.get(record.userId)!,
          }));
        }),
        snapshotCount: snapshots.length,
      };
    }, projectEngagementScope(request)),
  );
}
