import { useId } from "react";
import type { Source } from "@urban/core";
import type { CategoryDraft, DraftIssue, MeasureDraft } from "./draft";

export function RetailNumber({
  label,
  value,
  onChange,
  optional = false,
  max,
  hint,
  invalid = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  max?: number;
  hint?: string;
  invalid?: boolean;
}) {
  const id = useId();
  return (
    <label className="field retail-field">
      <span id={`${id}-label`}>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        max={max ?? 1e12}
        step="any"
        required={!optional}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid}
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? id : undefined}
      />
      {hint && <small id={id}>{hint}</small>}
    </label>
  );
}
function MeasureFields({
  label,
  measure,
  onChange,
  sources,
  invalid,
}: {
  label: string;
  measure: MeasureDraft;
  onChange: (value: MeasureDraft) => void;
  sources: Source[];
  invalid: boolean;
}) {
  return (
    <fieldset className="retail-measure">
      <legend>{label}</legend>
      <div className="retail-field-grid">
        <label className="field">
          <span>{label} status</span>
          <select
            value={measure.status}
            onChange={(event) =>
              onChange({
                ...measure,
                status: event.target.value as MeasureDraft["status"],
              })
            }
          >
            <option value="available">Available</option>
            <option value="missing">Missing</option>
            <option value="suppressed">Suppressed</option>
          </select>
        </label>
        {measure.status === "available" ? (
          <RetailNumber
            label={`${label} ($ / year)`}
            value={measure.value}
            invalid={invalid}
            onChange={(value) => onChange({ ...measure, value })}
          />
        ) : (
          <p className="retail-unknown">
            {measure.status === "suppressed"
              ? "Withheld by the source."
              : "No value supplied."}{" "}
            This is not zero.
          </p>
        )}
      </div>
      <label className="field">
        <span>{label} source</span>
        <select
          value={measure.sourceId}
          required={measure.status !== "missing"}
          onChange={(event) =>
            onChange({ ...measure, sourceId: event.target.value })
          }
        >
          <option value="">Select a cited source</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name || "Untitled source"}
              {source.vintage ? ` · ${source.vintage}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{label} note</span>
        <input
          value={measure.note}
          maxLength={2000}
          placeholder="Optional coverage or source caveat"
          onChange={(event) =>
            onChange({ ...measure, note: event.target.value })
          }
        />
      </label>
    </fieldset>
  );
}
export function RetailCategoryEditor({
  category,
  onChange,
  sources,
  issues,
}: {
  category: CategoryDraft;
  onChange: (category: CategoryDraft) => void;
  sources: Source[];
  issues: DraftIssue[];
}) {
  const invalid = (field: string) =>
    issues.some((issue) => issue.field === `${category.id}.${field}`);
  return (
    <div className="retail-category-editor">
      <div className="retail-field-grid">
        <label className="field">
          <span>Category name</span>
          <input
            required
            maxLength={160}
            value={category.name}
            onChange={(event) =>
              onChange({ ...category, name: event.target.value })
            }
          />
        </label>
        <label className="field">
          <span>Category code</span>
          <input
            required
            maxLength={80}
            value={category.code}
            placeholder="Your declared classification"
            onChange={(event) =>
              onChange({ ...category, code: event.target.value })
            }
          />
        </label>
      </div>
      <p className="retail-note">
        Use mutually exclusive categories. A parent category and its
        subcategories must not count the same spending twice.
      </p>
      <h3>Captured evidence</h3>
      <MeasureFields
        label="Baseline resident demand"
        measure={category.baselineDemand}
        sources={sources}
        invalid={invalid("baselineDemand")}
        onChange={(baselineDemand) => onChange({ ...category, baselineDemand })}
      />
      <MeasureFields
        label="Baseline local sales"
        measure={category.baselineSales}
        sources={sources}
        invalid={invalid("baselineSales")}
        onChange={(baselineSales) => onChange({ ...category, baselineSales })}
      />
      <MeasureFields
        label="Annual sales per establishment"
        measure={category.salesPerEstablishment}
        sources={sources}
        invalid={invalid("salesPerEstablishment")}
        onChange={(salesPerEstablishment) =>
          onChange({ ...category, salesPerEstablishment })
        }
      />
      <h3>Scenario assumptions</h3>
      <p className="retail-note">
        Annual values at this study’s horizon. Building edits, population
        changes and annual growth do not automatically change these inputs.
      </p>
      <RetailNumber
        label="Scenario resident demand ($ / year)"
        optional
        value={category.scenarioDemand}
        invalid={invalid("scenarioDemand")}
        hint="Leave blank to retain the captured demand. Enter 0 only when zero demand is intended."
        onChange={(scenarioDemand) => onChange({ ...category, scenarioDemand })}
      />
      <RetailNumber
        label="Annual added sales capacity ($ / year)"
        value={category.annualSalesCapacity}
        invalid={invalid("annualSalesCapacity")}
        hint="Capacity assigned only to this category. Do not reuse the same proposed capacity across categories."
        onChange={(annualSalesCapacity) =>
          onChange({ ...category, annualSalesCapacity })
        }
      />
      <div className="retail-field-grid">
        <RetailNumber
          label="Capture share (%)"
          value={category.captureShare}
          max={100}
          invalid={invalid("captureShare")}
          onChange={(captureShare) => onChange({ ...category, captureShare })}
        />
        <RetailNumber
          label="Local displacement (%)"
          value={category.displacementShare}
          max={100}
          invalid={invalid("displacementShare")}
          onChange={(displacementShare) =>
            onChange({ ...category, displacementShare })
          }
        />
      </div>
      <p className="retail-note">
        Capture is the share of eligible unmet demand addressed. Displacement
        reduces that capture for sales shifted from existing local businesses.
      </p>
    </div>
  );
}
