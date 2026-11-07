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
  AccessibilityRequest,
  AccessibilityModeEvidence,
} from "@urban/core";
import type { AccessibilityStartBody } from "../../lib/accessibility-api";

export interface AccessibilitySiteChoice {
  id: string;
  label: string;
  position: Position;
}
export function accessibilitySiteChoices(
  place: Place,
  scenario: Scenario,
): AccessibilitySiteChoice[] {
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
export function accessibilityCoordinates(
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
export function accessibilityQueryKey(request: AccessibilityRequest): string {
  return JSON.stringify([
    request.site[0],
    request.site[1],
    request.mode,
    request.direction,
    request.thresholdsMinutes,
  ]);
}
export function sameAccessibilityQuery(
  a: AccessibilityRequest | null,
  b: AccessibilityRequest | null,
): boolean {
  return !!a && !!b && accessibilityQueryKey(a) === accessibilityQueryKey(b);
}
/** Imported receipts are informational. They never trigger an automatic private result lookup. */
export function retainedAccessibilityJobId(
  accessibility: AccessibilityModeEvidence | undefined,
  jobs: readonly { id: string; projectId: string; scenarioId: string }[],
  scenarioId: string,
): string {
  if (accessibility?.origin !== "server-run") return "";
  return (
    jobs.find(
      (job) =>
        job.id === accessibility.receipt.jobId &&
        job.projectId === accessibility.receipt.projectId &&
        job.scenarioId === scenarioId,
    )?.id ?? ""
  );
}
export function accessibilitySubmissionMessage(
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | undefined,
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
export class AccessibilityStartAttempts {
  private attempts = new Map<string, AccessibilityStartBody>();
  for(
    projectId: string,
    body: Omit<AccessibilityStartBody, "idempotencyKey">,
  ): AccessibilityStartBody {
    const key = JSON.stringify([
      projectId,
      body.scenarioId,
      accessibilityQueryKey(body.request),
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
  complete(projectId: string, body: AccessibilityStartBody) {
    this.attempts.delete(
      JSON.stringify([
        projectId,
        body.scenarioId,
        accessibilityQueryKey(body.request),
      ]),
    );
  }
  clear() {
    this.attempts.clear();
  }
}

/** A current server profile comparison is separate from the frozen query and its authority. */
export function accessibilitySourceChanged(
  evidence: AccessibilityModeEvidence,
  identity:
    | {
        jobsPackHash: string;
        boundaryHash: string;
        manifestId: string;
        graphHash: string;
        profileHash: string;
        methodVersion: string;
      }
    | null
    | undefined,
): boolean | null {
  if (!identity) return null;
  const c = evidence.capture;
  return (
    c.jobsPackHash !== identity.jobsPackHash ||
    c.coverage.destinations.boundaryHash !== identity.boundaryHash ||
    c.network.id !== identity.manifestId ||
    c.network.graphHash !== identity.graphHash ||
    c.network.profileHash !== identity.profileHash ||
    c.methodVersion !== identity.methodVersion
  );
}
