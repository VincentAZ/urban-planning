import type { TrafficNetwork, TrafficPeriod } from "@urban/core";
import {
  readTrafficCoordinates,
  readTrafficCountDraft,
  readTrafficClock,
  type TrafficCountDraft,
} from "./traffic-draft";

export interface TrafficCountSeries {
  key: string;
  rows: TrafficCountDraft[];
}
/** Exact identities only. Display labels, proximity and intervals never merge different series. */
export function trafficCountSeriesKey(row: TrafficCountDraft): string {
  const c = row.count;
  return JSON.stringify([
    [...c.sourceIds].sort(),
    c.stationId,
    c.raw.directionCode,
    c.raw.laneCode,
    c.raw.classCode,
    c.position,
    c.date,
    c.timeZone,
    c.utcOffsetMinutes,
  ]);
}
export function groupTrafficCounts(
  rows: readonly TrafficCountDraft[],
): TrafficCountSeries[] {
  const groups = new Map<string, TrafficCountDraft[]>();
  for (const row of rows) {
    const key = trafficCountSeriesKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups].map(([key, members]) => ({
    key,
    rows: [...members].sort(
      (a, b) =>
        a.count.beginSeconds - b.count.beginSeconds ||
        a.count.endSeconds - b.count.endSeconds ||
        a.count.id.localeCompare(b.count.id),
    ),
  }));
}
/** A partly overlapping observation is retained, but cannot stand in for a shorter observed interval. */
export function countWithinTrafficPeriod(
  row: TrafficCountDraft,
  period: TrafficPeriod,
): boolean {
  const c = row.count;
  try {
    const begin = readTrafficClock(row.begin, "Count start"),
      end = readTrafficClock(row.end, "Count end");
    return (
      c.date === period.date &&
      c.timeZone === period.timeZone &&
      c.utcOffsetMinutes === period.utcOffsetMinutes &&
      begin >= period.beginSeconds &&
      end <= period.endSeconds &&
      end > begin
    );
  } catch {
    return false;
  }
}
function mappingValue(row: TrafficCountDraft) {
  return [
    row.targetKind,
    row.targetId,
    row.positionPercent,
    row.laneCoverage,
    row.laneCoverageNetworkHash,
    [...row.laneIds].sort(),
    [...(row.count.vehicleClasses ?? [])].sort(),
  ];
}
function unchangedPosition(row: TrafficCountDraft): boolean {
  return (
    JSON.stringify(readTrafficCoordinates(row.longitude, row.latitude)) ===
    JSON.stringify(row.count.position)
  );
}
export interface TrafficSeriesMappingPreview {
  seriesKey: string;
  templateId: string;
  recordIds: string[];
  networkHash: string;
  fingerprint: string;
  note: string;
  classCoverageConfirmed: true;
  period: TrafficPeriod | null;
  changedExistingMappings: number;
}
function fingerprint(
  rows: readonly TrafficCountDraft[],
  ids: readonly string[],
  network: TrafficNetwork,
): string {
  const byId = new Map(rows.map((row) => [row.count.id, row]));
  const first = byId.get(ids[0]);
  const seriesKey = first ? trafficCountSeriesKey(first) : null;
  return JSON.stringify([
    network.manifest.networkFileSha256,
    ids.map((id) => byId.get(id) ?? null),
    rows
      .filter((row) => trafficCountSeriesKey(row) === seriesKey)
      .map((row) => row.count.id)
      .sort(),
  ]);
}
export function previewTrafficSeriesMapping(
  rows: readonly TrafficCountDraft[],
  templateId: string,
  recordIds: readonly string[],
  network: TrafficNetwork,
  options: {
    classCoverageConfirmed: boolean;
    note: string;
    period?: TrafficPeriod;
  },
): TrafficSeriesMappingPreview {
  if (!options.classCoverageConfirmed)
    throw new Error(
      "Confirm the class coverage interpretation before applying it to a series. Coverage is not vehicle composition.",
    );
  const template = rows.find((row) => row.count.id === templateId);
  if (!template || template.targetKind === "unmapped")
    throw new Error(
      "Review one mapped observation before applying its mapping to a series.",
    );
  readTrafficCountDraft(template, network);
  if (!unchangedPosition(template))
    throw new Error(
      "Series mapping cannot copy a corrected station location. Review the location change individually first.",
    );
  if (
    !recordIds.length ||
    new Set(recordIds).size !== recordIds.length ||
    !recordIds.includes(templateId)
  )
    throw new Error(
      "Choose distinct records including the reviewed observation.",
    );
  const key = trafficCountSeriesKey(template),
    byId = new Map(rows.map((row) => [row.count.id, row]));
  const members = recordIds.map((id) => byId.get(id));
  if (members.some((row) => !row || trafficCountSeriesKey(row) !== key))
    throw new Error(
      "Series mapping must retain identical source, station, direction, lane, class, original location and observation clock.",
    );
  if (members.some((row) => !unchangedPosition(row!)))
    throw new Error(
      "A selected observation has a changed station location; review it individually before series mapping.",
    );
  if (
    options.period &&
    members.some((row) => !countWithinTrafficPeriod(row!, options.period!))
  )
    throw new Error(
      "Every selected record must lie wholly inside the previewed analysis period.",
    );
  const note = options.note.trim();
  if (note.length > 2000)
    throw new Error("Keep the series review note within 2,000 characters.");
  return {
    seriesKey: key,
    templateId,
    recordIds: [...recordIds],
    networkHash: network.manifest.networkFileSha256,
    fingerprint: fingerprint(rows, recordIds, network),
    note,
    classCoverageConfirmed: true,
    period: options.period ? { ...options.period } : null,
    changedExistingMappings: members.filter(
      (row) =>
        row!.count.id !== templateId &&
        row!.targetKind !== "unmapped" &&
        JSON.stringify(mappingValue(row!)) !==
          JSON.stringify(mappingValue(template)),
    ).length,
  };
}
export function trafficSeriesPreviewCurrent(
  preview: TrafficSeriesMappingPreview,
  rows: readonly TrafficCountDraft[],
  network: TrafficNetwork,
  currentPeriod?: TrafficPeriod,
): boolean {
  return (
    (!preview.period ||
      JSON.stringify(preview.period) === JSON.stringify(currentPeriod)) &&
    preview.fingerprint === fingerprint(rows, preview.recordIds, network)
  );
}
/** Applies only the reviewed interpretation. Raw observations and per-record edits remain untouched. */
export function applyTrafficSeriesMapping(
  preview: TrafficSeriesMappingPreview,
  rows: readonly TrafficCountDraft[],
  network: TrafficNetwork,
  currentPeriod?: TrafficPeriod,
): TrafficCountDraft[] {
  if (!trafficSeriesPreviewCurrent(preview, rows, network, currentPeriod))
    throw new Error(
      "The observations, analysis period or graph changed after preview. Review the affected records again.",
    );
  const checked = previewTrafficSeriesMapping(
    rows,
    preview.templateId,
    preview.recordIds,
    network,
    {
      classCoverageConfirmed: preview.classCoverageConfirmed,
      note: preview.note,
      ...(preview.period ? { period: currentPeriod } : {}),
    },
  );
  if (checked.seriesKey !== preview.seriesKey)
    throw new Error("The observation series changed after preview.");
  const template = rows.find((row) => row.count.id === preview.templateId)!;
  const ids = new Set(preview.recordIds),
    note = preview.note ? `Series mapping review: ${preview.note}` : null;
  return rows.map((row) =>
    ids.has(row.count.id)
      ? {
          ...row,
          targetKind: template.targetKind,
          targetId: template.targetId,
          positionPercent: template.positionPercent,
          laneCoverage: template.laneCoverage,
          laneCoverageNetworkHash: template.laneCoverageNetworkHash,
          laneIds: [...template.laneIds],
          mappingChanged: true,
          mappingReviewed: true,
          count: {
            ...row.count,
            vehicleClasses: template.count.vehicleClasses?.length
              ? [...template.count.vehicleClasses]
              : null,
            notes:
              note && !row.count.notes.includes(note)
                ? [...row.count.notes, note]
                : [...row.count.notes],
          },
        }
      : row,
  );
}
