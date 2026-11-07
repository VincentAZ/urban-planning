# Census community context

The source vintage is explicitly **2024 ACS five-year estimates**, covering **2020–2024**. Census lists this as its latest available five-year release as verified on November 5, 2026; the official Summary Files were published January 29, 2026. A five-year estimate is not a 2026 count or forecast. ZCTAs approximate postal ZIP geography, and some postal ZIPs have no ZCTA.

## Reusable public download cache

Run from the repository root:

```bash
corepack pnpm exec tsx scripts/prepare-acs.ts
```

The script downloads six individual official files once, retains selected **whole-ZCTA** cells, and writes `public/data/acs-2024-zcta.json`. Intermediate table subsets are cached in `.local/cache/acs-2024/`; subsequent runs reuse them. Files are written by atomic rename. No national archive or per-visitor bulk download is used. The script caps transferred bytes at 250,000,000, checks complete lengths and required columns, and records each original file's SHA-256 and retrieval time.

The verified cache contains **33,772 ZCTAs**, is **5,194,827 bytes** before compression, and was prepared from **234,169,546 downloaded bytes**. This is national Census demographic coverage, not proof of national map, parcel, routing, or model completeness. Missing or suppressed cells remain missing or suppressed.

`enrichPlaceDemographics(place, signal)` reads this cache when no `CENSUS_API_KEY` is configured. If the optional Data Profiles API fails, it uses the validated cache with an explicit fallback note and Detailed Table dataset labels. `ACS_SUMMARY_PATH` can select another prepared cache. The server does not download bulk data in response to a visitor. Set a free Census API key only in the server environment to use the optional Data Profiles API adapter; keys are not retained in source records or sent to browsers. The Census data API now requires a key even though metadata and official Summary File downloads remain public.

## Measures and uncertainty

| Measure                     | Official Detailed Table cells         | Treatment                                                                               |
| --------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| Population                  | B01003, total 001                     | Published estimate and 90% MOE                                                          |
| Households                  | B11001, total 001                     | Published estimate and 90% MOE                                                          |
| Housing units               | B25001, total 001                     | Published estimate and 90% MOE, including vacant units                                  |
| Median household income     | B19013, total 001                     | Published estimate and 90% MOE in 2024 dollars; open-ended medians are not exact values |
| Poverty percentage          | C17002, (002 + 003) / 001             | Derived percentage among people with poverty status determined; approximate 90% MOE     |
| Bachelor's degree or higher | B15003, (022 + 023 + 024 + 025) / 001 | Derived percentage among people age 25+; approximate 90% MOE                            |

For derived proportions, sum numerator counts; combine component margins as `sqrt(sum(MOE²))`; let `P = numerator / denominator`. The percentage margin is `100 / denominator × sqrt(numeratorMOE² − P² × denominatorMOE²)`. If the radicand is negative, use the Census ratio fallback with addition. Missing component counts or a nonpositive denominator leave the percentage unavailable; missing margins leave its MOE unavailable. Approximation does not include covariance and can differ from the directly published Data Profile percentage margin.

The optional API adapter uses DP05_0001E, DP02_0001E, DP04_0001E, DP03_0062E, DP03_0128PE, and DP02_0068PE with their MOE and annotation fields. Its dataset is identified as `acs/acs5/profile`; the download cache is identified as `acs/acs5`. The interface labels derived margins as approximate and shows variables, universes, source period, retrieval date, and calculation guidance.

Numeric Census sentinel values are never used as observations. Raw values and annotations are preserved. A legitimate published zero remains zero. The controlled-MOE sentinel is specifically labeled and treated as zero only as permitted by Census guidance.

## Geographic/model boundary

`Place.geography = {type: 'zcta', code, boundaryVintage: '2020'}` is set only after retaining the exact authoritative study boundary. Demographics for any smaller or unmatched area are wider-area context: no spatial prorating occurs. Census housing totals do not overwrite building units, jobs, or `Place.population`.

For an exact matching ZCTA, fiscal service costs may anchor existing residents to the published population, then add/subtract residents from edited dwelling capacity under explicit occupancy/household-size assumptions. Population multipliers and forecast growth remain user scenarios. Census sampling uncertainty is disclosed but is **not propagated** into fiscal totals. Housing-supported residents remain a separate capacity measure. Neither source establishes taxing jurisdiction or validates local cost coefficients.

## Live cache verification

These values were read from the downloaded official tables; percentages below are rounded for display, with approximate derived margins.

| ZCTA  | Population     | Households  | Housing units | Median household income | Poverty        | Bachelor's or higher |
| ----- | -------------- | ----------- | ------------- | ----------------------- | -------------- | -------------------- |
| 85004 | 12,408 ± 1,173 | 6,444 ± 528 | 7,072 ± 571   | $73,750 ± $6,852        | 21.7% ± 5.3 pp | 60.6% ± 7.0 pp       |
| 60601 | 15,235 ± 1,530 | 9,631 ± 777 | 10,971 ± 677  | $121,458 ± $10,903      | 5.6% ± 2.6 pp  | 83.9% ± 6.7 pp       |

Tests cover sentinel semantics, geographic identity, exact-vintage requests, missing credentials, approximate MOE formulas, malformed caches, and separation from building-derived model quantities. They do not establish forecast accuracy.

References: [available ACS five-year API releases](https://www.census.gov/data/developers/data-sets/acs-5year.html), [official 2024 Summary Files](https://www.census.gov/programs-surveys/acs/data/summary-file.2024.html), [numeric values and annotations](https://www.census.gov/data/developers/data-sets/acs-1year/notes-on-acs-estimate-and-annotation-values.html), [Census handbook chapter 8, derived estimates and margins](https://www.census.gov/content/dam/Census/library/publications/2020/acs/acs_general_handbook_2020_ch08.pdf).

## Independent household vehicle supplement

`corepack pnpm exec tsx scripts/prepare-acs-vehicles.ts` prepares the optional B25046 supplement from the [official 2024 table file](https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b25046.dat). It uses `B25046_001E` and `B25046_001M` (Summary File columns `B25046_E001` and `B25046_M001`) directly: aggregate vehicles available to occupied housing units, with a 90% margin of error. The table is not a registered-vehicle fleet or a traffic count. Capped categories in B08201/B25044 are not summed into an invented total.

The public download is bounded at 25,000,000 bytes with length/column/duplicate checks and full-source SHA-256. The prepared source has 22,107,846 bytes and SHA-256 `5632fcf8bbfb62c1cd01adf8dd501cf127dc0a9d790797f7341bbc5e9e367b23`. Its separate 701,188-byte cache contains 29,673 ZCTA rows; missing ZCTAs are not filled with zeros. The 85004 estimate is 7,975 ± 793 vehicles; 60601 is 6,149 ± 963. These are 2020–2024 household survey estimates, not present-day observations.

Immutable preparation subsets live in `.local/cache/acs-vehicles-2024/`; the runtime reads `public/data/acs-vehicles-2024.json` or `ACS_VEHICLES_CACHE`, with a two-megabyte parsed-cache limit and at most four retained configured cache copies. The runtime never downloads this file for a visitor. New source captures may include optional `Place.vehicleAvailability`; existing baseline hashes are preserved. A saved project may explicitly adopt matching evidence in `Scenario.activity.vehicleReference` without altering its Place. The six-measure community profile contract remains unchanged.

Exact matching requires the same ZCTA identifier and 2020 boundary declaration. Smaller areas require an independently sourced entered reference; whole-ZCTA vehicle stock is not prorated into painted neighborhoods. Household vehicles kept at home include eligible cars, vans and light trucks, excluding motorcycles, recreational vehicles, immobile vehicles and business-only vehicles. The questionnaire includes a six-or-more category; the published aggregate remains a survey estimate. Raw sentinels and MOEs are retained, and published sampling uncertainty is not propagated through the planning sensitivity.

Definitions: [B25046 metadata](https://api.census.gov/data/2024/acs/acs5/groups/B25046.html), [2024 ACS subject definitions, vehicles available](https://www2.census.gov/programs-surveys/acs/tech_docs/subject_definitions/2024_ACSSubjectDefinitions.pdf), and [FHWA traffic monitoring definitions](https://www.fhwa.dot.gov/policyinformation/tmguide/tmg_2022/tmg-glossary.cfm). Household stock and AADT/daily trip ends are different quantities.
