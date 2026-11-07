import type {
  Assumptions,
  Building,
  LandUse,
  Place,
  Position,
  Project,
  Scenario,
} from "@urban/core";
import { landUseLabels, projectWithTrafficVersion } from "@urban/core";

export const MODEL_VERSION = "0.7.0";
export const SQFT_PER_SQM = 10.76391041671;
export const SQM_PER_ACRE = 4046.8564224;
export const METERS_PER_MILE = 1609.344;

/** Starter values are editable scenario assumptions, not local observations or licensed ITE rates. */
export function defaultAssumptions(): Assumptions {
  return {
    householdSize: 2.4,
    vacancyRate: 0.08,
    tripRates: {
      residential: 8,
      multifamily: 6,
      retail: 24,
      office: 10,
      industrial: 4,
      warehouse: 2,
      school: 12,
      healthcare: 16,
      civic: 8,
      "mixed-use": 6,
      park: 0,
      parking: 0,
      vacant: 0,
    },
    jobsPer1000Sqft: {
      residential: 0,
      multifamily: 0,
      retail: 2,
      office: 4,
      industrial: 1.5,
      warehouse: 0.5,
      school: 2,
      healthcare: 3,
      civic: 3,
      "mixed-use": 2,
      park: 0,
      parking: 0,
      vacant: 0,
    },
    parkingPerUnit: 1.25,
    parkingPer1000Sqft: 2.5,
    annualWage: 60000,
    assessedValuePerSqft: 200,
    effectivePropertyTaxRate: 0.01,
    annualServiceCostPerResident: 1200,
    annualServiceCostPerJob: 300,
    annualGrowthRate: 0.01,
    discountRate: 0.03,
    driveShare: 0.8,
    transitShare: 0.08,
    bikeShare: 0.04,
    walkShare: 0.08,
    populationMultiplier: 1,
    vehicleMultiplier: 1,
    incentiveGrant: 0,
    abatementPercent: 0,
    abatementYears: 0,
    salesPerSqft: 350,
    localSalesTaxRate: 0.02,
    retailCaptureRate: 0.5,
    emissionsKgPerMile: 0.4,
    averageTripMiles: 5,
    jurisdictionName: "Unconfigured jurisdiction",
    fiscalInputsConfirmed: false,
    tripRatesConfirmed: false,
  };
}

function id(prefix: string) {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

export function createScenario(name: string, parent?: Scenario): Scenario {
  const now = new Date().toISOString();
  const assumptions = parent
    ? structuredClone(parent.assumptions)
    : defaultAssumptions();
  return {
    id: id("scenario"),
    name,
    description: "",
    parentId: parent?.id ?? null,
    revision: 0,
    horizon: parent?.horizon ?? 0,
    createdAt: now,
    updatedAt: now,
    buildingEdits: structuredClone(parent?.buildingEdits ?? {}),
    roadEdits: structuredClone(parent?.roadEdits ?? {}),
    ...(parent?.parcelEdits !== undefined
      ? { parcelEdits: structuredClone(parent.parcelEdits) }
      : {}),
    assumptions,
    baselineAssumptions: structuredClone(
      parent?.baselineAssumptions ?? assumptions,
    ),
    sources: structuredClone(parent?.sources ?? []),
    ...(parent?.presentation !== undefined
      ? { presentation: structuredClone(parent.presentation) }
      : {}),
    ...(parent?.activity !== undefined
      ? { activity: structuredClone(parent.activity) }
      : {}),
    ...(parent?.retail !== undefined
      ? { retail: structuredClone(parent.retail) }
      : {}),
    ...(parent?.flood !== undefined
      ? { flood: structuredClone(parent.flood) }
      : {}),
    ...(parent?.accessibility !== undefined
      ? { accessibility: structuredClone(parent.accessibility) }
      : {}),
    ...(parent?.workforce !== undefined
      ? { workforce: structuredClone(parent.workforce) }
      : {}),
    ...(parent?.traffic !== undefined
      ? { traffic: structuredClone(parent.traffic) }
      : {}),
    ...(parent?.fiscal !== undefined
      ? { fiscal: structuredClone(parent.fiscal) }
      : {}),
  };
}

export function createProject(place: Place): Project {
  const baseline = createScenario("Baseline");
  baseline.id = "baseline";
  baseline.description = `Unedited source geometry for ${place.extentLabel}. Source vintage varies by layer.`;
  const option = createScenario("Option A", baseline);
  return projectWithTrafficVersion(
    {
      id: id("project"),
      name: `${place.name} · possibilities`,
      placeId: place.id,
      scenarios: [baseline, option],
      activeScenarioId: option.id,
      history: [],
      undone: [],
      updatedAt: new Date().toISOString(),
      schemaVersion: place.parcels !== undefined ? 2 : 1,
    },
    place,
  );
}

const presets: Record<
  LandUse,
  {
    width: number;
    depth: number;
    floors: number;
    units: number;
    jobs: number;
    parking: number;
  }
> = {
  residential: {
    width: 14,
    depth: 12,
    floors: 2,
    units: 1,
    jobs: 0,
    parking: 2,
  },
  multifamily: {
    width: 45,
    depth: 30,
    floors: 4,
    units: 48,
    jobs: 0,
    parking: 60,
  },
  retail: { width: 35, depth: 25, floors: 1, units: 0, jobs: 18, parking: 24 },
  office: {
    width: 40,
    depth: 30,
    floors: 5,
    units: 0,
    jobs: 250,
    parking: 100,
  },
  industrial: {
    width: 70,
    depth: 55,
    floors: 1,
    units: 0,
    jobs: 60,
    parking: 70,
  },
  warehouse: {
    width: 90,
    depth: 65,
    floors: 1,
    units: 0,
    jobs: 30,
    parking: 40,
  },
  school: { width: 65, depth: 45, floors: 2, units: 0, jobs: 100, parking: 70 },
  healthcare: {
    width: 50,
    depth: 40,
    floors: 4,
    units: 0,
    jobs: 250,
    parking: 150,
  },
  civic: { width: 35, depth: 30, floors: 2, units: 0, jobs: 65, parking: 45 },
  "mixed-use": {
    width: 45,
    depth: 30,
    floors: 5,
    units: 60,
    jobs: 30,
    parking: 90,
  },
  park: { width: 65, depth: 50, floors: 0, units: 0, jobs: 0, parking: 0 },
  parking: { width: 40, depth: 30, floors: 3, units: 0, jobs: 0, parking: 120 },
  vacant: { width: 35, depth: 25, floors: 0, units: 0, jobs: 0, parking: 0 },
};

export function buildingPreset(
  use: LandUse,
  center: Position,
): Building & { footprint: Position[]; geometry?: never } {
  const preset = presets[use];
  const longitudeMeters = 111320 * Math.cos((center[1] * Math.PI) / 180);
  const dx = preset.width / 2 / longitudeMeters;
  const dy = preset.depth / 2 / 111320;
  const footprint: Position[] = [
    [center[0] - dx, center[1] - dy],
    [center[0] + dx, center[1] - dy],
    [center[0] + dx, center[1] + dy],
    [center[0] - dx, center[1] + dy],
    [center[0] - dx, center[1] - dy],
  ];
  return {
    id: id("proposal"),
    name: `New ${landUseLabels[use].toLowerCase()}`,
    use,
    footprint,
    height:
      use === "park" || use === "vacant"
        ? 0
        : Math.max(
            preset.floors * 3.4,
            use === "warehouse" || use === "industrial" ? 9 : 3.4,
          ),
    floors: preset.floors,
    areaSqm: preset.width * preset.depth,
    units: preset.units,
    jobs: preset.jobs,
    parkingSpaces: preset.parking,
    sourceId: "user-proposal",
    estimated: true,
  };
}

export function formatMetric(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (unit === "%" || unit === "percent")
    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}%`;
  if (unit.startsWith("$") || unit === "USD")
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
      notation: Math.abs(value) >= 1000000 ? "compact" : "standard",
      ...(Math.abs(value) >= 1000000 ? { maximumFractionDigits: 1 } : {}),
    }).format(value);
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: [
      "ratio",
      "FAR",
      "acres",
      "units/acre",
      "years",
      "miles",
      "tCO₂e/year",
      "tCO₂/year",
      "minutes",
      "m²/person",
    ].includes(unit)
      ? 1
      : 0,
    notation: Math.abs(value) >= 1000000 ? "compact" : "standard",
  }).format(value);
}

/** Spherical ring area; input coordinates are WGS84 longitude/latitude. */
export function polygonAreaSqm(ring: Position[]): number {
  if (ring.length < 3) return 0;
  const radians = Math.PI / 180;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    let difference = (b[0] - a[0]) * radians;
    if (difference > Math.PI) difference -= 2 * Math.PI;
    if (difference < -Math.PI) difference += 2 * Math.PI;
    sum +=
      difference * (2 + Math.sin(a[1] * radians) + Math.sin(b[1] * radians));
  }
  return Math.abs((sum * 6371008.8 ** 2) / 2);
}

export function distanceMeters(a: Position, b: Position): number {
  const r = Math.PI / 180;
  const sinLat = Math.sin(((b[1] - a[1]) * r) / 2),
    sinLon = Math.sin(((b[0] - a[0]) * r) / 2);
  const h = sinLat ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * sinLon ** 2;
  return (
    6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
  );
}

export function lineLengthMeters(points: Position[]): number {
  return points
    .slice(1)
    .reduce(
      (sum, point, index) => sum + distanceMeters(points[index], point),
      0,
    );
}

export function validateAssumptions(a: Assumptions): string[] {
  const issues: string[] = [];
  for (const [key, value] of Object.entries(a)) {
    if (
      typeof value === "number" &&
      (!Number.isFinite(value) || (value < 0 && key !== "annualGrowthRate"))
    )
      issues.push(`${key} must be a finite nonnegative number.`);
  }
  if (a.annualGrowthRate <= -1)
    issues.push("annualGrowthRate must be greater than -1.");
  if (a.householdSize <= 0) issues.push("householdSize must be positive.");
  for (const key of [
    "vacancyRate",
    "driveShare",
    "transitShare",
    "bikeShare",
    "walkShare",
    "abatementPercent",
    "retailCaptureRate",
    "effectivePropertyTaxRate",
    "localSalesTaxRate",
  ] as const) {
    if (a[key] > 1)
      issues.push(`${key} is a fraction and must be between 0 and 1.`);
  }
  const modeTotal = a.driveShare + a.transitShare + a.bikeShare + a.walkShare;
  if (Math.abs(modeTotal - 1) > 0.000001)
    issues.push("Driving, transit, bike, and walk shares must sum to 1.");
  for (const category of ["tripRates", "jobsPer1000Sqft"] as const) {
    for (const use of Object.keys(landUseLabels) as LandUse[]) {
      if (!Number.isFinite(a[category]?.[use]) || a[category][use] < 0)
        issues.push(`${category}.${use} must be a finite nonnegative number.`);
    }
  }
  return issues;
}
