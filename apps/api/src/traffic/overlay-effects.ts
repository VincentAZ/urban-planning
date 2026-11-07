import {
  canonicalJSON,
  type TrafficNetwork,
  type TrafficOverlay,
  type TrafficSignalTiming,
} from "@urban/core";
import { ApiError } from "../errors.js";

function fail(message: string): never {
  throw new ApiError(422, "TRAFFIC_OVERLAY_EFFECT", message);
}

/** Verify the graph actually executed, rather than treating an accepted patch as proof.
 * Precision is explicit because older retained netconvert outputs used two decimals. */
export function assertTrafficOverlayEffects(
  baseline: TrafficNetwork,
  proposal: TrafficNetwork,
  overlays: readonly TrafficOverlay[],
  speedDecimalPlaces: 2 | 6 = 6,
  signalTimings: readonly TrafficSignalTiming[] = [],
): void {
  if (!overlays.length && !signalTimings.length) {
    const topology = (network: TrafficNetwork) => [
      network.nodes,
      network.edges,
      network.connections,
      network.signals,
    ];
    if (
      baseline.manifest.networkFileSha256 !==
        proposal.manifest.networkFileSha256 ||
      canonicalJSON(topology(baseline)) !== canonicalJSON(topology(proposal))
    )
      fail(
        "An experiment without native controls must retain the exact baseline graph.",
      );
    return;
  }
  if (!overlays.length && signalTimings.length) {
    const selected = new Set(signalTimings.map((control) => control.signalId));
    const unchanged = (network: TrafficNetwork) => [
      network.nodes,
      network.edges,
      network.connections,
      network.signals.filter((signal) => !selected.has(signal.id)),
    ];
    if (
      canonicalJSON(unchanged(baseline)) !== canonicalJSON(unchanged(proposal))
    )
      fail(
        "A timing-only experiment changed undeclared topology, geometry or an unselected signal program.",
      );
  }
  const before = new Map(baseline.edges.map((edge) => [edge.id, edge]));
  const after = new Map(proposal.edges.map((edge) => [edge.id, edge]));
  const controls = new Map(
    overlays.map((overlay) => [overlay.edgeId, overlay]),
  );
  if (controls.size !== overlays.length)
    fail("Native controls repeat a directed edge; no result accepted.");
  for (const overlay of overlays) {
    if (!before.has(overlay.edgeId))
      fail("A native control references an absent baseline edge.");
    if (
      overlay.closed === true &&
      (overlay.lanes !== undefined || overlay.speedMps !== undefined)
    )
      fail(
        "A removed native edge cannot also represent a lane or speed change.",
      );
  }
  if (proposal.edges.some((edge) => !before.has(edge.id)))
    fail("The native proposal added an undeclared directed edge.");
  const tolerance = 0.51 * 10 ** -speedDecimalPlaces;
  const close = (a: number, b: number) =>
    Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  for (const original of baseline.edges) {
    const overlay = controls.get(original.id);
    const actual = after.get(original.id);
    if (overlay?.closed === true) {
      if (actual)
        fail("A requested native closure remained in the executed graph.");
      continue;
    }
    if (!actual)
      fail("The native proposal removed an undeclared directed edge.");
    if (actual.from !== original.from || actual.to !== original.to)
      fail("The native proposal changed a directed edge's endpoints.");
    if (actual.lanes.length !== (overlay?.lanes ?? original.lanes.length))
      fail(
        "The executed lane count does not match the reviewed native control.",
      );
    const classes = (values: readonly string[]) =>
      [...values].sort().join("\0");
    const originalLanes = new Map(
      original.lanes.map((lane) => [lane.index, lane]),
    );
    if (
      actual.lanes.some((lane) => {
        const previous = originalLanes.get(lane.index);
        return previous
          ? classes(lane.allowedClasses) !== classes(previous.allowedClasses)
          : !original.lanes.some(
              (source) =>
                classes(source.allowedClasses) === classes(lane.allowedClasses),
            );
      })
    )
      fail(
        "The native proposal changed lane access permissions without a supported control.",
      );
    if (overlay?.speedMps !== undefined) {
      if (actual.lanes.some((lane) => !close(lane.speedMps, overlay.speedMps!)))
        fail("The executed speed does not match the reviewed native control.");
    } else {
      const lanes = new Map(original.lanes.map((lane) => [lane.index, lane]));
      if (
        actual.lanes.some((lane) => {
          const previous = lanes.get(lane.index);
          // Surviving lanes keep their speeds. Added lanes may inherit a recorded
          // edge speed, but cannot silently introduce an unrequested speed limit.
          return previous
            ? !close(lane.speedMps, previous.speedMps)
            : !original.lanes.some((source) =>
                close(lane.speedMps, source.speedMps),
              );
        })
      )
        fail("The native proposal changed a speed without a declared control.");
    }
  }
}
