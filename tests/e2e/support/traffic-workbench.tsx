import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createScenario } from "@urban/models";
import type { Place, TrafficNetwork } from "@urban/core";
import type { CapturedTrafficExperiment } from "../../../apps/api/src/traffic/experiment";
import { TrafficDialog } from "../../../apps/web/src/components/traffic/TrafficDialog";
import type { TrafficResultPair } from "../../../apps/web/src/components/traffic/TrafficResults";
import "../../../apps/web/src/styles.css";

/** Served only through the opt-in Playwright route; no native run, auth or queue is mocked. */
export interface TrafficWorkbenchQAData {
  place: Place;
  network: TrafficNetwork;
  experiment: CapturedTrafficExperiment;
}

function CapturedWorkbench({ data }: { data: TrafficWorkbenchQAData }) {
  const [open, setOpen] = useState(true);
  const scenario = useMemo(
    () => createScenario("Local QA · authored demand"),
    [],
  );
  const pair = useMemo<TrafficResultPair>(
    () => ({
      id: `local-qa-${data.experiment.recipeHash}`,
      scenarioRevision: scenario.revision,
      recipe: data.experiment.recipe,
      baseline: data.experiment.baseline,
      proposal: data.experiment.proposal,
      countPack: data.experiment.request.countPack,
      // Baseline count fit only; null stays explicitly Not assessed.
      calibration: data.experiment.calibration,
    }),
    [data, scenario],
  );
  return (
    <main style={{ padding: 28, maxWidth: 960, margin: "0 auto" }}>
      <h1>Local QA · retained native traffic capture</h1>
      <p>
        Actual SUMO output on the captured Phoenix 85004 network, with
        explicitly authored vehicle demand. This isolated review has no server
        save, run, download or progress callbacks. It does not establish
        calibrated traffic.
      </p>
      <button type="button" className="button" onClick={() => setOpen(true)}>
        Reopen local traffic review
      </button>
      {!open && (
        <p role="status">Local review closed. Retained inputs are unchanged.</p>
      )}
      {open && (
        <TrafficDialog
          place={data.place}
          scenario={scenario}
          accountScope="isolated-local-traffic-qa"
          canEdit
          network={data.network}
          countPack={data.experiment.request.countPack}
          demand={data.experiment.request.demand}
          period={data.experiment.request.period}
          overlays={data.experiment.request.overlays}
          result={pair}
          resultCurrent
          capabilityReason="Local QA only · actual authored-demand run. Draft review is editable; saving and execution are disconnected. Count fit was not assessed."
          onClose={() => setOpen(false)}
        />
      )}
    </main>
  );
}

function TrafficWorkbenchHarness() {
  const [data, setData] = useState<TrafficWorkbenchQAData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void fetch("/__traffic-qa-data", {
      signal: abort.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `Retained QA data is unavailable (${response.status}).`,
          );
        return response.json() as Promise<TrafficWorkbenchQAData>;
      })
      .then((value) => {
        if (!abort.signal.aborted) setData(value);
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted) setError((failure as Error).message);
      });
    return () => abort.abort();
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!data)
    return <p role="status">Loading the retained native QA capture…</p>;
  return <CapturedWorkbench data={data} />;
}

createRoot(document.getElementById("root")!).render(
  <TrafficWorkbenchHarness />,
);
