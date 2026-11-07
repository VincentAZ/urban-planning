import { FiscalPanel } from "./fiscal/FiscalOverview";
import { useEffect, useId, useMemo, useState } from "react";
import {
  ArrowRight,
  Building2,
  Check,
  CircleHelp,
  Factory,
  Home,
  Landmark,
  Leaf,
  ParkingSquare,
  Plus,
  School,
  ShoppingBag,
  Stethoscope,
  Trash2,
  Warehouse,
  X,
} from "lucide-react";
import {
  landUseLabels,
  type Assumptions,
  buildingTypologyLabels,
  buildingTypologyUse,
  type BuildingTypology,
  type LandUse,
  type Road,
  USER_ROAD_SOURCE,
} from "@urban/core";
import { validateAssumptions } from "@urban/models";
import { roadSchema } from "../../../../packages/core/src/validation";
import { useWorkspace } from "../lib/workspace";
import { RetailPanel } from "./retail/RetailOverview";
import { WorkforcePanel } from "./workforce/WorkforceOverview";
import { AccessibilityPanel } from "./accessibility/AccessibilityOverview";

export function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-with-suffix">
        <input
          type="number"
          aria-label={label}
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (Number.isFinite(v)) onChange(v);
          }}
        />
        {suffix && <span>{suffix}</span>}
      </div>
    </label>
  );
}
const buildingIcons: Record<LandUse, typeof Home> = {
  residential: Home,
  multifamily: Building2,
  retail: ShoppingBag,
  office: Building2,
  industrial: Factory,
  warehouse: Warehouse,
  school: School,
  healthcare: Stethoscope,
  civic: Landmark,
  "mixed-use": Building2,
  park: Leaf,
  parking: ParkingSquare,
  vacant: Landmark,
};
export function BuildingLibrary({
  onPlace,
  onDraw,
}: {
  onPlace: (typology: BuildingTypology) => void;
  onDraw: (typology: BuildingTypology) => void;
}) {
  const [drawing, setDrawing] = useState(false);
  return (
    <>
      <div className="panel-intro">
        <span className="eyebrow">MAKE ROOM FOR WHAT’S NEXT</span>
        <h2>Build a possibility.</h2>
        <p>
          Choose a starting point. Shape the footprint, tune the program, and
          review your idea before applying.
        </p>
      </div>
      <div
        className="building-entry-mode"
        role="group"
        aria-label="Building creation method"
      >
        <button aria-pressed={!drawing} onClick={() => setDrawing(false)}>
          Place a preset
        </button>
        <button aria-pressed={drawing} onClick={() => setDrawing(true)}>
          Draw a footprint
        </button>
      </div>
      <div className="building-library">
        {(Object.keys(buildingTypologyLabels) as BuildingTypology[]).map(
          (typology) => {
            const use = buildingTypologyUse[typology],
              Icon = buildingIcons[use];
            return (
              <button
                key={typology}
                className={`library-item use-${use}`}
                onClick={() => (drawing ? onDraw(typology) : onPlace(typology))}
              >
                <span className="library-illustration">
                  <Icon size={28} strokeWidth={1.3} />
                </span>
                <span>{buildingTypologyLabels[typology]}</span>
                <Plus size={13} />
              </button>
            );
          },
        )}
      </div>
      <div className="tip">
        <CircleHelp size={15} />
        <span>
          Editable planning presets with illustrative quantities. Apply adds one
          reversible edit to your alternative.
        </span>
      </div>
    </>
  );
}
export function RoadEditor({
  road,
  onClose,
  onEditGeometry,
}: {
  road: Road;
  onClose: () => void;
  onEditGeometry?: (road: Road) => void;
}) {
  const dispatch = useWorkspace((s) => s.dispatch);
  const [draft, setDraft] = useState(road);
  const [removing, setRemoving] = useState(false);
  const validationId = useId();
  const validated = useMemo(
    () =>
      roadSchema.safeParse({
        ...draft,
        name: draft.name.trim(),
        attributeSourceId: USER_ROAD_SOURCE.id,
        estimated: true,
      }),
    [draft],
  );
  const validationMessage = validated.success
    ? null
    : [
        ...new Set(
          validated.error.issues.map((issue) => {
            switch (issue.path[0]) {
              case "name":
                return "Use a street name between 1 and 240 characters.";
              case "lanes":
                return "Enter a whole number of travel lanes from 1 to 20.";
              case "speedMph":
                return "Enter a speed limit from 0 to 150 mph.";
              case "cycleSeconds":
                return "Enter a signal cycle from 1 to 1,000 seconds.";
              case "greenSplit":
                return "Enter a green split from 0% to 100%.";
              default:
                return `Street ${String(issue.path[0] ?? "settings")}: ${issue.message}`;
            }
          }),
        ),
      ].join(" ");
  const changed = JSON.stringify(draft) !== JSON.stringify(road);
  const editable = useWorkspace(
    (s) => s.project?.activeScenarioId !== "baseline" && !s.readOnly,
  );
  useEffect(() => {
    setDraft(road);
    setRemoving(false);
  }, [road]);
  return (
    <div className="inspector">
      <div className="panel-heading">
        <span className="eyebrow">STREET INSPECTOR</span>
        <button
          className="icon-button"
          aria-label="Close road inspector"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <h2>{road.name}</h2>
      <p className="muted">Street configuration · {road.kind}</p>
      <fieldset
        disabled={!editable}
        aria-describedby={validationMessage ? validationId : undefined}
      >
        <label className="field">
          <span>Street name</span>
          <input
            aria-label="Street name"
            value={draft.name}
            maxLength={240}
            aria-invalid={
              !validated.success &&
              validated.error.issues.some((issue) => issue.path[0] === "name")
            }
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </label>
        <NumberField
          label="Travel lanes"
          value={draft.lanes}
          min={1}
          max={20}
          onChange={(lanes) => setDraft({ ...draft, lanes: Math.round(lanes) })}
        />
        <NumberField
          label="Speed limit"
          value={draft.speedMph}
          min={0}
          max={150}
          suffix="mph"
          onChange={(speedMph) => setDraft({ ...draft, speedMph })}
        />
        {(["oneWay", "closed", "bikeLane", "busLane", "signal"] as const).map(
          (key, i) => (
            <label className="check-row" key={key}>
              <span>
                {
                  [
                    "One way",
                    "Close this street",
                    "Protected bike lane",
                    "Bus priority lane",
                    "Traffic signal",
                  ][i]
                }
              </span>
              <input
                type="checkbox"
                checked={!!draft[key]}
                onChange={(e) =>
                  setDraft({ ...draft, [key]: e.target.checked })
                }
              />
            </label>
          ),
        )}
        {draft.signal && (
          <>
            <NumberField
              label="Signal cycle"
              value={draft.cycleSeconds ?? 90}
              min={1}
              max={1000}
              suffix="sec"
              onChange={(cycleSeconds) => setDraft({ ...draft, cycleSeconds })}
            />
            <NumberField
              label="Green split"
              value={Math.round((draft.greenSplit ?? 0.5) * 100)}
              min={0}
              max={100}
              suffix="%"
              onChange={(v) => setDraft({ ...draft, greenSplit: v / 100 })}
            />
          </>
        )}
        {validationMessage && (
          <p id={validationId} className="street-validation" role="alert">
            {validationMessage}
          </p>
        )}
        <button
          className="button primary full-width"
          disabled={!changed || !validated.success}
          onClick={() => {
            if (!editable || !validated.success) return;
            dispatch(
              {
                type: "road.upsert",
                road: validated.data,
                source: USER_ROAD_SOURCE,
              },
              `Update ${road.name}`,
            );
          }}
        >
          Apply street changes <ArrowRight size={15} />
        </button>
        {onEditGeometry && (
          <div className="street-editor-actions">
            <button
              className="button full-width"
              disabled={changed}
              title={
                changed ? "Apply street settings before reshaping." : undefined
              }
              onClick={() => onEditGeometry(road)}
            >
              Reshape street path
            </button>
            <button
              className="button full-width danger"
              onClick={() => setRemoving(true)}
            >
              <Trash2 size={14} /> Remove street
            </button>
          </div>
        )}
        {changed && onEditGeometry && (
          <p className="street-help">
            Apply the settings before reshaping the street path.
          </p>
        )}
        {removing && (
          <div
            className="street-remove-check"
            role="group"
            aria-label="Confirm street removal"
          >
            <p>
              Remove {road.name} from this alternative? The baseline is
              preserved, and you can undo this edit.
            </p>
            <div>
              <button
                className="button danger"
                onClick={() => {
                  dispatch(
                    { type: "road.remove", id: road.id },
                    `Remove ${road.name}`,
                  );
                  onClose();
                }}
              >
                Remove from scenario
              </button>
              <button className="button" onClick={() => setRemoving(false)}>
                Keep street
              </button>
            </div>
          </div>
        )}
      </fieldset>
      <div className="tip">
        Network edits change the scenario. Calibrated delay and LOS require
        traffic counts and a detailed run.
      </div>
    </div>
  );
}
export function AssumptionsEditor({
  assumptions,
  activityEnabled = false,
  retailEnabled = false,
  onClose,
}: {
  assumptions: Assumptions;
  activityEnabled?: boolean;
  retailEnabled?: boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(assumptions);
  const dispatch = useWorkspace((s) => s.dispatch);
  const editable = useWorkspace(
    (s) => !s.readOnly && s.project?.activeScenarioId !== "baseline",
  );
  const [tab, setTab] = useState("People");
  const field = (
    key: keyof Assumptions,
    label: string,
    multiplier = 1,
    suffix?: string,
    step = 1,
  ) => (
    <NumberField
      key={key}
      label={label}
      value={Number(draft[key]) * multiplier}
      step={step}
      suffix={suffix}
      onChange={(value) => setDraft({ ...draft, [key]: value / multiplier })}
    />
  );
  const total =
    draft.driveShare + draft.transitShare + draft.bikeShare + draft.walkShare;
  const issues = validateAssumptions(draft);
  return (
    <div>
      <div className="tabs">
        {["People", "Mobility", "Economy", "Fiscal"].map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="notice">
        Starting coefficients are illustrative product defaults unless you
        supply and confirm local inputs. Changes are saved with this scenario.
      </div>
      {!editable && (
        <p className="notice">
          These assumptions are open for inspection. Editing requires an
          editable alternative and project editor access.
        </p>
      )}
      <fieldset
        className="assumptions-grid permission-fields"
        disabled={!editable}
      >
        {tab === "People" && (
          <>
            {field("householdSize", "People per household", 1, undefined, 0.1)}
            {field("vacancyRate", "Vacancy", 100, "%", 0.1)}
            {field("annualGrowthRate", "Annual growth", 100, "%", 0.1)}
            {activityEnabled ? (
              <p className="notice">
                Explicit population targets are active in People. Household size
                and vacancy still describe physical housing capacity; the legacy
                population sensitivity is superseded.
              </p>
            ) : (
              field(
                "populationMultiplier",
                "Housing population sensitivity",
                100,
                "%",
              )
            )}
          </>
        )}
        {tab === "Mobility" && (
          <>
            {field("driveShare", "Driving share", 100, "%")}
            {field("transitShare", "Transit share", 100, "%")}
            {field("bikeShare", "Cycling share", 100, "%")}
            {field("walkShare", "Walking share", 100, "%")}
            {field(
              "vehicleMultiplier",
              "Legacy trip-demand sensitivity",
              100,
              "%",
            )}
            <p className="notice">
              Change this percentage to show fewer or more moving cars: 50% is
              lighter traffic, 100% is the default, 200% is heavier, and 0%
              hides the cars. Save assumptions to apply. The map samples up to
              12 cars per road and 650 overall, with no further increase above
              300%. This also scales estimated trip ends; it does not change
              demand in Traffic simulation runs. Household vehicle counts have
              separate references and targets in People.
            </p>
            {field("averageTripMiles", "Average trip distance", 1, "mi", 0.1)}
            {field("parkingPerUnit", "Parking per home", 1, undefined, 0.1)}
            {field(
              "parkingPer1000Sqft",
              "Parking per 1,000 ft²",
              1,
              undefined,
              0.1,
            )}
          </>
        )}
        {tab === "Economy" && (
          <>
            {field("annualWage", "Annual wage", 1, "$")}
            {field("salesPerSqft", "Annual retail sales / ft²", 1, "$")}
            {field("retailCaptureRate", "Local retail capture", 100, "%")}
            {retailEnabled && (
              <p className="notice">
                The retail workbench has its own category demand, sales and
                capture assumptions. These general retail settings continue to
                inform the separate fiscal estimate based on retail floor area.
              </p>
            )}
          </>
        )}
        {tab === "Fiscal" && (
          <>
            <label className="field">
              <span>Receiving jurisdiction</span>
              <input
                value={draft.jurisdictionName}
                onChange={(e) =>
                  setDraft({ ...draft, jurisdictionName: e.target.value })
                }
              />
            </label>
            {field(
              "effectivePropertyTaxRate",
              "Effective property levy",
              100,
              "%",
              0.01,
            )}
            {field(
              "localSalesTaxRate",
              "Retained sales tax rate",
              100,
              "%",
              0.01,
            )}
            {field("assessedValuePerSqft", "Assessed value / ft²", 1, "$")}
            {field(
              "annualServiceCostPerResident",
              "Annual service cost / resident",
              1,
              "$",
            )}
            {field(
              "annualServiceCostPerJob",
              "Annual service cost / job",
              1,
              "$",
            )}
            {field("discountRate", "Real discount rate", 100, "%", 0.1)}
            <label className="check-row">
              <span>
                I have reviewed these fiscal inputs for this jurisdiction
              </span>
              <input
                type="checkbox"
                checked={draft.fiscalInputsConfirmed}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    fiscalInputsConfirmed: e.target.checked,
                  })
                }
              />
            </label>
          </>
        )}
      </fieldset>
      {issues.length > 0 && (
        <div className="error-message" role="alert">
          {issues.join(" ")}
        </div>
      )}
      <div className="modal-actions">
        <button className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={!editable || issues.length > 0}
          onClick={() => {
            dispatch(
              { type: "assumptions.update", patch: draft },
              "Update scenario assumptions",
            );
            onClose();
          }}
        >
          Save assumptions
        </button>
      </div>
    </div>
  );
}
export function EconomyPanel({
  onPlace,
  onAssumptions,
  onRetail,
  onWorkforce,
  onAccessibility,
  onFiscal,
  fiscalResolution,
  editable,
}: {
  onPlace: (use: LandUse) => void;
  onAssumptions: () => void;
  onRetail: () => void;
  onWorkforce: () => void;
  onAccessibility: () => void;
  onFiscal: () => void;
  fiscalResolution?: import("@urban/core").FiscalResolution;
  editable: boolean;
}) {
  const project = useWorkspace((s) => s.project);
  const place = useWorkspace((s) => s.place);
  const scenario = project?.scenarios.find(
    (s) => s.id === project.activeScenarioId,
  );
  const dispatch = useWorkspace((s) => s.dispatch);
  const [tool, setTool] = useState("Employer");
  if (!scenario) return null;
  return (
    <>
      <div className="panel-intro">
        <span className="eyebrow">ECONOMIC DEVELOPMENT</span>
        <h2>A place to prosper.</h2>
        <p>Explore an employer’s footprint and the community’s return.</p>
      </div>
      <div className="tabs compact">
        {["Employer", "Incentives", "Retail gaps", "Readiness"].map((t) => (
          <button
            className={tool === t ? "active" : ""}
            onClick={() => setTool(t)}
            key={t}
          >
            {t}
          </button>
        ))}
      </div>
      {tool === "Employer" && (
        <fieldset className="permission-fields" disabled={!editable}>
          <button
            className="employer-card"
            onClick={() => onPlace("industrial")}
          >
            <Factory size={28} />
            <div>
              <strong>Manufacturing</strong>
              <span>Production & skilled jobs</span>
            </div>
            <Plus size={15} />
          </button>
          <button
            className="employer-card"
            onClick={() => onPlace("warehouse")}
          >
            <Warehouse size={28} />
            <div>
              <strong>Logistics hub</strong>
              <span>Distribution & operations</span>
            </div>
            <Plus size={15} />
          </button>
          <button className="employer-card" onClick={() => onPlace("office")}>
            <Building2 size={28} />
            <div>
              <strong>Office & innovation</strong>
              <span>Professional employment</span>
            </div>
            <Plus size={15} />
          </button>
          <button className="employer-card" onClick={() => onPlace("retail")}>
            <ShoppingBag size={28} />
            <div>
              <strong>Neighborhood retail</strong>
              <span>Local spending & amenities</span>
            </div>
            <Plus size={15} />
          </button>
          <p className="tip">
            Place an employer, then edit its direct jobs, size, and operating
            assumptions.
          </p>
        </fieldset>
      )}
      {tool === "Incentives" && (
        <>
          <FiscalPanel
            scenario={scenario}
            study={project?.fiscalStudy}
            resolution={fiscalResolution}
            onOpen={onFiscal}
          />
          {!project?.fiscalStudy && (
            <details>
              <summary>Quick illustrative incentive assumptions</summary>
              <fieldset className="permission-fields" disabled={!editable}>
                <p className="muted">
                  Compare grant and abatement assumptions in the fiscal
                  scorecard.
                </p>
                <NumberField
                  label="Upfront grant"
                  value={scenario.assumptions.incentiveGrant}
                  suffix="$"
                  step={10000}
                  onChange={(incentiveGrant) =>
                    dispatch(
                      { type: "assumptions.update", patch: { incentiveGrant } },
                      "Update incentive grant",
                    )
                  }
                />
                <NumberField
                  label="Abatement on added property value"
                  value={scenario.assumptions.abatementPercent * 100}
                  suffix="%"
                  max={100}
                  onChange={(v) =>
                    dispatch(
                      {
                        type: "assumptions.update",
                        patch: { abatementPercent: v / 100 },
                      },
                      "Update tax abatement",
                    )
                  }
                />
                <NumberField
                  label="Abatement term"
                  value={scenario.assumptions.abatementYears}
                  suffix="years"
                  max={20}
                  onChange={(abatementYears) =>
                    dispatch(
                      { type: "assumptions.update", patch: { abatementYears } },
                      "Update abatement term",
                    )
                  }
                />
                <button className="button full-width" onClick={onAssumptions}>
                  Review local fiscal assumptions
                </button>
              </fieldset>
            </details>
          )}
        </>
      )}
      {tool === "Retail gaps" && place && (
        <RetailPanel place={place} scenario={scenario} onOpen={onRetail} />
      )}
      {tool === "Readiness" && (
        <>
          <AccessibilityPanel scenario={scenario} onOpen={onAccessibility} />
          <WorkforcePanel scenario={scenario} onOpen={onWorkforce} />
          <p className="muted">
            Select a building or parcel for other available site evidence.
          </p>
          {[
            "Parcel boundaries",
            "Authoritative zoning rules",
            "Utility capacity",
            "Incentive eligibility",
          ].map((item) => (
            <div className="readiness-row" key={item}>
              <span>{item}</span>
              <span className="badge neutral">Needs local data</span>
            </div>
          ))}
          <div className="notice">
            A nearby utility or incentive boundary does not establish site
            capacity or eligibility.
          </div>
        </>
      )}
    </>
  );
}
