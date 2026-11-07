import type { FiscalStudy, Scenario } from "@urban/core";

/** A draft result belongs to the exact objects dispatched to its worker. */
export function fiscalPreviewMatches(
  captured: {
    scenario: Scenario;
    study: FiscalStudy;
    fingerprint: string;
  } | null,
  scenario: Scenario,
  study: FiscalStudy | undefined,
  fingerprint: string,
  openedRevision: number,
): boolean {
  return (
    !!captured &&
    scenario.revision === openedRevision &&
    captured.scenario === scenario &&
    captured.study === study &&
    captured.fingerprint === fingerprint
  );
}
