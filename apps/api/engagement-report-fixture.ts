import type { EngagementAggregate, EngagementReport } from "@urban/core";

/** Synthetic QA only. No public respondents or opinions are invented as real evidence. */
export function engagementReportFixture(stress = false): EngagementReport {
  const aggregate: EngagementAggregate = {
    participatingAccounts: 3,
    includedRecords: 6,
    pendingIncludedRecords: 3,
    excludedCurrentRecords: 2,
    supersededRecords: 3,
    totalHistoricalRecords: 11,
    comments: { count: 2, accounts: 2, pinnedCount: 1 },
    votes: { accounts: 2, support: 1, concern: 1, neutral: 0 },
    survey: {
      accounts: 2,
      questions: [
        {
          id: "priority",
          prompt: "Which design direction should receive further study?",
          type: "single-choice",
          answeredAccounts: 2,
          skippedAccounts: 0,
          options: [
            { option: "More shade", count: 1 },
            { option: "Safer crossings", count: 1 },
          ],
        },
        {
          id: "context",
          prompt: "What should the planning team understand?",
          type: "text",
          answeredAccounts: 1,
          skippedAccounts: 1,
          textResponses: [
            {
              text: "Please study afternoon shade and safe access. END ANSWER QA.",
            },
          ],
        },
      ],
    },
    notes: [],
  };
  const at = "2026-11-05T12:00:00.000Z";
  const report: EngagementReport = {
    schemaVersion: 1,
    generatedAt: "2026-11-05T14:00:00.000Z",
    snapshot: {
      id: "snapshot-qa-only",
      url: "https://example.invalid/shared/snapshot-qa-only",
      projectName: "Neighborhood public realm study",
      placeName: "Synthetic QA neighborhood",
      extentLabel: "Illustrative report fixture only",
      scenarioId: "scenario-qa-only",
      scenarioName: "Shade and crossing option",
      scenarioRevision: 7,
      createdAt: "2026-11-04T12:00:00.000Z",
      engagement: {
        config: {
          introduction:
            "Synthetic product QA. This fixture demonstrates how a planning team can review feedback on a frozen proposal; it contains no real public responses.",
          comments: true,
          votes: true,
          pins: true,
          questions: [
            {
              id: "priority",
              prompt: aggregate.survey.questions[0].prompt,
              type: "single-choice",
              required: true,
              options: ["More shade", "Safer crossings"],
            },
            {
              id: "context",
              prompt: aggregate.survey.questions[1].prompt,
              type: "text",
              required: false,
            },
          ],
        },
        collection: {
          status: "closed",
          version: 2,
          updatedAt: "2026-11-05T13:30:00.000Z",
        },
      },
      aggregate,
    },
    aggregate,
    comments: [
      {
        respondentLabel: "Account 1",
        text: "The crossing feels long in the afternoon. Please investigate shade and crossing time. END COMMENT QA.",
        position: [-112.0712345, 33.4512345],
        createdAt: at,
        moderation: "pending",
      },
      {
        respondentLabel: "Account 2",
        text: 'Please retain a clear walking route. A quoted note: "Keep access open," including during construction.',
        createdAt: "2026-11-05T12:05:00.000Z",
        moderation: "included",
      },
    ],
    responses: [
      {
        kind: "vote",
        respondentLabel: "Account 1",
        createdAt: at,
        moderation: "included",
        vote: "support",
      },
      {
        kind: "vote",
        respondentLabel: "Account 2",
        createdAt: at,
        moderation: "pending",
        vote: "concern",
      },
      {
        kind: "survey",
        respondentLabel: "Account 1",
        createdAt: at,
        moderation: "included",
        answers: {
          priority: "More shade",
          context: aggregate.survey.questions[1].textResponses![0].text,
        },
      },
      {
        kind: "survey",
        respondentLabel: "Account 3",
        createdAt: at,
        moderation: "pending",
        answers: { priority: "Safer crossings" },
      },
    ],
    sources: [
      {
        id: "qa-source",
        name: "Synthetic publication source",
        url: "https://example.invalid/synthetic-evidence",
        vintage: "QA only",
        kind: "user-supplied",
        license: "Synthetic fixture",
        description:
          "No real community response or observed condition is asserted by this test source.",
      },
    ],
    notes: [
      "All examples in this file are synthetic QA data, not an adopted proposal or actual community consultation.",
    ],
  };
  if (stress) {
    report.snapshot.projectName =
      "Long published project title testing responsive report typography and complete source retention "
        .repeat(3)
        .slice(0, 240);
    report.comments[0].text =
      "LONG COMMENT QA. The reviewer needs the complete account of the crossing, access, and shade concerns. This paragraph must remain readable across a page boundary without losing the final sentence.\n\n"
        .repeat(50)
        .slice(0, 9800) + " END LONG COMMENT QA.";
    report.responses[2].answers!.context =
      "LONG ANSWER QA. Preserve each submitted observation as written. A report must distinguish the response from an inferred planning conclusion.\n\n".repeat(
        24,
      ) + " END LONG ANSWER QA.";
    aggregate.survey.questions[1].textResponses![0].text =
      report.responses[2].answers!.context;
    for (let i = 4; i <= 43; i++)
      report.responses.push({
        kind: "vote",
        respondentLabel: `Account ${i}`,
        createdAt: at,
        moderation: "included",
        vote: "neutral",
      });
    aggregate.participatingAccounts += 40;
    aggregate.includedRecords += 40;
    aggregate.totalHistoricalRecords += 40;
    aggregate.votes.accounts += 40;
    aggregate.votes.neutral += 40;
    report.sources[0].name =
      "Synthetic source title for complete disclosure and wrapping ".repeat(4);
    report.sources[0].url =
      "https://example.invalid/" +
      "long-source-path-".repeat(90) +
      "?fixture=only";
    report.sources[0].description =
      "Source scope QA. This deliberately long source description must remain legible and complete. ".repeat(
        18,
      ) + "END LONG SOURCE QA.";
  }
  return report;
}
