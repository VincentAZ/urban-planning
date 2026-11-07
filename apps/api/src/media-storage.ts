import { assertBudgetCostEvidence, budgetDashboard } from "./budget.js";
import { canonicalJSON } from "@urban/core";
import type { EntityName, StoreScope } from "./store-scope.js";
import type { StoreChanges } from "./storage-core.js";
import { projectAccess } from "./project-access.js";
/** SQLite parity for media mutations; undefined scope is an explicit trusted operator operation. */
export function assertMediaStorageChanges(
  changes: StoreChanges,
  scope: StoreScope | undefined,
  read: (collection: EntityName) => any[],
) {
  if (
    !scope ||
    !changes.upserts.some(
      (r) =>
        ["mediaJobs", "mediaArtifacts"].includes(r.collection) ||
        (r.collection === "nativeCapacity" &&
          ((r.header.slot as any)?.kind === "media" ||
            read("nativeCapacity")[0]?.slot?.kind === "media")),
    )
  )
    return;
  const cache = new Map<EntityName, any[]>();
  const before = (c: EntityName) => {
    if (!cache.has(c)) cache.set(c, read(c));
    return cache.get(c)!;
  };
  const id = (c: EntityName, r: any) =>
    c === "nativeCapacity"
      ? "nativeCapacity"
      : (r.id ??
        r.hash ??
        r.project?.id ??
        canonicalJSON([r.userId, r.organizationId]));
  const after = (c: EntityName) => {
    const rows = new Map(before(c).map((r) => [id(c, r), r]));
    for (const r of changes.upserts)
      if (r.collection === c)
        rows.set(r.id, {
          ...r.header,
          ...(r.payload && typeof r.payload === "object" ? r.payload : {}),
        });
    return [...rows.values()];
  };
  const same = (a: unknown, b: unknown) =>
    canonicalJSON(a ?? null) === canonicalJSON(b ?? null);
  const without = (r: any, keys: string[]) =>
    Object.fromEntries(
      Object.entries(r ?? {}).filter(([k]) => !keys.includes(k)),
    );
  const fail = (m: string): never => {
    throw new Error(`Media storage: ${m}`);
  };
  const session = before("sessions").find(
      (s) =>
        s.hash === scope.auth?.sessionHash &&
        Date.parse(s.expiresAt) > Date.now(),
    ),
    user =
      session &&
      before("users").find(
        (u) =>
          u.id === session.userId &&
          (u.credentialVersion ?? 0) === (session.credentialVersion ?? 0),
      );
  const role = (projectId: string, userId?: string) => {
    const p = before("projects").find((p) => p.project.id === projectId),
      m = before("memberships").find(
        (m) => m.userId === userId && m.organizationId === p?.organizationId,
      );
    return p && m ? projectAccess(p, userId!, m) : null;
  };
  const worker =
    scope.security?.mode === "worker" && scope.security.purpose === "media";
  const canEdit = (j: any) => {
    const p = before("projects").find(
      (p) =>
        p.project.id === j.projectId && p.organizationId === j.organizationId,
    );
    return (
      p &&
      role(j.projectId, j.userId)?.canEdit &&
      p.project.scenarios.some((s: any) => s.id === j.scenarioId)
    );
  };
  for (const r of changes.upserts) {
    if (!["mediaJobs", "mediaArtifacts"].includes(r.collection)) continue;
    const j = r.header as any,
      old = before(r.collection).find((x) => x.id === r.id),
      p = before("projects").find(
        (p) =>
          p.project.id === j.projectId && p.organizationId === j.organizationId,
      );
    if (
      !p ||
      j.id !== r.id ||
      j.organizationId !== r.indexes.organizationId ||
      j.projectId !== r.indexes.projectId ||
      j.userId !== r.indexes.userId ||
      r.payload !== null ||
      Buffer.byteLength(canonicalJSON(j)) > 65536
    )
      fail("invalid bounded identity indexes");
    const reference = r.collection === "mediaArtifacts" ? j.archive : j.input;
    if (
      !reference ||
      typeof reference.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(reference.sha256) ||
      !Number.isSafeInteger(reference.bytes) ||
      reference.bytes < 1 ||
      reference.bytes > 268435456 ||
      !Number.isInteger(reference.fileCount) ||
      reference.fileCount < 1 ||
      reference.fileCount > 64
    )
      fail("invalid complete archive reference");
    if (r.collection === "mediaArtifacts") {
      if (
        !Array.isArray(j.files) ||
        j.files.length < 4 ||
        j.files.length > 7 ||
        new Set(j.files.map((f: any) => f.name)).size !== j.files.length ||
        j.files.some(
          (f: any) =>
            typeof f.name !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(f.name) ||
            f.name.includes("..") ||
            !/^[a-f0-9]{64}$/.test(f.sha256) ||
            !Number.isSafeInteger(f.bytes) ||
            f.bytes < 1 ||
            typeof f.contentType !== "string",
        )
      )
        fail("invalid artifact inventory");

      const job = after("mediaJobs").find((x) => x.id === j.jobId);
      if (
        old ||
        !worker ||
        !job ||
        job.status !== "completed" ||
        job.cancelRequested ||
        !canEdit(job) ||
        j.projectId !== job.projectId ||
        j.organizationId !== job.organizationId ||
        j.userId !== job.userId ||
        !same(j.sceneHash, job.sceneHash) ||
        !same(j.requestHash, job.requestHash) ||
        !same(j.runtimeIdentity, job.runtimeIdentity) ||
        job.result?.artifactId !== j.id ||
        job.result?.archiveHash !== j.archive?.sha256 ||
        !same(job.result?.files, j.files)
      )
        fail(
          "artifact must append atomically with exact authorized completed job",
        );
      continue;
    }
    if (
      !["queued", "running", "completed", "failed", "cancelled"].includes(
        j.status,
      ) ||
      !Number.isInteger(j.attempt) ||
      j.attempt < 0 ||
      j.attempt > 3 ||
      !Array.isArray(j.attempts) ||
      j.attempts.length !== j.attempt ||
      !Array.isArray(j.requestKeys) ||
      typeof j.cancelRequested !== "boolean" ||
      !Number.isInteger(j.totalFrames) ||
      j.totalFrames < 1 ||
      j.totalFrames > 30000 ||
      !Number.isInteger(j.completedFrames) ||
      j.completedFrames < 0 ||
      j.completedFrames > j.totalFrames
    )
      fail("invalid job state or frames");
    if (
      new Set(j.requestKeys).size !== j.requestKeys.length ||
      j.requestKeys.some(
        (key: any) =>
          typeof key !== "string" || key.length < 8 || key.length > 160,
      ) ||
      before("mediaJobs").some(
        (other) =>
          other.id !== j.id &&
          other.userId === j.userId &&
          other.projectId === j.projectId &&
          other.requestKeys.some((key: string) => j.requestKeys.includes(key)),
      )
    )
      fail("request keys cannot be duplicated or reassigned");
    if (!old) {
      const s = p.project.scenarios.find((s: any) => s.id === j.scenarioId);
      if (
        !worker ||
        !user ||
        user.id !== j.userId ||
        !canEdit(j) ||
        j.status !== "queued" ||
        j.attempt !== 0 ||
        j.version !== 1 ||
        j.completedFrames !== 0 ||
        j.stage !== "queued" ||
        j.cancelRequested ||
        ["workerId", "leaseExpiresAt", "capacityToken", "result", "error"].some(
          (k) => Object.hasOwn(j, k),
        ) ||
        p.version !== j.projectVersion ||
        p._baselineHash !== j.baselineHash ||
        s?.revision !== j.scenarioRevision ||
        !same(j.requestKeys, [j.idempotencyKey]) ||
        !/^[a-f0-9]{64}$/.test(j.input?.sha256)
      )
        fail("admission requires authenticated editor and exact saved version");
    } else {
      const mutable = [
        "version",
        "status",
        "stage",
        "completedFrames",
        "attempt",
        "attempts",
        "cancelRequested",
        "workerId",
        "leaseExpiresAt",
        "capacityToken",
        "error",
        "result",
        "updatedAt",
        "requestKeys",
      ];
      if (
        old.status === "completed" ||
        !same(without(j, mutable), without(old, mutable))
      )
        fail("admitted inputs and completed records are immutable");
      const allowed: Record<string, string[]> = {
        queued: ["queued", "running", "failed", "cancelled"],
        running: ["running", "completed", "failed", "cancelled"],
        failed: ["queued"],
        cancelled: ["queued"],
      };
      if (!allowed[old.status]?.includes(j.status)) fail("invalid transition");
      const nextVersion =
        old.version +
        (old.status !== j.status ||
        old.cancelRequested !== j.cancelRequested ||
        !same(old.requestKeys, j.requestKeys)
          ? 1
          : 0);
      if (j.version !== nextVersion) fail("transition version mismatch");
      if (!worker) {
        if (
          scope.security ||
          !user ||
          !role(j.projectId, user.id)?.canEdit ||
          !["queued", "running"].includes(old.status) ||
          j.cancelRequested !== true ||
          j.status !== (old.status === "queued" ? "cancelled" : "running") ||
          !same(
            without(j, ["version", "status", "cancelRequested", "updatedAt"]),
            without(old, ["version", "status", "cancelRequested", "updatedAt"]),
          )
        )
          fail("web role can only request cancellation");
      } else if (["failed", "cancelled"].includes(old.status)) {
        if (
          !user ||
          !role(j.projectId, user.id)?.canEdit ||
          !canEdit(j) ||
          old.attempt >= 3 ||
          old.error?.retryable === false ||
          j.cancelRequested ||
          j.requestKeys.length !== old.requestKeys.length + 1 ||
          !same(j.requestKeys.slice(0, -1), old.requestKeys) ||
          !same(
            without(j, [
              "version",
              "status",
              "stage",
              "completedFrames",
              "cancelRequested",
              "updatedAt",
              "requestKeys",
              "error",
            ]),
            without(old, [
              "version",
              "status",
              "stage",
              "completedFrames",
              "cancelRequested",
              "updatedAt",
              "requestKeys",
              "error",
            ]),
          )
        )
          fail("retry requires exact input and authenticated editor");
      } else {
        if (!same(j.requestKeys, old.requestKeys))
          fail("request keys only change on explicit retry");
        if (old.status === "queued" && j.status === "running") {
          if (
            j.attempt !== old.attempt + 1 ||
            !canEdit(j) ||
            j.cancelRequested ||
            !j.workerId ||
            !j.capacityToken ||
            !j.leaseExpiresAt ||
            j.attempts.at(-1)?.number !== j.attempt ||
            j.attempts.at(-1)?.admission?.incrementalExternalCents !== 0
          )
            fail("start must consume exact fixed-capacity attempt");
        } else if (j.attempt !== old.attempt)
          fail("only start consumes attempts");
        for (let i = 0; i < old.attempts.length; i++) {
          const a = old.attempts[i],
            b = j.attempts[i];
          if (old.status === "running" && i === old.attempt - 1) {
            if (
              !same(
                without(a, ["endedAt", "outcome", "elapsedMilliseconds"]),
                without(b, ["endedAt", "outcome", "elapsedMilliseconds"]),
              ) ||
              (j.status === "running" && !same(a, b))
            )
              fail("attempt evidence cannot change");
          } else if (!same(a, b)) fail("past attempts are immutable");
        }
        if (
          old.status === "running" &&
          j.status === "running" &&
          (j.workerId !== old.workerId ||
            j.capacityToken !== old.capacityToken ||
            j.completedFrames < old.completedFrames)
        )
          fail("progress retains worker identity and monotone frames");
      }
    }
    if (
      !old ||
      (old.status !== "queued" && j.status === "queued") ||
      (old.status === "queued" && j.status === "running")
    ) {
      const budget = before("budget")[0],
        dashboard = budgetDashboard(budget);
      assertBudgetCostEvidence(budget);
      if (
        budget.policy.paidOperationsPaused ||
        dashboard.totals.availableCents <= 0
      )
        fail("fresh reviewed budget headroom required");
      const others = before("mediaJobs").filter(
        (x) => x.id !== j.id && ["queued", "running"].includes(x.status),
      );
      if (
        others.length >= 10 ||
        others.some((x) => x.userId === j.userId) ||
        before("mediaJobs")
          .filter((x) => x.userId === j.userId)
          .flatMap((x) => x.attempts)
          .filter((x) =>
            x.startedAt.startsWith(new Date().toISOString().slice(0, 10)),
          ).length >= 3
      )
        fail("shared fair-use limit reached");
      if (j.status === "running") {
        const cost = j.attempts.at(-1)?.admission,
          model = cost?.costModel;
        if (
          cost?.budgetPolicyVersion !== budget.policy.version ||
          cost?.period !== dashboard.period ||
          cost?.incrementalExternalCents !== 0 ||
          model?.mode !== "fixed-capacity" ||
          !["local-development", "deployment"].includes(model?.environment) ||
          typeof model?.statement !== "string" ||
          model.statement.trim().length < 12 ||
          (model.environment === "deployment" &&
            budget.policy.fixedCostReserveCents <= 0 &&
            dashboard.totals.recordedFixedCents <= 0)
        )
          fail("exact fixed capacity declaration required");
      }
    }
    if (j.status === "completed") {
      const priorSlot = before("nativeCapacity")[0]?.slot;
      if (
        !old ||
        old.status !== "running" ||
        !priorSlot ||
        priorSlot.kind !== "media" ||
        priorSlot.status !== "running" ||
        priorSlot.jobId !== j.id ||
        priorSlot.token !== old.capacityToken ||
        priorSlot.workerId !== old.workerId ||
        !Number.isFinite(Date.parse(priorSlot.hardDeadlineAt)) ||
        Date.parse(priorSlot.hardDeadlineAt) <= Date.now() ||
        !Number.isFinite(Date.parse(old.leaseExpiresAt)) ||
        Date.parse(old.leaseExpiresAt) <= Date.now()
      )
        fail("completion requires its live originally running lease");

      const a = after("mediaArtifacts").find(
        (a) => a.id === j.result?.artifactId,
      );
      if (
        !a ||
        a.jobId !== j.id ||
        !same(a.files, j.result?.files) ||
        a.archive?.sha256 !== j.result?.archiveHash ||
        j.completedFrames !== j.totalFrames ||
        !canEdit(j)
      )
        fail("completed export requires its exact artifact");
    } else if (j.result) fail("incomplete export cannot publish results");
    if (j.status === "running") {
      const slot = after("nativeCapacity")[0]?.slot;
      if (
        !slot ||
        slot.status !== "running" ||
        slot.kind !== "media" ||
        slot.jobId !== j.id ||
        slot.workerId !== j.workerId ||
        slot.token !== j.capacityToken ||
        !Number.isFinite(Date.parse(slot.hardDeadlineAt)) ||
        Date.parse(slot.hardDeadlineAt) <= Date.now()
      )
        fail("running media requires its exact shared native lease");
    }
  }
  const changed = changes.upserts.find(
    (r) => r.collection === "nativeCapacity",
  );
  if (changed) {
    const old = before("nativeCapacity")[0],
      next = changed.header as any;
    if (old?.slot?.kind === "media" || next.slot?.kind === "media") {
      if (
        next.slot &&
        !["acquiredAt", "heartbeatAt", "hardDeadlineAt"].every(
          (k) =>
            typeof next.slot[k] === "string" &&
            Number.isFinite(Date.parse(next.slot[k])),
        )
      )
        fail("native timestamps must be explicit finite instants");

      if (
        !worker ||
        next.revision !== old.revision + 1 ||
        !same(next.recoveryHistory, old.recoveryHistory)
      )
        fail("native slot requires owning media purpose");
      if (old.slot) {
        if (next.slot === null) {
          if (
            old.slot.status === "quarantined" ||
            after("mediaJobs").find((j) => j.id === old.slot.jobId)?.status ===
              "running"
          )
            fail("running or quarantined capacity cannot be released");
        } else if (
          !same(
            without(old.slot, ["heartbeatAt", "status", "reason"]),
            without(next.slot, ["heartbeatAt", "status", "reason"]),
          ) ||
          (old.slot.status === "quarantined" &&
            next.slot.status !== "quarantined")
        )
          fail("native lease cannot be stolen or extended");
      } else if (
        next.slot?.status !== "running" ||
        Date.parse(next.slot.hardDeadlineAt) >
          Date.parse(next.slot.acquiredAt) + 900000
      )
        fail("native claim requires bounded hard deadline");
    }
  }
}
