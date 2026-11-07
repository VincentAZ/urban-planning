import type { Assumptions, LandUse } from "@urban/core";

export interface EvidenceReference {
  sourceId: string;
  vintage: string;
  geography: string;
}
export interface EconomicMultipliers extends EvidenceReference {
  /** Type I and Type II total-employment multipliers per direct job, not final-demand multipliers. */
  typeIEmployment: number;
  typeIIEmployment: number;
  annualOutputPerDirectJob: number;
}
export interface RetailEvidence extends EvidenceReference {
  residentAnnualDemand: number;
  baselineAnnualSales: number;
  displacedLocalSalesFraction: number;
  annualSalesPerEstablishment: number;
}
export interface AccessEvidence extends EvidenceReference {
  /** Results supplied by a routing run tied to the respective scenario revision. */
  scenarioRevision: number;
  baselineJobs: {
    car: [number, number, number];
    transit?: [number, number, number];
    walk?: [number, number, number];
  };
  scenarioJobs: {
    car: [number, number, number];
    transit?: [number, number, number];
    walk?: [number, number, number];
  };
  baselineLowIncomeJobs30?: number;
  scenarioLowIncomeJobs30?: number;
  baselineNoCarTransitJobs30?: number;
  scenarioNoCarTransitJobs30?: number;
  serviceDate?: string;
}
export interface EnvironmentEvidence extends EvidenceReference {
  scenarioRevision: number;
  baselineCanopySqm?: number;
  scenarioCanopySqm?: number;
  stormDepthMm?: number;
  baselineCurveNumber?: number;
  scenarioCurveNumber?: number;
  baselineFloodExposedUnits?: number;
  scenarioFloodExposedUnits?: number;
  baselineHeatExposureIndex?: number;
  scenarioHeatExposureIndex?: number;
}
export interface SafetyEvidence extends EvidenceReference {
  scenarioRevision: number;
  baselineConflictPoints?: number;
  scenarioConflictPoints?: number;
  baselineHighInjuryTrips?: number;
  scenarioHighInjuryTrips?: number;
  baselineEmergencyCoveragePercent?: number;
  scenarioEmergencyCoveragePercent?: number;
}
export interface ParcelEvidence extends EvidenceReference {
  parcels: {
    id: string;
    areaSqm: number;
    maxFar?: number;
    maxHeight?: number;
    allowedUses?: LandUse[];
  }[];
}
export interface ModelEvidence {
  economicMultipliers?: EconomicMultipliers;
  retail?: RetailEvidence;
  access?: AccessEvidence;
  environment?: EnvironmentEvidence;
  safety?: SafetyEvidence;
  parcels?: ParcelEvidence;
  sensitivity?: {
    low: Partial<Assumptions>;
    high: Partial<Assumptions>;
    source: string;
    description: string;
  };
}
export interface KnownFiscalYear {
  year: number;
  propertyRevenue: number;
  salesRevenue: number;
  serviceCost: number;
  abatementCost: number;
  grantCost: number;
  netRevenue: number;
  discountedNet: number;
}

export type FiscalYear = {
  [K in keyof KnownFiscalYear]: K extends "year" | "grantCost"
    ? number
    : number | null;
};
