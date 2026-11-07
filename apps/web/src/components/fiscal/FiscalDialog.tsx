import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  createFiscalScenarioReview,
  type Command,
  type FiscalProfile,
  type FiscalResolution,
  type Place,
  type Project,
  type Scenario,
} from "@urban/core";
import { Modal } from "../Modal";
import { ApiError } from "../../lib/api";
import {
  fiscalApi,
  type FiscalProfileSubmission,
  type FiscalProfileVersionView,
} from "../../lib/fiscal-api";
import { saveLocalFiscalProfile } from "../../lib/fiscal-library";
import { previewFiscalStudy } from "../../lib/fiscal-task";
import { exportFiscalCSV } from "../../lib/fiscal-export";
import {
  createFiscalProfileDraft,
  fiscalCaseDraft,
  readFiscalCases,
  readFiscalOffer,
  readFiscalProfileDraft,
} from "./draft";
import { FiscalNumber, FiscalText } from "./FiscalFields";
import { FiscalProfileEditor } from "./FiscalProfileEditor";
import { FiscalCasesEditor } from "./FiscalCasesEditor";
import { FiscalLibrary } from "./FiscalLibrary";
import { FiscalProfileEvidence, FiscalResults } from "./FiscalOverview";
import "./fiscal.css";
import { fiscalPreviewMatches } from "./preview-scope";

export interface FiscalNewStudyRequest {
  profile: FiscalProfile;
  name: string;
  applicabilityNotes: string;
  saved: boolean;
  idempotencyKey: string;
  libraryVersionId?: string;
}
export interface FiscalDialogProps {
  place: Place;
  project: Project;
  scenario: Scenario;
  results?: import("@urban/core").ModelResults;
  canEdit: boolean;
  canCreateSaved: boolean;
  canReadLibrary: boolean;
  canWriteLibrary: boolean;
  actor: string;
  accountScope: string;
  onClose: () => void;
  onApply: (command: Extract<Command, { type: "scenario.fiscal" }>) => void;
  onCreateStudy: (
    request: FiscalNewStudyRequest,
    signal: AbortSignal,
  ) => Promise<void>;
  onAccessError?: () => void;
}
const reason = (error: unknown) => {
  const issues = (
    error as { issues?: { path: (string | number)[]; message: string }[] }
  )?.issues;
  return issues?.length
    ? `${issues[0].path.join(" · ")}: ${issues[0].message}`
    : error instanceof Error
      ? error.message
      : "The fiscal operation could not be completed.";
};
export function FiscalDialog(props: FiscalDialogProps) {
  const { place, project, scenario, actor, accountScope } = props;
  const study = project.fiscalStudy;
  const [stamp] = useState(() => new Date().toISOString());
  const [initial] = useState(() => ({
    profile: createFiscalProfileDraft(scenario, study?.profile),
    offer: {
      grant: String(scenario.assumptions.incentiveGrant),
      abatement: String(scenario.assumptions.abatementPercent * 100),
      years: String(scenario.assumptions.abatementYears),
    },
    cases: (scenario.fiscal?.cases ?? []).map((item) => fiscalCaseDraft(item)),
    reviewNotes: scenario.fiscal?.review.notes ?? "",
    revision: scenario.revision,
  }));
  const [profile, setProfile] = useState(initial.profile),
    [offer, setOffer] = useState(initial.offer),
    [cases, setCases] = useState(initial.cases),
    [reviewNotes, setReviewNotes] = useState(initial.reviewNotes),
    [reviewed, setReviewed] = useState(false);
  const [section, setSection] = useState<
      "study" | "offer" | "cases" | "results" | "library"
    >(study ? "offer" : "study"),
    [newProfile, setNewProfile] = useState(!study),
    [studyName, setStudyName] = useState(`${project.name} · fiscal study`),
    [applicability, setApplicability] = useState(""),
    [applicabilityReviewed, setApplicabilityReviewed] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(""),
    [refresh, setRefresh] = useState(0),
    [version, setVersion] = useState<FiscalProfileVersionView | undefined>(),
    [versionDraft, setVersionDraft] = useState<string | null>(null),
    [confirmation, setConfirmation] = useState<
      "close" | "profile" | "create-local" | "create-saved" | null
    >(null);
  const [pendingProfile, setPendingProfile] = useState<{
    profile: FiscalProfile;
    version?: FiscalProfileVersionView;
  } | null>(null);
  const [preview, setPreview] = useState<{
    fingerprint: string;
    scenario: Scenario;
    study: NonNullable<Project["fiscalStudy"]>;
    value: FiscalResolution;
  } | null>(null);
  const alive = useRef(true),
    controller = useRef<AbortController | null>(null),
    live = useRef(props);
  live.current = props;
  const libraryAttempt = useRef<{
      fingerprint: string;
      body: FiscalProfileSubmission;
    } | null>(null),
    createAttempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const stale = scenario.revision !== initial.revision,
    canMutate = props.canEdit && !stale;
  const offerFingerprint = JSON.stringify({
    offer,
    cases,
    reviewNotes,
    reviewed,
  });
  const offerDirty =
    JSON.stringify({ offer, cases, reviewNotes }) !==
    JSON.stringify({
      offer: initial.offer,
      cases: initial.cases,
      reviewNotes: initial.reviewNotes,
    });
  const profileDirty =
    JSON.stringify(profile) !== JSON.stringify(initial.profile);
  const dirty =
    profileDirty || offerDirty || reviewed || applicability.trim() !== "";
  const readProfile = useMemo(() => {
    try {
      return {
        value: readFiscalProfileDraft(profile, actor, stamp),
        error: "",
      };
    } catch (failure) {
      return { value: null, error: reason(failure) };
    }
  }, [profile, actor, stamp]);
  const readOffer = useMemo(() => {
    try {
      return {
        value: readFiscalOffer(offer),
        cases: readFiscalCases(cases),
        error: "",
      };
    } catch (failure) {
      return { value: null, cases: [], error: reason(failure) };
    }
  }, [offer, cases]);
  const previewCurrent = fiscalPreviewMatches(
    preview,
    scenario,
    study,
    offerFingerprint,
    initial.revision,
  );
  const currentResult = stale
    ? undefined
    : previewCurrent
      ? preview!.value
      : !offerDirty && !reviewed
        ? props.results?.fiscal
        : undefined;
  const valid = () =>
    alive.current &&
    live.current.accountScope === accountScope &&
    live.current.scenario.id === scenario.id &&
    live.current.place === place;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!props.canEdit || stale) {
      controller.current?.abort();
      controller.current = null;
      setBusy("");
      setConfirmation(null);
      setPreview(null);
    }
  }, [props.canEdit, stale]);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  function updateProfile(value: typeof profile) {
    if (!canMutate) return;
    setProfile(value);
    setApplicabilityReviewed(false);
    setError("");
  }
  function updateOffer(value: typeof offer) {
    if (!canMutate) return;
    setOffer(value);
    setReviewed(false);
    setError("");
  }
  function updateCases(value: typeof cases) {
    if (!canMutate) return;
    setCases(value);
    setReviewed(false);
    setError("");
  }
  function requestClose() {
    if (busy) {
      controller.current?.abort();
      controller.current = null;
      setBusy("");
    }
    dirty ? setConfirmation("close") : props.onClose();
  }
  function takeProfile(
    value: FiscalProfile,
    selected?: FiscalProfileVersionView,
  ) {
    if (!canMutate) return;
    setPendingProfile({ profile: value, version: selected });
    if (profileDirty) setConfirmation("profile");
    else applyProfile(value, selected);
  }
  function applyProfile(
    value: FiscalProfile,
    selected?: FiscalProfileVersionView,
  ) {
    const nextDraft = createFiscalProfileDraft(scenario, value);
    setProfile(nextDraft);
    setVersion(selected);
    setVersionDraft(selected ? JSON.stringify(nextDraft) : null);
    setApplicabilityReviewed(false);
    setNewProfile(true);
    setSection("study");
    setNotice(
      "Profile copied into the draft for review. No project has changed.",
    );
    setPendingProfile(null);
  }
  function command() {
    if (
      !study ||
      !readOffer.value ||
      readOffer.error ||
      !reviewed ||
      !reviewNotes.trim()
    )
      throw new Error(
        readOffer.error ||
          "Review the current assumptions and enter review notes before applying.",
      );
    return {
      type: "scenario.fiscal" as const,
      fiscal: createFiscalScenarioReview(
        scenario,
        study.profileHash,
        {
          reviewedBy: actor,
          reviewedAt: new Date().toISOString(),
          notes: reviewNotes,
        },
        readOffer.cases,
      ),
      offer: readOffer.value,
    };
  }
  async function previewDraft() {
    if (!canMutate || busy || !study) return;
    let action;
    try {
      action = command();
    } catch (failure) {
      setError(reason(failure));
      return;
    }
    const signalController = new AbortController();
    controller.current = signalController;
    setBusy("Calculating the reviewed offer and cases");
    setError("");
    try {
      const value = await previewFiscalStudy(
        place,
        study,
        {
          ...scenario,
          assumptions: { ...scenario.assumptions, ...action.offer },
          fiscal: action.fiscal,
        },
        signalController.signal,
      );
      if (
        valid() &&
        !signalController.signal.aborted &&
        live.current.scenario === scenario &&
        live.current.project.fiscalStudy === study
      ) {
        setPreview({ fingerprint: offerFingerprint, scenario, study, value });
        setSection("results");
      }
    } catch (failure) {
      if (valid() && !signalController.signal.aborted)
        setError(reason(failure));
    } finally {
      if (valid() && controller.current === signalController) setBusy("");
    }
  }
  function apply() {
    if (!canMutate || busy) return;
    try {
      props.onApply(command());
      props.onClose();
    } catch (failure) {
      setError(reason(failure));
    }
  }
  async function saveProfile(shared: boolean, append = false) {
    if (
      !canMutate ||
      busy ||
      !readProfile.value ||
      (shared && !props.canWriteLibrary)
    )
      return;
    const signalController = new AbortController();
    controller.current = signalController;
    setBusy("Saving immutable profile");
    setError("");
    try {
      if (shared) {
        const input = {
          profile: readProfile.value,
          ...(append && version
            ? {
                profileId: version.profileId,
                expectedLatestVersionId: version.id,
              }
            : { expectedLatestVersionId: null }),
        };
        const fingerprint = JSON.stringify(input);
        if (libraryAttempt.current?.fingerprint !== fingerprint)
          libraryAttempt.current = {
            fingerprint,
            body: { ...input, idempotencyKey: crypto.randomUUID() },
          };
        const result = await fiscalApi.save(
          libraryAttempt.current.body,
          signalController.signal,
        );
        if (!valid() || signalController.signal.aborted) return;
        libraryAttempt.current = null;
        const savedDraft = createFiscalProfileDraft(scenario, result.profile);
        setProfile(savedDraft);
        setVersion(result.version);
        setVersionDraft(JSON.stringify(savedDraft));
      } else {
        await saveLocalFiscalProfile(accountScope, readProfile.value);
        if (!valid() || signalController.signal.aborted) return;
      }
      setRefresh((value) => value + 1);
      setNotice(
        shared
          ? "Immutable profile saved to this workspace. Existing studies still use their original version."
          : "Immutable profile saved in this browser for this account scope.",
      );
    } catch (failure) {
      if (valid() && !signalController.signal.aborted) {
        setError(reason(failure));
        if (failure instanceof ApiError && [401, 403].includes(failure.status))
          props.onAccessError?.();
      }
    } finally {
      if (valid() && controller.current === signalController) setBusy("");
    }
  }
  async function create(saved: boolean) {
    if (
      !canMutate ||
      busy ||
      !readProfile.value ||
      !applicabilityReviewed ||
      !applicability.trim() ||
      !studyName.trim()
    )
      return;
    const signalController = new AbortController();
    controller.current = signalController;
    setBusy(
      saved
        ? "Saving the source and creating a separate fiscal study"
        : "Creating a separate browser fiscal study",
    );
    setError("");
    setConfirmation(null);
    try {
      const input = {
        profile: readProfile.value,
        name: studyName.trim(),
        applicabilityNotes: applicability.trim(),
        saved,
        ...(saved && version && versionDraft === JSON.stringify(profile)
          ? { libraryVersionId: version.id }
          : {}),
      };
      const fingerprint = JSON.stringify(input);
      if (createAttempt.current?.fingerprint !== fingerprint)
        createAttempt.current = { fingerprint, id: crypto.randomUUID() };
      await props.onCreateStudy(
        { ...input, idempotencyKey: createAttempt.current.id },
        signalController.signal,
      );
      if (valid() && !signalController.signal.aborted) props.onClose();
    } catch (failure) {
      if (valid() && !signalController.signal.aborted)
        setError(reason(failure));
    } finally {
      if (valid() && controller.current === signalController) setBusy("");
    }
  }
  return (
    <Modal
      title="A clearer case for the public dollar."
      description="Cited local inputs, the same development, and an offer you can explain."
      wide
      open
      onClose={requestClose}
    >
      <div className="fiscal-workbench fiscal-dialog-body" aria-busy={!!busy}>
        <p>
          Review the fiscal study separately from market feasibility or a claim
          that an incentive induces development. No employer wage or non-fiscal
          assumption changes when a profile is applied.
        </p>
        {stale && (
          <p role="alert" className="fiscal-error">
            The scenario changed while this workbench was open. Your draft is
            retained here for inspection; close and reopen before applying to
            the new revision. Earlier draft results are withheld.
          </p>
        )}
        {!props.canEdit && (
          <p className="notice">
            Read-only review. Editing requires an editable alternative and
            current project access.
          </p>
        )}
        {error && (
          <p role="alert" className="fiscal-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {busy && <p role="status">{busy}…</p>}
        <nav className="fiscal-tabs" aria-label="Fiscal workbench sections">
          {(
            [
              ["study", study ? "Profile & sources" : "New study"],
              ["offer", "Offer & review"],
              ["cases", "Sensitivity cases"],
              ["results", "Cash flows"],
              ["library", "Profile library"],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              className="button"
              key={id}
              aria-pressed={section === id}
              disabled={
                !!busy ||
                (!study &&
                  (id === "offer" || id === "cases" || id === "results"))
              }
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        {section === "study" && (
          <>
            {study && !newProfile ? (
              <>
                <FiscalProfileEvidence
                  study={study}
                  scenario={scenario}
                  resolution={props.results?.fiscal}
                />
                <button
                  type="button"
                  className="button"
                  disabled={!canMutate || !!busy}
                  onClick={() => setNewProfile(true)}
                >
                  Prepare another fiscal study
                </button>
              </>
            ) : (
              <fieldset disabled={!canMutate || !!busy}>
                <legend>New immutable profile and study</legend>
                <FiscalProfileEditor draft={profile} onChange={updateProfile} />
                {readProfile.error && (
                  <p className="fiscal-muted">
                    Before saving this profile: {readProfile.error}
                  </p>
                )}
                <div className="fiscal-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={!readProfile.value}
                    onClick={() => void saveProfile(false)}
                  >
                    Save profile in this browser
                  </button>
                  {props.canWriteLibrary && (
                    <>
                      <button
                        type="button"
                        className="button"
                        disabled={!readProfile.value}
                        onClick={() => void saveProfile(true)}
                      >
                        Save new workspace profile
                      </button>
                      {version && (
                        <button
                          type="button"
                          className="button"
                          disabled={!readProfile.value}
                          onClick={() => void saveProfile(true, true)}
                        >
                          Append workspace profile version
                        </button>
                      )}
                    </>
                  )}
                </div>
                <hr />
                <FiscalText
                  label="New fiscal study name"
                  value={studyName}
                  maxLength={240}
                  onChange={setStudyName}
                />
                <FiscalText
                  label="Study applicability review"
                  value={applicability}
                  multiline
                  maxLength={4000}
                  hint="Explain why these jurisdiction, valuation and service allocations apply to this study area and the selected current development."
                  onChange={(value) => {
                    setApplicability(value);
                    setApplicabilityReviewed(false);
                  }}
                />
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={applicabilityReviewed}
                    onChange={(event) =>
                      setApplicabilityReviewed(event.target.checked)
                    }
                  />
                  <span>
                    I reviewed the cited profile, its constant-dollar basis, and
                    its applicability to this study area. I understand this
                    creates a separate study with a new fiscal baseline.
                  </span>
                </label>
                <div className="fiscal-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={
                      !readProfile.value ||
                      !applicabilityReviewed ||
                      !applicability.trim() ||
                      !studyName.trim()
                    }
                    onClick={() => setConfirmation("create-local")}
                  >
                    Create browser fiscal study
                  </button>
                  {props.canCreateSaved && (
                    <button
                      type="button"
                      className="button"
                      disabled={
                        !readProfile.value ||
                        !applicabilityReviewed ||
                        !applicability.trim() ||
                        !studyName.trim()
                      }
                      onClick={() => setConfirmation("create-saved")}
                    >
                      Save source & create fiscal study
                    </button>
                  )}
                </div>
              </fieldset>
            )}
          </>
        )}
        {section === "library" && (
          <FiscalLibrary
            key={accountScope}
            scope={accountScope}
            shared={props.canReadLibrary}
            refreshKey={refresh}
            onSelect={takeProfile}
          />
        )}
        {section === "offer" && study && (
          <fieldset disabled={!canMutate || !!busy}>
            <legend>Offer and current input review</legend>
            <p className="notice">
              The no-offer case assumes the same development occurs. The
              difference shows the offer's modeled cost; it does not measure
              behavioral inducement.
            </p>
            <div className="fiscal-grid">
              <FiscalNumber
                label="Fiscal upfront grant ($)"
                value={offer.grant}
                onChange={(grant) => updateOffer({ ...offer, grant })}
                hint="Paid at time zero, at the start of the selected forecast horizon."
              />
              <FiscalNumber
                label="Fiscal added-value abatement (%)"
                value={offer.abatement}
                onChange={(abatement) => updateOffer({ ...offer, abatement })}
                hint="Applies to added taxable assessed value, not the whole existing tax base."
              />
              <FiscalNumber
                label="Fiscal abatement term (years)"
                value={offer.years}
                onChange={(years) => updateOffer({ ...offer, years })}
              />
            </div>
            <FiscalProfileEvidence
              study={study}
              scenario={scenario}
              resolution={props.results?.fiscal}
            />
            <FiscalText
              label="Current fiscal input review notes"
              value={reviewNotes}
              multiline
              maxLength={4000}
              onChange={(value) => {
                setReviewNotes(value);
                setReviewed(false);
              }}
              hint="Explain any authored deviations from the profile, household/service assumptions, remaining limitations and the paired cases."
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              <span>
                I reviewed the current fiscal and demographic inputs, offer, and
                named sensitivity cases. Profile citations do not independently
                verify my overrides.
              </span>
            </label>
          </fieldset>
        )}
        {section === "cases" && study && (
          <fieldset disabled={!canMutate || !!busy}>
            <legend>Paired sensitivity assumptions</legend>
            <FiscalCasesEditor
              cases={cases}
              sources={study.profile.sources}
              onChange={updateCases}
            />
          </fieldset>
        )}
        {section === "results" && (
          <>
            {currentResult ? (
              <FiscalResults resolution={currentResult} />
            ) : (
              <p className="notice">
                Review the current draft and choose Preview offer & cases.
                Results from an earlier draft are withheld when inputs change.
              </p>
            )}
            {previewCurrent && (
              <p className="notice">
                Draft preview only. Apply this offer and its cases to retain
                them in scenario history.
              </p>
            )}
          </>
        )}
        {study && section !== "study" && section !== "library" && (
          <div className="fiscal-footer">
            {section !== "results" && (
              <p className="fiscal-muted">
                {readOffer.error ||
                  (!reviewed
                    ? "Review and acknowledge the current inputs before applying or previewing a changed offer."
                    : "One Apply records the offer and named paired cases together. Undo restores their previous values.")}
              </p>
            )}
            <div className="fiscal-actions">
              {section !== "results" && (
                <button
                  type="button"
                  className="button"
                  disabled={
                    !canMutate ||
                    !!busy ||
                    !!readOffer.error ||
                    !reviewed ||
                    !reviewNotes.trim()
                  }
                  onClick={() => void previewDraft()}
                >
                  Preview offer & cases
                </button>
              )}
              {(section !== "results" || offerDirty || reviewed) && (
                <button
                  type="button"
                  className="button primary"
                  disabled={
                    !canMutate ||
                    !!busy ||
                    !!readOffer.error ||
                    !reviewed ||
                    !reviewNotes.trim()
                  }
                  onClick={apply}
                >
                  Apply offer & sensitivity cases
                </button>
              )}
              {section === "results" && (
                <button
                  type="button"
                  className="button"
                  onClick={() => setSection("offer")}
                >
                  Review inputs
                </button>
              )}
              {section === "results" && !offerDirty && !reviewed && (
                <button
                  type="button"
                  className="button"
                  disabled={
                    !!busy || offerDirty || reviewed || !props.results?.fiscal
                  }
                  onClick={() => {
                    try {
                      exportFiscalCSV(place, project, scenario, props.results!);
                    } catch (failure) {
                      setError(reason(failure));
                    }
                  }}
                >
                  Download applied fiscal CSV
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <Dialog.Root
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content
            className="modal"
            role="alertdialog"
            aria-describedby="fiscal-confirm-description"
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            <Dialog.Title>
              {confirmation === "close"
                ? "Discard this fiscal draft?"
                : confirmation === "profile"
                  ? "Replace the profile draft?"
                  : "Create a separate fiscal study?"}
            </Dialog.Title>
            <Dialog.Description id="fiscal-confirm-description">
              {confirmation === "close"
                ? "Applied scenario values and saved profiles remain intact. Unapplied input changes will be discarded."
                : confirmation === "profile"
                  ? "This replaces only the profile draft. No current project or baseline changes."
                  : "The new study contains a new fiscal baseline and the selected current alternative, with fresh undo history. Earlier history stays in the original study. Current geometry and evidence are retained; copied native captures are imported evidence. The original study and reports are not rewritten."}
            </Dialog.Description>
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                onClick={() => setConfirmation(null)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  const action = confirmation;
                  setConfirmation(null);
                  if (action === "close") props.onClose();
                  else if (action === "profile" && pendingProfile)
                    applyProfile(
                      pendingProfile.profile,
                      pendingProfile.version,
                    );
                  else if (
                    action === "create-local" ||
                    action === "create-saved"
                  )
                    void create(action === "create-saved");
                }}
              >
                {confirmation === "close"
                  ? "Discard draft"
                  : confirmation === "profile"
                    ? "Use selected profile"
                    : "Create separate study"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Modal>
  );
}
