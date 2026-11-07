# Fiscal studies and incentive comparisons

This document describes the fiscal-study contract. The [implementation status](IMPLEMENTATION_STATUS.md) records verified delivery and the remaining product gates. All fiscal tools follow the application's free-access policy; a profile library is organizational storage, not a paid feature.

## A reviewed baseline is a new study

A local profile records the jurisdiction, applicable geography, reference year, monetary basis, fiscal coefficients and their evidence. Applying one creates a new study from a selected proposal and its captured place. The original project, baseline, history and publications retain their original interpretation. The new study identifies its source project and scenario revision, retains the selected proposal's current planning edits, and begins its own history.

Profiles are immutable snapshots. Saving another library version does not change an existing study. A profile review records the user's review; it is neither external certification nor a statement that every input is observed. Changing a reviewed coefficient must make that review visibly out of date until reviewed again. Project-owned native evidence copied into another study cannot acquire new server authority merely by being copied.

## Evidence and coefficient meaning

Each fiscal coefficient distinguishes a published value, a derived value and an authored assumption, with source identifiers and an explanation of any derivation. No local tax rate or service-cost coefficient is automatically inferred from a ZIP code. A ZIP/ZCTA is a study geography, not a taxing authority.

- **Value and levy:** modeled taxable assessed value and the effective property-tax rate must use compatible bases. A statutory rate quoted per $100 of net assessed value cannot be applied directly to an unrelated market-value estimate. The retained rate represents the modeled jurisdiction's share, not an automatically combined overlapping levy.
- **Service costs:** per-resident and per-job coefficients need an explicit allocation basis. A budget divided by population describes average allocated cost, not the marginal cost of new development. Allocating the same expenditure pool twice would double count it.
- **Sales:** floor area, annual sales per square foot, capture share and the retained local sales-tax rate describe a planning assumption. They do not establish taxable sales observed at the site or causally new regional spending.
- **Monetary basis:** constant-dollar cash flows pair with a real discount rate. The reference dollar year, chosen rate and source belong in the saved study. The application does not prescribe a municipality's discount rate.

Arizona's property-tax documentation explains assessed-value ratios and rates per $100 of net assessed value; it is a reason to review valuation compatibility, not a source for a universal effective rate. [Arizona Department of Revenue](https://azdor.gov/sites/default/files/2023-03/PROPERTY_AZPropertyTaxation.pdf).

The federal OMB guidance distinguishes real/nominal rates and constant/current-dollar flows. This supports consistent units in the model; it does not make federal discount-rate policy binding on a local jurisdiction. [OMB Circular A-94](https://www.whitehouse.gov/wp-content/uploads/2023/11/CircularA-94.pdf).

## Cash-flow interpretation

Each comparison retains three alternatives: the frozen baseline, the proposal with the same development but without the offer, and the proposal with the offer. Removing an offer changes grant/abatement inputs only. It does **not** predict whether the development would occur without incentives.

The existing model holds assessed value constant over the cash-flow period. Annual growth applies to modeled sales and service-cost bases. Authored population/employment controls already apply at the scenario horizon and are not grown to that horizon a second time. Abatement applies only to positive added assessed value evaluated using the proposal's valuation assumptions; changing the tax rate or valuation profile does not make the original tax base eligible.

The upfront grant occurs at time zero. Recurring flows occur at each year end. First-year scorecard and per-acre amounts combine the upfront grant with the first year-end balance. The workbench shows them separately so the grant is counted only once. Legacy fiscal rows include the grant in the first row's net amount, but the NPV calculation leaves that grant undiscounted.

The scenario horizon moves the start of the modeled operating period. NPV discounts to the start of that period, **not automatically to today**. The comparison must state its horizon and discount clock. A 20-year total is the modeled total over that operating period, not necessarily the next 20 calendar years.

Incremental values subtract the corresponding baseline from the proposal. Incentive payback is the first year when cumulative modeled incremental net receipts cover the offer under the retained assumptions. A complete calculation that does not reach payback within the analysis period is a valid outcome, distinct from a calculation with missing quantities. Neither result establishes legal incentive eligibility, financing feasibility or causal inducement.

## Sensitivity cases

Named cases retain explicit baseline and proposal assumptions. Each case recalculates both sides and the offer/no-offer alternatives using the same captured geography and planning edits. A low/expected/high label describes the author's chosen scenario, not a guaranteed ordering of every metric.

Three calculated cases are not a probability distribution, confidence interval or exhaustive minimum/maximum. Missing inputs remain unknown; partial results do not become zeros. Comparisons retain exact assumptions, case descriptions and citations so another reviewer can reproduce the arithmetic.

GFOA recommends considering annual timing, net jurisdictional impacts, assumptions, uncertainty and limitations when evaluating development proposals. The workbench supports that review; a calculation alone does not satisfy the wider fiscal, legal and policy evaluation. [GFOA: Evaluating and Selecting Economic Development Projects](https://www.gfoa.org/materials/evaluating-and-selecting-economic-development-projects).

## Reproduction and delivery gates

Saved/public results and exports must bind the exact profile version, source records, study lineage, scenario revision, named cases and calculation version. Later library edits must not alter old results. Source display, analysis, export and public-redistribution permissions apply to fiscal evidence as they do to other evidence.

Acceptance requires independent arithmetic cases for grant timing, abatement terms, missing-versus-zero inputs, paired sensitivity and payback; unchanged legacy numeric replay; profile/history/source isolation; account/tenant permission checks; and a complete browser workflow through save, reopen, comparison and export. Native document and workbook output must preserve the same annual rows and evidence. Consultant comparison and professional validation remain separate general-launch gates.
