import { useEffect, useMemo, useRef, useState } from "react";
import type {
  HousingAffordabilityScenario,
  HousingIncomeLimitCatalog,
  ModelResults,
  Place,
  Project,
  Scenario,
} from "@urban/core";
import { materializeBuildings } from "@urban/core";
import { Modal } from "../Modal";
import { runHousingTask, type HousingPreview } from "../../lib/housing-task";
import { exportHousingCSV } from "../../lib/housing-export";
import { HousingAreas } from "./HousingAreas";
import { HousingGroups } from "./HousingGroups";
import { HousingSources } from "./HousingSources";
import { HousingResults } from "./HousingOverview";
import { HousingField } from "./HousingFields";
import {
  housingGroupDraft,
  housingSourceDraft,
  readHousingGroup,
  readHousingSources,
  type HousingGroupDraft,
} from "./draft";
import "./housing.css";
export interface HousingAffordabilityDialogProps {
  place: Place;
  project: Project;
  scenario: Scenario;
  results?: ModelResults;
  canEdit: boolean;
  actor: string;
  accountScope: string;
  selectedBuildingId?: string;
  onClose: () => void;
  onSelectBuilding?: (id: string) => void;
  onApply: (
    packs: HousingIncomeLimitCatalog,
    affordability: HousingAffordabilityScenario,
    signal: AbortSignal,
  ) => Promise<void>;
  onRemove?: () => void;
}
export function HousingAffordabilityDialog(
  props: HousingAffordabilityDialogProps,
) {
  const { place, project, scenario, actor, accountScope } = props;
  const [initial] = useState(() => ({
    revision: scenario.revision,
    place,
    projectId: project.id,
    accountScope,
    original: scenario.affordability,
  }));
  const [baseline, setBaseline] = useState(() =>
    (scenario.affordability?.baselineGroups ?? []).map((g) =>
      housingGroupDraft(g),
    ),
  );
  const [proposal, setProposal] = useState(() =>
    (scenario.affordability?.proposalGroups ?? []).map((g) =>
      housingGroupDraft(g),
    ),
  );
  const [sources, setSources] = useState(() =>
    (scenario.affordability?.sources ?? []).map(housingSourceDraft),
  );
  const [packs, setPacks] = useState<HousingIncomeLimitCatalog>(
    () => project.housingIncomeLimits ?? {},
  );
  const [verified, setVerified] = useState<Set<string>>(() => new Set());
  const [notes, setNotes] = useState(
      scenario.affordability?.review.notes ?? "",
    ),
    [reviewed, setReviewed] = useState(false);
  const [tab, setTab] = useState("areas"),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<
    (HousingPreview & { fingerprint: string }) | null
  >(null);
  const [confirmClose, setConfirmClose] = useState(false),
    [edited, setEdited] = useState(false);
  const pending = useRef<AbortController | null>(null),
    current = useRef(props);
  current.current = props;
  const stale =
    scenario.revision !== initial.revision ||
    place !== initial.place ||
    project.id !== initial.projectId ||
    accountScope !== initial.accountScope;
  const fingerprint = JSON.stringify({
    baseline,
    proposal,
    sources,
    notes,
    packs: Object.keys(packs),
  });
  const currentPreview =
    !stale && preview?.fingerprint === fingerprint ? preview : null;
  const proposalBuildings = useMemo(
    () => materializeBuildings(place, scenario),
    [place, scenario],
  );
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (stale || !props.canEdit) {
      pending.current?.abort();
      pending.current = null;
      setBusy("");
    }
  }, [stale, props.canEdit]);
  function changed() {
    pending.current?.abort();
    pending.current = null;
    setBusy("");
    setReviewed(false);
    setEdited(true);
    setNotice("");
  }
  function groups(side: "baseline" | "proposal", values: HousingGroupDraft[]) {
    changed();
    const previous = side === "baseline" ? baseline : proposal;
    const next = values.map((g) => {
      const old = previous.find((p) => p.id === g.id);
      return !old || old.areaHash !== g.areaHash
        ? {
            ...g,
            areaOrigin: verified.has(g.areaHash)
              ? ("server-catalog" as const)
              : ("imported" as const),
          }
        : g;
    });
    side === "baseline" ? setBaseline(next) : setProposal(next);
  }
  const close = () => {
    if (edited || busy) setConfirmClose(true);
    else props.onClose();
  };
  async function prepare() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy("Preparing preview");
    setError("");
    setPreview(null);
    try {
      if (stale || !current.current.canEdit)
        throw new Error(
          "This project context changed. Close and reopen the workbench to review its current state.",
        );
      if (!reviewed || !notes.trim())
        throw new Error(
          "Add review notes and confirm the area, capacity and cost assignments.",
        );
      const input = {
        baselineGroups: baseline.map(readHousingGroup),
        proposalGroups: proposal.map(readHousingGroup),
        sources: readHousingSources(sources, actor, new Date().toISOString()),
      };
      if (!input.baselineGroups.length && !input.proposalGroups.length)
        throw new Error("Add at least one baseline or proposal unit group.");
      const result = await runHousingTask<HousingPreview>(
        {
          kind: "preview",
          place,
          scenario,
          input,
          review: {
            reviewedBy: actor,
            reviewedAt: new Date().toISOString(),
            notes,
          },
          catalog: packs,
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (
        pending.current !== controller ||
        current.current.scenario !== scenario ||
        current.current.place !== place ||
        !current.current.canEdit
      )
        return;
      setPreview({ ...result, fingerprint });
      setTab("results");
      setNotice(
        "Draft preview ready. Apply saves these reviewed groups as one reversible change.",
      );
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Housing review failed.");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy("");
      }
    }
  }
  async function apply() {
    if (
      !currentPreview ||
      !reviewed ||
      !props.canEdit ||
      currentPreview.result.status === "stale"
    )
      return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy("Applying reviewed groups");
    setError("");
    const onApply = props.onApply;
    try {
      await onApply(packs, currentPreview.affordability, controller.signal);
      controller.signal.throwIfAborted();
      props.onClose();
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "Housing evidence could not be applied.",
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy("");
      }
    }
  }
  const savedResult = !stale && props.results?.affordability;
  return (
    <Modal
      title="Housing affordability"
      description="Follow each group of homes from complete housing costs to published income limits."
      open
      onClose={close}
      wide
    >
      <div className="housing-dialog-body">
        <nav className="housing-tabs" aria-label="Housing workbench sections">
          {[
            ["areas", "HUD areas"],
            ["baseline", "Baseline groups"],
            ["proposal", "Proposal groups"],
            ["sources", "Sources"],
            ["review", "Review"],
            ["results", "Results"],
          ].map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="housing-scroll">
          <p className="housing-intro">
            A useful comparison starts with complete costs—not average rent.
            Keep unassigned homes and unknown payments visible, then test the
            proposal against the same published thresholds.
          </p>
          {stale && (
            <p className="warning" role="status">
              The project changed while this review was open. Your raw inputs
              are retained, but preview and Apply are disabled. Close and reopen
              to review the current building capacities.
            </p>
          )}
          {!props.canEdit && (
            <p role="status">
              Read-only evidence. Editing requires an editable proposal.
            </p>
          )}
          {error && (
            <p role="alert" className="warning">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <fieldset
            className="housing-work-fields"
            disabled={!!busy || stale || !props.canEdit}
            hidden={tab === "results"}
          >
            {tab === "areas" && (
              <HousingAreas
                packs={packs}
                onRetain={(hash, pack) => {
                  changed();
                  setPacks((p) => ({ ...p, [hash]: pack }));
                  setVerified((v) => new Set([...v, hash]));
                  setBaseline((gs) =>
                    gs.map((g) =>
                      g.areaHash === hash
                        ? { ...g, areaOrigin: "server-catalog" }
                        : g,
                    ),
                  );
                  setProposal((gs) =>
                    gs.map((g) =>
                      g.areaHash === hash
                        ? { ...g, areaOrigin: "server-catalog" }
                        : g,
                    ),
                  );
                  setNotice(
                    "HUD area retained. Assign it explicitly to the relevant unit groups.",
                  );
                }}
              />
            )}{" "}
            {(tab === "baseline" || tab === "proposal") && (
              <HousingGroups
                key={tab}
                side={tab}
                groups={tab === "baseline" ? baseline : proposal}
                buildings={
                  tab === "baseline" ? place.buildings : proposalBuildings
                }
                packs={packs}
                sources={sources}
                selectedBuildingId={props.selectedBuildingId}
                onChange={(g) => groups(tab, g)}
                onSelectBuilding={props.onSelectBuilding}
              />
            )}{" "}
            {tab === "sources" && (
              <HousingSources
                sources={sources}
                onChange={(s) => {
                  changed();
                  setSources(s);
                }}
              />
            )}{" "}
            {tab === "review" && (
              <section>
                <h3>Review the assignment</h3>
                <p>
                  {baseline.length} baseline groups · {proposal.length} proposal
                  groups · {Object.keys(packs).length} retained areas
                </p>
                <p>
                  Each home can belong to one group on each side. Alternative
                  household-size assumptions need a separate scenario, not
                  another overlapping group. Cost year and published-limit
                  fiscal year must match; no inflation adjustment is invented.
                </p>
                <HousingField
                  label="Housing review notes"
                  value={notes}
                  onChange={(value) => {
                    changed();
                    setNotes(value);
                  }}
                  hint="Explain area applicability, household-size choices, cost evidence and any unresolved homes."
                />
                <label className="check">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  I reviewed the HUD jurisdiction components, household sizes,
                  unit capacities and complete cost assignments.
                </label>
                <button
                  className="housing-primary"
                  type="button"
                  disabled={!reviewed || !notes.trim()}
                  onClick={() => void prepare()}
                >
                  Preview housing affordability
                </button>
              </section>
            )}
          </fieldset>
          {tab === "results" &&
            (currentPreview ? (
              <HousingResults
                result={currentPreview.result}
                onSelectBuilding={props.onSelectBuilding}
              />
            ) : savedResult ? (
              <>
                <p>
                  Saved evidence. Draft changes are not included in these
                  results.
                </p>
                <HousingResults
                  result={savedResult}
                  onSelectBuilding={props.onSelectBuilding}
                />
              </>
            ) : (
              <p>
                Preview the reviewed groups to see coverage and affordability.
                No draft calculations have been saved.
              </p>
            ))}
        </div>
        <footer className="housing-footer">
          <div>
            {busy ? (
              <span role="status">{busy}…</span>
            ) : currentPreview ? (
              <span>Draft preview · {currentPreview.result.status}</span>
            ) : (
              <span>Apply creates one Undo step.</span>
            )}
          </div>
          <div className="housing-actions">
            {busy && (
              <button
                type="button"
                onClick={() => {
                  pending.current?.abort();
                  pending.current = null;
                  setBusy("");
                }}
              >
                Cancel preparation
              </button>
            )}
            {tab !== "review" && tab !== "results" && (
              <button type="button" onClick={() => setTab("review")}>
                Review groups
              </button>
            )}
            {tab === "results" && (
              <button type="button" onClick={() => setTab("review")}>
                Return to review
              </button>
            )}
            {currentPreview && (
              <button
                className="housing-primary"
                type="button"
                disabled={
                  !!busy ||
                  !props.canEdit ||
                  stale ||
                  !reviewed ||
                  currentPreview.result.status === "stale"
                }
                onClick={() => void apply()}
              >
                Apply housing evidence
              </button>
            )}
            {savedResult && tab === "results" && (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  try {
                    exportHousingCSV(place, project, scenario, props.results!);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Export failed.");
                  }
                }}
              >
                Download saved housing CSV
              </button>
            )}
            {scenario.affordability &&
              props.onRemove &&
              props.canEdit &&
              tab === "review" && (
                <button
                  type="button"
                  disabled={!!busy || stale}
                  onClick={props.onRemove}
                >
                  Remove housing evidence
                </button>
              )}
          </div>
        </footer>
      </div>
      {confirmClose && (
        <div
          className="housing-confirm"
          role="alertdialog"
          aria-label="Discard housing draft"
        >
          <p>
            Discard this unsaved housing review? Applied project evidence is
            retained.
          </p>
          <button type="button" onClick={() => setConfirmClose(false)}>
            Keep editing
          </button>
          <button
            type="button"
            onClick={() => {
              pending.current?.abort();
              props.onClose();
            }}
          >
            Discard draft and close
          </button>
        </div>
      )}
    </Modal>
  );
}
