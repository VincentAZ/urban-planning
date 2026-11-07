import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readWorkforceAcsSummary,
  workforceAcsCells,
  workforceAcsColumns,
  type WorkforceAcsTable,
} from "./workforce-acs";

const geoid = "040130001001";
function fixture(
  table: WorkforceAcsTable = "B15003",
  values?: string[],
  ids = [geoid],
) {
  const columns = workforceAcsColumns(table);
  const row = values ?? columns.map((_, i) => (i % 2 ? "5" : "10"));
  return (
    [
      `GEO_ID|${columns.join("|")}`,
      ...ids.map((id) => `1500000US${id}|${row.join("|")}`),
    ].join("\n") + "\n"
  );
}
async function* chunks(text: string, width = 17) {
  const buffer = Buffer.from(text);
  for (let i = 0; i < buffer.length; i += width)
    yield buffer.subarray(i, i + width);
}

describe("official ACS workforce table ingestion", () => {
  it("retains complete native BG records, exact raw-byte hashes and explicit zeros across streamed boundaries", async () => {
    const values = workforceAcsColumns("B15003").map(() => "0");
    const text = fixture("B15003", values, [geoid, "170310001001"]);
    const result = await readWorkforceAcsSummary(
      chunks(text, 1),
      "B15003",
      "04",
      { retrievedAt: "2026-11-06T00:00:00Z" },
    );
    expect(Object.keys(result.rows)).toEqual([geoid]);
    expect(result.source.sha256).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(result.source.bytes).toBe(Buffer.byteLength(text));
    expect(Object.keys(workforceAcsCells(result, geoid))).toHaveLength(25);
    expect(workforceAcsCells(result, geoid).B15003_001.estimate).toEqual({
      value: 0,
      status: "available",
      raw: "0",
      annotation: null,
    });
    expect(result.rows[geoid]).toEqual(values);
  });

  it("retains suppression, missing estimates, controlled MOEs and other official jam statuses", async () => {
    const values = workforceAcsColumns("C24010").map(() => "0");
    values[0] = "-999999999";
    values[1] = "-555555555";
    values[2] = "";
    values[3] = "-222222222";
    values[4] = "-888888888";
    values[5] = "-333333333";
    values[6] = "-666666666";
    const result = await readWorkforceAcsSummary(
      chunks(fixture("C24010", values)),
      "C24010",
      "04",
    );
    const cells = workforceAcsCells(result, geoid);
    expect(Object.keys(cells)).toHaveLength(73);
    expect(cells.C24010_001.estimate).toMatchObject({
      value: null,
      status: "suppressed",
      raw: "-999999999",
    });
    expect(cells.C24010_001.marginOfError).toMatchObject({
      value: 0,
      status: "controlled",
    });
    expect(cells.C24010_002.estimate).toMatchObject({
      value: null,
      status: "missing",
    });
    expect(cells.C24010_002.marginOfError.status).toBe("uncomputable");
    expect(cells.C24010_003.estimate.status).toBe("not-applicable");
    expect(cells.C24010_004.estimate.status).toBe("uncomputable");
  });

  it("maps a reordered published header by name and accepts BOM/CRLF without altering its hash", async () => {
    const columns = workforceAcsColumns("B15003").reverse();
    const row = columns.map((name) => (name === "B15003_E001" ? "123" : "0"));
    const text = `\uFEFFGEO_ID|${columns.join("|")}\r\n1500000US${geoid}|${row.join("|")}\r\n`;
    const result = await readWorkforceAcsSummary(
      chunks(text, 2),
      "B15003",
      "04",
    );
    expect(workforceAcsCells(result, geoid).B15003_001.estimate.value).toBe(
      123,
    );
    expect(result.source.sha256).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
  });

  it("rejects duplicated units and malformed/partial numeric evidence", async () => {
    await expect(
      readWorkforceAcsSummary(
        chunks(fixture("B15003", undefined, [geoid, geoid])),
        "B15003",
        "04",
      ),
    ).rejects.toThrow("duplicate");
    const values = workforceAcsColumns("B15003").map(() => "0");
    for (const invalid of [
      "-1",
      "NaN",
      "Infinity",
      "42.5",
      "unknown",
      "9007199254740992",
    ]) {
      values[0] = invalid;
      await expect(
        readWorkforceAcsSummary(
          chunks(fixture("B15003", values)),
          "B15003",
          "04",
        ),
      ).rejects.toThrow("numeric value");
    }
    values.pop();
    await expect(
      readWorkforceAcsSummary(
        chunks(fixture("B15003", values)),
        "B15003",
        "04",
      ),
    ).rejects.toThrow("malformed");
  });

  it("rejects wrong tables, duplicate columns, absent geographies, oversized and invalid UTF8 sources", async () => {
    await expect(
      readWorkforceAcsSummary(
        chunks(fixture()),
        "toString" as WorkforceAcsTable,
        "04",
      ),
    ).rejects.toThrow("Unsupported");
    await expect(
      readWorkforceAcsSummary(
        chunks(fixture().replace("B15003_M001", "B15003_E001")),
        "B15003",
        "04",
      ),
    ).rejects.toThrow("header");
    await expect(
      readWorkforceAcsSummary(chunks(fixture()), "C24010", "04"),
    ).rejects.toThrow("header");
    await expect(
      readWorkforceAcsSummary(chunks(fixture()), "B15003", "17"),
    ).rejects.toThrow("no native block groups");
    await expect(
      readWorkforceAcsSummary(chunks(fixture()), "B15003", "04", {
        maxBytes: 30,
      }),
    ).rejects.toThrow("byte limit");
    async function* badUtf8() {
      yield new Uint8Array([0xc3, 0x28]);
    }
    await expect(
      readWorkforceAcsSummary(badUtf8(), "B15003", "04"),
    ).rejects.toThrow();
    await expect(
      readWorkforceAcsSummary(chunks("X".repeat(64_001)), "B15003", "04"),
    ).rejects.toThrow("line-length");
  });

  it("does not silently fabricate cells for missing or tampered retained rows", async () => {
    const result = await readWorkforceAcsSummary(
      chunks(fixture()),
      "B15003",
      "04",
    );
    expect(() => workforceAcsCells(result, "040130001002")).toThrow(
      "complete retained",
    );
    result.rows[geoid].pop();
    expect(() => workforceAcsCells(result, geoid)).toThrow("complete retained");
    result.columns.reverse();
    expect(() => workforceAcsCells(result, geoid)).toThrow("table contract");
  });
});
