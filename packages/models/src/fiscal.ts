import {
  FISCAL_COEFFICIENT_KEYS,
  FISCAL_METHOD_VERSION,
  createFiscalScenarioReview,
  fiscalContentHash,
  fiscalProfileHash,
  fiscalProfileSchema,
  fiscalReviewInputHash,
  fiscalResolutionInputHash,
  fiscalProjectIssues,
  projectWithImportedWorkforce,
  projectWithImportedAccessibility,
  projectWithImportedTraffic,
  projectWithImportedFlood,
  type Assumptions,
  type FiscalProfile,
  type FiscalStudy,
  type FiscalResolution,
  type FiscalCaseResult,
  type FiscalTrajectory,
  type FiscalCashFlowRow,
  type FiscalIncremental,
  type FiscalSensitivityCase,
  type Place,
  type Project,
  type Scenario,
} from "@urban/core";
import { projectSchema } from "../../core/src/validation";
import { fiscalCashFlows } from "./engine";
import { missingMetricBuildings } from "./quantity-coverage";
import { resolveActivity } from "./activity";

export function createFiscalStudy(input: {
  place: Place;
  project: Project;
  scenarioId: string;
  profile: FiscalProfile;
  review: {
    reviewedBy: string;
    reviewedAt: string;
    applicabilityNotes: string;
  };
  name?: string;
}): Project {
  const { place, project, scenarioId, review } = input;
  projectSchema.parse(project);
  const profile = fiscalProfileSchema.parse(input.profile);
  if (place.id !== project.placeId)
    throw new Error("Fiscal study source place does not match its project.");
  const source = project.scenarios.find((s) => s.id === scenarioId);
  const originalBaseline = project.scenarios.find((s) => s.id === "baseline");
  if (!source || !originalBaseline)
    throw new Error("Select an existing scenario and its original baseline.");
  const profileHash = fiscalProfileHash(profile);
  const initialize = (a: Assumptions): Assumptions => ({
    ...structuredClone(a),
    ...profile.coefficients,
    jurisdictionName: profile.jurisdiction.name,
    fiscalInputsConfirmed: true,
  });
  const baseline = structuredClone(originalBaseline);
  baseline.assumptions = initialize(baseline.assumptions);
  baseline.baselineAssumptions = structuredClone(baseline.assumptions);
  baseline.createdAt = review.reviewedAt;
  baseline.updatedAt = review.reviewedAt;
  const proposal = structuredClone(source);
  proposal.id = `scenario-${globalThis.crypto.randomUUID()}`;
  proposal.parentId = "baseline";
  proposal.name = source.id === "baseline" ? "Option A" : source.name;
  proposal.revision = 0;
  proposal.createdAt = review.reviewedAt;
  proposal.updatedAt = review.reviewedAt;
  proposal.assumptions = initialize(source.assumptions);
  proposal.baselineAssumptions = structuredClone(baseline.assumptions);
  const cases = source.fiscal?.cases ?? [];
  if (
    cases.some((c) =>
      c.sourceIds.some((id) => !profile.sources.some((s) => s.id === id)),
    )
  )
    throw new Error(
      "The selected scenario's sensitivity sources must be retained in the new profile before copying.",
    );
  proposal.fiscal = createFiscalScenarioReview(
    proposal,
    profileHash,
    { ...review, notes: review.applicabilityNotes },
    cases,
  );
  const result: Project = {
    id: `project-${globalThis.crypto.randomUUID()}`,
    name: input.name ?? `${project.name} · fiscal study`,
    placeId: place.id,
    scenarios: [baseline, proposal],
    activeScenarioId: proposal.id,
    history: [],
    undone: [],
    updatedAt: review.reviewedAt,
    schemaVersion: 12,
    ...(project.floodDatasets
      ? { floodDatasets: structuredClone(project.floodDatasets) }
      : {}),
    fiscalStudy: {
      version: 1,
      methodVersion: FISCAL_METHOD_VERSION,
      profile,
      profileHash,
      placeHash: fiscalContentHash(place),
      baselineAssumptionsHash: fiscalContentHash(baseline.assumptions),
      applicability: { ...review, kind: "user-reviewed-study-area" },
      lineage: {
        projectId: project.id,
        scenarioId,
        scenarioRevision: source.revision,
        projectHash: fiscalContentHash(project),
        scenarioHash: fiscalContentHash(source),
        historyHash: fiscalContentHash({
          history: project.history,
          undone: project.undone,
        }),
        copiedAt: review.reviewedAt,
        policy: "selected-current-scenario-native-evidence-imported",
      },
    },
  };
  const imported = projectWithImportedFlood(
    projectWithImportedTraffic(
      projectWithImportedAccessibility(projectWithImportedWorkforce(result)),
    ),
  );
  const issues = fiscalProjectIssues(imported, place);
  if (issues.length) throw new Error(issues.join(" "));
  return projectSchema.parse(imported) as Project;
}

const sum = (values: (number | null)[]): number | null => {
  if (values.some((v) => v === null)) return null;
  const result = (values as number[]).reduce((a, b) => a + b, 0);
  return Number.isFinite(result) ? result : null;
};
const difference = (a: number | null, b: number | null): number | null =>
  a === null || b === null || !Number.isFinite(a - b) ? null : a - b;
function trajectory(
  place: Place,
  scenario: Scenario,
  firstYear: number,
  baseline: boolean,
): FiscalTrajectory {
  const activity = scenario.activity
    ? resolveActivity(place, scenario)
    : undefined;
  const flows = fiscalCashFlows(place, scenario, 20, baseline, activity);
  const grant = baseline ? 0 : scenario.assumptions.incentiveGrant;
  const rows: FiscalCashFlowRow[] = [
    {
      year: 0,
      fiscalYear: null,
      propertyRevenue: 0,
      salesRevenue: 0,
      serviceCost: 0,
      abatementCost: 0,
      grantCost: grant,
      netRevenue: grant === 0 ? 0 : -grant,
      discountedNet: grant === 0 ? 0 : -grant,
    },
    ...flows.map((f) => ({
      ...f,
      fiscalYear: firstYear + f.year - 1,
      grantCost: 0,
      netRevenue: f.netRevenue === null ? null : f.netRevenue + f.grantCost,
      discountedNet:
        f.discountedNet === null ? null : f.discountedNet + f.grantCost,
    })),
  ];
  const missingBuildingIds = [
    ...new Set(
      [
        "fiscal.propertyTax",
        "fiscal.salesTax",
        "fiscal.serviceCost",
        "fiscal.netAnnual",
      ].flatMap((id) =>
        missingMetricBuildings(id, place, scenario, baseline, activity),
      ),
    ),
  ].sort();
  return {
    rows,
    totals: {
      propertyRevenue: sum(rows.map((r) => r.propertyRevenue)),
      salesRevenue: sum(rows.map((r) => r.salesRevenue)),
      serviceCost: sum(rows.map((r) => r.serviceCost)),
      abatementCost: sum(rows.map((r) => r.abatementCost)),
      grantCost: grant,
      netRevenue: sum(rows.map((r) => r.netRevenue)),
      npv: sum(rows.map((r) => r.discountedNet)),
    },
    missingBuildingIds,
  };
}
function incremental(
  proposal: FiscalTrajectory,
  baseline: FiscalTrajectory,
): FiscalIncremental {
  const rows = proposal.rows.map((r, i) => {
    const b = baseline.rows[i];
    return {
      year: r.year,
      fiscalYear: r.fiscalYear,
      propertyRevenue: difference(r.propertyRevenue, b.propertyRevenue),
      salesRevenue: difference(r.salesRevenue, b.salesRevenue),
      serviceCost: difference(r.serviceCost, b.serviceCost),
      abatementCost: difference(r.abatementCost, b.abatementCost),
      grantCost: r.grantCost - b.grantCost,
      netRevenue: difference(r.netRevenue, b.netRevenue),
      discountedNet: difference(r.discountedNet, b.discountedNet),
    };
  });
  return {
    rows,
    netRevenue: sum(rows.map((r) => r.netRevenue)),
    npv: sum(rows.map((r) => r.discountedNet)),
  };
}
function evaluateCase(
  place: Place,
  source: Scenario,
  firstYear: number,
  spec: FiscalSensitivityCase,
): FiscalCaseResult {
  const scenario = {
    ...source,
    assumptions: { ...source.assumptions, ...spec.proposal },
    baselineAssumptions: { ...source.baselineAssumptions, ...spec.baseline },
  };
  const baseline = trajectory(place, scenario, firstYear, true);
  const withOffer = trajectory(place, scenario, firstYear, false);
  const withoutOffer = trajectory(
    place,
    {
      ...scenario,
      assumptions: {
        ...scenario.assumptions,
        incentiveGrant: 0,
        abatementPercent: 0,
        abatementYears: 0,
      },
    },
    firstYear,
    false,
  );
  const change = {
    withoutOffer: incremental(withoutOffer, baseline),
    withOffer: incremental(withOffer, baseline),
  };
  let payback: FiscalCaseResult["payback"];
  const offer = scenario.assumptions;
  // A known offer cost does not become unknown just because an unrelated
  // operating-cost or sales input is missing. Do not subtract two large NPVs.
  const offerCost = {
    total: sum([withOffer.totals.grantCost, withOffer.totals.abatementCost]),
    npv: sum(
      withOffer.rows.map((row) =>
        row.abatementCost === null
          ? null
          : row.grantCost +
            row.abatementCost / (1 + offer.discountRate) ** row.year,
      ),
    ),
  };
  if (offerCost.total === 0) payback = { status: "not-needed", year: 0 };
  else if (change.withOffer.rows.some((r) => r.netRevenue === null))
    payback = { status: "unavailable", year: null };
  else {
    let balance = change.withOffer.rows[0].netRevenue!;
    const row = change.withOffer.rows.slice(1).find((r) => {
      balance += r.netRevenue!;
      return balance >= 0;
    });
    payback = row
      ? { status: "reached", year: row.year }
      : { status: "not-reached", year: null };
  }
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    sourceIds: [...spec.sourceIds],
    status: [baseline, withoutOffer, withOffer].some(
      (t) => t.totals.netRevenue === null || t.totals.npv === null,
    )
      ? "incomplete"
      : "ready",
    assumptions: {
      baseline: structuredClone(scenario.baselineAssumptions),
      proposal: structuredClone(scenario.assumptions),
    },
    baseline,
    withoutOffer,
    withOffer,
    incremental: change,
    offerCost,
    payback,
  };
}

/** Optional study context preserves legacy computations when absent. No clocks or network predictions are inferred. */
export function resolveFiscalStudy(
  place: Place,
  project: Pick<Project, "fiscalStudy">,
  scenario: Scenario,
): FiscalResolution {
  const study = project.fiscalStudy;
  const resolution: FiscalResolution = {
    methodVersion: FISCAL_METHOD_VERSION,
    scenarioId: scenario.id,
    scenarioRevision: scenario.revision,
    status: "unavailable",
    reviewState: "missing",
    profileHash: study?.profileHash ?? null,
    profileName: study?.profile.name ?? null,
    inputHash: fiscalResolutionInputHash(place, scenario, study),
    clock: null,
    deviations: [],
    base: null,
    cases: [],
    notes: [],
  };
  if (!study) {
    resolution.notes.push("No reviewed fiscal study profile is attached.");
    return resolution;
  }
  const probe = {
    schemaVersion: 12,
    fiscalStudy: study,
    scenarios: [
      {
        ...scenario,
        id: "baseline",
        assumptions: scenario.baselineAssumptions,
        fiscal: undefined,
      },
      scenario,
    ],
    history: [],
    undone: [],
  } as unknown as Project;
  if (fiscalProjectIssues(probe, place).length) {
    resolution.reviewState = "invalid";
    resolution.notes.push(
      "Fiscal study identity, source profile, baseline or sensitivity references do not match; results are withheld.",
    );
    return resolution;
  }
  const review = scenario.fiscal?.review;
  resolution.reviewState =
    scenario.id === "baseline"
      ? "current"
      : !review
        ? "missing"
        : review.inputHash === fiscalReviewInputHash(scenario) &&
            scenario.assumptions.fiscalInputsConfirmed
          ? "current"
          : "stale";
  resolution.deviations = FISCAL_COEFFICIENT_KEYS.filter(
    (k) => scenario.assumptions[k] !== study.profile.coefficients[k],
  ).map((key) => ({
    key,
    profileValue: study.profile.coefficients[key],
    currentValue: scenario.assumptions[key],
    kind: "authored-override",
  }));
  const firstYear = study.profile.fiscalYear + scenario.horizon;
  resolution.clock = {
    dollarYear: study.profile.dollarYear,
    baseFiscalYear: study.profile.fiscalYear,
    horizonYears: scenario.horizon,
    firstOperatingYear: firstYear,
    years: 20,
    valuation: "start-of-selected-horizon",
    currency: "USD",
    priceBasis: "constant-dollars",
    discountBasis: "real",
  };
  resolution.base = evaluateCase(place, scenario, firstYear, {
    id: "reference",
    name: "Reviewed inputs",
    description:
      "Current saved baseline and proposal assumptions; the incentive offer is evaluated separately.",
    baseline: {},
    proposal: {},
    sourceIds: study.profile.sources.map((s) => s.id),
  });
  resolution.cases = (scenario.fiscal?.cases ?? []).map((spec) =>
    evaluateCase(place, scenario, firstYear, spec),
  );
  resolution.status =
    resolution.reviewState !== "current"
      ? "stale"
      : [resolution.base, ...resolution.cases].some(
            (c) => c.status === "incomplete",
          )
        ? "incomplete"
        : "ready";
  resolution.notes = [
    "Jurisdiction applicability and coefficient compatibility are user reviews, not independent tax, legal or budget verification. ZCTA boundaries do not define taxing authority.",
    "Amounts are constant dollars. The valuation date is the start of the selected horizon; the grant occurs at time zero and recurring cash flows at each year end. The horizon advances the retained growth assumptions once; it does not add a construction or absorption schedule.",
    "Property value is held constant. Sales and operating costs use the entered common annual growth rate. Capital costs, development fees, assessment limitations and overlapping authorities are excluded unless separately modeled; this is an operating screening estimate.",
    "Average allocated service costs are not marginal cost predictions. Resident and workplace allocations must not count the same budget expense twice.",
    "Named sensitivity cases are paired authored alternatives, not statistical confidence intervals, optimized bounds or consultant validation. Each case retains both exact assumption sets.",
    "The source project and its history remain unchanged. This new study copied only the selected current proposal; project-owned native captures are imported evidence with their original numerical content and receipts retained.",
    ...(resolution.reviewState !== "current"
      ? [
          "Current fiscal inputs have not been reviewed against this study. Displayed draft calculations are not reviewed profile results.",
        ]
      : []),
    ...(resolution.deviations.length
      ? [
          "Current coefficient deviations are authored overrides. The original published/derived profile citations do not validate those changed values.",
        ]
      : []),
    ...study.profile.notes,
  ];
  return resolution;
}
