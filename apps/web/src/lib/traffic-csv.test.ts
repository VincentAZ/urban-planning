import { describe, expect, it } from "vitest";
import {
  parseTrafficCSV,
  trafficNumericCell,
  TRAFFIC_CSV_LIMITS,
} from "./traffic-csv";

describe("traffic-count CSV staging", () => {
  it("preserves quoted delimiters, escaped quotes, missing cells and physical source lines", () => {
    expect(
      parseTrafficCSV(
        '\uFEFFstation,count,note\r\n"Main, north",0,"One ""lane""\r\ncount"\r\n\r\nSouth,,missing\r\n',
      ),
    ).toEqual({
      headers: ["station", "count", "note"],
      rows: [
        { line: 2, cells: ["Main, north", "0", 'One "lane"\ncount'] },
        { line: 5, cells: ["South", "", "missing"] },
      ],
    });
  });
  it("does not silently accept truncated, ambiguous or oversized source records", () => {
    for (const text of [
      "name,count\na",
      "name,count\na,1,2",
      "name,name\na,1",
      "name,\na,1",
      'name,count\n"a,1',
      'name,count\n"a"tail,1',
    ])
      expect(() => parseTrafficCSV(text)).toThrow();
    expect(() =>
      parseTrafficCSV(
        "name,count\n" +
          Array.from({ length: TRAFFIC_CSV_LIMITS.rows + 1 }, () => "a,1").join(
            "\n",
          ),
      ),
    ).toThrow("No rows were truncated");
    expect(() =>
      parseTrafficCSV(
        "a,b\n" + "x".repeat(TRAFFIC_CSV_LIMITS.cellCharacters + 1) + ",1",
      ),
    ).toThrow("10,000 characters");
  });
  it("keeps explicit missing rows and treats prototype-looking headers only as column text", () => {
    expect(parseTrafficCSV("constructor,__proto__\n,\n")).toEqual({
      headers: ["constructor", "__proto__"],
      rows: [{ line: 2, cells: ["", ""] }],
    });
  });
  it("never converts blank counts to zero or evaluates formulas and mixed units", () => {
    expect(trafficNumericCell("  ", "Count")).toBeNull();
    expect(trafficNumericCell("0", "Count")).toBe(0);
    expect(trafficNumericCell("12.5", "Count")).toBe(12.5);
    for (const value of [
      "=1+2",
      "1,000",
      "NaN",
      "Infinity",
      "1e999",
      "12 vehicles",
    ])
      expect(() => trafficNumericCell(value, "Count")).toThrow();
  });
});
