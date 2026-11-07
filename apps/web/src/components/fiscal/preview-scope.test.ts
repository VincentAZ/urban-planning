import { expect, it } from "vitest";
import { fiscalFixture } from "../../../../../packages/models/src/fiscal-fixture";
import { fiscalPreviewMatches } from "./preview-scope";

it("masks a completed fiscal preview on raw edits, revision drift, or a replaced source study", () => {
  const f = fiscalFixture(),
    study = f.project.fiscalStudy!;
  const captured = {
    scenario: f.scenario,
    study,
    fingerprint: "reviewed-draft",
  };
  const current = (
    scenario = f.scenario,
    source = study,
    fingerprint = "reviewed-draft",
  ) =>
    fiscalPreviewMatches(
      captured,
      scenario,
      source,
      fingerprint,
      f.scenario.revision,
    );
  expect(current()).toBe(true);
  expect(current(f.scenario, study, "changed-grant")).toBe(false);
  expect(current({ ...f.scenario, revision: f.scenario.revision + 1 })).toBe(
    false,
  );
  expect(
    current({
      ...f.scenario,
      assumptions: { ...f.scenario.assumptions, discountRate: 0.07 },
    }),
  ).toBe(false);
  expect(
    current(f.scenario, {
      ...study,
      applicability: {
        ...study.applicability,
        applicabilityNotes: "Replaced context",
      },
    }),
  ).toBe(false);
  expect(
    fiscalPreviewMatches(
      null,
      f.scenario,
      study,
      "reviewed-draft",
      f.scenario.revision,
    ),
  ).toBe(false);
});
