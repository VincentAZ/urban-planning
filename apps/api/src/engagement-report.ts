import type { EngagementReport } from "@urban/core";
import { engagementPdfLayout } from "./engagement-pdf-layout";
import { ApiError } from "./errors";

const voteLabels = {
  support: "I see promise here",
  concern: "I have concerns",
  neutral: "I need more information",
} as const;
const counted = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
const ownAnswer = (
  answers: Record<string, string> | undefined,
  questionId: string,
): string | undefined => {
  if (!answers || !Object.hasOwn(answers, questionId)) return undefined;
  const value = answers[questionId];
  return typeof value === "string" ? value : undefined;
};
const percent = (count: number, denominator: number) =>
  denominator === 0
    ? "Not applicable"
    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format((count / denominator) * 100)}%`;
const chronology = <T extends { createdAt: string; respondentLabel: string }>(
  rows: T[],
) =>
  [...rows].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.respondentLabel.localeCompare(b.respondentLabel),
  );
const methodNotes = [
  "Responses come from self-selected signed-in accounts. They are not a representative sample of residents or the general population. One account does not establish one unique person, local residency, or eligibility to vote in an election.",
  "Pending moderation records are included. Excluded current records and superseded votes or surveys are omitted from response totals and appendices. The historical records export retains that history separately.",
  "Each account contributes at most one current vote and one current survey submission to this snapshot. Multiple comments from the same account are allowed. Vote percentages use included voting accounts; each survey question uses included accounts answering that question. Skips are counted separately.",
  "Account labels are opaque and stable within this published snapshot. They do not expose account names, emails, or internal user identifiers. Submitted text is reproduced without automated redaction and can contain personal information supplied by the respondent.",
];
export const engagementReportLimits = {
  pdfRecords: 750,
  pdfCharacters: 300_000,
  concurrentPdfs: 2,
  csvRecords: 5_000,
  csvCharacters: 5_000_000,
} as const;
let activePdfs = 0;
export class EngagementReportLimitError extends ApiError {
  constructor(message: string, statusCode: 413 | 503 = 413) {
    super(
      statusCode,
      statusCode === 503
        ? "ENGAGEMENT_REPORT_BUSY"
        : "ENGAGEMENT_REPORT_TOO_LARGE",
      message,
    );
    this.name = "EngagementReportLimitError";
  }
}
const reportTextCharacters = (report: EngagementReport) => {
  const count = (value: unknown): number =>
    typeof value === "string"
      ? value.length
      : Array.isArray(value)
        ? value.reduce((sum, child) => sum + count(child), 0)
        : value && typeof value === "object"
          ? Object.values(value).reduce<number>(
              (sum, child) => sum + count(child),
              0,
            )
          : 0;
  // Only data potentially printed, never unrelated identity metadata or audit history.
  return count([
    report.snapshot.projectName,
    report.snapshot.placeName,
    report.snapshot.extentLabel,
    report.snapshot.scenarioName,
    report.snapshot.engagement.config,
    report.comments.map((row) => row.text),
    report.responses.map((row) => row.answers),
    report.sources,
    report.notes,
    report.aggregate.notes,
  ]);
};

/** Fail closed if an export receives inconsistent totals or inactive response rows. */
export function assertEngagementReport(report: EngagementReport) {
  const { aggregate, comments, responses } = report;
  const votes = responses.filter((row) => row.kind === "vote");
  const surveys = responses.filter((row) => row.kind === "survey");
  const records = [...comments, ...responses];
  const unique = (rows: { respondentLabel: string }[]) =>
    new Set(rows.map((row) => row.respondentLabel)).size;
  const check = (condition: boolean) => {
    if (!condition)
      throw new Error(
        "Engagement report records and aggregate totals do not match.",
      );
  };
  check(
    report.schemaVersion === 1 &&
      Boolean(report.snapshot.id) &&
      Number.isInteger(report.snapshot.scenarioRevision),
  );
  check(
    records.every(
      (row) =>
        /^Account [1-9]\d*$/.test(row.respondentLabel) &&
        (row.moderation === "included" || row.moderation === "pending"),
    ),
  );
  check(
    aggregate.includedRecords === records.length &&
      aggregate.participatingAccounts === unique(records),
  );
  check(
    aggregate.pendingIncludedRecords ===
      records.filter((row) => row.moderation === "pending").length,
  );
  check(
    aggregate.comments.count === comments.length &&
      aggregate.comments.accounts === unique(comments) &&
      aggregate.comments.pinnedCount ===
        comments.filter((row) => row.position).length,
  );
  check(
    aggregate.votes.accounts === votes.length &&
      unique(votes) === votes.length &&
      aggregate.survey.accounts === surveys.length &&
      unique(surveys) === surveys.length,
  );
  for (const vote of ["support", "concern", "neutral"] as const)
    check(
      aggregate.votes[vote] === votes.filter((row) => row.vote === vote).length,
    );
  check(votes.every((row) => row.vote !== undefined && row.vote in voteLabels));
  check(
    aggregate.totalHistoricalRecords ===
      aggregate.includedRecords +
        aggregate.excludedCurrentRecords +
        aggregate.supersededRecords,
  );
  check(
    [aggregate.excludedCurrentRecords, aggregate.supersededRecords].every(
      (count) => Number.isInteger(count) && count >= 0,
    ),
  );
  const questions = report.snapshot.engagement.config.questions;
  check(aggregate.survey.questions.length === questions.length);
  for (const definition of questions) {
    const result = aggregate.survey.questions.find(
      (question) => question.id === definition.id,
    );
    check(Boolean(result));
    if (!result) continue;
    const answers = surveys
      .map((row) => ownAnswer(row.answers, definition.id))
      .filter((value): value is string => Boolean(value?.trim()));
    check(
      result.answeredAccounts === answers.length &&
        result.skippedAccounts === surveys.length - answers.length,
    );
    if (definition.type === "single-choice") {
      check(
        answers.every(
          (answer) => definition.options?.includes(answer) === true,
        ),
      );
      check(
        (result.options ?? []).length === (definition.options ?? []).length,
      );
      for (const option of definition.options ?? [])
        check(
          result.options?.find((row) => row.option === option)?.count ===
            answers.filter((answer) => answer === option).length,
        );
    }
  }
}

export async function renderEngagementPdf(
  report: EngagementReport,
): Promise<Buffer> {
  assertEngagementReport(report);
  if (
    report.aggregate.includedRecords > engagementReportLimits.pdfRecords ||
    reportTextCharacters(report) > engagementReportLimits.pdfCharacters
  )
    throw new EngagementReportLimitError(
      "This engagement report exceeds the PDF processing limit. No responses were truncated. Use the CSV or full records export; all stored responses remain retained.",
    );
  if (activePdfs >= engagementReportLimits.concurrentPdfs)
    throw new EngagementReportLimitError(
      "Engagement PDF generation is busy. Retry shortly; no responses were changed.",
      503,
    );
  activePdfs++;
  return new Promise<Buffer>((resolve, reject) => {
    const layout = engagementPdfLayout(
      `${report.snapshot.projectName} - Public engagement report`,
      report.generatedAt,
    );
    const { doc, heading, paragraph, table, finish } = layout;
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      const { snapshot, aggregate } = report;
      heading("Public engagement report", 25);
      paragraph(snapshot.projectName, 15, "#000000");
      paragraph(
        `${snapshot.scenarioName} · Published revision ${snapshot.scenarioRevision}\n${snapshot.placeName} · ${snapshot.extentLabel}`,
        10,
      );
      paragraph(
        `Published ${snapshot.createdAt}\nReport captured ${report.generatedAt}\nCollection ${snapshot.engagement.collection.status}${snapshot.revokedAt ? ` · Link revoked ${snapshot.revokedAt}` : ""}`,
        9,
      );
      heading("Response brief");
      paragraph(
        `${counted(aggregate.participatingAccounts, "participating account")} contributed ${counted(aggregate.includedRecords, "included response record")}: ${counted(aggregate.votes.accounts, "vote")}, ${counted(aggregate.survey.accounts, "survey submission")}, and ${counted(aggregate.comments.count, "comment")}. ${counted(aggregate.comments.pinnedCount, "comment")} ${aggregate.comments.pinnedCount === 1 ? "includes" : "include"} a map location.`,
      );
      paragraph(
        "Read these responses as issues and preferences raised by participants, not as a population-wide mandate or an estimate of public opinion.",
      );
      table(
        ["Current account vote", "Accounts", "Share of votes"],
        (["support", "concern", "neutral"] as const).map((vote) => [
          voteLabels[vote],
          String(aggregate.votes[vote]),
          percent(aggregate.votes[vote], aggregate.votes.accounts),
        ]),
        [270, 100, 146],
      );
      paragraph(
        `Denominator: ${counted(aggregate.votes.accounts, "included voting account")}. Accounts that only commented or answered a survey are outside this denominator.`,
        9,
      );
      paragraph(
        `${counted(aggregate.pendingIncludedRecords, "included record")} ${aggregate.pendingIncludedRecords === 1 ? "awaits" : "await"} moderation. ${counted(aggregate.excludedCurrentRecords, "current record")} ${aggregate.excludedCurrentRecords === 1 ? "is" : "are"} excluded; ${counted(aggregate.supersededRecords, "earlier vote or survey record")} ${aggregate.supersededRecords === 1 ? "was" : "were"} superseded. Detailed inclusion counts and the frozen questions follow.`,
        9,
      );
      heading("Survey and collection definition", 17, true);
      paragraph(
        `Snapshot ${snapshot.id}\nScenario ${snapshot.scenarioId} · Revision ${snapshot.scenarioRevision}\nSnapshot link ${snapshot.url}`,
        9,
      );
      paragraph(
        `Frozen response settings: comments ${snapshot.engagement.config.comments ? "enabled" : "disabled"}; account votes ${snapshot.engagement.config.votes ? "enabled" : "disabled"}; location pins ${snapshot.engagement.config.pins ? "enabled" : "disabled"}. Collection status version ${snapshot.engagement.collection.version}, updated ${snapshot.engagement.collection.updatedAt}.`,
        9,
      );
      table(
        ["Inclusion record", "Records"],
        [
          ["Included current records", String(aggregate.includedRecords)],
          [
            "Of included records, pending moderation",
            String(aggregate.pendingIncludedRecords),
          ],
          [
            "Excluded current records",
            String(aggregate.excludedCurrentRecords),
          ],
          [
            "Superseded historical votes or surveys",
            String(aggregate.supersededRecords),
          ],
          ["All historical records", String(aggregate.totalHistoricalRecords)],
        ],
        [396, 120],
      );
      if (snapshot.engagement.config.introduction) {
        heading("Introduction shown to participants", 13);
        paragraph(snapshot.engagement.config.introduction);
      }
      if (!snapshot.engagement.config.questions.length)
        paragraph("No survey questions were configured for this publication.");
      for (const question of snapshot.engagement.config.questions) {
        const result = aggregate.survey.questions.find(
          (item) => item.id === question.id,
        )!;
        heading(question.prompt, 13);
        paragraph(
          `Question ID ${question.id} · ${question.type === "text" ? "Written response" : "Single choice"} · ${question.required ? "Required" : "Optional"}\n${counted(result.answeredAccounts, "account")} answered; ${counted(result.skippedAccounts, "account")} skipped out of ${counted(aggregate.survey.accounts, "included survey submission")}.`,
          9,
        );
        if (question.type === "single-choice") {
          table(
            ["Response option", "Accounts", "Share answering"],
            (question.options ?? []).map((option) => {
              const count =
                result.options?.find((row) => row.option === option)?.count ??
                0;
              return [
                option,
                String(count),
                percent(count, result.answeredAccounts),
              ];
            }),
            [290, 90, 136],
          );
        } else
          paragraph(
            "Full written answers appear in the survey response appendix. No sentiment or inferred consensus has been assigned.",
            9,
          );
      }
      heading("Comments and map locations", 17, true);
      paragraph(
        `${counted(aggregate.comments.count, "included comment")} from ${counted(aggregate.comments.accounts, "account")}. A pin records the submitted longitude and latitude; it does not establish the respondent’s home address.`,
        9,
      );
      if (!report.comments.length)
        paragraph(
          "No included comments were recorded at the report capture time.",
        );
      chronology(report.comments).forEach((comment, i) => {
        heading(`Comment ${i + 1} · ${comment.respondentLabel}`, 13);
        paragraph(
          `${comment.createdAt} · Moderation ${comment.moderation}${comment.position ? `\nMap location: longitude ${comment.position[0]}, latitude ${comment.position[1]} (WGS 84)` : "\nNo map location submitted."}`,
          9,
        );
        paragraph(comment.text);
      });
      heading("Current vote records", 17, true);
      const votes = chronology(
        report.responses.filter((row) => row.kind === "vote"),
      );
      if (!votes.length)
        paragraph(
          "No included current votes were recorded at the report capture time.",
        );
      else
        table(
          ["Account label", "Vote", "Submitted UTC", "Moderation"],
          votes.map((row) => [
            row.respondentLabel,
            voteLabels[row.vote!],
            row.createdAt,
            row.moderation,
          ]),
          [91, 171, 153, 101],
        );
      heading("Survey response appendix", 17);
      const surveys = chronology(
        report.responses.filter((row) => row.kind === "survey"),
      );
      if (!surveys.length)
        paragraph(
          "No included current survey submissions were recorded at the report capture time.",
        );
      surveys.forEach((response, i) => {
        heading(`Submission ${i + 1} · ${response.respondentLabel}`, 13);
        paragraph(
          `${response.createdAt} · Moderation ${response.moderation}`,
          9,
        );
        for (const question of snapshot.engagement.config.questions) {
          heading(`${question.id} · ${question.prompt}`, 11);
          paragraph(
            ownAnswer(response.answers, question.id) ||
              "Skipped — no answer submitted.",
          );
        }
      });
      heading("Interpretation and source scope", 17, true);
      for (const note of [
        ...new Set([...methodNotes, ...aggregate.notes, ...report.notes]),
      ])
        paragraph(note);
      paragraph(
        `This report describes the responses captured at ${report.generatedAt} for published snapshot ${snapshot.id}, scenario revision ${snapshot.scenarioRevision}. Later submissions or moderation changes can change a subsequent report. Geography and scenario evidence belong to the frozen publication; current project edits are not substituted.`,
        9,
      );
      if (!report.sources.length)
        paragraph(
          "No map or model source records were supplied with this snapshot.",
        );
      report.sources.forEach((source, i) => {
        heading(`${i + 1} ${source.name}`, 12);
        paragraph(
          `Source ID ${source.id} · Vintage ${source.vintage} · ${source.kind}\nLicense ${source.license}`,
          9,
        );
        if (source.description) paragraph(source.description, 9);
        paragraph(source.url, 9);
      });
      finish(snapshot.scenarioRevision);
    } catch (error) {
      reject(error);
      doc.end();
    }
  }).finally(() => {
    activePdfs--;
  });
}

const csvColumns = [
  "record_type",
  "snapshot_id",
  "project_name",
  "place_name",
  "extent",
  "scenario_id",
  "scenario_name",
  "scenario_revision",
  "published_at",
  "generated_at",
  "collection_status",
  "respondent",
  "submitted_at",
  "moderation",
  "vote_code",
  "vote_label",
  "question_id",
  "question_prompt",
  "question_type",
  "option",
  "answer",
  "measure",
  "count",
  "denominator",
  "percent",
  "longitude",
  "latitude",
  "text",
  "url",
  "source_vintage",
  "source_license",
] as const;
type CsvColumn = (typeof csvColumns)[number];
type CsvValue = string | number | undefined;
const csvCell = (value: CsvValue) => {
  const raw = value === undefined ? "" : String(value);
  // Spreadsheet applications can execute a quoted cell too; prefix dangerous textual cells.
  const safe =
    typeof value === "string" &&
    (/^[\u0000-\u0020\uFEFF]*[=+\-@]/u.test(raw) || /^[\t\r\n]/.test(raw))
      ? `'${raw}`
      : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};

export function exportEngagementCsv(report: EngagementReport): string {
  assertEngagementReport(report);
  if (
    report.aggregate.includedRecords > engagementReportLimits.csvRecords ||
    reportTextCharacters(report) > engagementReportLimits.csvCharacters
  )
    throw new EngagementReportLimitError(
      "This engagement report exceeds the CSV processing limit. No responses were truncated. Use the full records export; all stored responses remain retained.",
    );
  const { snapshot, aggregate } = report;
  const base: Partial<Record<CsvColumn, CsvValue>> = {
    snapshot_id: snapshot.id,
    project_name: snapshot.projectName,
    place_name: snapshot.placeName,
    extent: snapshot.extentLabel,
    scenario_id: snapshot.scenarioId,
    scenario_name: snapshot.scenarioName,
    scenario_revision: snapshot.scenarioRevision,
    published_at: snapshot.createdAt,
    generated_at: report.generatedAt,
    collection_status: snapshot.engagement.collection.status,
  };
  const rows: Partial<Record<CsvColumn, CsvValue>>[] = [];
  const add = (row: Partial<Record<CsvColumn, CsvValue>>) =>
    rows.push({ ...base, ...row });
  const totals: [string, number][] = [
    ["participating_accounts", aggregate.participatingAccounts],
    ["included_records", aggregate.includedRecords],
    ["pending_included_records", aggregate.pendingIncludedRecords],
    ["excluded_current_records", aggregate.excludedCurrentRecords],
    ["superseded_records", aggregate.supersededRecords],
    ["total_historical_records", aggregate.totalHistoricalRecords],
    ["comment_records", aggregate.comments.count],
    ["commenting_accounts", aggregate.comments.accounts],
    ["pinned_comments", aggregate.comments.pinnedCount],
    ["voting_accounts", aggregate.votes.accounts],
    ["survey_accounts", aggregate.survey.accounts],
  ];
  totals.forEach(([measure, count]) =>
    add({ record_type: "summary", measure, count }),
  );
  for (const vote of ["support", "concern", "neutral"] as const)
    add({
      record_type: "vote_total",
      vote_code: vote,
      vote_label: voteLabels[vote],
      count: aggregate.votes[vote],
      denominator: aggregate.votes.accounts,
      percent: aggregate.votes.accounts
        ? (aggregate.votes[vote] / aggregate.votes.accounts) * 100
        : undefined,
    });
  add({
    record_type: "introduction",
    text: snapshot.engagement.config.introduction,
  });
  for (const question of snapshot.engagement.config.questions) {
    const result = aggregate.survey.questions.find(
      (row) => row.id === question.id,
    )!;
    const fields = {
      question_id: question.id,
      question_prompt: question.prompt,
      question_type: question.type,
    };
    add({
      ...fields,
      record_type: "question_definition",
      measure: question.required ? "required" : "optional",
      text: JSON.stringify(question.options ?? []),
    });
    add({
      ...fields,
      record_type: "question_total",
      measure: "answered_accounts",
      count: result.answeredAccounts,
      denominator: aggregate.survey.accounts,
    });
    add({
      ...fields,
      record_type: "question_total",
      measure: "skipped_accounts",
      count: result.skippedAccounts,
      denominator: aggregate.survey.accounts,
    });
    for (const option of question.options ?? []) {
      const count =
        result.options?.find((row) => row.option === option)?.count ?? 0;
      add({
        ...fields,
        record_type: "question_option",
        option,
        count,
        denominator: result.answeredAccounts,
        percent: result.answeredAccounts
          ? (count / result.answeredAccounts) * 100
          : undefined,
      });
    }
  }
  for (const row of chronology(report.comments))
    add({
      record_type: "comment",
      respondent: row.respondentLabel,
      submitted_at: row.createdAt,
      moderation: row.moderation,
      longitude: row.position?.[0],
      latitude: row.position?.[1],
      text: row.text,
    });
  for (const row of chronology(report.responses)) {
    const fields = {
      respondent: row.respondentLabel,
      submitted_at: row.createdAt,
      moderation: row.moderation,
    };
    if (row.kind === "vote")
      add({
        ...fields,
        record_type: "vote",
        vote_code: row.vote,
        vote_label: voteLabels[row.vote!],
      });
    else
      for (const question of snapshot.engagement.config.questions)
        add({
          ...fields,
          record_type: "survey_answer",
          question_id: question.id,
          question_prompt: question.prompt,
          question_type: question.type,
          answer: ownAnswer(row.answers, question.id) ?? "",
          measure: ownAnswer(row.answers, question.id)?.trim()
            ? "answered"
            : "skipped",
        });
  }
  for (const note of [
    ...new Set([...methodNotes, ...aggregate.notes, ...report.notes]),
  ])
    add({ record_type: "method_note", text: note });
  add({
    record_type: "method_note",
    text: "CSV formula protection prefixes dangerous textual cells with an apostrophe. Coordinates are numeric WGS 84 longitude/latitude. Empty percentages mean no eligible denominator, not zero support.",
  });
  for (const source of report.sources)
    add({
      record_type: "source",
      measure: source.id,
      text: `${source.name}\n${source.description ?? ""}`,
      url: source.url,
      source_vintage: source.vintage,
      source_license: source.license,
    });
  const totalCharacters = rows.reduce(
    (sum, row) =>
      sum +
      csvColumns.reduce(
        (subtotal, column) => subtotal + String(row[column] ?? "").length,
        0,
      ),
    0,
  );
  if (totalCharacters > engagementReportLimits.csvCharacters)
    throw new EngagementReportLimitError(
      "This engagement report exceeds the CSV processing limit. No responses were truncated. Use the full records export; all stored responses remain retained.",
    );
  return (
    [
      csvColumns.map(csvCell).join(","),
      ...rows.map((row) =>
        csvColumns.map((column) => csvCell(row[column])).join(","),
      ),
    ].join("\r\n") + "\r\n"
  );
}
