import {
  assertCommandFeatureIdentifiers,
  assertFeatureEditRecords,
} from "./identifiers";
import {
  assertBuildingProgram,
  type BuildingProgram,
  type BuildingTypology,
} from "./buildings";
import {
  assertScenarioPresentation,
  type ScenarioPresentation,
} from "./presentation";
export * from "./presentation";
import {
  assertActivityScenario,
  USER_ACTIVITY_SOURCE,
  type ActivityScenario,
} from "./activity";
export * from "./activity";
export * from "./activity-geometry";
import {
  assertRetailScenario,
  USER_RETAIL_SOURCE,
  type RetailScenario,
} from "./retail";
export * from "./retail";
export * from "./workforce";
export * from "./accessibility";
export * from "./accessibility-scenario";
export * from "./flood";
export * from "./fiscal";
export * from "./fiscal-serialization";
import {
  fiscalScenarioSchema,
  fiscalOfferSchema,
  type FiscalScenario,
  type FiscalStudy,
  type FiscalOffer,
} from "./fiscal";
import {
  floodReferenceSchema,
  type FloodReference,
  type FloodDatasetCatalog,
} from "./flood";
import {
  assertAccessibilityModeEvidence,
  type AccessibilityScenario,
  type AccessibilityModeEvidence,
} from "./accessibility-scenario";
import {
  assertWorkforceScenario,
  type WorkforceScenario,
} from "./workforce-scenario";
export * from "./workforce-scenario";
import {
  assertTrafficScenario,
  type TrafficScenario,
} from "./traffic-scenario";
export * from "./traffic-scenario";
export * from "./buildings";
export * from "./identifiers";
import { assertParcelCommandIdentifiers, type Parcel } from "./parcels";
export * from "./parcels";
import type {
  CommunityDemographics,
  VehicleAvailability,
} from "./demographics";
export * from "./demographics";
export * from "./collaboration";

export type LandUse =
  | "residential"
  | "multifamily"
  | "retail"
  | "office"
  | "industrial"
  | "warehouse"
  | "school"
  | "healthcare"
  | "civic"
  | "mixed-use"
  | "park"
  | "parking"
  | "vacant";
export type MetricDomain =
  | "Housing"
  | "Mobility"
  | "Economy"
  | "Fiscal"
  | "Land & form"
  | "Access & equity"
  | "Environment"
  | "Safety";
export type Position = [number, number];
export type Polygon = Position[];
export * from "./import-metadata";
export * from "./quantities";
export interface Source {
  id: string;
  name: string;
  url: string;
  vintage: string;
  license: string;
  kind: "observed" | "published-estimate" | "inferred" | "user-supplied";
  description?: string;
  import?: import("./import-metadata").SourceImportMetadata;
  rights?: import("./import-metadata").SourceRights;
}
export interface BuildingBase {
  id: string;
  name: string;
  use: LandUse;
  height: number | null;
  floors: number | null;
  areaSqm: number;
  units: number | null;
  jobs: number | null;
  parkingSpaces: number | null;
  sourceId: string;
  estimated: boolean;
  attributeSourceId?: string;
  attributeProvenance?: import("./import-metadata").BuildingAttributeProvenance;
  address?: string;
  parcelId?: string;
  zoning?: string;
  maxHeight?: number;
  maxFar?: number;
  rentMonthly?: number;
  assessedValue?: number;
  typology?: BuildingTypology;
  program?: BuildingProgram;
  geometrySourceId?: string;
  programSourceId?: string;
  sourceFeatureId?: string;
}
export type Building = BuildingBase &
  (
    | { footprint: Polygon; geometry?: never }
    | { geometry: import("./study-area").StudyAreaGeometry; footprint?: never }
  );
export interface Road {
  id: string;
  name: string;
  coordinates: Position[];
  lanes: number;
  speedMph: number;
  oneWay: boolean;
  kind: string;
  sourceId: string;
  estimated?: boolean;
  attributeSourceId?: string;
  /** Source of a user-authored centerline, separate from retained source attributes. */
  geometrySourceId?: string;
  closed?: boolean;
  bikeLane?: boolean;
  busLane?: boolean;
  signal?: boolean;
  cycleSeconds?: number;
  greenSplit?: number;
  aadt?: number;
}
export interface Place {
  id: string;
  name: string;
  city: string;
  state: string;
  zip: string;
  center: Position;
  bounds: [number, number, number, number];
  boundary: Polygon;
  /** Exact source geometry. Legacy boundary is used only when this is absent. */
  studyArea?: import("./study-area").StudyAreaGeometry;
  buildings: Building[];
  roads: Road[];
  parcels?: Parcel[];
  sources: Source[];
  population?: number;
  demographics?: CommunityDemographics;
  vehicleAvailability?: VehicleAvailability;
  /** Present only when the study boundary represents the exact authoritative geography. */
  geography?: { type: "zcta"; code: string; boundaryVintage: "2020" };
  coverage: {
    layer: string;
    status: "available" | "estimated" | "unavailable";
    description: string;
  }[];
  loadedAt: string;
  extentLabel: string;
}
export interface Assumptions {
  householdSize: number;
  vacancyRate: number;
  tripRates: Record<LandUse, number>;
  jobsPer1000Sqft: Record<LandUse, number>;
  parkingPerUnit: number;
  parkingPer1000Sqft: number;
  annualWage: number;
  assessedValuePerSqft: number;
  effectivePropertyTaxRate: number;
  annualServiceCostPerResident: number;
  annualServiceCostPerJob: number;
  annualGrowthRate: number;
  discountRate: number;
  driveShare: number;
  transitShare: number;
  bikeShare: number;
  walkShare: number;
  populationMultiplier: number;
  vehicleMultiplier: number;
  incentiveGrant: number;
  abatementPercent: number;
  abatementYears: number;
  salesPerSqft: number;
  localSalesTaxRate: number;
  retailCaptureRate: number;
  emissionsKgPerMile: number;
  averageTripMiles: number;
  jurisdictionName: string;
  fiscalInputsConfirmed: boolean;
  tripRatesConfirmed: boolean;
}
export interface Scenario {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
  revision: number;
  horizon: 0 | 5 | 10 | 20;
  createdAt: string;
  updatedAt: string;
  buildingEdits: Record<string, Building | null>;
  roadEdits: Record<string, Road | null>;
  parcelEdits?: Record<string, Parcel | null>;
  assumptions: Assumptions;
  baselineAssumptions: Assumptions;
  sources?: Source[];
  presentation?: ScenarioPresentation;
  activity?: ActivityScenario;
  retail?: RetailScenario;
  workforce?: WorkforceScenario;
  accessibility?: AccessibilityScenario;
  flood?: FloodReference;
  traffic?: TrafficScenario;
  fiscal?: FiscalScenario;
}
export type Command =
  | { type: "building.upsert"; building: Building; sources?: Source[] }
  | {
      type: "buildings.import";
      buildings: Building[];
      source: Source;
      mode?: "append" | "match";
    }
  | { type: "building.remove"; id: string }
  | { type: "road.upsert"; road: Road; source?: Source }
  | { type: "road.remove"; id: string }
  | { type: "parcel.upsert"; parcel: Parcel; source?: Source }
  | { type: "parcel.remove"; id: string }
  | {
      type: "parcels.replace";
      operation: "split" | "assemble";
      removeIds: string[];
      parcels: Parcel[];
      source: Source;
    }
  | {
      type: "parcels.import";
      parcels: Parcel[];
      source: Source;
      mode?: "append" | "match";
    }
  | { type: "assumptions.update"; patch: Partial<Assumptions> }
  | {
      type: "scenario.fiscal";
      fiscal: FiscalScenario | null;
      offer?: FiscalOffer;
    }
  | { type: "scenario.rename"; name: string }
  | { type: "scenario.details"; name: string; description: string }
  | { type: "scenario.presentation"; presentation: ScenarioPresentation | null }
  | {
      type: "scenario.activity";
      activity: ActivityScenario | null;
      sources?: Source[];
      horizon?: Scenario["horizon"];
    }
  | { type: "scenario.horizon"; horizon: Scenario["horizon"] }
  | { type: "scenario.restore" }
  | {
      type: "scenario.retail";
      retail: RetailScenario | null;
      sources?: Source[];
    }
  | { type: "scenario.workforce"; workforce: WorkforceScenario | null }
  | {
      type: "scenario.accessibility";
      mode: "car" | "walk";
      evidence: AccessibilityModeEvidence | null;
    }
  | { type: "scenario.traffic"; traffic: TrafficScenario | null }
  | { type: "scenario.flood"; flood: FloodReference | null };
export interface HistoryEntry {
  id: string;
  at: string;
  actor: string;
  label: string;
  command: Command;
  before: Scenario;
  after: Scenario;
  superseded?: boolean;
}
export interface Project {
  id: string;
  name: string;
  placeId: string;
  scenarios: Scenario[];
  activeScenarioId: string;
  history: HistoryEntry[];
  undone: HistoryEntry[];
  updatedAt: string;
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
  fiscalStudy?: FiscalStudy;
  floodDatasets?: FloodDatasetCatalog;
  baselineMigration?: {
    kind: "legacy-source-adoption";
    adoptedAt: string;
    message: string;
  };
}
export interface MetricResult {
  id: string;
  label: string;
  domain: MetricDomain;
  unit: string;
  baseline: number | null;
  value: number | null;
  delta: number | null;
  coverage?: {
    baseline: { knownSubtotal?: number | null; missingBuildingIds: string[] };
    scenario: { knownSubtotal?: number | null; missingBuildingIds: string[] };
  };
  low?: number;
  high?: number;
  status: "ready" | "incomplete" | "unavailable";
  explanation: string;
  formula: string;
  inputs: { name: string; value: string | number; source: string }[];
  sourceIds: string[];
  method: string;
  methodVersion: string;
  scenarioRevision: number;
  geography: string;
  caveat?: string;
  desirable?: "increase" | "decrease" | "neutral";
}
export interface ModelResults {
  scenarioId: string;
  revision: number;
  computedAt: string;
  metrics: MetricResult[];
  warnings: string[];
  modelVersion: string;
  fiscal?: import("./fiscal").FiscalResolution;
}
export const landUseLabels: Record<LandUse, string> = {
  residential: "Single-family",
  multifamily: "Apartments",
  retail: "Retail",
  office: "Office",
  industrial: "Industrial",
  warehouse: "Warehouse",
  school: "School",
  healthcare: "Healthcare",
  civic: "Civic",
  "mixed-use": "Mixed use",
  park: "Park",
  parking: "Parking",
  vacant: "Vacant",
};
export const landUseColors: Record<LandUse, [number, number, number]> = {
  residential: [223, 191, 150],
  multifamily: [217, 167, 119],
  retail: [197, 139, 115],
  office: [174, 193, 190],
  industrial: [168, 171, 163],
  warehouse: [174, 171, 160],
  school: [204, 172, 132],
  healthcare: [205, 184, 172],
  civic: [210, 193, 161],
  "mixed-use": [207, 151, 105],
  park: [128, 160, 117],
  parking: [180, 180, 166],
  vacant: [207, 208, 186],
};
export function materializeBuildings(
  place: Place,
  scenario: Scenario,
): Building[] {
  const byId = new Map(place.buildings.map((b) => [b.id, b]));
  for (const [id, value] of Object.entries(scenario.buildingEdits)) {
    if (value === null) byId.delete(id);
    else byId.set(id, value);
  }
  return [...byId.values()];
}
export function materializeRoads(place: Place, scenario: Scenario): Road[] {
  const byId = new Map(place.roads.map((r) => [r.id, r]));
  for (const [id, value] of Object.entries(scenario.roadEdits)) {
    if (value === null) byId.delete(id);
    else byId.set(id, value);
  }
  return [...byId.values()];
}
export function applyCommand(scenario: Scenario, command: Command): Scenario {
  if (command.type === "scenario.fiscal") {
    if (scenario.id === "baseline")
      throw new Error("The fiscal reference baseline is immutable.");
    if (command.fiscal !== null) fiscalScenarioSchema.parse(command.fiscal);
    if (command.offer !== undefined) fiscalOfferSchema.parse(command.offer);
  }
  if (command.type === "scenario.flood") {
    if (scenario.id === "baseline")
      throw new Error("The immutable baseline cannot adopt flood evidence.");
    if (command.flood !== null) floodReferenceSchema.parse(command.flood);
  }
  if (command.type === "scenario.accessibility") {
    if (scenario.id === "baseline")
      throw new Error(
        "The captured baseline cannot contain adopted accessibility evidence.",
      );
    if (command.evidence !== null) {
      assertAccessibilityModeEvidence(command.evidence);
      if (command.evidence.capture.request.mode !== command.mode)
        throw new Error("Accessibility mode must match its capture.");
    }
  }
  if (command.type === "scenario.traffic") {
    if (scenario.id === "baseline")
      throw new Error(
        "The captured baseline cannot contain an adopted traffic experiment.",
      );
    if (command.traffic !== null) assertTrafficScenario(command.traffic);
  }
  if (command.type === "scenario.workforce") {
    if (scenario.id === "baseline")
      throw new Error(
        "The captured baseline cannot contain adopted workforce evidence.",
      );
    if (command.workforce !== null) assertWorkforceScenario(command.workforce);
  }
  if (command.type === "scenario.retail") {
    if (scenario.id === "baseline")
      throw new Error(
        "The captured baseline cannot contain an authored retail analysis.",
      );
    if (command.retail !== null) assertRetailScenario(command.retail);
  }
  if (command.type === "scenario.activity") {
    if (scenario.id === "baseline")
      throw new Error(
        "The captured baseline cannot contain authored activity controls.",
      );
    if (command.activity !== null) assertActivityScenario(command.activity);
    if (
      command.horizon !== undefined &&
      ![0, 5, 10, 20].includes(command.horizon)
    )
      throw new Error("Choose a supported scenario horizon.");
  }
  if (command.type === "scenario.presentation") {
    if (scenario.id === "baseline")
      throw new Error(
        "The captured baseline cannot have an authored presentation. Create an editable scenario first.",
      );
    if (command.presentation !== null)
      assertScenarioPresentation(command.presentation);
  }
  assertParcelCommandIdentifiers(command);
  assertCommandFeatureIdentifiers(command);
  assertFeatureEditRecords(scenario);
  if (command.type === "building.upsert")
    assertBuildingProgram(command.building);
  if (command.type === "buildings.import")
    command.buildings.forEach(assertBuildingProgram);
  const result: Scenario = structuredClone(scenario);
  if (command.type === "building.upsert") {
    result.buildingEdits[command.building.id] = structuredClone(
      command.building,
    );
    if (command.sources)
      result.sources = [
        ...(result.sources ?? []).filter(
          (s) => !command.sources!.some((next) => next.id === s.id),
        ),
        ...structuredClone(command.sources),
      ];
  }
  if (command.type === "buildings.import") {
    for (const building of command.buildings)
      result.buildingEdits[building.id] = structuredClone(building);
    result.sources = [
      ...(result.sources ?? []).filter(
        (source) => source.id !== command.source.id,
      ),
      structuredClone(command.source),
    ];
  }
  if (command.type === "building.remove")
    result.buildingEdits[command.id] = null;
  if (command.type === "road.upsert") {
    result.roadEdits[command.road.id] = structuredClone(command.road);
    if (command.source)
      result.sources = [
        ...(result.sources ?? []).filter(
          (source) => source.id !== command.source!.id,
        ),
        structuredClone(command.source),
      ];
  }
  if (command.type === "road.remove") result.roadEdits[command.id] = null;
  if (
    command.type === "parcel.upsert" ||
    command.type === "parcel.remove" ||
    command.type === "parcels.replace" ||
    command.type === "parcels.import"
  ) {
    result.parcelEdits ??= {};
    if (command.type === "parcel.upsert")
      result.parcelEdits[command.parcel.id] = structuredClone(command.parcel);
    if (command.type === "parcel.remove") result.parcelEdits[command.id] = null;
    if (command.type === "parcels.replace")
      for (const id of command.removeIds) result.parcelEdits[id] = null;
    if (command.type === "parcels.replace" || command.type === "parcels.import")
      for (const parcel of command.parcels)
        result.parcelEdits[parcel.id] = structuredClone(parcel);
    if ("source" in command && command.source)
      result.sources = [
        ...(result.sources ?? []).filter((s) => s.id !== command.source!.id),
        structuredClone(command.source),
      ];
  }
  if (command.type === "assumptions.update")
    result.assumptions = { ...result.assumptions, ...command.patch };
  if (command.type === "scenario.fiscal") {
    if (command.fiscal === null) delete result.fiscal;
    else result.fiscal = structuredClone(command.fiscal);
    if (command.offer) Object.assign(result.assumptions, command.offer);
  }
  if (command.type === "scenario.rename") result.name = command.name;
  if (command.type === "scenario.details") {
    result.name = command.name;
    result.description = command.description;
  }
  if (command.type === "scenario.presentation") {
    if (command.presentation === null) delete result.presentation;
    else result.presentation = structuredClone(command.presentation);
  }
  if (command.type === "scenario.accessibility") {
    const captures = structuredClone(result.accessibility?.captures ?? {});
    if (command.evidence === null) delete captures[command.mode];
    else captures[command.mode] = structuredClone(command.evidence);
    if (Object.keys(captures).length)
      result.accessibility = { version: 1, captures };
    else delete result.accessibility;
  }
  if (command.type === "scenario.flood") {
    if (command.flood === null) delete result.flood;
    else result.flood = structuredClone(command.flood);
  }
  if (command.type === "scenario.workforce") {
    if (command.workforce === null) delete result.workforce;
    else result.workforce = structuredClone(command.workforce);
  }
  if (command.type === "scenario.traffic") {
    if (command.traffic === null) delete result.traffic;
    else result.traffic = structuredClone(command.traffic);
  }
  if (command.type === "scenario.retail") {
    if (command.retail === null) delete result.retail;
    else result.retail = structuredClone(command.retail);
    const sources = [
      ...(command.sources ?? []),
      ...(command.retail ? [USER_RETAIL_SOURCE] : []),
    ];
    if (sources.length) {
      const merged = new Map((result.sources ?? []).map((s) => [s.id, s]));
      for (const source of sources)
        merged.set(source.id, structuredClone(source));
      result.sources = [...merged.values()];
    }
  }
  if (command.type === "scenario.activity") {
    if (command.activity === null) delete result.activity;
    else result.activity = structuredClone(command.activity);
    const sources = [
      ...(command.sources ?? []),
      ...(command.activity
        ? [
            USER_ACTIVITY_SOURCE,
            ...(command.activity.vehicleReference
              ? [command.activity.vehicleReference.source]
              : []),
          ]
        : []),
    ];
    if (sources.length) {
      const merged = new Map((result.sources ?? []).map((s) => [s.id, s]));
      for (const source of sources)
        merged.set(source.id, structuredClone(source));
      result.sources = [...merged.values()];
    }
    if (command.horizon !== undefined) result.horizon = command.horizon;
  }
  if (command.type === "scenario.horizon") result.horizon = command.horizon;
  if (command.type === "scenario.restore") {
    result.buildingEdits = {};
    result.roadEdits = {};
    if (result.parcelEdits !== undefined) result.parcelEdits = {};
  }
  result.revision += 1;
  result.updatedAt = new Date().toISOString();
  return result;
}

export {
  baselineIdentity,
  canonicalJSON,
  validatePlace,
  validateProjectSnapshot,
} from "./snapshots";

export type { BaselineIdentity, ProjectSnapshot } from "./snapshots";

export type {
  BudgetDashboard,
  BudgetPolicy,
  BudgetPolicyUpdate,
  BudgetAdjustmentInput,
} from "./budget";

export {
  studyAreaGeometry,
  studyAreaFeature,
  studyAreaPolygons,
  studyAreaSqm,
  studyAreaBounds,
  studyAreaAnchor,
  pointInStudyArea,
  buildingWithinStudyArea,
  lineWithinStudyArea,
  clipLineToStudyArea,
  isValidStudyArea,
} from "./study-area";
export type {
  StudyAreaGeometry,
  StudyAreaInput,
  StudyAreaBounds,
} from "./study-area";

export type * from "./engagement";
export {
  validateRoadPath,
  validateRoadEdit,
  roadPreset,
  USER_ROAD_SOURCE,
  MAX_AUTHORED_ROAD_POINTS,
} from "./roads";
export type { RoadPathValidation } from "./roads";

export * from "./traffic";
export * from "./traffic-validation";

export * from "./traffic-csv";
export * from "./traffic-planning";
export * from "./traffic-signals";
export * from "./traffic-commute";
export * from "./traffic-commute-evidence";
export type * from "./budget";
export * from "./budget-outlook";
export type * from "./budget-records";
export * from "./media";
export * from "./media-timeline";
