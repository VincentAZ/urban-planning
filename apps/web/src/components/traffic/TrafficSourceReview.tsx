import type { Source } from "@urban/core";
import type { TrafficSourceDeclaration } from "../../lib/traffic-draft";
import { TrafficSourceForm } from "./TrafficSourceForm";

export function TrafficSourceReview({
  sources,
  declarations,
  onChange,
  canEdit,
}: {
  sources: Source[];
  declarations: TrafficSourceDeclaration[];
  onChange: (value: TrafficSourceDeclaration[]) => void;
  canEdit: boolean;
}) {
  const rows = [
    ...new Map(
      sources
        .filter((source) => source.kind === "user-supplied")
        .map((source) => [source.id, source]),
    ).values(),
  ];
  if (!rows.length) return null;
  return (
    <details className="traffic-source-details">
      <summary>Review authored-source permissions ({rows.length})</summary>
      <p className="traffic-muted">
        Private use and public redistribution are separate permissions. Updating
        this declaration applies to the new configuration; retained earlier
        captures keep their original statements. Permission declarations do not
        turn assumptions into measured evidence.
      </p>
      {rows.map((source) => {
        const value = declarations.find(
          (value) => value.sourceId === source.id,
        ) ?? {
          sourceId: source.id,
          name: source.name,
          url: source.url,
          vintage: source.vintage,
          license: source.license,
          privateUseConfirmed:
            !!source.rights &&
            [
              source.rights.privateUse,
              source.rights.cache,
              source.rights.analyze,
              source.rights.privateDisplay,
              source.rights.export,
              source.rights.historicalRetention,
            ].every(Boolean),
          publicRedistribution: source.rights?.publicRedistribution ?? false,
        };
        return (
          <details key={source.id}>
            <summary>{source.name}</summary>
            <TrafficSourceForm
              prefix="Authored"
              value={value}
              disabled={!canEdit}
              onChange={(next) =>
                onChange([
                  ...declarations.filter((item) => item.sourceId !== source.id),
                  next,
                ])
              }
            />
          </details>
        );
      })}
    </details>
  );
}
