import {
  floodDatasetCatalogSchema,
  floodReferenceSchema,
  floodReferences,
} from "./flood";
import {
  buildingAttributeProvenanceSchema,
  sourceImportMetadataSchema,
  sourceRightsSchema,
  projectHasImportExtensions,
} from "./import-metadata";
import {
  assertBuildingProgram,
  hasExtendedBuilding,
  type Building,
} from "./index";
import { isSafeFeatureIdentifier } from "./identifiers";
import { z } from "zod";
import {
  validateParcelGeometry,
  isSafeParcelIdentifier,
  MAX_SCENARIO_PARCELS,
} from "./parcels";
import { isValidStudyArea } from "./study-area";
import {
  communityDemographicsSchema,
  vehicleAvailabilitySchema,
} from "./demographics";
import { activityScenarioSchema } from "./activity";
import { retailScenarioSchema } from "./retail";
import {
  accessibilityScenarioSchema,
  accessibilityModeEvidenceSchema,
} from "./accessibility-scenario";
import { workforceScenarioSchema } from "./workforce-scenario";
import { trafficScenarioSchema } from "./traffic-scenario";
import {
  fiscalScenarioSchema,
  fiscalStudySchema,
  fiscalOfferSchema,
  fiscalProjectIssues,
} from "./fiscal";
import {
  housingAffordabilityScenarioSchema,
  housingIncomeLimitCatalogSchema,
  housingProjectIssues,
} from "./housing";
export {
  workforceScenarioSchema,
  workforceCaptureSchema,
  workforceCapturedCountSchema,
} from "./workforce-scenario";
export {
  retailScenarioSchema,
  retailCategorySchema,
  retailMeasureSchema,
} from "./retail";
export {
  activityScenarioSchema,
  countTargetSchema,
  activityReferenceChoiceSchema,
  activityForecastSchema,
  activityNeighborhoodSchema,
} from "./activity";
import { scenarioPresentationSchema } from "./presentation";
export {
  presentationCameraSchema,
  presentationStopSchema,
  scenarioPresentationSchema,
} from "./presentation";

const finite = z.number().finite();
const positive = finite.min(0);
const proportion = finite.min(0).max(1);
export const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
export const featureIdentifier = identifier.refine(
  isSafeFeatureIdentifier,
  "Feature identifiers cannot use reserved object-property names.",
);
export const parcelIdentifier = identifier.refine(
  isSafeParcelIdentifier,
  "Parcel identifiers cannot use reserved object-property names.",
);
const label = z.string().trim().min(1).max(240);
const timestamp = z.string().datetime();
export const position = z.tuple([
  finite.min(-180).max(180),
  finite.min(-90).max(90),
]);
export const polygon = z
  .array(position)
  .min(4)
  .max(10000)
  .refine(
    (p) => p[0][0] === p.at(-1)![0] && p[0][1] === p.at(-1)![1],
    "Polygon ring must be closed.",
  );
const landUse = z.enum([
  "residential",
  "multifamily",
  "retail",
  "office",
  "industrial",
  "warehouse",
  "school",
  "healthcare",
  "civic",
  "mixed-use",
  "park",
  "parking",
  "vacant",
]);
export const buildingRateSchema = z.object({
  value: positive.max(10000),
  basis: z.enum(["dwelling", "occupied-dwelling", "1000-sqft", "job", "bed"]),
  sourceId: identifier,
});
export const buildingProgramComponentSchema = z.object({
  id: featureIdentifier,
  name: label.optional(),
  use: landUse.exclude(["mixed-use", "park", "vacant"]),
  grossFloorAreaSqm: positive.max(1e10),
  units: positive.int().max(1e7),
  jobs: positive.max(1e8),
  beds: positive.int().max(1e7).optional(),
  residentialSubtype: z
    .enum(["single-family", "townhome", "apartment"])
    .optional(),
  tripRate: buildingRateSchema.optional(),
  parkingRate: buildingRateSchema.optional(),
  sourceId: identifier.optional(),
});
export const buildingProgramSchema = z.object({
  version: z.literal(1),
  grossFloorAreaSqm: positive.max(1e10),
  commonAreaSqm: positive.max(1e10),
  components: z.array(buildingProgramComponentSchema).max(64),
});
export const buildingSchema = z
  .object({
    id: featureIdentifier,
    name: label,
    use: landUse,
    footprint: polygon.optional(),
    geometry: z.lazy(() => parcelGeometrySchema).optional(),
    height: positive.max(1500).nullable(),
    floors: positive.int().max(250).nullable(),
    areaSqm: positive.max(1e9),
    units: positive.int().max(1e7).nullable(),
    jobs: positive.max(1e8).nullable(),
    parkingSpaces: positive.max(1e8).nullable(),
    sourceId: identifier,
    attributeSourceId: identifier.optional(),
    attributeProvenance: buildingAttributeProvenanceSchema.optional(),
    estimated: z.boolean(),
    address: z.string().max(500).optional(),
    parcelId: identifier.optional(),
    zoning: z.string().max(240).optional(),
    maxHeight: positive.optional(),
    maxFar: positive.optional(),
    rentMonthly: positive.optional(),
    assessedValue: positive.optional(),
    typology: z
      .enum([
        "house",
        "townhome",
        "apartments",
        "retail",
        "office",
        "industrial",
        "warehouse",
        "school",
        "hospital",
        "healthcare",
        "civic",
        "mixed-use",
        "park",
        "parking",
        "vacant",
      ])
      .optional(),
    program: buildingProgramSchema.optional(),
    geometrySourceId: identifier.optional(),
    programSourceId: identifier.optional(),
    sourceFeatureId: z.string().max(240).optional(),
  })
  .superRefine((building, context) => {
    if (
      (building.footprint === undefined) ===
      (building.geometry === undefined)
    )
      context.addIssue({
        code: "custom",
        message:
          "Use exactly one building geometry representation: legacy footprint or full geometry.",
      });
    try {
      assertBuildingProgram(building as Building);
    } catch (error) {
      context.addIssue({ code: "custom", message: (error as Error).message });
    }
  })
  .transform((building) => building as Building);
export const roadSchema = z.object({
  id: featureIdentifier,
  name: label,
  coordinates: z.array(position).min(2).max(10000),
  lanes: positive.int().min(1).max(20),
  speedMph: positive.max(150),
  oneWay: z.boolean(),
  kind: z.string().max(100),
  sourceId: identifier,
  closed: z.boolean().optional(),
  bikeLane: z.boolean().optional(),
  busLane: z.boolean().optional(),
  signal: z.boolean().optional(),
  cycleSeconds: positive.min(1).max(1000).optional(),
  greenSplit: proportion.optional(),
  aadt: positive.optional(),
  estimated: z.boolean().optional(),
  attributeSourceId: identifier.optional(),
  geometrySourceId: identifier.optional(),
});
export const assumptionShape = {
  householdSize: positive.min(0.1).max(30),
  vacancyRate: proportion,
  tripRates: z.record(landUse, positive.max(10000)),
  jobsPer1000Sqft: z.record(landUse, positive.max(10000)),
  parkingPerUnit: positive.max(100),
  parkingPer1000Sqft: positive.max(1000),
  annualWage: positive.max(1e9),
  assessedValuePerSqft: positive.max(1e7),
  effectivePropertyTaxRate: proportion,
  annualServiceCostPerResident: positive.max(1e7),
  annualServiceCostPerJob: positive.max(1e7),
  annualGrowthRate: finite.min(-0.99).max(1),
  discountRate: finite.min(0).max(1),
  driveShare: proportion,
  transitShare: proportion,
  bikeShare: proportion,
  walkShare: proportion,
  populationMultiplier: positive.max(100),
  vehicleMultiplier: positive.max(100),
  incentiveGrant: positive.max(1e12),
  abatementPercent: proportion,
  abatementYears: positive.int().max(100),
  salesPerSqft: positive.max(1e8),
  localSalesTaxRate: proportion,
  retailCaptureRate: proportion,
  emissionsKgPerMile: positive.max(100),
  averageTripMiles: positive.max(1000),
  jurisdictionName: z.string().max(240),
  fiscalInputsConfirmed: z.boolean(),
  tripRatesConfirmed: z.boolean(),
};
export const assumptionsSchema = z
  .object(assumptionShape)
  .refine(
    (a) =>
      Math.abs(a.driveShare + a.transitShare + a.bikeShare + a.walkShare - 1) <
      0.000001,
    "Travel mode shares must sum to 100%.",
  );
const fiscalNullable = z.number().finite().nullable();
const fiscalRowSchema = z
  .object({
    year: positive.int().max(20),
    fiscalYear: positive.int().nullable(),
    propertyRevenue: fiscalNullable,
    salesRevenue: fiscalNullable,
    serviceCost: fiscalNullable,
    abatementCost: fiscalNullable,
    grantCost: finite,
    netRevenue: fiscalNullable,
    discountedNet: fiscalNullable,
  })
  .strict();
const fiscalTrajectorySchema = z
  .object({
    rows: z.array(fiscalRowSchema).length(21),
    totals: z
      .object({
        propertyRevenue: fiscalNullable,
        salesRevenue: fiscalNullable,
        serviceCost: fiscalNullable,
        abatementCost: fiscalNullable,
        grantCost: finite,
        netRevenue: fiscalNullable,
        npv: fiscalNullable,
      })
      .strict(),
    missingBuildingIds: z.array(identifier).max(100000),
  })
  .strict();
const fiscalIncrementSchema = z
  .object({
    rows: z.array(fiscalRowSchema).length(21),
    netRevenue: fiscalNullable,
    npv: fiscalNullable,
  })
  .strict();
const fiscalCaseResultSchema = z
  .object({
    id: identifier,
    name: label,
    description: z.string().max(4000),
    sourceIds: z.array(identifier).max(100),
    status: z.enum(["ready", "incomplete"]),
    assumptions: z
      .object({ baseline: assumptionsSchema, proposal: assumptionsSchema })
      .strict(),
    baseline: fiscalTrajectorySchema,
    withoutOffer: fiscalTrajectorySchema,
    withOffer: fiscalTrajectorySchema,
    incremental: z
      .object({
        withoutOffer: fiscalIncrementSchema,
        withOffer: fiscalIncrementSchema,
      })
      .strict(),
    offerCost: z
      .object({ total: fiscalNullable, npv: fiscalNullable })
      .strict(),
    payback: z
      .object({
        status: z.enum(["not-needed", "reached", "not-reached", "unavailable"]),
        year: positive.int().max(20).nullable(),
      })
      .strict(),
  })
  .strict();
export const fiscalResolutionSchema: z.ZodType<
  import("./fiscal").FiscalResolution
> = z
  .object({
    methodVersion: z.literal("fiscal-study-1.0.0"),
    scenarioId: identifier,
    scenarioRevision: positive.int(),
    status: z.enum(["ready", "incomplete", "stale", "unavailable"]),
    reviewState: z.enum(["current", "stale", "missing", "invalid"]),
    profileHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    profileName: label.nullable(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
    clock: z
      .object({
        dollarYear: positive.int(),
        baseFiscalYear: positive.int(),
        horizonYears: positive.int(),
        firstOperatingYear: positive.int(),
        years: z.literal(20),
        valuation: z.literal("start-of-selected-horizon"),
        currency: z.literal("USD"),
        priceBasis: z.literal("constant-dollars"),
        discountBasis: z.literal("real"),
      })
      .strict()
      .nullable(),
    deviations: z
      .array(
        z
          .object({
            key: z.enum([
              "assessedValuePerSqft",
              "effectivePropertyTaxRate",
              "annualServiceCostPerResident",
              "annualServiceCostPerJob",
              "annualGrowthRate",
              "discountRate",
              "salesPerSqft",
              "localSalesTaxRate",
              "retailCaptureRate",
            ]),
            profileValue: finite,
            currentValue: finite,
            kind: z.literal("authored-override"),
          })
          .strict(),
      )
      .max(9),
    base: fiscalCaseResultSchema.nullable(),
    cases: z.array(fiscalCaseResultSchema).max(12),
    notes: z.array(z.string().max(4000)).max(200),
  })
  .strict();
export const sourceSchema = z
  .object({
    id: identifier,
    name: label,
    url: z.string().max(4000),
    vintage: z.string().max(100),
    license: z.string().max(2000),
    kind: z.enum([
      "observed",
      "published-estimate",
      "inferred",
      "user-supplied",
    ]),
    description: z.string().max(5000).optional(),
    import: sourceImportMetadataSchema.optional(),
    rights: sourceRightsSchema.optional(),
  })
  .superRefine((source, context) => {
    if (
      source.import &&
      (!source.rights ||
        ![
          source.rights.privateUse,
          source.rights.cache,
          source.rights.analyze,
          source.rights.privateDisplay,
          source.rights.export,
          source.rights.historicalRetention,
        ].every(Boolean))
    )
      context.addIssue({
        code: "custom",
        message:
          "Imported sources require explicit private storage, analysis, display, export and historical-retention permissions.",
      });
  });
export const parcelGeometrySchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("Polygon"),
      coordinates: z.array(polygon).min(1).max(128),
    }),
    z.object({
      type: z.literal("MultiPolygon"),
      coordinates: z.array(z.array(polygon).min(1).max(128)).min(1).max(128),
    }),
  ])
  .superRefine((geometry, context) => {
    const check = validateParcelGeometry(geometry);
    if (!check.valid)
      context.addIssue({ code: "custom", message: check.error! });
  });
export const parcelSchema = z.object({
  id: parcelIdentifier,
  name: label,
  kind: z.enum(["parcel", "block"]),
  geometry: parcelGeometrySchema,
  sourceId: identifier,
  geometrySourceId: identifier.optional(),
  sourceFeatureId: z.string().min(1).max(240).optional(),
  lineage: z
    .object({
      operation: z.enum(["draw", "reshape", "split", "assemble", "import"]),
      parentIds: z.array(parcelIdentifier).max(MAX_SCENARIO_PARCELS),
      sourceIds: z.array(identifier).max(5000),
    })
    .optional(),
});
const parcelEditsSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // Zod deliberately skips __proto__ during record parsing; reject it before that step.
      const prototype = Object.getPrototypeOf(value);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        Object.keys(value).some((key) => !isSafeParcelIdentifier(key))
      )
        context.addIssue({
          code: "custom",
          message:
            "Parcel edit keys must be ordinary feature IDs, not reserved object-property names.",
        });
    }
  })
  .pipe(z.record(parcelIdentifier, parcelSchema.nullable()));
function safeFeatureRecord<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .unknown()
    .superRefine((value, context) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const proto = Object.getPrototypeOf(value);
        if (
          (proto !== Object.prototype && proto !== null) ||
          Object.keys(value).some((id) => !isSafeFeatureIdentifier(id))
        )
          context.addIssue({
            code: "custom",
            message:
              "Feature edit keys cannot use reserved identifiers or a custom prototype.",
          });
      }
    })
    .pipe(z.record(featureIdentifier, valueSchema));
}
export const scenarioSchema = z.object({
  id: identifier,
  name: label,
  description: z.string().max(10000),
  parentId: identifier.nullable(),
  revision: positive.int(),
  horizon: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(20)]),
  createdAt: timestamp,
  updatedAt: timestamp,
  buildingEdits: safeFeatureRecord(buildingSchema.nullable()),
  roadEdits: safeFeatureRecord(roadSchema.nullable()),
  parcelEdits: parcelEditsSchema.optional(),
  assumptions: assumptionsSchema,
  baselineAssumptions: assumptionsSchema,
  sources: z.array(sourceSchema).max(5000).optional(),
  presentation: scenarioPresentationSchema.optional(),
  activity: activityScenarioSchema.optional(),
  retail: retailScenarioSchema.optional(),
  workforce: workforceScenarioSchema.optional(),
  accessibility: accessibilityScenarioSchema.optional(),
  flood: floodReferenceSchema.optional(),
  traffic: trafficScenarioSchema.optional(),
  fiscal: fiscalScenarioSchema.optional(),
  affordability: housingAffordabilityScenarioSchema.optional(),
});
export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("scenario.affordability"),
      affordability: housingAffordabilityScenarioSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scenario.fiscal"),
      fiscal: fiscalScenarioSchema.nullable(),
      offer: fiscalOfferSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scenario.flood"),
      flood: floodReferenceSchema.nullable(),
    })
    .strict(),
  z.object({
    type: z.literal("scenario.traffic"),
    traffic: trafficScenarioSchema.nullable(),
  }),
  z.object({
    type: z.literal("scenario.accessibility"),
    mode: z.enum(["car", "walk"]),
    evidence: accessibilityModeEvidenceSchema.nullable(),
  }),
  z.object({
    type: z.literal("scenario.workforce"),
    workforce: workforceScenarioSchema.nullable(),
  }),
  z.object({
    type: z.literal("scenario.retail"),
    retail: retailScenarioSchema.nullable(),
    sources: z.array(sourceSchema).max(256).optional(),
  }),
  z.object({
    type: z.literal("buildings.import"),
    mode: z.enum(["append", "match"]).optional(),
    buildings: z.array(buildingSchema).min(1).max(5000),
    source: sourceSchema,
  }),
  z.object({
    type: z.literal("building.upsert"),
    building: buildingSchema,
    sources: z.array(sourceSchema).max(100).optional(),
  }),
  z.object({ type: z.literal("building.remove"), id: featureIdentifier }),
  z.object({
    type: z.literal("road.upsert"),
    road: roadSchema,
    source: sourceSchema.optional(),
  }),
  z.object({ type: z.literal("road.remove"), id: featureIdentifier }),
  z.object({
    type: z.literal("parcel.upsert"),
    parcel: parcelSchema,
    source: sourceSchema.optional(),
  }),
  z.object({ type: z.literal("parcel.remove"), id: parcelIdentifier }),
  z.object({
    type: z.literal("parcels.replace"),
    operation: z.enum(["split", "assemble"]),
    removeIds: z.array(parcelIdentifier).min(1).max(100),
    parcels: z.array(parcelSchema).min(1).max(100),
    source: sourceSchema,
  }),
  z.object({
    type: z.literal("parcels.import"),
    mode: z.enum(["append", "match"]).optional(),
    parcels: z.array(parcelSchema).min(1).max(MAX_SCENARIO_PARCELS),
    source: sourceSchema,
  }),
  z.object({
    type: z.literal("assumptions.update"),
    patch: z.object(assumptionShape).partial(),
  }),
  z.object({ type: z.literal("scenario.rename"), name: label }),
  z.object({
    type: z.literal("scenario.presentation"),
    presentation: scenarioPresentationSchema.nullable(),
  }),
  z.object({
    type: z.literal("scenario.activity"),
    activity: activityScenarioSchema.nullable(),
    sources: z.array(sourceSchema).max(100).optional(),
    horizon: z
      .union([z.literal(0), z.literal(5), z.literal(10), z.literal(20)])
      .optional(),
  }),
  z.object({
    type: z.literal("scenario.details"),
    name: label,
    description: z.string().max(10000),
  }),
  z.object({
    type: z.literal("scenario.horizon"),
    horizon: z.union([
      z.literal(0),
      z.literal(5),
      z.literal(10),
      z.literal(20),
    ]),
  }),
  z.object({ type: z.literal("scenario.restore") }),
]);
const historySchema = z.object({
  id: identifier,
  at: timestamp,
  actor: z.string().max(240),
  label: z.string().max(500),
  command: commandSchema,
  before: scenarioSchema,
  after: scenarioSchema,
  superseded: z.boolean().optional(),
});
export const projectSchema = z
  .object({
    id: identifier,
    name: label,
    placeId: identifier,
    scenarios: z.array(scenarioSchema).min(1).max(100),
    activeScenarioId: identifier,
    history: z.array(historySchema).max(100000),
    undone: z.array(historySchema).max(100000),
    updatedAt: timestamp,
    schemaVersion: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
      z.literal(8),
      z.literal(9),
      z.literal(10),
      z.literal(11),
      z.literal(12),
      z.literal(13),
    ]),
    floodDatasets: floodDatasetCatalogSchema.optional(),
    fiscalStudy: fiscalStudySchema.optional(),
    housingIncomeLimits: housingIncomeLimitCatalogSchema.optional(),
    baselineMigration: z
      .object({
        kind: z.literal("legacy-source-adoption"),
        adoptedAt: timestamp,
        message: z.string().min(1).max(2000),
      })
      .optional(),
  })
  .superRefine((project, context) => {
    for (const message of housingProjectIssues(
      project as import("./index").Project,
    ))
      context.addIssue({ code: "custom", message });
    for (const message of fiscalProjectIssues(
      project as import("./index").Project,
    ))
      context.addIssue({ code: "custom", message });
    const floodRefs = floodReferences(project as import("./index").Project);
    if (
      project.schemaVersion < 11 &&
      (project.floodDatasets !== undefined ||
        floodRefs.length ||
        [...project.history, ...project.undone].some(
          (e) => e.command.type === "scenario.flood",
        ))
    )
      context.addIssue({
        code: "custom",
        message: "Flood datasets require project format 11.",
      });
    if (
      floodRefs.some(
        (r) => !Object.hasOwn(project.floodDatasets ?? {}, r.datasetHash),
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Every current/historical flood reference needs its complete retained dataset.",
      });
    if (
      project.schemaVersion < 8 &&
      projectHasImportExtensions(project as import("./index").Project)
    )
      context.addIssue({
        code: "custom",
        message:
          "Nullable quantities and import provenance require project format 8.",
      });
    const parcelSnapshots = [
      ...project.scenarios,
      ...project.history.flatMap((e) => [e.before, e.after]),
      ...project.undone.flatMap((e) => [e.before, e.after]),
    ];
    if (
      project.schemaVersion < 10 &&
      (parcelSnapshots.some((s) => s.accessibility !== undefined) ||
        [...project.history, ...project.undone].some(
          (e) => e.command.type === "scenario.accessibility",
        ))
    )
      context.addIssue({
        code: "custom",
        message:
          "Saved accessibility evidence requires project schema version 10.",
      });
    if (
      project.schemaVersion < 9 &&
      (parcelSnapshots.some((s) => s.traffic !== undefined) ||
        [...project.history, ...project.undone].some(
          (e) => e.command.type === "scenario.traffic",
        ))
    )
      context.addIssue({
        code: "custom",
        message: "Saved traffic experiments require project schema version 9.",
      });
    if (
      project.schemaVersion < 7 &&
      (parcelSnapshots.some((s) => s.workforce !== undefined) ||
        [...project.history, ...project.undone].some(
          (e) => e.command.type === "scenario.workforce",
        ))
    )
      context.addIssue({
        code: "custom",
        message: "Saved workforce evidence requires project schema version 7.",
      });
    if (
      project.schemaVersion < 6 &&
      (parcelSnapshots.some((s) => s.retail !== undefined) ||
        [...project.history, ...project.undone].some(
          (e) => e.command.type === "scenario.retail",
        ))
    )
      context.addIssue({
        code: "custom",
        message: "Retail analysis requires project schema version 6.",
      });
    if (
      project.schemaVersion < 5 &&
      (parcelSnapshots.some((s) => s.activity !== undefined) ||
        [...project.history, ...project.undone].some(
          (e) => e.command.type === "scenario.activity",
        ))
    )
      context.addIssue({
        code: "custom",
        message: "Activity controls require project schema version 5.",
      });
    if (
      project.schemaVersion < 4 &&
      (parcelSnapshots.some(
        (scenario) => scenario.presentation !== undefined,
      ) ||
        [...project.history, ...project.undone].some(
          (entry) => entry.command.type === "scenario.presentation",
        ))
    )
      context.addIssue({
        code: "custom",
        message: "Saved presentations require project schema version 4.",
      });
    if (
      project.schemaVersion < 3 &&
      (parcelSnapshots.some((s) =>
        Object.values(s.buildingEdits).some(
          (b) => b && hasExtendedBuilding(b as Building),
        ),
      ) ||
        [...project.history, ...project.undone].some((e) =>
          e.command.type === "building.upsert"
            ? hasExtendedBuilding(e.command.building as Building)
            : e.command.type === "buildings.import" &&
              e.command.buildings.some((b) =>
                hasExtendedBuilding(b as Building),
              ),
        ))
    )
      context.addIssue({
        code: "custom",
        message: "Extended buildings require project schema version 3.",
      });
    if (
      project.schemaVersion === 1 &&
      (parcelSnapshots.some((s) => s.parcelEdits !== undefined) ||
        [...project.history, ...project.undone].some(
          (e) =>
            e.command.type.startsWith("parcel.") ||
            e.command.type.startsWith("parcels."),
        ))
    )
      context.addIssue({
        code: "custom",
        message:
          "Parcel-bearing projects require schema version 2 so older clients cannot discard their geometry.",
      });
    if (
      new Set(project.scenarios.map((s) => s.id)).size !==
      project.scenarios.length
    )
      context.addIssue({
        code: "custom",
        message: "Scenario identifiers must be unique.",
      });
    if (!project.scenarios.some((s) => s.id === project.activeScenarioId))
      context.addIssue({
        code: "custom",
        message: "Active scenario does not exist.",
      });
    const baseline = project.scenarios.find((s) => s.id === "baseline");
    if (
      !baseline ||
      Object.keys(baseline.buildingEdits).length ||
      Object.keys(baseline.roadEdits).length ||
      Object.keys(baseline.parcelEdits ?? {}).length ||
      baseline.presentation !== undefined ||
      baseline.activity !== undefined ||
      baseline.retail !== undefined ||
      baseline.workforce !== undefined ||
      baseline.accessibility !== undefined ||
      baseline.traffic !== undefined ||
      baseline.fiscal !== undefined ||
      baseline.affordability !== undefined
    )
      context.addIssue({
        code: "custom",
        message: "An untouched baseline scenario is required.",
      });
    if (
      baseline &&
      (baseline.parentId !== null ||
        baseline.horizon !== 0 ||
        baseline.revision !== 0)
    )
      context.addIssue({
        code: "custom",
        message:
          "The baseline must remain the original current-conditions scenario.",
      });
    for (const entry of [...project.history, ...project.undone])
      if (
        entry.before.id !== entry.after.id ||
        entry.after.id === "baseline" ||
        !project.scenarios.some((s) => s.id === entry.after.id)
      )
        context.addIssue({
          code: "custom",
          message:
            "History must reference an editable scenario in this project.",
        });
    if (baseline)
      for (const entry of [...project.history, ...project.undone])
        for (const snapshot of [entry.before, entry.after])
          if (
            JSON.stringify(snapshot.baselineAssumptions) !==
            JSON.stringify(baseline.assumptions)
          )
            context.addIssue({
              code: "custom",
              message:
                "Historical edits must preserve the frozen baseline assumptions.",
            });
    for (const scenario of project.scenarios) {
      if (
        baseline &&
        JSON.stringify(scenario.baselineAssumptions) !==
          JSON.stringify(baseline.assumptions)
      )
        context.addIssue({
          code: "custom",
          message:
            "All scenarios must preserve the same frozen baseline assumptions.",
        });
      if (
        scenario.parentId !== null &&
        !project.scenarios.some((s) => s.id === scenario.parentId)
      )
        context.addIssue({
          code: "custom",
          message: "Scenario parent does not exist in this project.",
        });
      const visited = new Set<string>();
      let current: typeof scenario | undefined = scenario;
      while (current) {
        if (visited.has(current.id)) {
          context.addIssue({
            code: "custom",
            message: "Scenario ancestry cannot contain a cycle.",
          });
          break;
        }
        visited.add(current.id);
        current =
          current.parentId === null
            ? undefined
            : project.scenarios.find((s) => s.id === current!.parentId);
      }
      for (const [id, building] of Object.entries(scenario.buildingEdits))
        if (building && id !== building.id)
          context.addIssue({
            code: "custom",
            message: "Building edit key must match identifier.",
          });
      for (const [id, parcel] of Object.entries(scenario.parcelEdits ?? {}))
        if (parcel && parcel.id !== id)
          context.addIssue({
            code: "custom",
            message: "Parcel edit key must match identifier.",
          });
      for (const [id, road] of Object.entries(scenario.roadEdits))
        if (road && id !== road.id)
          context.addIssue({
            code: "custom",
            message: "Road edit key must match identifier.",
          });
    }
  });
export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(256),
  name: label,
});
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});

const studyRing = z
  .array(position)
  .min(4)
  .max(500000)
  .refine(
    (ring) => ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1],
    "Study-area rings must be closed.",
  );
export const studyAreaSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("Polygon"),
      coordinates: z.array(studyRing).min(1).max(10000),
    }),
    z.object({
      type: z.literal("MultiPolygon"),
      coordinates: z
        .array(z.array(studyRing).min(1).max(10000))
        .min(1)
        .max(10000),
    }),
  ])
  .superRefine((geometry, context) => {
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;
    if (
      polygons.reduce(
        (sum, rings) => sum + rings.reduce((n, ring) => n + ring.length, 0),
        0,
      ) > 2000000
    )
      context.addIssue({
        code: "custom",
        message: "The study area exceeds the supported vertex budget.",
      });
    else if (!isValidStudyArea(geometry))
      context.addIssue({
        code: "custom",
        message: "The study area has invalid polygon topology.",
      });
  });

export const placeSchema = z
  .object({
    id: identifier,
    name: label,
    city: label,
    state: label,
    zip: z.string().max(30),
    center: position,
    bounds: z.tuple([
      finite.min(-180).max(180),
      finite.min(-90).max(90),
      finite.min(-180).max(180),
      finite.min(-90).max(90),
    ]),
    boundary: studyRing,
    studyArea: studyAreaSchema.optional(),
    buildings: z.array(buildingSchema).max(500000),
    roads: z.array(roadSchema).max(1000000),
    parcels: z.array(parcelSchema).max(MAX_SCENARIO_PARCELS).optional(),
    sources: z.array(sourceSchema).max(5000),
    population: positive.optional(),
    demographics: communityDemographicsSchema.optional(),
    vehicleAvailability: vehicleAvailabilitySchema.optional(),
    geography: z
      .object({
        type: z.literal("zcta"),
        code: z.string().regex(/^\d{5}$/),
        boundaryVintage: z.literal("2020"),
      })
      .optional(),
    loadedAt: z.string().min(1).max(100),
    extentLabel: z.string().min(1).max(1000),
    coverage: z
      .array(
        z.object({
          layer: z.string().max(240),
          status: z.enum(["available", "estimated", "unavailable"]),
          description: z.string().max(5000),
        }),
      )
      .max(1000),
  })
  .superRefine((place, context) => {
    if (
      place.bounds[0] >= place.bounds[2] ||
      place.bounds[1] >= place.bounds[3]
    )
      context.addIssue({
        code: "custom",
        message: "The snapshot bounds are invalid.",
      });
    for (const features of [place.buildings, place.roads, place.parcels ?? []])
      if (new Set(features.map((f) => f.id)).size !== features.length)
        context.addIssue({
          code: "custom",
          message:
            "Snapshot feature identifiers must be unique within a layer.",
        });
  });
