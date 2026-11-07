import { describe, expect, it } from "vitest";
import { readFiscalNumber } from "./numbers";
describe("fiscal numeric drafts", () => {
  it("retains genuine zero, signed growth and decimal rates", () => {
    expect(readFiscalNumber("0", "Grant")).toBe(0);
    expect(readFiscalNumber("-0.25", "Growth")).toBe(-0.25);
    expect(readFiscalNumber(" .015 ", "Levy")).toBe(0.015);
  });
  it.each(["", " ", "-", ".", "1,000", "NaN", "Infinity", "1e999", "0x10"])(
    "rejects unfinished or ambiguous text %j without coercion",
    (raw) => {
      expect(() => readFiscalNumber(raw, "Grant")).toThrow();
    },
  );
});
