import type { TrafficSourceDeclaration } from "../../lib/traffic-draft";
import { TrafficText } from "./TrafficFields";
export const newDeclaration = (): TrafficSourceDeclaration => ({
  sourceId: `traffic-source-${crypto.randomUUID()}`,
  name: "",
  url: "",
  vintage: "",
  license: "",
  privateUseConfirmed: false,
  publicRedistribution: false,
});
export function TrafficSourceForm({
  value,
  onChange,
  disabled,
  prefix = "Count",
}: {
  value: TrafficSourceDeclaration;
  onChange: (value: TrafficSourceDeclaration) => void;
  disabled: boolean;
  prefix?: string;
}) {
  const patch = (next: Partial<TrafficSourceDeclaration>) =>
    onChange({ ...value, ...next });
  return (
    <fieldset disabled={disabled} className="traffic-source-form">
      <legend>Source and permission</legend>
      <div className="traffic-field-grid">
        <TrafficText
          label={`${prefix} source name`}
          value={value.name}
          onChange={(name) => patch({ name })}
          maxLength={240}
        />
        <TrafficText
          label={`${prefix} source vintage`}
          value={value.vintage}
          onChange={(vintage) => patch({ vintage })}
          maxLength={100}
        />
      </div>
      <TrafficText
        label={`${prefix} source citation URL`}
        type="url"
        maxLength={4000}
        value={value.url}
        onChange={(url) => patch({ url })}
      />
      <TrafficText
        label={`${prefix} source license or permission`}
        value={value.license}
        onChange={(license) => patch({ license })}
        maxLength={1000}
      />
      <label className="traffic-check">
        <input
          type="checkbox"
          checked={value.privateUseConfirmed}
          onChange={(event) =>
            patch({ privateUseConfirmed: event.target.checked })
          }
        />
        <span>
          I have permission to retain, analyze, privately display and export
          this evidence, including its historical records.
        </span>
      </label>
      <label className="traffic-check">
        <input
          type="checkbox"
          checked={value.publicRedistribution}
          onChange={(event) =>
            patch({ publicRedistribution: event.target.checked })
          }
        />
        <span>
          This source permits public redistribution of input values and
          attribution in snapshots and downloads.
        </span>
      </label>
      <p className="traffic-muted">
        Private by default. The server records the declaring account and time
        when accepted; this form does not verify a license.
      </p>
    </fieldset>
  );
}
