import {
  HOUSING_OWNER_COST_KINDS,
  HOUSING_RENT_COST_KINDS,
  housingCostGroupSchema,
  type HousingCostGroup,
  type HousingCostItem,
  type HousingCostKind,
  type Source,
} from "@urban/core";

export const housingCostLabels: Record<HousingCostKind, string> = {
  rent: "Rent",
  utilities: "Utilities",
  "mandatory-fees": "Mandatory fees",
  "loan-payment": "Loan payment",
  "property-tax": "Property tax",
  "property-insurance": "Property insurance",
  "flood-insurance": "Flood insurance",
  "mortgage-insurance": "Mortgage insurance",
  "association-fees": "Association fees",
  "ground-rent": "Ground rent",
};
export interface HousingCostDraft {
  id: string;
  kind: HousingCostKind;
  state: HousingCostItem["state"];
  dollars: string;
  includedIn: string;
  provenance: HousingCostItem["provenance"];
}
export interface HousingGroupDraft {
  id: string;
  buildingId: string;
  componentId: string;
  units: string;
  tenure: "rent" | "own";
  householdSize: string;
  bedrooms: string;
  areaHash: string;
  areaOrigin: HousingCostGroup["areaOrigin"];
  costYear: string;
  costs: HousingCostDraft[];
  notes: string;
}
export interface HousingSourceDraft {
  source: Source;
  privateUse: boolean;
  exportAllowed: boolean;
  publicRedistribution: boolean;
}
export function newHousingCosts(tenure: "rent" | "own"): HousingCostDraft[] {
  return (
    tenure === "rent" ? HOUSING_RENT_COST_KINDS : HOUSING_OWNER_COST_KINDS
  ).map((kind) => ({
    id: crypto.randomUUID(),
    kind,
    state: "unknown",
    dollars: "",
    includedIn: "",
    provenance: {
      kind: "authored",
      sourceIds: [],
      description: "Planner-authored cost assumption.",
    },
  }));
}
export function housingGroupDraft(
  group?: HousingCostGroup,
  buildingId = "",
): HousingGroupDraft {
  return group
    ? {
        ...group,
        componentId: group.componentId ?? "",
        units: String(group.units),
        householdSize: String(group.householdSize),
        bedrooms: group.bedrooms === undefined ? "" : String(group.bedrooms),
        costYear: String(group.costYear),
        costs: group.costs.map((c) => ({
          ...c,
          dollars:
            c.state === "separate" ? (c.monthlyCents / 100).toFixed(2) : "",
          includedIn: c.state === "included" ? c.includedIn : "",
        })),
      }
    : {
        id: crypto.randomUUID(),
        buildingId,
        componentId: "",
        units: "",
        tenure: "rent",
        householdSize: "",
        bedrooms: "",
        areaHash: "",
        areaOrigin: "imported",
        costYear: String(new Date().getFullYear()),
        costs: newHousingCosts("rent"),
        notes: "",
      };
}
export function housingInteger(raw: string, label: string, min = 0): number {
  if (!/^\d+$/u.test(raw.trim()))
    throw new Error(
      `${label}: enter a whole number; blank is unknown, not zero.`,
    );
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min)
    throw new Error(`${label}: enter a whole number of at least ${min}.`);
  return n;
}
export function housingCents(raw: string, label: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(raw.trim());
  if (!match)
    throw new Error(
      `${label}: enter dollars with up to two decimal places, or choose Unknown.`,
    );
  const n = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(n) || n > 1_000_000_000)
    throw new Error(`${label}: amount is outside the supported range.`);
  return n;
}
export function readHousingGroup(d: HousingGroupDraft): HousingCostGroup {
  return housingCostGroupSchema.parse({
    id: d.id,
    buildingId: d.buildingId,
    ...(d.componentId ? { componentId: d.componentId } : {}),
    units: housingInteger(d.units, "Homes in group", 1),
    tenure: d.tenure,
    householdSize: housingInteger(d.householdSize, "Household size", 1),
    ...(d.bedrooms.trim()
      ? { bedrooms: housingInteger(d.bedrooms, "Bedrooms") }
      : {}),
    areaHash: d.areaHash,
    areaOrigin: d.areaOrigin,
    costYear: housingInteger(d.costYear, "Cost year"),
    notes: d.notes,
    costs: d.costs.map((c) => ({
      id: c.id,
      kind: c.kind,
      state: c.state,
      provenance: c.provenance,
      ...(c.state === "separate"
        ? { monthlyCents: housingCents(c.dollars, housingCostLabels[c.kind]) }
        : c.state === "included"
          ? { includedIn: c.includedIn }
          : {}),
    })),
  });
}
export function housingSourceDraft(source?: Source): HousingSourceDraft {
  return {
    source: source
      ? structuredClone(source)
      : {
          id: `housing-source-${crypto.randomUUID()}`,
          name: "",
          url: "",
          vintage: "",
          license: "",
          kind: "user-supplied",
          description: "",
        },
    privateUse:
      !!source?.rights &&
      [
        "privateUse",
        "cache",
        "analyze",
        "privateDisplay",
        "historicalRetention",
      ].every((k) => source.rights![k as keyof typeof source.rights] === true),
    exportAllowed: !!source?.rights?.export,
    publicRedistribution: !!source?.rights?.publicRedistribution,
  };
}
export function readHousingSources(
  drafts: HousingSourceDraft[],
  actor: string,
  at: string,
): Source[] {
  return drafts.map((d) => {
    if (
      !d.source.name.trim() ||
      !d.source.vintage.trim() ||
      !d.source.license.trim()
    )
      throw new Error(
        "Every cost source needs a name, vintage and license or usage terms.",
      );
    if (!d.privateUse)
      throw new Error(`Review private use and retention for ${d.source.name}.`);
    return {
      ...d.source,
      rights: {
        version: 1,
        privateUse: true,
        cache: true,
        analyze: true,
        privateDisplay: true,
        historicalRetention: true,
        export: d.exportAllowed,
        publicRedistribution: d.publicRedistribution,
        declaredBy: actor,
        declaredAt: at,
      },
    };
  });
}
