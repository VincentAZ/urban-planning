import { useId, type ReactNode } from "react";

export function FiscalField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (props: { id: string; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="fiscal-field">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(hint ? { "aria-describedby": `${id}-hint` } : {}) })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}

/** Raw text is retained until the entire draft passes validation. Empty is never zero. */
export function FiscalNumber({
  label,
  value,
  onChange,
  hint,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (raw: string) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <FiscalField label={label} hint={hint}>
      {(props) => (
        <input
          {...props}
          type="text"
          inputMode="decimal"
          value={value}
          disabled={disabled}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FiscalField>
  );
}

export function FiscalText({
  label,
  value,
  onChange,
  hint,
  multiline = false,
  maxLength = 2000,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  multiline?: boolean;
  maxLength?: number;
  disabled?: boolean;
}) {
  return (
    <FiscalField label={label} hint={hint}>
      {(props) =>
        multiline ? (
          <textarea
            {...props}
            value={value}
            disabled={disabled}
            maxLength={maxLength}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <input
            {...props}
            value={value}
            disabled={disabled}
            maxLength={maxLength}
            onChange={(event) => onChange(event.target.value)}
          />
        )
      }
    </FiscalField>
  );
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
export const fiscalMoney = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "Unavailable"
    : money.format(value);
