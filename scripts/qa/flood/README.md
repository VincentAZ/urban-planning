# Independent flood geometry audit

These tools check retained flood-source and model evidence. They are offline QA
tools, not production validators or a new source of FEMA authority. They do not
download data, repair geometry, alter packs, or change audit acceptance by a
distance or area tolerance.

## Small regression suite

Python 3 with its standard library is sufficient:

```sh
python3 scripts/qa/flood/flood-domain-certificate-test.py
python3 scripts/qa/flood/independent-ogr-audit-v2-uniqueness-test.py
```

An optional first argument saves a JSON test receipt to an existing output
directory. Otherwise the tests print results and do not write files. The first
suite has eight adversarial cases, including the retained 13-ULP intersection,
one-ULP incorrect coordinates, changed original segments, rewired boundaries,
extra components/holes and exact collinear subdivisions. The second executes
the auditor's actual uniqueness helper and rejects duplicate retained feature,
building-input and saved-ledger IDs before dictionaries can hide them.

`flood-domain-certificate.fixture.json` contains two retained Chicago geometric
examples and their original source identities. Its SHA256 is
`35a6e515bc237d346b4792915f81140dce9e5a705f47636cb7b644f3398278b3`.
These are regression inputs, not an independently authenticated flood map.

## Full source and model audit

The input directory must retain `pack.json`, `manifest.json`, and every
`raw/<sha256>.json` response listed in the manifest. The model input contains
`datasetHash` and all cases with their complete baseline/proposal building
inventories, scenarios, and `flood-footprint-1.1.0` results. Original version-1.0
artifacts are retained separately; this auditor does not rewrite or reinterpret
them as version 1.1.

Example with an existing local capture and an existing output directory:

```sh
docker run --rm --network none --cpus 1 --memory 512m \
  -v "$PWD:/workspace:ro" -w /workspace \
  ghcr.io/osgeo/gdal@sha256:44fee7d4f9be0966851d7b14a0a387216897d8347f9e0ebc4e812f7217bc39d6 \
  python3 scripts/qa/flood/independent-ogr-audit-v2.py \
  .local/flood/packs/60601-v2 \
  .local/qa/flood-performance/method-v2/60601/model.json \
  > .local/qa/flood-performance/60601-audit.json \
  2> .local/qa/flood-performance/60601-audit.log
```

The container has read-only repository access and no network. The host shell
writes the output. The pinned image used for the retained verification provides
GDAL 3.13.3 and GEOS 3.14.1; the receipt records actual runtime versions. Each
input file is capped at 128 MiB. Production packs have additional limits (8 MiB
and 50,000 normalized vertices); these QA tools assume retained inputs and are
not an untrusted-upload service. The container limits bound memory and CPU;
operators should also apply an execution deadline appropriate to their runner.

The full audit independently checks raw bytes, source IDs/attributes, capture
fences, canonical hashes, every normalized clip, all case/side building IDs,
footprint classifications, null/zero quantities, whole-building contributions,
diagnostic areas, totals and deltas. Version 1.1 first unions the retained
normalized source regions before footprint operations. GEOS results use exact
binary64 rational shoelace positivity; area diagnostics never decide counts or
completeness.

## Coordinate-domain certificate and limits

The production clipping dependency interprets JavaScript Number coordinates as
their canonical decimal strings, while GEOS interprets them as binary64 values.
The certificate computes original source/study segment intersections with exact
fractions in both domains. Differing vertices must be the correctly rounded
intersections of the same unique original segment pair, with the incident
source/study edges proved. Shared non-original vertices must also refer to the
same singleton pair in both domains. Complete ring cycles, components and hole
parents must agree. Only exact original collinear vertices may subdivide a
comparison edge, after an exact on-edge and between-endpoints proof in both
domains. No source coordinate is changed.

This certificate requires independent proof that Python's numeric formatting
reproduces the retained JavaScript canonical records. The full auditor checks
the pack's exact canonical bytes, study-area hash and all source-record fence
hashes before interpreting the certificate. A standalone `certify()` result
without those preconditions remains a geometric diagnostic. The certificate
does not establish real-world mapping accuracy, general exactness of finite
precision overlays, regulatory compliance or building/home-source completeness.

GEOS symmetric differences are retained as diagnostics, not used as a residual
acceptance threshold. Any raw-source self-intersection diagnosed outside the
study area remains an explicit warning; the local normalized clip must still be
valid and independently equivalent. No global raw-source validity is claimed.

The extracted certificate and full auditor initially preserve the reviewed QA
implementations exactly:

- Certificate SHA256: `6be807e9e499f8eb15c8891886ce39eb180d3c086118060024033ba805c0e18c`.
- Auditor SHA256: `b0bb5c34ac74f066608f40e1adb677638996fc157d4147469cf308749de9e72f`.

Each full receipt records its actual script, certificate, source and model
hashes. Re-run the audit when those inputs change; an old passing receipt cannot
attest to a newer implementation or model file.
