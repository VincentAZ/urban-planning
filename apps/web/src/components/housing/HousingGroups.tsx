import { useMemo, useState } from "react";
import {
  housingCapacities,
  type Building,
  type HousingIncomeLimitCatalog,
} from "@urban/core";
import { HousingField, HousingSelect } from "./HousingFields";
import {
  housingCostLabels,
  housingGroupDraft,
  newHousingCosts,
  type HousingGroupDraft,
  type HousingSourceDraft,
} from "./draft";
export function HousingGroups({
  side,
  groups,
  buildings,
  packs,
  sources,
  selectedBuildingId,
  onChange,
  onSelectBuilding,
}: {
  side: "baseline" | "proposal";
  groups: HousingGroupDraft[];
  buildings: Building[];
  packs: HousingIncomeLimitCatalog;
  sources: HousingSourceDraft[];
  selectedBuildingId?: string;
  onChange: (groups: HousingGroupDraft[]) => void;
  onSelectBuilding?: (id: string) => void;
}) {
  const [selected, setSelected] = useState(
    groups.find((g) => g.buildingId === selectedBuildingId)?.id ??
      groups[0]?.id ??
      "",
  );
  const [query, setQuery] = useState("");
  const capacity = useMemo(
    () => new Map(housingCapacities(buildings).map((c) => [c.buildingId, c])),
    [buildings],
  );
  const names = useMemo(
    () => new Map(buildings.map((b) => [b.id, b.name ?? b.id])),
    [buildings],
  );
  const group = groups.find((g) => g.id === selected);
  const update = (next: HousingGroupDraft) =>
    onChange(groups.map((g) => (g.id === next.id ? next : g)));
  const add = () => {
    const d = housingGroupDraft(
      undefined,
      selectedBuildingId && capacity.has(selectedBuildingId)
        ? selectedBuildingId
        : "",
    );
    onChange([...groups, d]);
    setSelected(d.id);
  };
  const filtered = groups.filter((g) =>
    `${names.get(g.buildingId) ?? ""} ${g.buildingId} ${g.notes}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const cap = group ? capacity.get(group.buildingId) : undefined;
  const assigned = group
    ? groups
        .filter((g) => g.buildingId === group.buildingId)
        .reduce((n, g) => (/^\d+$/u.test(g.units) ? n + Number(g.units) : n), 0)
    : 0;
  return (
    <section>
      <h3>{side === "baseline" ? "Baseline" : "Proposal"} unit groups</h3>
      <p>
        A group describes actual homes sharing tenure, household size and
        housing costs. Groups partition building capacity; they do not estimate
        the households who live there.
      </p>
      <div className="housing-actions">
        <button className="housing-primary" type="button" onClick={add}>
          Add {side} group
        </button>
        <HousingField
          label={`Find ${side} group`}
          value={query}
          onChange={setQuery}
        />
      </div>
      <div className="housing-group-layout">
        <nav className="housing-group-list" aria-label={`${side} unit groups`}>
          {filtered.map((g, i) => (
            <button
              type="button"
              key={g.id}
              aria-pressed={g.id === selected}
              onClick={() => setSelected(g.id)}
            >
              <strong>{names.get(g.buildingId) ?? "Choose a building"}</strong>
              <small>
                {g.units || "Unknown"} homes ·{" "}
                {g.tenure === "rent" ? "Rental" : "Ownership"} · group {i + 1}
              </small>
            </button>
          ))}
          {!filtered.length && <p>No matching groups.</p>}
        </nav>
        {group ? (
          <div className="housing-group-editor">
            <div className="housing-fields">
              <HousingSelect
                label="Building"
                value={group.buildingId}
                onChange={(buildingId) =>
                  update({ ...group, buildingId, componentId: "" })
                }
              >
                <option value="">Choose a building</option>
                {buildings
                  .filter(
                    (b) =>
                      b.units === null ||
                      b.units > 0 ||
                      b.id === group.buildingId,
                  )
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name ?? b.id} · {b.units ?? "unknown"} homes
                    </option>
                  ))}
              </HousingSelect>
              {cap?.components.length ? (
                <HousingSelect
                  label="Residential program component"
                  value={group.componentId}
                  onChange={(componentId) => update({ ...group, componentId })}
                  hint="Choose a component when assigning homes in a typed building program."
                >
                  <option value="">Choose a component</option>
                  {cap.components
                    .filter((c) => c.units > 0)
                    .map((c) => (
                      <option key={c.componentId} value={c.componentId}>
                        {c.componentId} · {c.units} homes
                      </option>
                    ))}
                </HousingSelect>
              ) : null}
              <HousingField
                label="Homes in group"
                numeric
                value={group.units}
                onChange={(units) => update({ ...group, units })}
              />
              <HousingSelect
                label="Tenure"
                value={group.tenure}
                onChange={(value) => {
                  const tenure = value as "rent" | "own";
                  update({ ...group, tenure, costs: newHousingCosts(tenure) });
                }}
                hint="Changing tenure resets the required cost components to Unknown."
              >
                <option value="rent">Rental</option>
                <option value="own">Ownership</option>
              </HousingSelect>
              <HousingSelect
                label="Household size"
                value={group.householdSize}
                onChange={(householdSize) =>
                  update({ ...group, householdSize })
                }
                hint="Explicit analysis choice; not inferred from bedrooms."
              >
                <option value="">Choose household size</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option value={n} key={n}>
                    {n} {n === 1 ? "person" : "people"}
                  </option>
                ))}
              </HousingSelect>
              <HousingField
                label="Bedrooms (optional)"
                numeric
                value={group.bedrooms}
                onChange={(bedrooms) => update({ ...group, bedrooms })}
              />
              <HousingSelect
                label="Applicable HUD area"
                value={group.areaHash}
                onChange={(areaHash) => update({ ...group, areaHash })}
              >
                <option value="">Choose a reviewed area</option>
                {Object.entries(packs).map(([hash, p]) => (
                  <option key={hash} value={hash}>
                    {p.area.name} · FY {p.fiscalYear}
                  </option>
                ))}
              </HousingSelect>
              <HousingField
                label="Cost year"
                numeric
                value={group.costYear}
                onChange={(costYear) => update({ ...group, costYear })}
              />
            </div>
            <p className="housing-capacity" role="status">
              Building capacity: <strong>{cap?.units ?? "Unknown"}</strong>{" "}
              homes. Raw group assignments: <strong>{assigned}</strong>. Exact
              component and capacity checks run in the preview.
            </p>
            {group.buildingId && onSelectBuilding && (
              <button
                type="button"
                onClick={() => onSelectBuilding(group.buildingId)}
              >
                Show this building on map
              </button>
            )}
            <h4>Monthly housing costs</h4>
            <p>
              Enter each charge once. “Included” points to a known payment that
              already contains it; for example, taxes included in a loan escrow
              payment.
            </p>
            {group.costs.map((cost, index) => {
              const patch = (change: Partial<typeof cost>) =>
                update({
                  ...group,
                  costs: group.costs.map((c, i) =>
                    i === index ? { ...c, ...change } : c,
                  ),
                });
              return (
                <fieldset key={cost.id} className="housing-cost">
                  <legend>{housingCostLabels[cost.kind]}</legend>
                  <div className="housing-fields">
                    <HousingSelect
                      label={`${housingCostLabels[cost.kind]} treatment`}
                      value={cost.state}
                      onChange={(state) =>
                        patch({ state: state as typeof cost.state })
                      }
                    >
                      <option value="unknown">Unknown</option>
                      <option value="separate">Separate known payment</option>
                      <option value="included">
                        Included in another payment
                      </option>
                      <option value="not-applicable">Not applicable</option>
                    </HousingSelect>
                    {cost.state === "separate" && (
                      <HousingField
                        label={`${housingCostLabels[cost.kind]} monthly dollars`}
                        value={cost.dollars}
                        numeric
                        onChange={(dollars) =>
                          patch({
                            dollars,
                            provenance: {
                              ...cost.provenance,
                              kind: "authored",
                            },
                          })
                        }
                      />
                    )}{" "}
                    {cost.state === "included" && (
                      <HousingSelect
                        label={`${housingCostLabels[cost.kind]} included in`}
                        value={cost.includedIn}
                        onChange={(includedIn) => patch({ includedIn })}
                      >
                        <option value="">Choose known payment</option>
                        {group.costs
                          .filter(
                            (c) =>
                              c.id !== cost.id &&
                              c.state === "separate" &&
                              c.dollars.trim(),
                          )
                          .map((c) => (
                            <option value={c.id} key={c.id}>
                              {housingCostLabels[c.kind]}
                            </option>
                          ))}
                      </HousingSelect>
                    )}
                  </div>
                  <details>
                    <summary>Cost provenance</summary>
                    <HousingSelect
                      label={`${housingCostLabels[cost.kind]} evidence kind`}
                      value={cost.provenance.kind}
                      onChange={(kind) =>
                        patch({
                          provenance: {
                            ...cost.provenance,
                            kind: kind as typeof cost.provenance.kind,
                          },
                        })
                      }
                    >
                      <option value="authored">Authored assumption</option>
                      <option value="published">Published value</option>
                      <option value="derived">Derived value</option>
                    </HousingSelect>
                    <HousingField
                      label={`${housingCostLabels[cost.kind]} evidence description`}
                      value={cost.provenance.description}
                      onChange={(description) =>
                        patch({
                          provenance: { ...cost.provenance, description },
                        })
                      }
                    />
                    {sources.map((s) => (
                      <label className="check" key={s.source.id}>
                        <input
                          type="checkbox"
                          checked={cost.provenance.sourceIds.includes(
                            s.source.id,
                          )}
                          onChange={(e) =>
                            patch({
                              provenance: {
                                ...cost.provenance,
                                sourceIds: e.target.checked
                                  ? [...cost.provenance.sourceIds, s.source.id]
                                  : cost.provenance.sourceIds.filter(
                                      (id) => id !== s.source.id,
                                    ),
                              },
                            })
                          }
                        />
                        {s.source.name || "Unnamed cost source"}
                      </label>
                    ))}
                    {!sources.length && (
                      <p>
                        Add citations in Sources for published or derived costs.
                      </p>
                    )}
                  </details>
                </fieldset>
              );
            })}
            <HousingField
              label="Group notes"
              value={group.notes}
              onChange={(notes) => update({ ...group, notes })}
            />
            <button
              type="button"
              onClick={() => {
                onChange(groups.filter((g) => g.id !== group.id));
                setSelected(groups.find((g) => g.id !== group.id)?.id ?? "");
              }}
            >
              Remove this group
            </button>
          </div>
        ) : (
          <p className="housing-empty">
            Add a group to describe costs for a set of homes.
          </p>
        )}
      </div>
    </section>
  );
}
