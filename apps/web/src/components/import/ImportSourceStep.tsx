import type { ImportSourceDeclaration } from "../../../../api/src/gis-jobs-types";
export function ImportSourceStep({
  value,
  onChange,
}: {
  value: ImportSourceDeclaration;
  onChange: (source: ImportSourceDeclaration) => void;
}) {
  const patch = (change: Partial<ImportSourceDeclaration>) =>
    onChange({ ...value, ...change });
  return (
    <section className="import-section">
      <h3>Keep the source with the story.</h3>
      <p>
        This citation and your declared rights travel with the prepared geometry
        and retained project history. Raw uploads are private.
      </p>
      <label className="field">
        <span>Source name</span>
        <input
          aria-label="Source name"
          value={value.name}
          maxLength={240}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </label>
      <div className="field-grid">
        <label className="field">
          <span>Source URL</span>
          <input
            aria-label="Source URL"
            type="url"
            value={value.url ?? ""}
            maxLength={4000}
            onChange={(event) => patch({ url: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Dataset vintage</span>
          <input
            aria-label="Dataset vintage"
            value={value.vintage ?? ""}
            placeholder="Unknown, or the dataset’s actual date"
            maxLength={100}
            onChange={(event) => patch({ vintage: event.target.value })}
          />
          <small>
            Blank is retained as unknown. Upload time is recorded separately.
          </small>
        </label>
      </div>
      <label className="field">
        <span>License and permission statement</span>
        <textarea
          aria-label="License and permission statement"
          value={value.license}
          rows={4}
          maxLength={2000}
          onChange={(event) => patch({ license: event.target.value })}
        />
      </label>
      <label className="import-check">
        <input
          type="checkbox"
          checked={value.privateUseConfirmed}
          onChange={(event) =>
            patch({ privateUseConfirmed: event.target.checked })
          }
        />
        <span>
          I am authorized to privately store, analyze and display this data,
          include it in authorized exports, and retain it in project history.
        </span>
      </label>
      <label className="import-check">
        <input
          type="checkbox"
          checked={value.publicRedistribution}
          onChange={(event) =>
            patch({ publicRedistribution: event.target.checked })
          }
        />
        <span>
          This source permits public redistribution of its geometry, input
          values and attribution in snapshots and downloads.
        </span>
      </label>
      {!value.publicRedistribution && (
        <p className="notice">
          Private use only. Public sharing of this imported source will be
          blocked; your free private project remains available.
        </p>
      )}
    </section>
  );
}
