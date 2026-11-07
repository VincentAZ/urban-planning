import { useId } from "react";
import type { ReactNode } from "react";

export function TrafficField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (ids: { id: string; describedBy?: string }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="traffic-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, describedBy: hint ? `${id}-hint` : undefined })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function TrafficText({
  label,
  value,
  onChange,
  hint,
  type = "text",
  disabled = false,
  maxLength = 500,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  type?: "text" | "date" | "time" | "url";
  disabled?: boolean;
  maxLength?: number;
}) {
  return (
    <TrafficField label={label} hint={hint}>
      {({ id, describedBy }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          type={type}
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </TrafficField>
  );
}
export function TrafficNumber({
  label,
  value,
  onChange,
  hint,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <TrafficField label={label} hint={hint}>
      {({ id, describedBy }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </TrafficField>
  );
}
export const trafficNumber = (value: number | null | undefined, digits = 1) =>
  value == null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(
        value,
      );
export const trafficQuality = {
  source: "Source supplied",
  authored: "User authored",
  inferred: "Inferred",
} as const;
export function trafficClock(seconds: number): string {
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    remainder = Math.floor(seconds % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}${remainder ? `:${String(remainder).padStart(2, "0")}` : ""}`;
}
