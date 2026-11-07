import {
  createRetailCategory,
  createRetailScenario,
  USER_RETAIL_SOURCE,
  type Place,
  type RetailCategory,
  type RetailMeasure,
  type RetailScenario,
  type Scenario,
  type Source,
} from "@urban/core";

export interface MeasureDraft {
  status: RetailMeasure["status"];
  value: string;
  sourceId: string;
  note: string;
}
export interface CategoryDraft extends Omit<
  RetailCategory,
  | "baselineDemand"
  | "baselineSales"
  | "salesPerEstablishment"
  | "scenarioDemand"
  | "annualSalesCapacity"
  | "captureShare"
  | "displacementShare"
> {
  baselineDemand: MeasureDraft;
  baselineSales: MeasureDraft;
  salesPerEstablishment: MeasureDraft;
  scenarioDemand: string;
  annualSalesCapacity: string;
  captureShare: string;
  displacementShare: string;
}
export interface RetailDraft {
  context: Omit<RetailScenario["context"], "referenceYear" | "dollarYear"> & {
    referenceYear: string;
    dollarYear: string;
  };
  categories: CategoryDraft[];
  sourceRights: RetailScenario["sourceRights"];
  sources: Source[];
}
const measureDraft = (measure: RetailMeasure): MeasureDraft => ({
  status: measure.status,
  value: measure.value == null ? "" : String(measure.value),
  sourceId: measure.sourceId ?? "",
  note: measure.note ?? "",
});
export function categoryDraft(
  category = createRetailCategory(),
): CategoryDraft {
  return {
    ...category,
    baselineDemand: measureDraft(category.baselineDemand),
    baselineSales: measureDraft(category.baselineSales),
    salesPerEstablishment: measureDraft(category.salesPerEstablishment),
    scenarioDemand:
      category.scenarioDemand == null ? "" : String(category.scenarioDemand),
    annualSalesCapacity: String(category.annualSalesCapacity),
    captureShare: String(category.captureShare * 100),
    displacementShare: String(category.displacementShare * 100),
  };
}
export function createRetailDraft(
  place: Place,
  scenario: Scenario,
): RetailDraft {
  const retail =
    scenario.retail ?? createRetailScenario(place, scenario.horizon);
  return {
    context: {
      ...structuredClone(retail.context),
      referenceYear: String(retail.context.referenceYear),
      dollarYear: String(retail.context.dollarYear),
    },
    categories: retail.categories.map(categoryDraft),
    sourceRights: structuredClone(retail.sourceRights),
    sources: [
      ...new Map(
        [...place.sources, ...(scenario.sources ?? []), USER_RETAIL_SOURCE].map(
          (source) => [source.id, source],
        ),
      ).values(),
    ],
  };
}
export interface DraftIssue {
  field: string;
  message: string;
}
/** Raw buffers live with the complete draft, so switching categories never loses invalid input. */
export function readRetailDraft(draft: RetailDraft): {
  retail: RetailScenario | null;
  issues: DraftIssue[];
} {
  const issues: DraftIssue[] = [];
  function number(
    raw: string,
    field: string,
    label: string,
    min = 0,
    max = 1e12,
    integer = false,
  ) {
    const value = raw.trim() ? Number(raw) : Number.NaN;
    if (
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    ) {
      issues.push({
        field,
        message: `${label}: enter ${integer ? "a whole number" : "a number"} from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.`,
      });
      return 0;
    }
    return value;
  }
  function measure(
    raw: MeasureDraft,
    field: string,
    label: string,
  ): RetailMeasure {
    const value =
      raw.status === "available" ? number(raw.value, field, label) : null;
    if (raw.status !== "missing" && !raw.sourceId)
      issues.push({
        field: `${field}.source`,
        message: `${label}: select a source.`,
      });
    return {
      status: raw.status,
      value,
      ...(raw.sourceId ? { sourceId: raw.sourceId } : {}),
      ...(raw.note.trim() ? { note: raw.note.trim() } : {}),
    };
  }
  const retail: RetailScenario = {
    version: 1,
    context: {
      ...draft.context,
      geography: draft.context.geography.trim(),
      referenceYear: number(
        draft.context.referenceYear,
        "referenceYear",
        "Reference year",
        1900,
        2200,
        true,
      ),
      dollarYear: number(
        draft.context.dollarYear,
        "dollarYear",
        "Dollar year",
        1900,
        2200,
        true,
      ),
      classification: {
        ...draft.context.classification,
        version: draft.context.classification.version.trim(),
      },
    },
    categories: draft.categories.map((category) => {
      const prefix = `${category.id}.`;
      const label = category.name.trim() || "Unnamed category";
      return {
        id: category.id,
        name: category.name.trim(),
        code: category.code.trim(),
        baselineDemand: measure(
          category.baselineDemand,
          `${prefix}baselineDemand`,
          `${label} baseline resident demand`,
        ),
        baselineSales: measure(
          category.baselineSales,
          `${prefix}baselineSales`,
          `${label} baseline local sales`,
        ),
        salesPerEstablishment: measure(
          category.salesPerEstablishment,
          `${prefix}salesPerEstablishment`,
          `${label} sales per establishment`,
        ),
        scenarioDemand:
          category.scenarioDemand.trim() === ""
            ? null
            : number(
                category.scenarioDemand,
                `${prefix}scenarioDemand`,
                `${label} scenario resident demand`,
              ),
        annualSalesCapacity: number(
          category.annualSalesCapacity,
          `${prefix}annualSalesCapacity`,
          `${label} added sales capacity`,
        ),
        captureShare:
          number(
            category.captureShare,
            `${prefix}captureShare`,
            `${label} capture share`,
            0,
            100,
          ) / 100,
        displacementShare:
          number(
            category.displacementShare,
            `${prefix}displacementShare`,
            `${label} displacement`,
            0,
            100,
          ) / 100,
        assumptionSourceId: category.assumptionSourceId,
      };
    }),
    sourceRights: structuredClone(
      draft.sourceRights.filter((right) =>
        draft.categories.some((category) =>
          [
            category.assumptionSourceId,
            category.baselineDemand.sourceId,
            category.baselineSales.sourceId,
            category.salesPerEstablishment.sourceId,
          ].includes(right.sourceId),
        ),
      ),
    ),
  };
  return { retail: issues.length ? null : retail, issues };
}
export function retailSourceIds(retail: RetailScenario | null): Set<string> {
  return new Set(
    retail?.categories.flatMap((category) =>
      [
        category.assumptionSourceId,
        category.baselineDemand.sourceId,
        category.baselineSales.sourceId,
        category.salesPerEstablishment.sourceId,
      ].filter((id): id is string => !!id),
    ) ?? [],
  );
}
export function newRetailSource(): Source {
  return {
    id: `retail-source-${crypto.randomUUID()}`,
    name: "",
    url: "",
    vintage: "",
    license: "",
    kind: "user-supplied",
    description: "",
  };
}
