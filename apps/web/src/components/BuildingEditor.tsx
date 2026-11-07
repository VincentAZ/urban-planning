import { FloodBuildingContext } from "./flood/FloodEvidence";
import type { FloodBuildingExposure } from "@urban/models";
import { useId, useState } from "react";
import {
  ArrowRight,
  Building2,
  Check,
  Move,
  MousePointer2,
  Plus,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import {
  BUILDING_EARTH_RADIUS_METERS,
  MAX_AUTHORED_BUILDING_RING_POINTS,
  MAX_BUILDING_PROGRAM_COMPONENTS,
  USER_BUILDING_SOURCE,
  ILLUSTRATIVE_BUILDING_SOURCE,
  buildingAreaSqm,
  buildingGeometry,
  buildingProgramTotals,
  buildingTypologyLabels,
  landUseLabels,
  studyAreaAnchor,
  validateBuildingGeometry,
  type Building,
  type BuildingProgramComponent,
  type BuildingRate,
  type BuildingRateBasis,
  type BuildingTypology,
  type Place,
  type Position,
  type Scenario,
  type Source,
} from "@urban/core";
import { activeBuildingPath } from "../lib/building-draft";
import type { BuildingEditorController } from "../lib/useBuildingEditor";
import "./building-editor.css";

const number = (n: number | null, digits = 0) =>
  n === null
    ? "Unknown"
    : Number.isFinite(n)
      ? n.toLocaleString(undefined, { maximumFractionDigits: digits })
      : "—";
const componentUses = Object.entries(landUseLabels).filter(
  ([use]) => !["mixed-use", "park", "vacant"].includes(use),
);
const rateBases: Record<BuildingRateBasis, string> = {
  dwelling: "Per entered home",
  "occupied-dwelling": "Per occupied home",
  "1000-sqft": "Per 1,000 ft² of component area",
  job: "Per entered job",
  bed: "Per entered bed",
};
function Numeric({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = "any",
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  suffix?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="input-with-suffix">
        <input
          aria-label={label}
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(event) => onChange(event.target.valueAsNumber)}
        />
        {suffix && <span>{suffix}</span>}
      </div>
    </label>
  );
}

function NullableQuantity({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = "any",
  suffix,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  suffix?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-with-suffix">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value !== null && Number.isFinite(value) ? value : ""}
          placeholder="Unknown"
          aria-describedby={`${id}-help`}
          onChange={(event) =>
            onChange(
              event.target.validity.badInput
                ? Number.NaN
                : event.target.value === ""
                  ? null
                  : event.target.valueAsNumber,
            )
          }
        />
        {suffix && <span>{suffix}</span>}
      </div>
      <small id={`${id}-help`}>
        Blank means unknown. An entered value is your planning assumption.
      </small>
    </div>
  );
}
function SourceName({ id, sources }: { id: string; sources: Source[] }) {
  return <>{sources.find((source) => source.id === id)?.name ?? id}</>;
}
export function BuildingInspector({
  building,
  editor,
  editable,
  place,
  scenario,
  onClose,
  onReview,
  flood,
  hasFlood,
  onFlood,
  onHousing,
}: {
  building: Building;
  editor: BuildingEditorController;
  editable: boolean;
  place: Place;
  scenario: Scenario;
  onClose: () => void;
  onReview?: () => void;
  flood?: FloodBuildingExposure;
  hasFlood?: boolean;
  onFlood?: () => void;
  onHousing?: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const totals = buildingProgramTotals(building),
    geometry = buildingGeometry(building);
  const parts =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const sources = [...place.sources, ...(scenario.sources ?? [])].reverse();
  return (
    <div className="building-inspector" aria-label="Building inspector">
      <div className="panel-heading">
        <span className="eyebrow">BUILDING INSPECTOR</span>
        <button
          className="icon-button"
          aria-label="Close inspector"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className={`site-illustration use-${building.use}`}>
        <Building2 size={50} strokeWidth={1} />
        <span>
          {building.typology
            ? buildingTypologyLabels[building.typology]
            : landUseLabels[building.use]}
        </span>
      </div>
      <h2>{building.name}</h2>
      {onHousing && (building.units === null || (building.units ?? 0) > 0) && (
        <button type="button" onClick={onHousing}>
          Review this building’s housing costs
        </button>
      )}
      {hasFlood && <FloodBuildingContext row={flood} onOpen={onFlood} />}
      <p className="building-help">
        {building.address || "Selected building footprint"}
      </p>
      <span className={`badge ${building.estimated ? "amber" : ""}`}>
        {building.estimated ? "Planning estimates" : "Source attributes"}
      </span>
      {[
        building.height,
        building.floors,
        building.units,
        building.jobs,
        building.parkingSpaces,
      ].some((value) => value === null) && (
        <p className="building-help">
          Some quantities are unknown. Missing values are not zero and remain
          unavailable until evidence or an explicit reviewed assumption is
          entered.
        </p>
      )}
      <div className="building-stat-grid">
        <div>
          <span>Footprint</span>
          <strong>
            {number(buildingAreaSqm(building), 1)} <small>m²</small>
          </strong>
        </div>
        <div>
          <span>Floor area</span>
          <strong>
            {number(totals.grossFloorAreaSqm)} <small>m²</small>
          </strong>
        </div>
        <div>
          <span>Entered homes</span>
          <strong>{number(totals.units)}</strong>
        </div>
        <div>
          <span>Entered jobs</span>
          <strong>{number(totals.jobs, 1)}</strong>
        </div>
      </div>
      <p className="building-help">
        {parts.length} footprint {parts.length === 1 ? "part" : "parts"} ·{" "}
        {parts.reduce((sum, part) => sum + part.length - 1, 0)} courtyards /
        holes ·{" "}
        {building.height === null
          ? "Height unknown; footprint shown without massing"
          : `${number(building.height, 1)} m high`}
      </p>
      {totals.explicit ? (
        <div className="building-program-list">
          {totals.components.map((component) => (
            <div key={component.id}>
              <span>{component.name || landUseLabels[component.use]}</span>
              <strong>{number(component.grossFloorAreaSqm)} m²</strong>
            </div>
          ))}
        </div>
      ) : (
        <p className="building-help">
          Legacy program estimates remain in use. Editing can convert them into
          explicit space allocations for review.
        </p>
      )}
      <details className="building-details">
        <summary>Sources and site context</summary>
        <dl>
          <dt>Geometry</dt>
          <dd>
            <SourceName
              id={building.geometrySourceId ?? building.sourceId}
              sources={sources}
            />
          </dd>
          <dt>Attributes</dt>
          <dd>
            <SourceName
              id={building.attributeSourceId ?? building.sourceId}
              sources={sources}
            />
          </dd>
          <dt>Program</dt>
          <dd>
            <SourceName
              id={
                building.programSourceId ??
                building.attributeSourceId ??
                building.sourceId
              }
              sources={sources}
            />
          </dd>
          <dt>Zoning</dt>
          <dd>{building.zoning || "Not supplied"}</dd>
        </dl>
        {building.attributeProvenance && (
          <>
            <h3>Attribute evidence</h3>
            <dl>
              {Object.entries(building.attributeProvenance.fields).map(
                ([field, evidence]) => (
                  <div className="building-evidence-row" key={field}>
                    <dt>
                      {field === "parkingSpaces"
                        ? "Parking supply"
                        : field === "units"
                          ? "Homes"
                          : field.charAt(0).toUpperCase() + field.slice(1)}
                    </dt>
                    <dd>
                      {evidence?.status === "missing"
                        ? "Unknown"
                        : evidence?.status}{" "}
                      ·{" "}
                      <SourceName
                        id={evidence?.sourceId ?? building.sourceId}
                        sources={sources}
                      />
                      {evidence?.sourceField && (
                        <small>
                          Source field: {evidence.sourceField}
                          {evidence.sourceUnit
                            ? ` (${evidence.sourceUnit})`
                            : ""}
                        </small>
                      )}
                      {evidence?.method && <small>{evidence.method}</small>}
                    </dd>
                  </div>
                ),
              )}
            </dl>
          </>
        )}
      </details>
      {!editable && (
        <p className="notice">
          Open an editable alternative to change this building.
        </p>
      )}
      <div className="building-actions">
        <button
          className="button primary full-width"
          disabled={!editable}
          onClick={() => editor.start(building)}
        >
          Edit building <ArrowRight size={15} />
        </button>
        <button
          className="button full-width"
          disabled={!editable}
          onClick={() => editor.start(building, "footprint")}
        >
          Reshape footprint
        </button>
        {onReview && (
          <button className="button full-width" onClick={onReview}>
            Discuss this building
          </button>
        )}
      </div>
      {removing ? (
        <div
          className="building-remove-confirm"
          role="group"
          aria-label="Confirm building removal"
        >
          <p>
            Remove this building and its program from this alternative? Parcel
            boundaries stay in place. Undo restores it.
          </p>
          <button
            className="button text-danger full-width"
            onClick={() => editor.remove(building)}
          >
            Confirm removal
          </button>
          <button className="text-button" onClick={() => setRemoving(false)}>
            Keep building
          </button>
        </div>
      ) : (
        <button
          className="text-button danger"
          disabled={!editable}
          onClick={() => setRemoving(true)}
        >
          <Trash2 size={14} /> Remove building
        </button>
      )}
    </div>
  );
}

function RateEditor({
  kind,
  rate,
  component,
  sources,
  onChange,
}: {
  kind: "trip" | "parking";
  rate?: BuildingRate;
  component: BuildingProgramComponent;
  sources: Source[];
  onChange: (rate?: BuildingRate) => void;
}) {
  const title = kind === "trip" ? "Daily trip rate" : "Parking demand rate";
  return (
    <div className="building-rate">
      <label className="check-row">
        <span>Override {title.toLowerCase()}</span>
        <input
          type="checkbox"
          checked={!!rate}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? {
                    value: 0,
                    basis: component.units > 0 ? "dwelling" : "1000-sqft",
                    sourceId: USER_BUILDING_SOURCE.id,
                  }
                : undefined,
            )
          }
        />
      </label>
      {rate && (
        <>
          <Numeric
            label={title}
            value={rate.value}
            max={10000}
            onChange={(value) =>
              onChange({ ...rate, value, sourceId: USER_BUILDING_SOURCE.id })
            }
          />
          <label className="field">
            <span>{kind === "trip" ? "Trip" : "Parking"} denominator</span>
            <select
              aria-label={`${kind === "trip" ? "Trip" : "Parking"} denominator`}
              value={rate.basis}
              onChange={(event) =>
                onChange({
                  ...rate,
                  basis: event.target.value as BuildingRateBasis,
                  sourceId: USER_BUILDING_SOURCE.id,
                })
              }
            >
              {Object.entries(rateBases).map(([basis, label]) => (
                <option key={basis} value={basis}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{kind === "trip" ? "Trip" : "Parking"} rate source</span>
            <select
              aria-label={`${kind === "trip" ? "Trip" : "Parking"} rate source`}
              value={rate.sourceId}
              onChange={(event) =>
                onChange({ ...rate, sourceId: event.target.value })
              }
            >
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}

function ProgramEditor({
  editor,
  sources,
}: {
  editor: BuildingEditorController;
  sources: Source[];
}) {
  const draft = editor.draft!,
    building = draft.value.building,
    program = building.program;
  const [conversionType, setConversionType] = useState<BuildingTypology>(
    building.typology ?? "apartments",
  );
  const [conversionMode, setConversionMode] = useState<
    "preserve-program" | "typed-defaults"
  >("preserve-program");
  const [showConversion, setShowConversion] = useState(false);
  let conversion: ReturnType<typeof editor.conversion> = null,
    conversionError = "";
  if (showConversion) {
    try {
      conversion = editor.conversion(conversionType, conversionMode);
    } catch (error) {
      conversionError = (error as Error).message;
    }
  }
  const allocation = program
    ? program.components.reduce(
        (sum, component) => sum + component.grossFloorAreaSqm,
        0,
      ) + program.commonAreaSqm
    : 0;
  function componentChange(
    id: string,
    patch: Partial<BuildingProgramComponent>,
  ) {
    if (program)
      editor.updateProgram({
        ...program,
        components: program.components.map((component) =>
          component.id === id
            ? { ...component, ...patch, sourceId: USER_BUILDING_SOURCE.id }
            : component,
        ),
      });
  }
  return (
    <>
      <div className="field-grid">
        <NullableQuantity
          label="Floors"
          value={building.floors}
          step={1}
          max={250}
          onChange={(floors) => editor.updateBuilding({ floors })}
        />
        <NullableQuantity
          label="Height"
          value={building.height}
          max={1500}
          suffix="m"
          onChange={(height) => editor.updateBuilding({ height })}
        />
        <NullableQuantity
          label="Parking spaces supplied"
          value={building.parkingSpaces}
          max={1e8}
          onChange={(parkingSpaces) => editor.updateBuilding({ parkingSpaces })}
        />
      </div>
      <p className="building-help">
        The map shows one height across all wings. Geometry and floor-count
        edits retain your entered homes, jobs, and program area.
      </p>
      {!program ? (
        <div className="building-preview">
          <strong>Make the space mix explicit.</strong>
          <p>
            {building.use === "mixed-use"
              ? "This legacy building assumes a full ground floor of retail. Review that interpretation before adopting it."
              : "Convert the existing estimates into editable components. The current totals are retained."}
          </p>
          <button className="button full-width" onClick={editor.adoptProgram}>
            Review an explicit program
          </button>
        </div>
      ) : (
        <>
          <div className="building-section-title">
            <h3>Space program</h3>
            <span className="badge">Entered quantities</span>
          </div>
          <div className="field-grid">
            <Numeric
              label="Declared gross floor area"
              value={program.grossFloorAreaSqm}
              max={1e10}
              suffix="m²"
              onChange={(grossFloorAreaSqm) =>
                editor.updateProgram({ ...program, grossFloorAreaSqm })
              }
            />
            <Numeric
              label="Shared / common floor area"
              value={program.commonAreaSqm}
              max={1e10}
              suffix="m²"
              onChange={(commonAreaSqm) =>
                editor.updateProgram({ ...program, commonAreaSqm })
              }
            />
          </div>
          <div
            className={`building-allocation ${Math.abs(allocation - program.grossFloorAreaSqm) > 0.000001 ? "incomplete" : ""}`}
            role="status"
          >
            <strong>
              {number(allocation, 2)} / {number(program.grossFloorAreaSqm, 2)}{" "}
              m² allocated
            </strong>
            <span>
              {Math.abs(allocation - program.grossFloorAreaSqm) <= 0.000001
                ? "Every square meter has a place."
                : `${number(Math.abs(program.grossFloorAreaSqm - allocation), 2)} m² ${allocation > program.grossFloorAreaSqm ? "over the total" : "still to allocate"}`}
            </span>
          </div>
          <button
            className="text-button"
            disabled={!Number.isFinite(allocation)}
            onClick={() =>
              editor.updateProgram({
                ...program,
                grossFloorAreaSqm: allocation,
              })
            }
          >
            Use allocated area as the declared total
          </button>
          {program.components.map((component, index) => (
            <details
              className="building-component"
              key={component.id}
              open={program.components.length === 1 ? true : undefined}
            >
              <summary>
                <span>
                  <strong>
                    {component.name || landUseLabels[component.use]}
                  </strong>
                  <small>
                    {number(component.grossFloorAreaSqm)} m² ·{" "}
                    {number(component.units)} homes ·{" "}
                    {number(component.jobs, 1)} jobs
                  </small>
                </span>
                <span>{index + 1}</span>
              </summary>
              <div
                className="building-component-body"
                aria-label={`Program component ${index + 1}`}
              >
                <label className="field">
                  <span>Component name</span>
                  <input
                    aria-label="Component name"
                    maxLength={240}
                    value={component.name ?? ""}
                    onChange={(event) =>
                      componentChange(component.id, {
                        name: event.target.value || undefined,
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Component use</span>
                  <select
                    aria-label="Component use"
                    value={component.use}
                    onChange={(event) =>
                      componentChange(component.id, {
                        use: event.target
                          .value as BuildingProgramComponent["use"],
                        ...(!["residential", "multifamily"].includes(
                          event.target.value,
                        )
                          ? { residentialSubtype: undefined }
                          : {}),
                      })
                    }
                  >
                    {componentUses.map(([use, label]) => (
                      <option key={use} value={use}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="field-grid">
                  <Numeric
                    label="Component floor area"
                    value={component.grossFloorAreaSqm}
                    suffix="m²"
                    max={1e10}
                    onChange={(grossFloorAreaSqm) =>
                      componentChange(component.id, { grossFloorAreaSqm })
                    }
                  />
                  <Numeric
                    label="Entered homes"
                    value={component.units}
                    step={1}
                    max={1e7}
                    onChange={(units) =>
                      componentChange(component.id, { units })
                    }
                  />
                  <Numeric
                    label="Entered direct jobs"
                    value={component.jobs}
                    max={1e8}
                    onChange={(jobs) => componentChange(component.id, { jobs })}
                  />
                </div>
                {["residential", "multifamily"].includes(component.use) && (
                  <label className="field">
                    <span>Residential form</span>
                    <select
                      aria-label="Residential form"
                      value={component.residentialSubtype ?? ""}
                      onChange={(event) =>
                        componentChange(component.id, {
                          residentialSubtype:
                            (event.target
                              .value as BuildingProgramComponent["residentialSubtype"]) ||
                            undefined,
                        })
                      }
                    >
                      <option value="">Not specified</option>
                      <option value="single-family">Single-family</option>
                      <option value="townhome">Townhome</option>
                      <option value="apartment">Apartment</option>
                    </select>
                  </label>
                )}
                <label className="check-row">
                  <span>Specify a bed count</span>
                  <input
                    type="checkbox"
                    checked={component.beds !== undefined}
                    onChange={(event) =>
                      componentChange(component.id, {
                        beds: event.target.checked ? 0 : undefined,
                      })
                    }
                  />
                </label>
                {component.beds !== undefined && (
                  <Numeric
                    label="Entered beds"
                    value={component.beds}
                    step={1}
                    max={1e7}
                    onChange={(beds) => componentChange(component.id, { beds })}
                  />
                )}
                <details className="building-details">
                  <summary>Trip and parking assumptions</summary>
                  <p className="building-help">
                    Defaults follow scenario assumptions unless overridden.
                    Enter daily trips and parking demand with their exact
                    denominator. Occupied-home rates use the scenario vacancy
                    assumption. Mixed uses receive no automatic trip discount.
                  </p>
                  <RateEditor
                    kind="trip"
                    rate={component.tripRate}
                    component={component}
                    sources={sources}
                    onChange={(tripRate) =>
                      componentChange(component.id, { tripRate })
                    }
                  />
                  <RateEditor
                    kind="parking"
                    rate={component.parkingRate}
                    component={component}
                    sources={sources}
                    onChange={(parkingRate) =>
                      componentChange(component.id, { parkingRate })
                    }
                  />
                </details>
                <button
                  className="text-button danger"
                  onClick={() =>
                    editor.updateProgram({
                      ...program,
                      components: program.components.filter(
                        (item) => item.id !== component.id,
                      ),
                    })
                  }
                >
                  <Trash2 size={13} /> Remove component
                </button>
              </div>
            </details>
          ))}
          <button
            className="button full-width"
            disabled={
              program.components.length >= MAX_BUILDING_PROGRAM_COMPONENTS ||
              ["park", "vacant"].includes(building.use)
            }
            onClick={() =>
              editor.updateProgram({
                ...program,
                components: [
                  ...program.components,
                  {
                    id: crypto.randomUUID(),
                    name: "New space",
                    use: "office",
                    grossFloorAreaSqm: Math.max(
                      0,
                      Number.isFinite(program.grossFloorAreaSqm - allocation)
                        ? program.grossFloorAreaSqm - allocation
                        : 0,
                    ),
                    units: 0,
                    jobs: 0,
                    sourceId: USER_BUILDING_SOURCE.id,
                  },
                ],
              })
            }
          >
            <Plus size={14} /> Add program component
          </button>
          <p className="building-help">
            Homes and jobs are entered once, within their components. Parking
            supply is counted once for the building. Common area adds no
            separate trip or parking demand.
          </p>
        </>
      )}
      {!program && (
        <div className="field-grid">
          <NullableQuantity
            label="Entered homes"
            value={building.units}
            step={1}
            max={1e7}
            onChange={(units) => editor.updateBuilding({ units })}
          />
          <NullableQuantity
            label="Entered direct jobs"
            value={building.jobs}
            max={1e8}
            onChange={(jobs) => editor.updateBuilding({ jobs })}
          />
        </div>
      )}
      <details className="building-details">
        <summary>Change the building type</summary>
        <p className="building-help">
          Preview a conversion here. Your footprint, identity, and name stay in
          place.
        </p>
        <label className="field">
          <span>New building type</span>
          <select
            aria-label="New building type"
            value={conversionType}
            onChange={(event) => {
              setConversionType(event.target.value as BuildingTypology);
              setShowConversion(false);
            }}
          >
            {Object.entries(buildingTypologyLabels).map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Conversion approach</span>
          <select
            aria-label="Conversion approach"
            value={conversionMode}
            onChange={(event) => {
              setConversionMode(event.target.value as typeof conversionMode);
              setShowConversion(false);
            }}
          >
            <option value="preserve-program">
              Keep entered program and quantities
            </option>
            <option value="typed-defaults">
              Replace with illustrative type defaults
            </option>
          </select>
        </label>
        <button
          className="button full-width"
          onClick={() => setShowConversion(true)}
        >
          Preview conversion
        </button>
        {conversionError && (
          <p className="building-validation" role="alert">
            {conversionError}
          </p>
        )}
        {conversion && (
          <div className="building-preview">
            <table>
              <thead>
                <tr>
                  <th>Measure</th>
                  <th>Current</th>
                  <th>Preview</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Homes", building.units, conversion.building.units],
                    ["Direct jobs", building.jobs, conversion.building.jobs],
                    ["Floors", building.floors, conversion.building.floors],
                    ["Height (m)", building.height, conversion.building.height],
                    [
                      "Parking supply",
                      building.parkingSpaces,
                      conversion.building.parkingSpaces,
                    ],
                    [
                      "Floor area (m²)",
                      buildingProgramTotals(building).grossFloorAreaSqm,
                      buildingProgramTotals(conversion.building)
                        .grossFloorAreaSqm,
                    ],
                  ] as [string, number | null, number | null][]
                ).map(([label, before, after]) => (
                  <tr key={label}>
                    <th>{label}</th>
                    <td>{number(before, 1)}</td>
                    <td>{number(after, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {conversion.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
            <button
              className="button full-width"
              onClick={() => {
                editor.applyConversion(conversionType, conversionMode);
                setShowConversion(false);
              }}
            >
              Use conversion in draft
            </button>
          </div>
        )}
      </details>
    </>
  );
}

function FootprintEditor({ editor }: { editor: BuildingEditorController }) {
  const draft = editor.draft!,
    path = activeBuildingPath(draft),
    activeRing = draft.value.rings.find(
      (ring) => ring.id === draft.activeRingId,
    );
  const [coordinateError, setCoordinateError] = useState("");
  const [east, setEast] = useState(0),
    [north, setNorth] = useState(0),
    [angle, setAngle] = useState(0),
    [targetArea, setTargetArea] = useState(Number.NaN);
  const pivot = editor.geometry ? studyAreaAnchor(editor.geometry) : null;
  const [longitude, setLongitude] = useState(pivot?.[0] ?? Number.NaN),
    [latitude, setLatitude] = useState(pivot?.[1] ?? Number.NaN);
  const pendingText = !!draft.coordinateText.trim();
  function useCoordinates() {
    try {
      let coordinates: Position[] = draft.coordinateText
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line, index) => {
          const parts = line.trim().split(/[\s,]+/);
          if (
            parts.length !== 2 ||
            parts.some((part) => !Number.isFinite(Number(part)))
          )
            throw new Error(`Line ${index + 1}: enter longitude, latitude.`);
          return [Number(parts[0]), Number(parts[1])];
        });
      if (
        coordinates.length > 1 &&
        JSON.stringify(coordinates[0]) === JSON.stringify(coordinates.at(-1))
      )
        coordinates = coordinates.slice(0, -1);
      if (coordinates.length > MAX_AUTHORED_BUILDING_RING_POINTS)
        throw new Error(
          `Use at most ${MAX_AUTHORED_BUILDING_RING_POINTS} points per authored ring.`,
        );
      const check = validateBuildingGeometry({
        type: "Polygon",
        coordinates: [
          [...coordinates, ...(coordinates.length ? [coordinates[0]] : [])],
        ],
      });
      if (!check.valid) throw new Error(check.error!);
      if (!draft.activeRingId)
        throw new Error("Choose a footprint ring first.");
      editor.pathChange(coordinates, {
        ringId: draft.activeRingId,
        kind: "move",
        vertexIndex: 0,
      });
      editor.patch({ coordinateText: "", selectedVertexIndex: null });
      setCoordinateError("");
    } catch (error) {
      setCoordinateError((error as Error).message);
    }
  }
  return (
    <>
      {draft.value.rings.some(
        (ring) => ring.coordinates.length > MAX_AUTHORED_BUILDING_RING_POINTS,
      ) && (
        <p className="building-warning">
          This source footprint exceeds the {MAX_AUTHORED_BUILDING_RING_POINTS}
          -point authored ring limit. Program-only edits retain its captured
          geometry. To reshape, supply a replacement within that limit; the
          original is never simplified automatically.
        </p>
      )}
      <p className="building-help">
        Draw in 2D. Click to add points, drag a point to reshape, or move and
        rotate the entire footprint. Courtyards stay open.
      </p>
      <label className="field">
        <span>Footprint ring</span>
        <select
          aria-label="Footprint ring"
          value={draft.activeRingId ?? ""}
          disabled={pendingText}
          onChange={(event) =>
            editor.patch({
              activeRingId: event.target.value,
              selectedVertexIndex: null,
              mode: "reshape",
            })
          }
        >
          {draft.value.rings.map((ring) => (
            <option key={ring.id} value={ring.id}>
              Wing {ring.partIndex + 1} ·{" "}
              {ring.ringIndex
                ? `courtyard / hole ${ring.ringIndex}`
                : "outer boundary"}
            </option>
          ))}
        </select>
      </label>
      <div className="building-ring-actions">
        <button
          className="button"
          disabled={pendingText}
          onClick={() => editor.addRing(false)}
        >
          Add a wing
        </button>
        <button
          className="button"
          disabled={pendingText || path.length < 3}
          onClick={() => editor.addRing(true)}
        >
          Add a courtyard
        </button>
        <button
          className="text-button danger"
          disabled={pendingText}
          onClick={editor.removeRing}
        >
          {activeRing?.ringIndex ? "Remove courtyard" : "Remove wing"}
        </button>
      </div>
      <div
        className="building-draw-modes"
        role="group"
        aria-label="Building drawing mode"
      >
        {(
          [
            { id: "draw", label: "Add points", icon: Plus },
            { id: "reshape", label: "Move a point", icon: MousePointer2 },
            { id: "move", label: "Move building", icon: Move },
            { id: "rotate", label: "Rotate building", icon: RotateCw },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            aria-pressed={draft.mode === id}
            disabled={
              pendingText ||
              (id === "reshape"
                ? !path.length
                : ["move", "rotate"].includes(id) && !editor.geometry)
            }
            onClick={() => editor.patch({ mode: id })}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>
      <label className="check-row">
        <span>Align to nearby building points</span>
        <input
          type="checkbox"
          checked={draft.snapToVertices}
          onChange={(event) =>
            editor.patch({ snapToVertices: event.target.checked })
          }
        />
      </label>
      <div className="building-draft-summary">
        <span>{path.length} points in this ring</span>
        <span>Not applied</span>
      </div>
      {!!path.length && (
        <ol className="building-vertices" aria-label="Footprint points">
          {path.map((point, index) => (
            <li key={index}>
              <button
                aria-label={`Select footprint point ${index + 1}`}
                disabled={pendingText}
                aria-pressed={draft.selectedVertexIndex === index}
                onClick={() => editor.vertexSelect(draft.activeRingId!, index)}
              >
                <span>{index + 1}</span>
                <div>
                  {point[1].toFixed(6)}° lat
                  <small>{point[0].toFixed(6)}° lon</small>
                </div>
              </button>
              <button
                className="icon-button"
                disabled={pendingText}
                aria-label={`Remove footprint point ${index + 1}`}
                onClick={() => editor.removeVertex(index)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <details className="building-details">
        <summary>Enter exact footprint coordinates</summary>
        <p className="building-help">
          One longitude, latitude pair per line for the selected ring. Up to{" "}
          {MAX_AUTHORED_BUILDING_RING_POINTS} points; closing point is optional.
          Other rings stay intact.
        </p>
        <textarea
          aria-label="Footprint coordinates"
          rows={5}
          spellCheck={false}
          value={draft.coordinateText}
          onChange={(event) => {
            editor.patch({ coordinateText: event.target.value });
            setCoordinateError("");
          }}
          placeholder="-112.070000, 33.460000"
        />
        <div className="building-actions">
          <button
            className="button"
            disabled={!pendingText}
            onClick={useCoordinates}
          >
            Use footprint coordinates
          </button>
          <button
            className="button"
            disabled={!path.length}
            onClick={() => {
              editor.patch({
                coordinateText: path
                  .map((point) => point.join(", "))
                  .join("\n"),
              });
              setCoordinateError("");
            }}
          >
            Load current footprint points
          </button>
          {pendingText && (
            <button
              className="text-button"
              onClick={() => {
                editor.patch({ coordinateText: "" });
                setCoordinateError("");
              }}
            >
              Discard coordinate text
            </button>
          )}
        </div>
        {coordinateError && (
          <p className="building-validation" role="alert">
            {coordinateError}
          </p>
        )}
      </details>
      <details className="building-details">
        <summary>Move, rotate, or resize precisely</summary>
        <fieldset disabled={!editor.geometry || pendingText}>
          <div className="field-grid">
            <Numeric
              label="Move east"
              value={east}
              min={-1e6}
              suffix="m"
              onChange={setEast}
            />
            <Numeric
              label="Move north"
              value={north}
              min={-1e6}
              suffix="m"
              onChange={setNorth}
            />
          </div>
          <button
            className="button full-width"
            disabled={![east, north].every(Number.isFinite)}
            onClick={() => editor.transform({ translateMeters: [east, north] })}
          >
            Move by these distances
          </button>
          <Numeric
            label="Clockwise rotation"
            value={angle}
            min={-360}
            max={360}
            suffix="°"
            onChange={setAngle}
          />
          <button
            className="button full-width"
            disabled={!Number.isFinite(angle) || Math.abs(angle) > 360}
            onClick={() => editor.transform({ rotationDegrees: angle })}
          >
            Rotate by this angle
          </button>
          <div className="field-grid">
            <Numeric
              label="Destination longitude"
              value={longitude}
              min={-180}
              max={180}
              onChange={setLongitude}
            />
            <Numeric
              label="Destination latitude"
              value={latitude}
              min={-89.99}
              max={89.99}
              onChange={setLatitude}
            />
          </div>
          <button
            className="button full-width"
            disabled={
              !pivot ||
              ![longitude, latitude].every(Number.isFinite) ||
              Math.abs(longitude) > 180 ||
              Math.abs(latitude) >= 89.99
            }
            onClick={() => {
              if (!pivot) return;
              const m = (BUILDING_EARTH_RADIUS_METERS * Math.PI) / 180;
              editor.transform({
                anchor: pivot,
                translateMeters: [
                  (longitude - pivot[0]) *
                    m *
                    Math.cos((pivot[1] * Math.PI) / 180),
                  (latitude - pivot[1]) * m,
                ],
              });
            }}
          >
            Move anchor to coordinates
          </button>
          <Numeric
            label="Target footprint area"
            value={targetArea}
            min={1}
            max={1e9}
            suffix="m²"
            onChange={setTargetArea}
          />
          <button
            className="button full-width"
            disabled={!Number.isFinite(targetArea) || targetArea <= 0}
            onClick={() => {
              if (editor.geometry)
                editor.transform({
                  scale: Math.sqrt(
                    targetArea /
                      validateBuildingGeometry(editor.geometry).areaSqm,
                  ),
                });
            }}
          >
            Resize entire footprint
          </button>
        </fieldset>
        <p className="building-help">
          All wings and holes move together. Resizing retains your entered floor
          area, homes, and jobs; review the program separately.
        </p>
      </details>
    </>
  );
}

export function BuildingDraftEditor({
  editor,
  place,
  scenario,
}: {
  editor: BuildingEditorController;
  place: Place;
  scenario: Scenario;
}) {
  const validationId = useId(),
    draft = editor.draft;
  if (!draft) return null;
  const building = draft.value.building,
    ready = !!editor.preview.command && !draft.coordinateText.trim();
  const sources = [
    ...new Map(
      [
        ...place.sources,
        ...(scenario.sources ?? []),
        ILLUSTRATIVE_BUILDING_SOURCE,
        USER_BUILDING_SOURCE,
      ].map((source) => [source.id, source]),
    ).values(),
  ];
  return (
    <div className="building-draft-editor" aria-label="Building editor">
      <div className="panel-heading">
        <span className="eyebrow">ROOM FOR YOUR NEXT IDEA</span>
        <button
          className="icon-button"
          aria-label="Discard building draft"
          onClick={editor.discard}
        >
          <X size={16} />
        </button>
      </div>
      <h2>{draft.original ? "Make it your own." : "A new possibility."}</h2>
      <p className="building-help">
        Review the shape and what goes inside. Apply saves everything as one
        reversible edit.
      </p>
      <label className="field">
        <span>Building name</span>
        <input
          aria-label="Building name"
          value={building.name}
          maxLength={240}
          onChange={(event) =>
            editor.updateBuilding({ name: event.target.value })
          }
        />
      </label>
      <div
        className="building-editor-tabs"
        role="group"
        aria-label="Building editor section"
      >
        <button
          aria-pressed={draft.section === "program"}
          onClick={() => editor.section("program")}
        >
          Program & massing
        </button>
        <button
          aria-pressed={draft.section === "footprint"}
          onClick={() => editor.section("footprint")}
        >
          Footprint
        </button>
      </div>
      {draft.section === "program" ? (
        <ProgramEditor editor={editor} sources={sources} />
      ) : (
        <FootprintEditor editor={editor} />
      )}
      {building.maxHeight !== undefined &&
        building.height !== null &&
        building.height > building.maxHeight && (
          <p className="notice">
            Proposed height exceeds the recorded {building.maxHeight} m limit.
            Review the local zoning requirements.
          </p>
        )}
      {editor.preview.error ? (
        <p className="building-validation" id={validationId} role="status">
          {editor.preview.error}
        </p>
      ) : (
        <div className="building-preview" id={validationId} role="status">
          <strong>
            <Check size={14} /> Ready to apply
          </strong>
          <span>
            {number(
              editor.preview.building
                ? buildingAreaSqm(editor.preview.building)
                : 0,
              1,
            )}{" "}
            m² footprint · {number(building.units)} homes ·{" "}
            {number(building.jobs, 1)} direct jobs
          </span>
        </div>
      )}
      {editor.preview.warnings.map((warning) => (
        <p className="building-warning" key={warning}>
          {warning}
        </p>
      ))}
      {!!draft.coordinateText.trim() && (
        <p className="building-warning">
          Use or discard coordinate text before applying, switching sections, or
          undoing edits.
        </p>
      )}
      <div className="building-draft-footer">
        <button
          className="button primary full-width"
          disabled={!ready}
          aria-describedby={validationId}
          onClick={editor.apply}
        >
          Apply building <ArrowRight size={15} />
        </button>
        <button className="button full-width" onClick={editor.discard}>
          Discard draft
        </button>
      </div>
      <p className="building-help">
        Planning estimates update after Apply. Defaults are illustrative and can
        be replaced with local evidence.
      </p>
    </div>
  );
}
