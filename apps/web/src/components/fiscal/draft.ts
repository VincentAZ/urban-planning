import {
  FISCAL_COEFFICIENT_KEYS,
  FISCAL_METHOD_VERSION,
  fiscalProfileSchema,
  fiscalOfferSchema,
  fiscalSensitivityCaseSchema,
  type FiscalProfile,
  type FiscalCoefficientKey,
  type FiscalSensitivityCase,
  type Scenario,
  type Source,
} from "@urban/core";
import { readFiscalNumber } from "./numbers";

export const fiscalFields: {
  key: FiscalCoefficientKey;
  label: string;
  unit: string;
  scale: number;
  hint: string;
}[] = [
  {
    key: "assessedValuePerSqft",
    label: "Fallback taxable assessed value",
    unit: "$/gross ft²",
    scale: 1,
    hint: "Used only where the building has no supplied assessed value.",
  },
  {
    key: "effectivePropertyTaxRate",
    label: "Effective property levy",
    unit: "% per year",
    scale: 100,
    hint: "Retained levy on taxable assessed value, not an unadjusted statutory rate.",
  },
  {
    key: "annualServiceCostPerResident",
    label: "Annual service cost per resident",
    unit: "$ / resident",
    scale: 1,
    hint: "An allocation of operating costs; does not establish marginal cost or capital capacity.",
  },
  {
    key: "annualServiceCostPerJob",
    label: "Annual service cost per job",
    unit: "$ / job",
    scale: 1,
    hint: "Document the allocation to avoid counting the same costs twice.",
  },
  {
    key: "annualGrowthRate",
    label: "Annual growth",
    unit: "%",
    scale: 100,
    hint: "An explicit constant-dollar assumption, not a regional forecast unless cited.",
  },
  {
    key: "discountRate",
    label: "Real discount rate",
    unit: "%",
    scale: 100,
    hint: "Recurring flows are discounted at year end; the grant occurs at time zero.",
  },
  {
    key: "salesPerSqft",
    label: "Annual taxable sales capacity",
    unit: "$/retail ft²",
    scale: 1,
    hint: "Floor-area capacity assumption; separate from the retail-gap workbench.",
  },
  {
    key: "localSalesTaxRate",
    label: "Retained sales tax rate",
    unit: "%",
    scale: 100,
    hint: "Only the receiving jurisdiction's retained share.",
  },
  {
    key: "retailCaptureRate",
    label: "Taxable sales capture",
    unit: "%",
    scale: 100,
    hint: "An authored capture assumption; not measured leakage or induced demand.",
  },
];
export interface FiscalSourceDraft {
  source: Source;
  privateUse: boolean;
  exportAllowed: boolean;
  publicRedistribution: boolean;
}
export interface FiscalProfileDraft {
  id: string;
  name: string;
  profileVersion: string;
  jurisdictionId: string;
  jurisdictionName: string;
  geography: string;
  fiscalYear: string;
  dollarYear: string;
  coefficients: Record<FiscalCoefficientKey, string>;
  retainedCoefficients?: FiscalProfile["coefficients"];
  provenance: FiscalProfile["provenance"];
  valuationNotes: string;
  allocationMethod: FiscalProfile["serviceAllocation"]["method"];
  allocationNotes: string;
  sources: FiscalSourceDraft[];
  jurisdictionSources: string[];
  allocationSources: string[];
  files: FiscalProfile["files"];
  notes: string;
}
export const newFiscalSource = (): FiscalSourceDraft => ({
  source: {
    id: `fiscal-source-${crypto.randomUUID()}`,
    name: "",
    url: "",
    vintage: "",
    license: "",
    kind: "user-supplied",
    description: "",
  },
  privateUse: false,
  exportAllowed: false,
  publicRedistribution: false,
});
export function createFiscalProfileDraft(
  scenario: Scenario,
  existing?: FiscalProfile,
): FiscalProfileDraft {
  const source = newFiscalSource();
  source.source.name = "Planner-authored fiscal assumptions";
  source.source.kind = "user-supplied";
  const year = new Date().getFullYear();
  return {
    id: existing?.id ?? `fiscal-profile-${crypto.randomUUID()}`,
    name: existing?.name ?? "",
    profileVersion: existing?.profileVersion ?? "1",
    jurisdictionId: existing?.jurisdiction.id ?? "",
    jurisdictionName:
      existing?.jurisdiction.name ?? scenario.assumptions.jurisdictionName,
    geography: existing?.jurisdiction.geography ?? "",
    fiscalYear: String(existing?.fiscalYear ?? year),
    dollarYear: String(existing?.dollarYear ?? year),
    coefficients: Object.fromEntries(
      fiscalFields.map(({ key, scale }) => [
        key,
        String(
          (existing?.coefficients[key] ?? scenario.assumptions[key]) * scale,
        ),
      ]),
    ) as FiscalProfileDraft["coefficients"],
    ...(existing ? { retainedCoefficients: { ...existing.coefficients } } : {}),
    provenance: existing
      ? structuredClone(existing.provenance)
      : (Object.fromEntries(
          FISCAL_COEFFICIENT_KEYS.map((key) => [
            key,
            {
              kind: "authored",
              sourceIds: [source.source.id],
              description:
                "Illustrative starting assumption; requires local review.",
            },
          ]),
        ) as FiscalProfile["provenance"]),
    valuationNotes: existing?.valuation.compatibilityNotes ?? "",
    allocationMethod:
      existing?.serviceAllocation.method ?? "average-cost-allocation",
    allocationNotes: existing?.serviceAllocation.notes ?? "",
    sources: existing
      ? existing.sources.map((item) => ({
          source: structuredClone(item),
          privateUse:
            !!item.rights &&
            [
              "privateUse",
              "cache",
              "analyze",
              "privateDisplay",
              "historicalRetention",
            ].every(
              (key) => item.rights![key as keyof typeof item.rights] === true,
            ),
          exportAllowed: !!item.rights?.export,
          publicRedistribution: !!item.rights?.publicRedistribution,
        }))
      : [source],
    jurisdictionSources: existing?.jurisdiction.sourceIds.slice() ?? [
      source.source.id,
    ],
    allocationSources: existing?.serviceAllocation.sourceIds.slice() ?? [
      source.source.id,
    ],
    files: existing ? structuredClone(existing.files) : [],
    notes: existing?.notes.join("\n") ?? "",
  };
}
export function readFiscalProfileDraft(
  draft: FiscalProfileDraft,
  actor: string,
  at: string,
): FiscalProfile {
  if (draft.sources.some((source) => !source.privateUse))
    throw new Error(
      "Review private use, analysis and historical retention for every cited source.",
    );
  const coefficients = Object.fromEntries(
    fiscalFields.map((field) => [
      field.key,
      draft.retainedCoefficients &&
      draft.coefficients[field.key] ===
        String(draft.retainedCoefficients[field.key] * field.scale)
        ? draft.retainedCoefficients[field.key]
        : readFiscalNumber(draft.coefficients[field.key], field.label) /
          field.scale,
    ]),
  );
  const sources = draft.sources.map(
    ({ source, privateUse, exportAllowed, publicRedistribution }) => ({
      ...source,
      rights: {
        version: 1 as const,
        privateUse,
        cache: privateUse,
        analyze: privateUse,
        privateDisplay: privateUse,
        export: exportAllowed,
        historicalRetention: privateUse,
        publicRedistribution,
        declaredBy: actor,
        declaredAt: at,
      },
    }),
  );
  return fiscalProfileSchema.parse({
    version: 1,
    id: draft.id,
    name: draft.name.trim(),
    profileVersion: draft.profileVersion.trim(),
    methodVersion: FISCAL_METHOD_VERSION,
    jurisdiction: {
      id: draft.jurisdictionId.trim(),
      name: draft.jurisdictionName.trim(),
      geography: draft.geography.trim(),
      sourceIds: draft.jurisdictionSources,
    },
    fiscalYear: readFiscalNumber(draft.fiscalYear, "Fiscal year"),
    dollarYear: readFiscalNumber(
      draft.dollarYear,
      "Constant-dollar price year",
    ),
    currency: "USD",
    priceBasis: "constant-dollars",
    discountBasis: "real",
    coefficients,
    provenance: draft.provenance,
    valuation: {
      buildingValueBasis: "taxable-assessed",
      fallbackValueBasis: "taxable-assessed-per-gross-sqft",
      compatibilityNotes: draft.valuationNotes,
    },
    serviceAllocation: {
      method: draft.allocationMethod,
      notes: draft.allocationNotes,
      sourceIds: draft.allocationSources,
    },
    sources,
    files: draft.files,
    notes: draft.notes
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  });
}
export interface FiscalCaseDraft {
  id: string;
  name: string;
  description: string;
  sourceIds: string[];
  baseline: Record<FiscalCoefficientKey, string>;
  proposal: Record<FiscalCoefficientKey, string>;
}
export function fiscalCaseDraft(
  value?: FiscalSensitivityCase,
  sourceId?: string,
): FiscalCaseDraft {
  return {
    id: value?.id ?? `case-${crypto.randomUUID()}`,
    name: value?.name ?? "",
    description: value?.description ?? "",
    sourceIds: value?.sourceIds.slice() ?? (sourceId ? [sourceId] : []),
    baseline: Object.fromEntries(
      fiscalFields.map(({ key, scale }) => [
        key,
        value?.baseline[key] === undefined
          ? ""
          : String(value.baseline[key]! * scale),
      ]),
    ) as FiscalCaseDraft["baseline"],
    proposal: Object.fromEntries(
      fiscalFields.map(({ key, scale }) => [
        key,
        value?.proposal[key] === undefined
          ? ""
          : String(value.proposal[key]! * scale),
      ]),
    ) as FiscalCaseDraft["proposal"],
  };
}
export function readFiscalCases(
  cases: FiscalCaseDraft[],
): FiscalSensitivityCase[] {
  return cases.map((value) =>
    fiscalSensitivityCaseSchema.parse({
      ...value,
      baseline: Object.fromEntries(
        fiscalFields
          .filter(({ key }) => value.baseline[key].trim() !== "")
          .map(({ key, label, scale }) => [
            key,
            readFiscalNumber(
              value.baseline[key],
              `${value.name} baseline ${label}`,
            ) / scale,
          ]),
      ),
      proposal: Object.fromEntries(
        fiscalFields
          .filter(({ key }) => value.proposal[key].trim() !== "")
          .map(({ key, label, scale }) => [
            key,
            readFiscalNumber(
              value.proposal[key],
              `${value.name} proposal ${label}`,
            ) / scale,
          ]),
      ),
    }),
  );
}
export function readFiscalOffer(draft: {
  grant: string;
  abatement: string;
  years: string;
}) {
  return fiscalOfferSchema.parse({
    incentiveGrant: readFiscalNumber(draft.grant, "Upfront grant"),
    abatementPercent: readFiscalNumber(draft.abatement, "Abatement") / 100,
    abatementYears: readFiscalNumber(draft.years, "Abatement term"),
  });
}
