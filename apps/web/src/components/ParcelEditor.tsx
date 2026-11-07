import { useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  Combine,
  MapPin,
  MousePointer2,
  Plus,
  Scissors,
  Search,
  Shapes,
  Trash2,
  X,
} from "lucide-react";
import {
  MAX_AUTHORED_PARCEL_RING_POINTS,
  parcelAreaSqm,
  validateParcelGeometry,
  type Parcel,
  type Place,
  type Position,
  type Scenario,
} from "@urban/core";
import { calculateParcelContext } from "@urban/models";
import { activeParcelPath } from "../lib/parcel-draft";
import type { ParcelEditorController } from "../lib/useParcelEditor";
import "./parcel-editor.css";

const formatArea = (sqm: number) =>
  sqm >= 10000
    ? `${(sqm / 10000).toLocaleString(undefined, { maximumFractionDigits: 2 })} ha`
    : `${sqm.toLocaleString(undefined, { maximumFractionDigits: 1 })} m²`;
const value = (n: number | null, decimals = 0) =>
  n === null
    ? "—"
    : n.toLocaleString(undefined, { maximumFractionDigits: decimals });
function ParcelList({
  parcels,
  selectedIds = [],
  onSelect,
  assembly = false,
}: {
  parcels: Parcel[];
  selectedIds?: readonly string[];
  onSelect: (id: string) => void;
  assembly?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);
  const matching = useMemo(
    () =>
      parcels.filter((parcel) =>
        `${parcel.name} ${parcel.kind} ${parcel.sourceFeatureId ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ),
    [parcels, query],
  );
  return (
    <>
      <label className="parcel-search">
        <Search size={15} />
        <input
          aria-label="Find a parcel or block"
          placeholder="Find a parcel or block"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(40);
          }}
        />
      </label>
      <div
        className="parcel-list"
        aria-label={
          assembly
            ? "Choose boundaries to assemble"
            : "Parcels and blocks in this scenario"
        }
      >
        {matching.slice(0, limit).map((parcel) => (
          <button
            key={parcel.id}
            aria-pressed={
              assembly ? selectedIds.includes(parcel.id) : undefined
            }
            onClick={() => onSelect(parcel.id)}
          >
            <Shapes size={18} />
            <span>
              <strong>{parcel.name}</strong>
              <small>
                {parcel.kind === "block" ? "Block" : "Parcel"} ·{" "}
                {formatArea(parcelAreaSqm(parcel))}
              </small>
            </span>
            {assembly ? (
              <span className="parcel-choice">
                {selectedIds.includes(parcel.id) ? "Selected" : "Add"}
              </span>
            ) : (
              <ChevronRight size={14} />
            )}
          </button>
        ))}
      </div>
      {!matching.length && (
        <p className="parcel-help">
          {parcels.length
            ? "No boundaries match that search."
            : "Draw a planning boundary or import a local parcel layer to get started."}
        </p>
      )}
      {matching.length > limit && (
        <button
          className="button full-width"
          onClick={() => setLimit((n) => n + 40)}
        >
          Show more boundaries ({matching.length - limit})
        </button>
      )}
    </>
  );
}

export function ParcelBrowser({
  editor,
  editable,
  onImport,
  onFocus,
}: {
  editor: ParcelEditorController;
  editable: boolean;
  onImport: () => void;
  onFocus: (parcel: Parcel) => void;
}) {
  return (
    <div className="parcel-browser">
      <div className="panel-intro">
        <span className="eyebrow">A PLACE FOR YOUR NEXT IDEA</span>
        <h2>Shape the possibilities.</h2>
        <p>Draw a parcel, plan a block, or bring neighboring lots together.</p>
      </div>
      <div className="parcel-actions">
        <button
          className="button primary full-width"
          disabled={!editable}
          onClick={() => editor.start("draw")}
        >
          <Plus size={15} /> Draw a parcel
        </button>
        <button
          className="button full-width"
          disabled={!editable}
          onClick={() => editor.start("draw", undefined, "block")}
        >
          <Shapes size={15} /> Draw a block
        </button>
        <button
          className="button full-width"
          disabled={!editable || editor.parcels.length < 2}
          onClick={() => editor.start("assemble")}
        >
          <Combine size={15} /> Assemble boundaries
        </button>
      </div>
      <p className="parcel-help">
        New boundaries are planning proposals. Blocks may contain parcels and
        are kept separate in parcel measures.
      </p>
      {!editable && (
        <p className="parcel-help">
          Open an editable alternative to change boundaries.
        </p>
      )}
      <ParcelList
        parcels={editor.parcels}
        onSelect={(id) => {
          editor.select(id);
          const parcel = editor.parcels.find((item) => item.id === id);
          if (parcel) onFocus(parcel);
        }}
      />
      <button className="text-button" disabled={!editable} onClick={onImport}>
        Import local parcel GeoJSON <ArrowRight size={14} />
      </button>
    </div>
  );
}

export function ParcelInspector({
  parcel,
  place,
  scenario,
  editor,
  editable,
}: {
  parcel: Parcel;
  place: Place;
  scenario: Scenario;
  editor: ParcelEditorController;
  editable: boolean;
}) {
  const context = useMemo(
    () => calculateParcelContext(place, scenario, parcel.id),
    [place, scenario, parcel.id],
  );
  const [removing, setRemoving] = useState(false);
  const source = [...place.sources, ...(scenario.sources ?? [])]
    .reverse()
    .find((item) => item.id === (parcel.geometrySourceId ?? parcel.sourceId));
  const proposal = context.proposal;
  return (
    <div className="parcel-inspector" aria-label="Parcel inspector">
      <div className="panel-heading">
        <span className="eyebrow">
          {parcel.kind === "block" ? "BLOCK" : "PARCEL"} INSPECTOR
        </span>
        <button
          className="icon-button"
          aria-label="Close parcel inspector"
          onClick={() => editor.select(null)}
        >
          <X size={16} />
        </button>
      </div>
      <h2>{parcel.name}</h2>
      <p className="parcel-help">
        {parcel.lineage ? "Proposal boundary" : "Supplied boundary"} ·{" "}
        {formatArea(context.areaSqm)}
        {parcel.geometry.type === "MultiPolygon"
          ? " · multiple land components"
          : ""}
      </p>
      <div className="parcel-stat-grid">
        <div>
          <span>Land area</span>
          <strong>{formatArea(context.areaSqm)}</strong>
        </div>
        <div>
          <span>Contained buildings</span>
          <strong>{proposal.buildingCount}</strong>
        </div>
        <div>
          <span>Floor area ratio</span>
          <strong>
            {value(proposal.far, 2)} <small>FAR</small>
          </strong>
        </div>
        <div>
          <span>Lot coverage</span>
          <strong>
            {value(proposal.lotCoveragePercent, 1)}
            <small>%</small>
          </strong>
        </div>
        <div>
          <span>Entered homes</span>
          <strong>{value(proposal.units)}</strong>
        </div>
        <div>
          <span>Entered jobs</span>
          <strong>{value(proposal.jobs)}</strong>
        </div>
      </div>
      <details className="parcel-context">
        <summary>Baseline buildings in this boundary</summary>
        <p>
          Both columns use this proposal boundary. This is a local context
          comparison, not a claim that the proposed parcel existed in the
          baseline.
        </p>
        <table>
          <thead>
            <tr>
              <th>Measure</th>
              <th>Baseline</th>
              <th>Proposal</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Buildings contained</th>
              <td>{context.baseline.buildingCount}</td>
              <td>{proposal.buildingCount}</td>
            </tr>
            <tr>
              <th>FAR</th>
              <td>{value(context.baseline.far, 2)}</td>
              <td>{value(proposal.far, 2)}</td>
            </tr>
            <tr>
              <th>Coverage %</th>
              <td>{value(context.baseline.lotCoveragePercent, 1)}</td>
              <td>{value(proposal.lotCoveragePercent, 1)}</td>
            </tr>
          </tbody>
        </table>
      </details>
      {(context.warnings.length > 0 || proposal.caveats.length > 0) && (
        <details className="parcel-context">
          <summary>Calculation details & limits</summary>
          {[...new Set([...context.warnings, ...proposal.caveats])].map(
            (message) => (
              <p key={message}>{message}</p>
            ),
          )}
        </details>
      )}
      {proposal.status === "incomplete" && (
        <p className="parcel-caveats">
          {proposal.straddlingBuildingIds.length
            ? `${proposal.straddlingBuildingIds.length} building footprint(s) cross this boundary. Complete floor area, homes, and jobs need review.`
            : "Some building attributes or parcel links need review. See the calculation details."}
        </p>
      )}
      <p className="parcel-help">
        Building matches come from geometry. Coverage uses clipped footprint
        unions; FAR uses complete building programs. Neither establishes legal
        ownership, zoning compliance, or buildable capacity.
      </p>
      <div className="parcel-actions">
        <button
          className="button primary full-width"
          disabled={!editable}
          onClick={() => editor.start("reshape", parcel)}
        >
          Reshape boundary
        </button>
        <button
          className="button full-width"
          disabled={!editable}
          onClick={() => editor.start("split", parcel)}
        >
          <Scissors size={15} /> Subdivide boundary
        </button>
        <button
          className="button full-width"
          disabled={
            !editable ||
            editor.parcels.filter((item) => item.kind === parcel.kind).length <
              2
          }
          onClick={() => editor.start("assemble", parcel)}
        >
          <Combine size={15} /> Assemble with another
        </button>
        <button
          className="button full-width danger"
          disabled={!editable}
          onClick={() => setRemoving(true)}
        >
          <Trash2 size={15} /> Remove boundary
        </button>
      </div>
      {removing && (
        <div
          className="parcel-remove"
          role="group"
          aria-label="Confirm boundary removal"
        >
          <p>
            Remove this boundary from the alternative? Buildings stay in place.
            Undo restores the boundary.
          </p>
          <button
            className="button danger"
            onClick={() => editor.remove(parcel)}
          >
            Remove from scenario
          </button>
          <button className="button" onClick={() => setRemoving(false)}>
            Keep boundary
          </button>
        </div>
      )}
      <div className="parcel-source">
        <span className="eyebrow">GEOMETRY SOURCE</span>
        <strong>{source?.name ?? parcel.sourceId}</strong>
        <p>
          {source?.description ??
            "Review the supplied source before treating this as a recorded parcel."}
        </p>
        {parcel.sourceFeatureId && (
          <small>Source feature: {parcel.sourceFeatureId}</small>
        )}
      </div>
    </div>
  );
}

export function ParcelDraftEditor({
  editor,
}: {
  editor: ParcelEditorController;
}) {
  const draft = editor.draft!;
  const { value: data } = draft;
  const [coordinateError, setCoordinateError] = useState("");
  const path = activeParcelPath(draft);
  const activeRing = data.rings.find((ring) => ring.id === draft.activeRingId);
  const assembly = draft.operation === "assemble",
    splitting = draft.operation === "split";
  const ringEditing = !assembly && !splitting;
  const ready = !!editor.preview.command && !draft.coordinateText.trim();
  const area = editor.preview.parcels.reduce(
    (sum, parcel) => sum + parcelAreaSqm(parcel),
    0,
  );
  const title = assembly
    ? "Better together."
    : splitting
      ? "Make space for more."
      : draft.operation === "reshape"
        ? "Refine the boundary."
        : "Start with a little land.";
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
        !splitting &&
        coordinates.length > 1 &&
        JSON.stringify(coordinates[0]) === JSON.stringify(coordinates.at(-1))
      )
        coordinates = coordinates.slice(0, -1);
      if (splitting) {
        if (coordinates.length !== 2)
          throw new Error("Enter exactly two points for the straight cut.");
        if (
          coordinates.some(
            (point) => Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90,
          )
        )
          throw new Error("Use valid WGS84 longitude and latitude.");
      } else {
        const checked = validateParcelGeometry({
          type: "Polygon",
          coordinates: [
            [...coordinates, ...(coordinates.length ? [coordinates[0]] : [])],
          ],
        });
        if (!checked.valid) throw new Error(checked.error!);
      }
      editor.pathChange(coordinates, {
        ringId: splitting ? null : draft.activeRingId,
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
    <div className="parcel-draft-editor" aria-label="Parcel drawing editor">
      <div className="panel-heading">
        <span className="eyebrow">
          {assembly
            ? "ASSEMBLE"
            : splitting
              ? "SUBDIVIDE"
              : "DRAW A POSSIBILITY"}
        </span>
        <button
          className="icon-button"
          aria-label="Discard parcel draft"
          onClick={editor.discard}
        >
          <X size={16} />
        </button>
      </div>
      <h2>{title}</h2>
      <p className="parcel-help">
        {assembly
          ? "Choose boundaries of the same kind on the map or in the list. Gaps stay as separate land components."
          : splitting
            ? "Choose two points for a straight cut. The cut extends across this boundary; every resulting piece is previewed."
            : "Click to add boundary points. Select or drag a numbered point to move it. The ring closes automatically."}{" "}
        Nothing changes until Apply.
      </p>
      <label className="field">
        <span>{splitting ? "New boundary name prefix" : "Boundary name"}</span>
        <input
          aria-label="Boundary name"
          value={data.name}
          maxLength={240}
          onChange={(event) =>
            editor.change({ ...data, name: event.target.value })
          }
        />
      </label>
      {draft.operation === "draw" && (
        <label className="field">
          <span>Boundary type</span>
          <select
            aria-label="Boundary type"
            value={data.kind}
            onChange={(event) =>
              editor.change({
                ...data,
                kind: event.target.value as Parcel["kind"],
              })
            }
          >
            <option value="parcel">Parcel</option>
            <option value="block">Block</option>
          </select>
        </label>
      )}
      {assembly ? (
        <ParcelList
          parcels={editor.parcels}
          selectedIds={data.sourceParcelIds}
          onSelect={editor.select}
          assembly
        />
      ) : (
        <>
          {ringEditing && (
            <>
              <label className="field">
                <span>Boundary ring</span>
                <select
                  aria-label="Boundary ring"
                  disabled={!!draft.coordinateText.trim()}
                  value={draft.activeRingId ?? ""}
                  onChange={(event) =>
                    editor.patch({
                      activeRingId: event.target.value,
                      selectedVertexIndex: null,
                      mode: "reshape",
                    })
                  }
                >
                  {data.rings.map((ring) => (
                    <option key={ring.id} value={ring.id}>
                      Part {ring.partIndex + 1} ·{" "}
                      {ring.ringIndex === 0
                        ? "outer boundary"
                        : `hole ${ring.ringIndex}`}
                    </option>
                  ))}
                </select>
              </label>
              <div className="parcel-ring-actions">
                <button
                  className="button"
                  disabled={!!draft.coordinateText.trim()}
                  onClick={() => editor.addRing(false)}
                >
                  Add land component
                </button>
                <button
                  className="button"
                  disabled={
                    !activeRing ||
                    path.length < 3 ||
                    !!draft.coordinateText.trim()
                  }
                  onClick={() => editor.addRing(true)}
                >
                  Add a hole
                </button>
                <button
                  className="text-button"
                  disabled={!!draft.coordinateText.trim()}
                  onClick={editor.removeRing}
                >
                  {activeRing?.ringIndex
                    ? "Remove hole"
                    : "Remove land component"}
                </button>
              </div>
            </>
          )}
          <div
            className="parcel-draw-modes"
            role="group"
            aria-label="Parcel drawing mode"
          >
            <button
              aria-pressed={draft.mode === "draw"}
              disabled={splitting && path.length === 2}
              onClick={() => editor.patch({ mode: "draw" })}
            >
              <Plus size={14} /> Add points
            </button>
            <button
              aria-pressed={draft.mode === "reshape"}
              disabled={!path.length}
              onClick={() =>
                editor.patch({
                  mode: "reshape",
                  selectedVertexIndex: draft.selectedVertexIndex ?? 0,
                })
              }
            >
              <MousePointer2 size={14} /> Move a point
            </button>
          </div>
          <label className="check-row">
            <span>Align to nearby boundary points</span>
            <input
              type="checkbox"
              checked={draft.snapToParcels}
              onChange={(event) =>
                editor.patch({ snapToParcels: event.target.checked })
              }
            />
          </label>
          <div className="parcel-draft-summary">
            <span>
              <MapPin size={14} /> {path.length} points
            </span>
            <span>Not applied</span>
          </div>
          {path.length > 0 && (
            <ol className="parcel-vertices" aria-label="Boundary points">
              {path.map((point, index) => (
                <li key={index}>
                  <button
                    aria-label={`Select boundary point ${index + 1}`}
                    aria-describedby={`parcel-${draft.id}-point-${index}`}
                    aria-pressed={draft.selectedVertexIndex === index}
                    onClick={() =>
                      editor.vertexSelect(
                        splitting ? null : draft.activeRingId,
                        index,
                      )
                    }
                  >
                    <span>{index + 1}</span>
                    <div id={`parcel-${draft.id}-point-${index}`}>
                      {point[1].toFixed(6)}° lat
                      <small>{point[0].toFixed(6)}° lon</small>
                    </div>
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Remove boundary point ${index + 1}`}
                    onClick={() => editor.removeVertex(index)}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <details className="parcel-coordinates">
            <summary>Enter exact coordinates</summary>
            <p>
              {splitting
                ? "Two longitude, latitude pairs define the cut."
                : `One longitude, latitude pair per line for the selected ring. Up to ${MAX_AUTHORED_PARCEL_RING_POINTS} points; closing point is optional. Other rings stay intact.`}
            </p>
            <textarea
              aria-label="Boundary coordinates"
              rows={5}
              spellCheck={false}
              value={draft.coordinateText}
              placeholder="-112.070000, 33.460000"
              onChange={(event) => {
                editor.patch({ coordinateText: event.target.value });
                setCoordinateError("");
              }}
            />
            <div className="parcel-actions">
              <button
                className="button"
                disabled={!draft.coordinateText.trim()}
                onClick={useCoordinates}
              >
                Use these coordinates
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
                Load current points
              </button>
              {draft.coordinateText.trim() && (
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
              <p className="parcel-validation" role="alert">
                {coordinateError}
              </p>
            )}
          </details>
        </>
      )}
      {editor.preview.error ? (
        <p
          className="parcel-validation"
          role={
            path.length >= (splitting ? 2 : 3) ||
            data.sourceParcelIds.length >= 2
              ? "alert"
              : "status"
          }
        >
          {editor.preview.error}
        </p>
      ) : (
        <div className="parcel-preview" role="status">
          <strong>
            {editor.preview.parcels.length}{" "}
            {data.kind === "block" ? "block" : "parcel"}
            {editor.preview.parcels.length === 1 ? "" : "s"} ·{" "}
            {formatArea(area)}
          </strong>
          <span>
            {assembly || splitting
              ? "Original land area retained. Holes and separate components stay intact."
              : "Boundary is valid and inside the study area."}
          </span>
        </div>
      )}
      {draft.coordinateText.trim() && (
        <p className="parcel-help">
          Use or discard coordinate text before applying or undoing boundary
          edits.
        </p>
      )}
      <div className="parcel-actions">
        <button
          className="button primary full-width"
          disabled={!ready}
          onClick={editor.apply}
        >
          Apply boundaries <ArrowRight size={15} />
        </button>
        <button className="button full-width" onClick={editor.discard}>
          Discard draft
        </button>
      </div>
      <p className="parcel-help">
        Planning geometry, not a recorded subdivision or zoning approval.
        Applying is one reversible scenario edit.
      </p>
    </div>
  );
}
