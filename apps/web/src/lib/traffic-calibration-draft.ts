import {
  trafficCalibrationPlanSchema,
  type TrafficCalibrationPlan,
} from "@urban/core";

export const trafficCriteriaFields = [
  {
    key: "gehMaximum",
    label: "Maximum GEH",
    hint: "A count-fit statistic; enter the tolerance your study will use.",
  },
  {
    key: "absoluteHourlyErrorMaximum",
    label: "Maximum absolute hourly error",
    hint: "Vehicles per hour, using hourly-equivalent observed intervals.",
  },
  {
    key: "relativeErrorMaximum",
    label: "Maximum relative error (%)",
    hint: "A percentage of the observed count. Zero observations use the absolute tolerance.",
  },
  {
    key: "requiredPassingFraction",
    label: "Required passing observations (%)",
    hint: "Applied separately to the calibration and held-out sets.",
  },
  {
    key: "minimumCalibrationCounts",
    label: "Minimum calibration observations",
    hint: "Whole interval records, not independent stations.",
  },
  {
    key: "minimumHoldoutCounts",
    label: "Minimum held-out observations",
    hint: "Whole interval records, not independent stations.",
  },
] as const;
type CriteriaKey = keyof TrafficCalibrationPlan["criteria"];
export interface TrafficCalibrationDraft {
  calibrationCountIds: string[];
  holdoutCountIds: string[];
  criteria: Record<CriteriaKey, string>;
  sourceIds: string[];
  description: string;
  /** Preserve the exact numeric values of an unchanged saved plan. */
  originalCriteria?: TrafficCalibrationPlan["criteria"];
}
export function trafficCalibrationDraft(
  plan: TrafficCalibrationPlan | null,
): TrafficCalibrationDraft | null {
  if (!plan) return null;
  return {
    ...plan,
    calibrationCountIds: [...plan.calibrationCountIds],
    holdoutCountIds: [...plan.holdoutCountIds],
    sourceIds: [...plan.sourceIds],
    originalCriteria: { ...plan.criteria },
    criteria: Object.fromEntries(
      trafficCriteriaFields.map(({ key }) => [
        key,
        String(
          plan.criteria[key] *
            (key === "relativeErrorMaximum" || key === "requiredPassingFraction"
              ? 100
              : 1),
        ),
      ]),
    ) as Record<CriteriaKey, string>,
  };
}
export function newTrafficCalibrationDraft(): TrafficCalibrationDraft {
  return {
    calibrationCountIds: [],
    holdoutCountIds: [],
    sourceIds: [],
    description: "",
    criteria: Object.fromEntries(
      trafficCriteriaFields.map(({ key }) => [key, ""]),
    ) as Record<CriteriaKey, string>,
  };
}
export function readTrafficCalibrationDraft(
  draft: TrafficCalibrationDraft | null,
): TrafficCalibrationPlan | null {
  if (!draft) return null;
  const criteria = {} as TrafficCalibrationPlan["criteria"];
  for (const { key, label } of trafficCriteriaFields) {
    const percent =
      key === "relativeErrorMaximum" || key === "requiredPassingFraction";
    const original = draft.originalCriteria?.[key];
    if (
      original !== undefined &&
      draft.criteria[key] === String(original * (percent ? 100 : 1))
    ) {
      criteria[key] = original;
      continue;
    }
    const text = draft.criteria[key].trim();
    if (
      !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ||
      !Number.isFinite(Number(text))
    )
      throw new Error(`${label}: enter a nonnegative number for this study.`);
    const value = Number(text);
    if (key === "minimumCalibrationCounts" || key === "minimumHoldoutCounts") {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${label}: enter a positive whole number.`);
    }
    if (key === "requiredPassingFraction" && value > 100)
      throw new Error(
        "Required passing observations must be from 0 to 100 percent.",
      );
    criteria[key] = percent ? value / 100 : value;
  }
  if (!draft.description.trim())
    throw new Error(
      "Explain the count-check criteria, grouping and held-out evidence in the study rationale.",
    );
  if (!draft.sourceIds.length)
    throw new Error(
      "Select a retained source or add an authored criteria citation for the count-check plan.",
    );
  return trafficCalibrationPlanSchema.parse({
    calibrationCountIds: draft.calibrationCountIds,
    holdoutCountIds: draft.holdoutCountIds,
    sourceIds: draft.sourceIds,
    criteria,
    description: draft.description,
  });
}
/** A role action always moves the entire visible period group, without deleting other selections. */
export function assignTrafficCalibrationGroup(
  draft: TrafficCalibrationDraft,
  countIds: readonly string[],
  role: "calibration" | "holdout" | "context",
): TrafficCalibrationDraft {
  const ids = new Set(countIds);
  return {
    ...draft,
    calibrationCountIds: [
      ...draft.calibrationCountIds.filter((id) => !ids.has(id)),
      ...(role === "calibration" ? countIds : []),
    ],
    holdoutCountIds: [
      ...draft.holdoutCountIds.filter((id) => !ids.has(id)),
      ...(role === "holdout" ? countIds : []),
    ],
  };
}
