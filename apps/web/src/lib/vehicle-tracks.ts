import { useEffect, useState } from "react";
import type { TrafficScenario } from "@urban/core";
import type { VehicleTracks } from "../components/map/motion";
import { trafficApi, trafficFile } from "./traffic-api";

export type ScenarioVehicleTracks = {
  baseline: VehicleTracks | null;
  proposal: VehicleTracks;
};

/** Loads the executed SUMO vehicle tracks retained with the scenario's saved
 * traffic run. Runs without tracks (older worker) or without access show none.
 */
export function useVehicleTracks(
  traffic: TrafficScenario | undefined,
): ScenarioVehicleTracks | null {
  const [tracks, setTracks] = useState<ScenarioVehicleTracks | null>(null);
  const projectId = traffic?.origin === "server-run" ? traffic.receipt.projectId : undefined;
  const jobId = projectId ? traffic?.receipt.jobId : undefined;
  useEffect(() => {
    setTracks(null);
    if (!projectId || !jobId) return;
    const controller = new AbortController();
    (async () => {
      const { files } = await trafficApi.files(projectId, jobId, controller.signal);
      const load = async (side: "baseline" | "proposal") => {
        const file = files.find((f) => f.name === `${side}-tracks.json`);
        if (!file) return null;
        const blob = await trafficFile(projectId, jobId, file, controller.signal);
        return JSON.parse(await blob.text()) as VehicleTracks;
      };
      const [baseline, proposal] = await Promise.all([load("baseline"), load("proposal")]);
      if (proposal) setTracks({ baseline, proposal });
    })().catch(() => {
      if (!controller.signal.aborted) setTracks(null);
    });
    return () => controller.abort();
  }, [projectId, jobId]);
  return tracks;
}
