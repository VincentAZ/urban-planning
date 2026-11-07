import { useEffect, useState } from "react";
import type { FloodDataset, Place, Scenario } from "@urban/core";
import type { FloodResolution, ModelContext } from "@urban/models";
import { Modal } from "../Modal";
import {
  fetchFloodDataset,
  floodCatalog,
  type FloodCatalogChoice,
} from "../../lib/flood-api";
import { FloodEvidence } from "./FloodEvidence";
export function FloodDialog({
  place,
  scenario,
  context,
  resolution,
  calculationError,
  canEdit,
  onAttach,
  onRemove,
  onUpdateMethod,
  onSelect,
  onClose,
}: {
  place: Place;
  scenario: Scenario;
  context: ModelContext;
  resolution: FloodResolution | null;
  calculationError?: string | null;
  canEdit: boolean;
  onAttach: (
    dataset: FloodDataset,
    hash: string,
    signal: AbortSignal,
  ) => Promise<void>;
  onRemove: () => void;
  onUpdateMethod: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<FloodCatalogChoice[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  const [operation] = useState(() => ({
    controller: null as AbortController | null,
  }));
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setChoices([]);
    void floodCatalog(place, controller.signal)
      .then(setChoices)
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "The catalog is unavailable.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      operation.controller?.abort();
    };
  }, [place, retry, operation]);
  useEffect(() => {
    if (!canEdit) operation.controller?.abort();
  }, [canEdit, operation]);
  const dataset = scenario.flood
    ? context.floodDatasets?.[scenario.flood.datasetHash]
    : undefined;
  async function attach(choice: FloodCatalogChoice) {
    if (!canEdit || busy || operation.controller) return;
    const controller = new AbortController();
    operation.controller = controller;
    setBusy(choice.datasetHash);
    setError("");
    try {
      const value = await fetchFloodDataset(
        choice.datasetHash,
        place,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      await onAttach(value, choice.datasetHash, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : "The map could not be attached.",
        );
    } finally {
      if (operation.controller === controller) {
        operation.controller = null;
        setBusy(null);
      }
    }
  }
  return (
    <Modal
      title="Flood evidence"
      description="A captured map, a transparent footprint screen, and room for uncertainty."
      wide
      open
      onClose={onClose}
    >
      <div className="flood-workbench">
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        {scenario.flood ? (
          <>
            <div className="flood-attached">
              <span className="badge">
                Map attached · scenario r{scenario.revision}
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="button compact"
                  disabled={!!busy}
                  onClick={onRemove}
                >
                  Remove flood map from scenario
                </button>
              )}
            </div>
            <FloodEvidence
              place={place}
              scenario={scenario}
              dataset={dataset}
              context={context}
              resolution={resolution}
              calculationError={calculationError}
              onUpdateMethod={
                canEdit && dataset
                  ? () => {
                      if (
                        !canEdit ||
                        busy ||
                        operation.controller ||
                        (!resolution && !calculationError)
                      )
                        return;
                      setError("");
                      try {
                        onUpdateMethod();
                      } catch (error) {
                        setError(
                          error instanceof Error
                            ? error.message
                            : "The method could not be updated.",
                        );
                      }
                    }
                  : undefined
              }
              methodUpdateDisabled={
                !!busy || (!resolution && !calculationError)
              }
              onSelect={onSelect}
            />
          </>
        ) : (
          <p>
            Attach a retained source map to screen the captured baseline and
            your proposed buildings. This does not change buildings or restrict
            editing.
          </p>
        )}
        <details open={!scenario.flood}>
          <summary>Available captured maps for this study area</summary>
          {loading ? (
            <p role="status">Checking captured maps…</p>
          ) : choices.length ? (
            choices.map((choice) => (
              <article className="flood-choice" key={choice.datasetHash}>
                <div>
                  <h3>{choice.label}</h3>
                  <p>
                    Captured {new Date(choice.capturedAt).toLocaleString()} ·{" "}
                    {(choice.bytes / 1024).toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}{" "}
                    KB
                  </p>
                  <small>
                    Retained effective-map data. Review source dates and
                    coverage after attaching.
                  </small>
                </div>
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    !canEdit ||
                    !!busy ||
                    scenario.flood?.datasetHash === choice.datasetHash
                  }
                  onClick={() => void attach(choice)}
                >
                  {busy === choice.datasetHash
                    ? "Checking map…"
                    : scenario.flood?.datasetHash === choice.datasetHash
                      ? "Attached"
                      : "Attach flood map"}
                </button>
              </article>
            ))
          ) : (
            <p>
              No captured flood map is available for this exact study area.
              Missing coverage does not mean no flood hazard.
            </p>
          )}
          <button
            type="button"
            className="button compact"
            disabled={loading || !!busy}
            onClick={() => setRetry((v) => v + 1)}
          >
            Refresh map catalog
          </button>
          {!canEdit && (
            <p>
              This scenario is open for review. An editable proposal is needed
              to attach or remove a map.
            </p>
          )}
        </details>
      </div>
    </Modal>
  );
}
