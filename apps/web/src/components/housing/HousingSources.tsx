import type { Source } from "@urban/core";
import { HousingField } from "./HousingFields";
import { housingSourceDraft, type HousingSourceDraft } from "./draft";
export function HousingSources({
  sources,
  onChange,
}: {
  sources: HousingSourceDraft[];
  onChange: (value: HousingSourceDraft[]) => void;
}) {
  return (
    <section>
      <h3>Housing cost sources</h3>
      <p>
        HUD publications describe income limits. They do not verify the rents,
        ownership costs or household-size choices entered here. Authored
        assumptions may be uncited; published and derived costs need a retained
        source.
      </p>
      {sources.map((d, index) => {
        const change = (value: HousingSourceDraft) =>
          onChange(sources.map((s, i) => (i === index ? value : s)));
        const metadata = (key: keyof Source, value: string) =>
          change({
            ...d,
            source: { ...d.source, [key]: value },
            privateUse: false,
            exportAllowed: false,
            publicRedistribution: false,
          });
        return (
          <fieldset key={d.source.id}>
            <legend>Cost source {index + 1}</legend>
            <div className="housing-fields">
              <HousingField
                label={`Source ${index + 1} name`}
                value={d.source.name}
                onChange={(v) => metadata("name", v)}
              />
              <HousingField
                label={`Source ${index + 1} URL`}
                value={d.source.url ?? ""}
                onChange={(v) => metadata("url", v)}
              />
              <HousingField
                label={`Source ${index + 1} vintage`}
                value={d.source.vintage}
                onChange={(v) => metadata("vintage", v)}
              />
              <HousingField
                label={`Source ${index + 1} license or terms`}
                value={d.source.license}
                onChange={(v) => metadata("license", v)}
              />
            </div>
            <HousingField
              label={`Source ${index + 1} description`}
              value={d.source.description ?? ""}
              onChange={(v) => metadata("description", v)}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={d.privateUse}
                onChange={(e) => change({ ...d, privateUse: e.target.checked })}
              />
              I can use, cache, analyze and display this source privately, and
              retain it in project history.
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={d.exportAllowed}
                onChange={(e) =>
                  change({ ...d, exportAllowed: e.target.checked })
                }
              />
              This source permits export of these input values and attribution.
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={d.publicRedistribution}
                onChange={(e) =>
                  change({ ...d, publicRedistribution: e.target.checked })
                }
              />
              This source permits public redistribution of these input values
              and attribution.
            </label>
            <button
              type="button"
              onClick={() => onChange(sources.filter((_, i) => i !== index))}
            >
              Remove source {index + 1}
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...sources, housingSourceDraft()])}
      >
        Add cost source
      </button>
    </section>
  );
}
