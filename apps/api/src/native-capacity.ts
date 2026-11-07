import { randomUUID } from "node:crypto";
import type { DataState } from "./store.js";
import { ApiError } from "./errors.js";

export type NativeCapacityKind =
  | "media"
  | "gis"
  | "workforce"
  | "traffic"
  | "accessibility";
export interface NativeCapacityLease {
  token: string;
  kind: NativeCapacityKind;
  jobId: string;
  workerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  hardDeadlineAt: string;
  status: "running" | "quarantined";
  reason?: string;
}
export interface NativeCapacityRecovery {
  token: string;
  kind: NativeCapacityKind;
  jobId: string;
  at: string;
  operator: string;
  confirmation: string;
}
export interface NativeCapacityState {
  version: 1;
  revision: number;
  slot: NativeCapacityLease | null;
  recoveryHistory: NativeCapacityRecovery[];
}
export const defaultNativeCapacity = (): NativeCapacityState => ({
  version: 1,
  revision: 0,
  slot: null,
  recoveryHistory: [],
});
/** Upgrade safety: an existing running process must never be assumed stopped during migration. */
export function legacyNativeCapacity(
  records: {
    kind: NativeCapacityKind;
    id: string;
    workerId?: string;
    createdAt?: string;
    status: string;
  }[],
): NativeCapacityState {
  const active = records.find((record) => record.status === "running");
  if (!active) return defaultNativeCapacity();
  const now = new Date().toISOString();
  return {
    version: 1,
    revision: 1,
    recoveryHistory: [],
    slot: {
      token: randomUUID(),
      kind: active.kind,
      jobId: active.id,
      workerId: active.workerId ?? "legacy-worker",
      acquiredAt: now,
      heartbeatAt: now,
      hardDeadlineAt: now,
      status: "quarantined",
      reason:
        "A native job was already running when shared capacity was introduced. Confirm all native processing has stopped before operator recovery.",
    },
  };
}
export const NATIVE_CAPACITY_HEARTBEAT_GRACE_MS = 60_000;
export function assertNativeCapacityAvailable(state: DataState): void {
  const slot = state.nativeCapacity.slot;
  if (
    slot &&
    (slot.status === "quarantined" ||
      Date.parse(slot.hardDeadlineAt) <= Date.now() ||
      Date.parse(slot.heartbeatAt) + NATIVE_CAPACITY_HEARTBEAT_GRACE_MS <=
        Date.now())
  )
    throw new ApiError(
      503,
      "NATIVE_CAPACITY_QUARANTINED",
      "Shared native processing is quarantined after an interrupted or uncertain operation. An operator must confirm termination and recover capacity before processing can continue.",
    );
}
const currentTime = (now?: number) => now ?? Date.now();
function owned(state: DataState, token: string): NativeCapacityLease {
  const slot = state.nativeCapacity.slot;
  if (!slot || slot.token !== token)
    throw new ApiError(
      409,
      "NATIVE_CAPACITY_FENCED",
      "This worker no longer owns the shared native processing slot.",
    );
  return slot;
}
/** Runs only inside the same durable transaction that claims the corresponding job. */
export function acquireNativeCapacity(
  state: DataState,
  input: {
    kind: NativeCapacityKind;
    jobId: string;
    workerId: string;
    runMilliseconds: number;
    now?: number;
  },
): NativeCapacityLease | null {
  const now = currentTime(input.now),
    capacity = state.nativeCapacity;
  if (
    !Number.isSafeInteger(input.runMilliseconds) ||
    input.runMilliseconds < 1 ||
    input.runMilliseconds > 15 * 60_000
  )
    throw new Error(
      "Native work requires an explicit hard deadline of at most 15 minutes.",
    );
  if (capacity.slot) {
    const slot = capacity.slot;
    if (
      slot.status === "running" &&
      (Date.parse(slot.hardDeadlineAt) <= now ||
        Date.parse(slot.heartbeatAt) + NATIVE_CAPACITY_HEARTBEAT_GRACE_MS <=
          now)
    ) {
      slot.status = "quarantined";
      slot.reason =
        "A prior native worker lost its heartbeat or reached its hard deadline. Processing remains blocked until termination is confirmed.";
      capacity.revision++;
    }
    return null;
  }
  capacity.slot = {
    token: randomUUID(),
    kind: input.kind,
    jobId: input.jobId,
    workerId: input.workerId,
    acquiredAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    hardDeadlineAt: new Date(now + input.runMilliseconds).toISOString(),
    status: "running",
  };
  capacity.revision++;
  return structuredClone(capacity.slot);
}
export function heartbeatNativeCapacity(
  state: DataState,
  token: string,
  now?: number,
): void {
  const slot = owned(state, token),
    at = currentTime(now);
  if (slot.status !== "running" || Date.parse(slot.hardDeadlineAt) <= at)
    throw new ApiError(
      409,
      "NATIVE_CAPACITY_QUARANTINED",
      "The native processing slot needs confirmed termination before it can be reused.",
    );
  slot.heartbeatAt = new Date(at).toISOString();
  state.nativeCapacity.revision++;
}
/** Never use an HTTP abort as proof that the native service has stopped processing. */
export function releaseNativeCapacity(
  state: DataState,
  token: string,
  _proof: { reason: "completed" | "confirmed-stopped" | "not-started" },
): void {
  if (owned(state, token).status === "quarantined")
    throw new ApiError(
      409,
      "NATIVE_CAPACITY_QUARANTINED",
      "A quarantined slot requires trusted operator recovery after termination confirmation.",
    );
  state.nativeCapacity.slot = null;
  state.nativeCapacity.revision++;
}
export function quarantineNativeCapacity(
  state: DataState,
  token: string,
  reason: string,
): void {
  const slot = owned(state, token);
  slot.status = "quarantined";
  slot.reason = reason.slice(0, 1000);
  state.nativeCapacity.revision++;
}
/** Trusted operator only. The caller must confirm all native work stopped; a lease timeout is insufficient. */
export function recoverNativeCapacity(
  state: DataState,
  input: {
    expectedRevision: number;
    token: string;
    operator: string;
    confirmation: string;
    now?: number;
  },
): void {
  if (state.nativeCapacity.revision !== input.expectedRevision)
    throw new ApiError(
      409,
      "NATIVE_CAPACITY_CHANGED",
      "The native capacity record changed; inspect it again before recovery.",
    );
  if (!input.operator.trim() || input.confirmation.trim().length < 30)
    throw new Error(
      "Recovery requires an identified operator and explicit confirmation that all native work has stopped.",
    );
  const slot = owned(state, input.token);
  if (state.nativeCapacity.recoveryHistory.length >= 1000)
    throw new Error(
      "Native recovery audit limit reached; archive and review it through an explicit maintenance migration.",
    );
  state.nativeCapacity.recoveryHistory.push({
    token: slot.token,
    kind: slot.kind,
    jobId: slot.jobId,
    at: new Date(currentTime(input.now)).toISOString(),
    operator: input.operator.trim(),
    confirmation: input.confirmation.trim(),
  });
  state.nativeCapacity.slot = null;
  state.nativeCapacity.revision++;
}
