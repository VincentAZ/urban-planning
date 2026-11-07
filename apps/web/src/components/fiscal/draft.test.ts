import { describe, expect, it } from "vitest";
import { fiscalFixture } from "../../../../../packages/models/src/fiscal-fixture";
import {
  createFiscalProfileDraft,
  fiscalCaseDraft,
  readFiscalCases,
  readFiscalOffer,
  readFiscalProfileDraft,
} from "./draft";
const at = "2026-11-06T10:00:00.000Z";
describe("reviewed fiscal drafts", () => {
  it("does not turn private processing permission into download or public permission", () => {
    const f = fiscalFixture();
    f.profile.sources[0].rights = {
      version: 1,
      privateUse: true,
      cache: true,
      analyze: true,
      privateDisplay: true,
      historicalRetention: true,
      export: false,
      publicRedistribution: false,
      declaredBy: "Earlier reviewer",
      declaredAt: at,
    };
    const draft = createFiscalProfileDraft(f.scenario, f.profile);
    expect(draft.sources[0]).toMatchObject({
      privateUse: true,
      exportAllowed: false,
      publicRedistribution: false,
    });
    expect(
      readFiscalProfileDraft(draft, "Reviewer", at).sources[0].rights,
    ).toMatchObject({
      privateUse: true,
      export: false,
      publicRedistribution: false,
    });
    draft.sources[0].exportAllowed = true;
    expect(
      readFiscalProfileDraft(draft, "Reviewer", at).sources[0].rights,
    ).toMatchObject({ export: true, publicRedistribution: false });
    f.profile.sources[0].rights.cache = false;
    expect(
      createFiscalProfileDraft(f.scenario, f.profile).sources[0].privateUse,
    ).toBe(false);
  });
  it("preserves the exact retained coefficient when percentage display is unchanged", () => {
    const f = fiscalFixture();
    f.profile.coefficients.effectivePropertyTaxRate = 0.00002999970000299997;
    const draft = createFiscalProfileDraft(f.scenario, f.profile);
    draft.sources.forEach((source) => (source.privateUse = true));
    expect(
      readFiscalProfileDraft(draft, "Reviewer", at).coefficients
        .effectivePropertyTaxRate,
    ).toBe(f.profile.coefficients.effectivePropertyTaxRate);
    draft.coefficients.effectivePropertyTaxRate = "2";
    expect(
      readFiscalProfileDraft(draft, "Reviewer", at).coefficients
        .effectivePropertyTaxRate,
    ).toBe(0.02);
  });
  it("withholds a profile until every source has an explicit private-use declaration", () => {
    const f = fiscalFixture(),
      draft = createFiscalProfileDraft(f.scenario, f.profile);
    expect(() => readFiscalProfileDraft(draft, "Reviewer", at)).toThrow(
      /private use/,
    );
    draft.sources.forEach((source) => (source.privateUse = true));
    const value = readFiscalProfileDraft(draft, "Reviewer", at);
    expect(value.coefficients).toEqual(f.profile.coefficients);
    expect(value.sources[0].rights).toMatchObject({
      privateUse: true,
      historicalRetention: true,
      publicRedistribution: false,
      declaredBy: "Reviewer",
    });
    expect(f.profile.sources[0].rights).toBeUndefined();
  });
  it("rejects a blank hidden coefficient, invalid percentages and uncited derived values", () => {
    const f = fiscalFixture(),
      draft = createFiscalProfileDraft(f.scenario, f.profile);
    draft.sources.forEach((source) => (source.privateUse = true));
    draft.coefficients.discountRate = "";
    expect(() => readFiscalProfileDraft(draft, "Reviewer", at)).toThrow(
      /Blank is not zero/,
    );
    draft.coefficients.discountRate = "101";
    expect(() => readFiscalProfileDraft(draft, "Reviewer", at)).toThrow();
    draft.coefficients.discountRate = "10";
    draft.provenance.discountRate.kind = "derived";
    expect(() => readFiscalProfileDraft(draft, "Reviewer", at)).toThrow(
      /derivation/,
    );
  });
  it("retains explicit zero and distinguishes inherited case fields from invalid unfinished input", () => {
    expect(readFiscalOffer({ grant: "0", abatement: "0", years: "0" })).toEqual(
      { incentiveGrant: 0, abatementPercent: 0, abatementYears: 0 },
    );
    expect(() =>
      readFiscalOffer({ grant: "", abatement: "0", years: "0" }),
    ).toThrow();
    const draft = fiscalCaseDraft(undefined, "source");
    draft.name = "Zero growth";
    draft.description = "Explicit zero proposal growth, baseline inherited.";
    draft.proposal.annualGrowthRate = "0";
    expect(readFiscalCases([draft])[0]).toMatchObject({
      baseline: {},
      proposal: { annualGrowthRate: 0 },
    });
    draft.baseline.discountRate = "-";
    expect(() => readFiscalCases([draft])).toThrow();
  });
});
