import type { Source } from "@urban/core";
import { FiscalText, FiscalNumber } from "./FiscalFields";
import { FiscalCitations } from "./FiscalProfileEditor";
import { fiscalFields, fiscalCaseDraft, type FiscalCaseDraft } from "./draft";
export function FiscalCasesEditor({
  cases,
  sources,
  onChange,
}: {
  cases: FiscalCaseDraft[];
  sources: Source[];
  onChange: (cases: FiscalCaseDraft[]) => void;
}) {
  const patch = (id: string, change: Partial<FiscalCaseDraft>) =>
    onChange(
      cases.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );
  return (
    <div className="fiscal-section">
      <h3>Test the assumptions, together.</h3>
      <p>
        Each named case pairs baseline and proposal changes. Blank case fields
        retain that side's current input; an entered zero is a deliberate zero.
        These cases are not confidence intervals or probabilities.
      </p>
      {cases.map((item, index) => (
        <section
          className="fiscal-case"
          key={item.id}
          aria-label={`Sensitivity case ${index + 1}`}
        >
          <div className="fiscal-section-title">
            <h4>Case {index + 1}</h4>
            <button
              type="button"
              className="button"
              onClick={() =>
                onChange(cases.filter((value) => value.id !== item.id))
              }
            >
              Remove case {index + 1}
            </button>
          </div>
          <FiscalText
            label={`Case ${index + 1} name`}
            value={item.name}
            maxLength={240}
            onChange={(name) => patch(item.id, { name })}
          />
          <FiscalText
            label={`Case ${index + 1} rationale`}
            value={item.description}
            multiline
            maxLength={4000}
            onChange={(description) => patch(item.id, { description })}
          />
          <FiscalCitations
            label={`Case ${index + 1} context citations`}
            sources={sources}
            value={item.sourceIds}
            onChange={(sourceIds) => patch(item.id, { sourceIds })}
          />
          <p className="fiscal-muted">
            Citations provide context; these entered variants are authored
            assumptions unless the rationale documents otherwise.
          </p>
          {fiscalFields.map((field) => (
            <div className="fiscal-case-grid" key={field.key}>
              <span>
                {field.label} · {field.unit}
              </span>
              <FiscalNumber
                label={`Case ${index + 1} baseline ${field.label.toLowerCase()}`}
                value={item.baseline[field.key]}
                hint="Blank: retain baseline"
                onChange={(raw) =>
                  patch(item.id, {
                    baseline: { ...item.baseline, [field.key]: raw },
                  })
                }
              />
              <FiscalNumber
                label={`Case ${index + 1} proposal ${field.label.toLowerCase()}`}
                value={item.proposal[field.key]}
                hint="Blank: retain proposal"
                onChange={(raw) =>
                  patch(item.id, {
                    proposal: { ...item.proposal, [field.key]: raw },
                  })
                }
              />
            </div>
          ))}
        </section>
      ))}
      <button
        type="button"
        className="button"
        disabled={cases.length >= 12}
        onClick={() =>
          onChange([...cases, fiscalCaseDraft(undefined, sources[0]?.id)])
        }
      >
        Add paired sensitivity case
      </button>
    </div>
  );
}
