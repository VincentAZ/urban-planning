import { useEffect, useId, useState, type InputHTMLAttributes } from "react";
import type { CountTarget } from "@urban/core";

export function ActivityNumber({
  label,
  value,
  onChange,
  ...props
}: { label: string; value: number; onChange: (value: number) => void } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type"
>) {
  const [text, setText] = useState(String(value));
  const hintId = useId();
  const invalid =
    !text.trim() ||
    !Number.isFinite(Number(text)) ||
    (props.min !== undefined && Number(text) < Number(props.min)) ||
    (props.max !== undefined && Number(text) > Number(props.max));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="field">
      <span id={`${hintId}-label`}>{label}</span>
      <input
        {...props}
        type="number"
        required
        aria-labelledby={`${hintId}-label`}
        aria-invalid={invalid}
        aria-describedby={invalid ? hintId : undefined}
        value={text}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (raw.trim() && Number.isFinite(Number(raw))) onChange(Number(raw));
        }}
      />
      {invalid && (
        <small id={hintId} className="activity-input-error">
          Enter a valid number
          {props.min !== undefined && props.max !== undefined
            ? ` from ${props.min} to ${props.max}`
            : ""}{" "}
          before continuing.
        </small>
      )}
    </label>
  );
}
export function TargetFields({
  label,
  scope = "global",
  target,
  reference,
  onChange,
}: {
  label: string;
  scope?: "global" | "area" | "vehicles";
  target: CountTarget | undefined;
  reference: number | null | undefined;
  onChange: (target: CountTarget | undefined) => void;
}) {
  return (
    <fieldset className="activity-target">
      <legend>{label}</legend>
      <label className="field">
        <span>{label} target method</span>
        <select
          value={target?.mode ?? "derived"}
          onChange={(event) =>
            onChange(
              event.target.value === "derived"
                ? undefined
                : event.target.value === "absolute"
                  ? { mode: "absolute", value: reference ?? 0 }
                  : { mode: "baseline-percent", percent: 100 },
            )
          }
        >
          <option value="derived">
            {scope === "area"
              ? "Use allocated global count"
              : scope === "vehicles"
                ? "Keep reference stock"
                : "Derived from capacity & growth"}
          </option>
          <option value="absolute">Absolute count</option>
          <option value="baseline-percent">
            Percent of year-zero reference
          </option>
        </select>
      </label>
      {target?.mode === "absolute" && (
        <ActivityNumber
          label={`${label} count`}
          value={target.value}
          min={0}
          max={1e9}
          step="any"
          onChange={(value) => onChange({ mode: "absolute", value })}
        />
      )}
      {target?.mode === "baseline-percent" && (
        <ActivityNumber
          label={`${label} percent of reference`}
          value={target.percent}
          min={0}
          max={10000}
          step="any"
          onChange={(percent) =>
            onChange({ mode: "baseline-percent", percent })
          }
        />
      )}
      <p>
        {target?.mode === "baseline-percent"
          ? `100% = ${reference == null ? "reference unavailable" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(reference)}. 125% adds 25% once; it never compounds with repeated clicks.`
          : target?.mode === "absolute"
            ? "This count applies at the selected horizon; annual growth is not applied again."
            : scope === "area"
              ? "This area keeps its allocated share of the studywide target unless you enter an exception."
              : scope === "vehicles"
                ? "Keep the household vehicle reference. Population changes do not automatically grow this stock."
                : "No explicit target. Structural changes and the selected growth assumption determine this value."}
      </p>
    </fieldset>
  );
}
