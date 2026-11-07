import {
  buildingAnchor,
  materializeBuildings,
  materializeParcels,
  studyAreaAnchor,
} from "@urban/core";
import type {
  Place,
  Position,
  Scenario,
  WorkforceRequest,
  WorkforceScenario,
} from "@urban/core";
import type { WorkforceStartBody } from "../../lib/workforce-api";

export interface WorkforceSiteChoice {
  id: string;
  label: string;
  position: Position;
}
export function workforceSiteChoices(
  place: Place,
  scenario: Scenario,
): WorkforceSiteChoice[] {
  return [
    ...materializeBuildings(place, scenario).map((building) => ({
      id: `building:${building.id}`,
      label: `Building · ${building.name || building.id}`,
      position: buildingAnchor(building),
    })),
    ...materializeParcels(place, scenario).map((parcel) => ({
      id: `parcel:${parcel.id}`,
      label: `${parcel.kind === "block" ? "Block" : "Parcel"} · ${parcel.name}`,
      position: studyAreaAnchor(parcel.geometry),
    })),
  ].sort((a, b) => a.label.localeCompare(b.label));
}
export function workforceCoordinates(
  longitude: string,
  latitude: string,
): Position | null {
  if (!longitude.trim() || !latitude.trim()) return null;
  const lon = Number(longitude),
    lat = Number(latitude);
  return Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= -180 &&
    lon <= 180 &&
    lat >= -85 &&
    lat <= 85
    ? [lon, lat]
    : null;
}
export function workforceQueryKey(request: WorkforceRequest): string {
  return JSON.stringify([
    request.site[0],
    request.site[1],
    request.mode,
    request.direction,
    request.thresholdsMinutes,
  ]);
}
export function sameWorkforceQuery(
  a: WorkforceRequest | null,
  b: WorkforceRequest | null,
): boolean {
  return !!a && !!b && workforceQueryKey(a) === workforceQueryKey(b);
}
/** Imported receipts are informational. They never trigger an automatic private result lookup. */
export function retainedWorkforceJobId(
  workforce: WorkforceScenario | undefined,
  jobs: readonly { id: string; projectId: string; scenarioId: string }[],
  scenarioId: string,
): string {
  if (workforce?.origin !== "server-run") return "";
  return (
    jobs.find(
      (job) =>
        job.id === workforce.receipt.jobId &&
        job.projectId === workforce.receipt.projectId &&
        job.scenarioId === scenarioId,
    )?.id ?? ""
  );
}
export function workforceSubmissionMessage(
  status:
    "queued" | "running" | "completed" | "failed" | "cancelled" | undefined,
): string {
  if (status === "completed")
    return "Captured result ready. Review its evidence and choose whether to save it to this scenario.";
  if (status === "failed")
    return "This run did not complete. Review its error below; no partial result was published.";
  if (status === "cancelled")
    return "This run was cancelled. Previously captured evidence remains available.";
  return "Request retained. You can close this workbench while the server finishes.";
}
/** Preserve the complete original attempt across an unknown response or a later saved version. */
export class WorkforceStartAttempts {
  private attempts = new Map<string, WorkforceStartBody>();
  for(
    projectId: string,
    body: Omit<WorkforceStartBody, "idempotencyKey">,
  ): WorkforceStartBody {
    const key = JSON.stringify([
      projectId,
      body.scenarioId,
      workforceQueryKey(body.request),
    ]);
    const existing = this.attempts.get(key);
    if (existing) return existing;
    const created = structuredClone({
      ...body,
      idempotencyKey: crypto.randomUUID(),
    });
    this.attempts.set(key, created);
    return created;
  }
  complete(projectId: string, body: WorkforceStartBody) {
    this.attempts.delete(
      JSON.stringify([
        projectId,
        body.scenarioId,
        workforceQueryKey(body.request),
      ]),
    );
  }
  clear() {
    this.attempts.clear();
  }
}
