import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJSON, trafficContentHash } from "@urban/core";
import { trafficCommuteEvidenceFixture } from "../../../../packages/models/src/traffic-commute-evidence-fixture";
import {
  readTrafficCommuteLedger,
  trafficCommuteLedgerCSV,
} from "./traffic-commute-ledger";

type Fixture = Awaited<ReturnType<typeof trafficCommuteEvidenceFixture>>;
function bundle(f: Fixture) {
  return {
    version: 1,
    manifest: { presetId: f.binding.presetId },
    sourcePack: f.sourcePack,
    prior: f.prior,
    routes: f.routes,
    compilation: f.compilation,
  };
}
function download(value: unknown) {
  const bytes = new TextEncoder().encode(canonicalJSON(value));
  return {
    bytes: bytes.buffer as ArrayBuffer,
    file: {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
async function read(f: Fixture) {
  const { bytes, file } = download(bundle(f));
  return readTrafficCommuteLedger(bytes, f.summary, file);
}
/** Parse the actual quoted export, including embedded quotes/newlines. */
function records(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && c === ",") {
      row.push(value);
      value = "";
    } else if (!quoted && c === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (!(c === "\r" && !quoted)) value += c;
  }
  const [headers, ...data] = rows;
  return data.map((values) =>
    Object.fromEntries(headers.map((key, i) => [key, values[i]])),
  );
}

describe("complete commute workbench accounting", () => {
  it("keeps source-cell destination residual separate from known-destination flow rows", async () => {
    const f = await trafficCommuteEvidenceFixture({
      changeRoutes(routes) {
        routes.attachments[1].status = "unmatched-local-network";
        routes.attachments[1].local = null;
        routes.attachments[1].notes = [
          "A permitted local connection is missing.",
        ];
      },
    });
    const before = canonicalJSON(f),
      view = await read(f);
    expect(view.rows).toHaveLength(4);
    expect(view.cells).toHaveLength(2);
    const flowMass = view.rows.reduce((n, row) => n + row.expectedVehicles, 0);
    const sourceResidual = view.cells.reduce(
      (n, cell) => n + (cell.unresolvedVehicles ?? 0),
      0,
    );
    expect(flowMass).toBe(24);
    expect(sourceResidual).toBe(6);
    expect(flowMass + sourceResidual).toBe(view.totals.sourceVehicles);
    expect(view.totals.sourceVehicles).toBe(30);
    expect(view.coverage.status).toBe("partial");
    expect(
      view.rows.filter((row) => row.routeStatus === "unmatched-local-network"),
    ).toEqual([
      expect.objectContaining({
        admittedExpectedVehicles: 0,
        roundedVehicles: 0,
        routeReason: "A permitted local connection is missing.",
        sourceRow: 3,
      }),
      expect.objectContaining({
        admittedExpectedVehicles: 0,
        roundedVehicles: 0,
        routeReason: "A permitted local connection is missing.",
        sourceRow: 3,
      }),
    ]);
    expect(canonicalJSON(f)).toBe(before);
  });

  it("exports every flow/bin including zero source quantities and positive contributions rounded to zero", async () => {
    const f = await trafficCommuteEvidenceFixture({
      changePack(pack) {
        pack.tracts[0].cells.B08132_022.estimate = {
          value: 1,
          raw: "1",
          annotation: null,
          status: "available",
        };
        pack.tracts[0].cells.B08132_023.estimate = {
          value: 0,
          raw: "0",
          annotation: null,
          status: "available",
        };
      },
    });
    const view = await read(f),
      rows = records(trafficCommuteLedgerCSV(view, "flows"));
    expect(rows).toHaveLength(f.compilation.ledger.length);
    expect(rows).toHaveLength(4);
    expect(
      view.rows.some(
        (row) => row.admittedExpectedVehicles > 0 && row.roundedVehicles === 0,
      ),
    ).toBe(true);
    expect(
      rows.filter((row) => row.source_expected_vehicles === "0"),
    ).toHaveLength(2);
    expect(
      rows.every(
        (row) => row.rounded_vehicles === "0" && row.demand_row_id === "",
      ),
    ).toBe(true);
    expect(rows.map((row) => row.flow_bin_id)).toEqual(
      view.rows.map((row) => row.id),
    );
    expect(rows[0]).toMatchObject({
      preset_id: f.binding.presetId,
      asset_sha256: f.binding.assetHash,
      compilation_sha256: f.binding.compilationHash,
      period_sha256: f.binding.periodHash,
      lodes_year: "2023",
      lodes_job_type: "JT01",
      acs_five_year_vintage: "2024",
      home_time_zone: "America/Phoenix",
      home_utc_offset_minutes: "-420",
      source_physical_row: "2",
    });
    expect(rows[0]).toHaveProperty("primary_jobs_do_not_sum_across_bins");
  });

  it("retains suppressed estimates and missing MOEs as null beside an explicit available zero", async () => {
    const f = await trafficCommuteEvidenceFixture({
      changePack(pack) {
        pack.tracts[0].cells.B08132_022.estimate = {
          value: null,
          raw: "-666666666",
          annotation: "**",
          status: "suppressed",
        };
        pack.tracts[0].cells.B08132_022.marginOfError = {
          value: null,
          raw: null,
          annotation: null,
          status: "missing",
        };
        pack.tracts[0].cells.B08132_023.estimate = {
          value: 0,
          raw: "0",
          annotation: null,
          status: "available",
        };
      },
    });
    const view = await read(f),
      cells = records(trafficCommuteLedgerCSV(view, "source-cells"));
    expect(view.totals.sourceVehicles).toBeNull();
    expect(view.totals.knownSourceVehicles).toBe(0);
    expect(view.rows).toHaveLength(2); // The unavailable cell has no invented zero-valued flows.
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({
      estimate_status: "suppressed",
      estimate_value: "",
      estimate_raw: "'-666666666",
      moe_status: "missing",
      moe_value: "",
      allocation_status: "unavailable",
      allocated_expected_vehicles: "",
      unresolved_expected_vehicles: "",
    });
    expect(cells[1]).toMatchObject({
      estimate_status: "available",
      estimate_value: "0",
      allocated_expected_vehicles: "0",
      unresolved_expected_vehicles: "0",
    });
    expect(cells[0]).toHaveProperty(
      "resident_primary_jobs_do_not_sum_across_bins",
    );
  });

  it("quotes multiline source diagnostics and neutralizes spreadsheet formulas without changing numeric negatives", async () => {
    const f = await trafficCommuteEvidenceFixture(),
      view = await read(f);
    view.rows[0].routeReason =
      ' =HYPERLINK("https://example.invalid")\nOriginal source note';
    const row = records(trafficCommuteLedgerCSV(view, "flows"))[0];
    expect(row.route_reason).toBe("'" + view.rows[0].routeReason);
    expect(row.rounding_delta).toBe(String(view.rows[0].roundingDelta));
    expect(row.local_utc_offset_minutes).toBe("-420");
  });

  it("rejects byte/size and selected-summary mismatch before showing partial records", async () => {
    const f = await trafficCommuteEvidenceFixture(),
      { bytes, file } = download(bundle(f));
    await expect(
      readTrafficCommuteLedger(bytes, f.summary, {
        ...file,
        bytes: file.bytes + 1,
      }),
    ).rejects.toThrow(/size|identity/);
    await expect(
      readTrafficCommuteLedger(bytes, f.summary, {
        ...file,
        sha256: "f".repeat(64),
      }),
    ).rejects.toThrow(/checksum/);
    const changed = structuredClone(f.summary);
    changed.binding.compilationHash = "f".repeat(64);
    await expect(
      readTrafficCommuteLedger(bytes, changed, file),
    ).rejects.toThrow(/identity/);
    const value = bundle(f);
    value.manifest.presetId = "another-preset";
    const renamed = download(value);
    await expect(
      readTrafficCommuteLedger(renamed.bytes, f.summary, renamed.file),
    ).rejects.toThrow(/preset/);
  });

  it.each([
    "missing-row",
    "duplicate-row",
    "wrong-flow-join",
    "null-quantity",
  ] as const)(
    "rejects coherently rehashed structural damage: %s",
    async (damage) => {
      const f = await trafficCommuteEvidenceFixture();
      if (damage === "missing-row") f.compilation.ledger.pop();
      if (damage === "duplicate-row")
        f.compilation.ledger.push(structuredClone(f.compilation.ledger[0]));
      if (damage === "wrong-flow-join")
        f.compilation.ledger[0].flowId = "flow-b";
      if (damage === "null-quantity")
        (
          f.compilation.ledger[0] as unknown as { expectedVehicles: null }
        ).expectedVehicles = null;
      f.summary.binding.compilationHash = await trafficContentHash(
        f.compilation,
      );
      const { bytes, file } = download(bundle(f));
      await expect(
        readTrafficCommuteLedger(bytes, f.summary, file),
      ).rejects.toThrow(/records|duplicate|join|quantity/);
    },
  );

  it("refuses a changed original source-cell value even when its prior hash is coherently updated", async () => {
    const f = await trafficCommuteEvidenceFixture();
    f.prior.cells[0].estimate.value! += 1;
    f.summary.binding.priorHash = await trafficContentHash(f.prior);
    f.routes.priorHash = f.summary.binding.priorHash;
    f.summary.binding.routesHash = await trafficContentHash(f.routes);
    f.compilation.priorHash = f.summary.binding.priorHash;
    f.compilation.routesHash = f.summary.binding.routesHash;
    f.summary.binding.compilationHash = await trafficContentHash(f.compilation);
    const { bytes, file } = download(bundle(f));
    await expect(
      readTrafficCommuteLedger(bytes, f.summary, file),
    ).rejects.toThrow(/original source estimate/);
  });
});
