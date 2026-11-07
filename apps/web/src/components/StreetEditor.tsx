import { useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronRight,
  MapPin,
  MousePointer2,
  Plus,
  Route,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  MAX_AUTHORED_ROAD_POINTS,
  validateRoadEdit,
  validateRoadPath,
  type Place,
  type Position,
  type Road,
} from "@urban/core";
import type { StreetDraft, StreetDraftValue } from "../lib/street-draft";
import "./street-editor.css";

export function StreetBrowser({
  roads,
  editable,
  onDraw,
  onSelect,
}: {
  roads: Road[];
  editable: boolean;
  onDraw: () => void;
  onSelect: (road: Road) => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);
  const matching = useMemo(
    () =>
      roads.filter((road) =>
        `${road.name} ${road.kind} ${road.id}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      ),
    [roads, query],
  );
  return (
    <div className="street-browser">
      <div className="panel-intro">
        <span className="eyebrow">KEEP A GOOD PLACE MOVING</span>
        <h2>Connect the dots.</h2>
        <p>
          Draw a new street or refine an existing one. Small changes can open
          new possibilities.
        </p>
      </div>
      <button
        className="button primary full-width"
        onClick={onDraw}
        disabled={!editable}
      >
        <Plus size={16} /> Draw a street
      </button>
      {!editable && (
        <p className="street-help">
          Open an editable alternative to change streets.
        </p>
      )}
      <label className="street-search">
        <Search size={15} />
        <input
          aria-label="Find a street"
          placeholder="Find a street or path"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(40);
          }}
        />
      </label>
      <div className="street-list" aria-label="Streets in this scenario">
        {matching.slice(0, limit).map((road) => (
          <button key={road.id} onClick={() => onSelect(road)}>
            <span className="street-icon">
              <Route size={17} />
            </span>
            <div>
              <strong>{road.name}</strong>
              <span>
                {road.closed
                  ? "Closed"
                  : `${road.lanes} lanes · ${road.speedMph} mph`}{" "}
                · {road.coordinates.length} points
              </span>
              <small>{road.id}</small>
            </div>
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
      {!matching.length && (
        <p className="street-help">
          No streets match that search. Try a name, type, or segment ID.
        </p>
      )}
      {matching.length > limit && (
        <button
          className="button full-width"
          onClick={() => setLimit((value) => value + 40)}
        >
          Show more streets ({matching.length - limit} remaining)
        </button>
      )}
    </div>
  );
}

export function StreetDraftEditor({
  draft,
  place,
  onChange,
  onMode,
  onSelectVertex,
  onRemoveVertex,
  onSnapChange,
  onCoordinateTextChange,
  onApply,
  onDiscard,
}: {
  draft: StreetDraft;
  place: Place;
  onChange: (value: StreetDraftValue) => void;
  onMode: (mode: StreetDraft["mode"]) => void;
  onSelectVertex: (index: number) => void;
  onRemoveVertex: (index: number) => void;
  onSnapChange: (value: boolean) => void;
  onApply: () => void;
  onDiscard: () => void;
  onCoordinateTextChange: (value: string) => void;
}) {
  const { value } = draft;
  const coordinateText = draft.coordinateText,
    setCoordinateText = onCoordinateTextChange;
  const [coordinateError, setCoordinateError] = useState("");
  const [coordinatesOpen, setCoordinatesOpen] = useState(false);
  const validation = useMemo(
    () =>
      draft.original
        ? validateRoadEdit({ ...draft.original, ...value }, place)
        : validateRoadPath(value.coordinates, place),
    [draft.original, value, place],
  );
  const canApply =
    validation.valid &&
    value.name.trim().length > 0 &&
    value.name.trim().length <= 240 &&
    !coordinateText.trim() &&
    (!draft.original ||
      value.name.trim() !== draft.original.name ||
      JSON.stringify(value.coordinates) !==
        JSON.stringify(draft.original.coordinates));
  function applyCoordinates() {
    const lines = coordinateText
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim());
    const points: Position[] = [];
    for (let index = 0; index < lines.length; index++) {
      const parts = lines[index].trim().split(/[\s,]+/);
      if (
        parts.length !== 2 ||
        parts.some((part) => !Number.isFinite(Number(part)))
      ) {
        setCoordinateError(`Line ${index + 1}: enter longitude, latitude.`);
        return;
      }
      points.push([Number(parts[0]), Number(parts[1])]);
    }
    const checked = validateRoadPath(points, place);
    if (!checked.valid) {
      setCoordinateError(checked.error!);
      return;
    }
    onChange({ ...value, coordinates: points });
    setCoordinateError("");
    setCoordinateText("");
  }
  return (
    <div className="street-draft-editor" aria-label="Street drawing editor">
      <div className="panel-heading">
        <span className="eyebrow">
          {draft.original ? "RESHAPE A STREET" : "A NEW CONNECTION"}
        </span>
        <button
          className="icon-button"
          aria-label="Discard street draft"
          onClick={onDiscard}
        >
          <X size={16} />
        </button>
      </div>
      <h2>{draft.original ? "Refine the route." : "Make room to move."}</h2>
      <p className="street-help">
        {draft.mode === "draw"
          ? "Click to add points. Drag a numbered point to move it."
          : "Select a point, then click the map or drag its numbered handle to move it."}{" "}
        Your proposal changes only when you apply.
      </p>
      <label className="field">
        <span>Street name</span>
        <input
          aria-label="Street name"
          value={value.name}
          maxLength={240}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </label>
      <div
        className="street-draw-modes"
        role="group"
        aria-label="Street drawing mode"
      >
        <button
          aria-pressed={draft.mode === "draw"}
          onClick={() => onMode("draw")}
        >
          <Plus size={14} /> Add points
        </button>
        <button
          aria-pressed={draft.mode === "reshape"}
          disabled={!value.coordinates.length}
          onClick={() => onMode("reshape")}
        >
          <MousePointer2 size={14} /> Move a point
        </button>
      </div>
      <label className="check-row">
        <span>Align to nearby street points</span>
        <input
          type="checkbox"
          checked={draft.snapToRoads}
          onChange={(event) => onSnapChange(event.target.checked)}
        />
      </label>
      <div className="street-draft-summary" role="status">
        <span>
          <MapPin size={14} /> {value.coordinates.length} points
        </span>
        <strong>
          {validation.lengthMeters >= 1000
            ? `${(validation.lengthMeters / 1000).toFixed(2)} km`
            : `${Math.round(validation.lengthMeters)} m`}
        </strong>
        <span className="street-draft-badge">Not applied</span>
      </div>
      {value.coordinates.length > 0 && (
        <ol className="street-vertices" aria-label="Street points">
          {value.coordinates.map((point, index) => (
            <li key={index}>
              <button
                className="street-vertex"
                aria-label={`Select street point ${index + 1}`}
                aria-describedby={`street-${draft.id}-point-${index}`}
                aria-pressed={draft.selectedVertexIndex === index}
                onClick={() => onSelectVertex(index)}
              >
                <span>{index + 1}</span>
                <div id={`street-${draft.id}-point-${index}`}>
                  {point[1].toFixed(6)}° lat
                  <small>{point[0].toFixed(6)}° lon</small>
                </div>
              </button>
              <button
                className="icon-button"
                aria-label={`Remove street point ${index + 1}`}
                onClick={() => onRemoveVertex(index)}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}
      {!validation.valid && (
        <p
          className="street-validation"
          role={value.coordinates.length > 1 ? "alert" : "status"}
        >
          {validation.error}
        </p>
      )}
      <details
        className="street-coordinate-entry"
        open={coordinatesOpen}
        onToggle={(event) => setCoordinatesOpen(event.currentTarget.open)}
      >
        <summary>Enter exact coordinates</summary>
        <p>
          One longitude, latitude pair per line. This replaces the draft path.
          Maximum {MAX_AUTHORED_ROAD_POINTS} points.
        </p>
        <label>
          <span className="sr-only">Street coordinates</span>
          <textarea
            aria-label="Street coordinates"
            spellCheck={false}
            rows={5}
            value={coordinateText}
            placeholder="-112.070000, 33.460000"
            onChange={(event) => {
              setCoordinateText(event.target.value);
              setCoordinateError("");
            }}
          />
        </label>
        <div className="street-coordinate-actions">
          <button
            className="button"
            disabled={!coordinateText.trim()}
            onClick={applyCoordinates}
          >
            Use these coordinates
          </button>
          <button
            className="button"
            disabled={!value.coordinates.length}
            onClick={() => {
              setCoordinateText(
                value.coordinates.map((point) => point.join(", ")).join("\n"),
              );
              setCoordinateError("");
            }}
          >
            Load draft points
          </button>
        </div>
        {coordinateText.trim() && (
          <button
            className="text-button"
            onClick={() => {
              setCoordinateText("");
              setCoordinateError("");
            }}
          >
            Discard coordinate text
          </button>
        )}
        {coordinateError && (
          <p className="street-validation" role="alert">
            {coordinateError}
          </p>
        )}
      </details>
      {coordinateText.trim() && (
        <p className="street-help">
          Use or discard the coordinate text before applying the street.
        </p>
      )}
      <div className="street-draft-actions">
        <button
          className="button primary full-width"
          disabled={!canApply}
          onClick={onApply}
        >
          Apply street <ArrowRight size={15} />
        </button>
        <button className="button full-width" onClick={onDiscard}>
          Discard draft
        </button>
      </div>
      <p className="street-help">
        {draft.original
          ? "The original street remains in the baseline."
          : "Starts with two lanes, 25 mph, and two-way travel. Change these settings in the street inspector."}{" "}
        Geometry updates network measures. Traffic routing and intersection
        behavior require a separate model.
      </p>
    </div>
  );
}
