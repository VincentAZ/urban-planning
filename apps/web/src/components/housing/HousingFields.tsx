import { useId, type ReactNode } from "react";
export function HousingField({
  label,
  value,
  onChange,
  hint,
  numeric = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  numeric?: boolean;
}) {
  const id = useId();
  return (
    <div className="housing-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        inputMode={numeric ? "decimal" : undefined}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function HousingSelect({
  label,
  value,
  onChange,
  children,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="housing-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      >
        {children}
      </select>
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
