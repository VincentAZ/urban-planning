import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { engagementReportFixture } from "../engagement-report-fixture";
import {
  assertEngagementReport,
  engagementReportLimits,
  exportEngagementCsv,
  renderEngagementPdf,
} from "./engagement-report";

/** Decode the actual PDFKit page streams and embedded ToUnicode maps, not a parallel text model. */
function pdfPageText(buffer: Buffer) {
  const objects = new Map(
    [
      ...buffer.toString("latin1").matchAll(/(\d+) 0 obj\n([\s\S]*?)\nendobj/g),
    ].map((match) => [Number(match[1]), match[2]]),
  );
  const stream = (id: number) => {
    const body = objects.get(id)!;
    const start = body.indexOf("stream\n") + 7;
    const length = Number(body.slice(0, start).match(/\/Length (\d+)/)![1]);
    const data = Buffer.from(body.slice(start, start + length), "latin1");
    return (/\/FlateDecode/.test(body) ? inflateSync(data) : data).toString(
      "latin1",
    );
  };
  const fonts = new Map<number, Map<number, string>>();
  for (const [id, body] of objects) {
    const reference = body.match(/\/ToUnicode (\d+) 0 R/);
    if (!reference) continue;
    const map = new Map<number, string>();
    for (const range of stream(Number(reference[1])).matchAll(
      /<([\da-f]+)>\s*<([\da-f]+)>\s*\[([^\]]+)\]/gi,
    )) {
      const start = parseInt(range[1], 16);
      [...range[3].matchAll(/<([^>]+)>/g)].forEach((value, i) =>
        map.set(
          start + i,
          String.fromCharCode(
            ...(value[1].replaceAll(" ", "").match(/.{4}/g) ?? []).map((hex) =>
              parseInt(hex, 16),
            ),
          ),
        ),
      );
    }
    fonts.set(id, map);
  }
  return [...objects.values()]
    .filter((body) => /\/Type \/Page\b/.test(body))
    .map((page) => {
      const resources = objects.get(
        Number(page.match(/\/Resources (\d+) 0 R/)![1]),
      )!;
      const aliases = new Map(
        [...resources.matchAll(/\/(F\d+) (\d+) 0 R/g)].map((match) => [
          match[1],
          fonts.get(Number(match[2]))!,
        ]),
      );
      const content = stream(Number(page.match(/\/Contents (\d+) 0 R/)![1]));
      let current: Map<number, string> | undefined;
      const lines: string[] = [];
      for (const token of content.matchAll(
        /\/(F\d+) [\d.]+ Tf|\[([^\]]*)\]\s*TJ|<([\da-f]+)>\s*Tj/gi,
      )) {
        if (token[1]) current = aliases.get(token[1]);
        else {
          expect(
            current,
            "text font has an embedded Unicode map",
          ).toBeDefined();
          const hexes = token[3]
            ? [token[3]]
            : [...token[2].matchAll(/<([\da-f]+)>/gi)].map((match) => match[1]);
          lines.push(
            hexes
              .flatMap((hex) => hex.match(/.{4}/g) ?? [])
              .map((glyph) => current!.get(parseInt(glyph, 16)) ?? "�")
              .join(""),
          );
        }
      }
      return lines.join("\n");
    });
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (char === "\r" && text[i + 1] === "\n" && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += char;
  }
  const [headers, ...values] = rows;
  return values.map((cells) =>
    Object.fromEntries(headers.map((header, i) => [header, cells[i]])),
  );
}

describe("published engagement exports", () => {
  it("treats missing inherited-name and malformed optional answers as absent in legacy reports", async () => {
    const report = engagementReportFixture();
    report.snapshot.engagement.config.questions[1].id = "toString";
    Object.assign(report.aggregate.survey.questions[1], {
      id: "toString",
      answeredAccounts: 0,
      skippedAccounts: 2,
      textResponses: [],
    });
    delete report.responses[2].answers!.context;
    expect(() => assertEngagementReport(report)).not.toThrow();
    const answers = parseCsv(exportEngagementCsv(report)).filter(
      (row) =>
        row.record_type === "survey_answer" && row.question_id === "toString",
    );
    expect(answers).toHaveLength(2);
    expect(
      answers.every((row) => row.answer === "" && row.measure === "skipped"),
    ).toBe(true);
    const pdf = pdfPageText(await renderEngagementPdf(report)).join(" ");
    expect(pdf).toContain("Skipped — no answer submitted.");
    expect(pdf).not.toContain("function toString");
    Object.defineProperty(report.responses[2].answers, "toString", {
      value: 42,
      enumerable: true,
    });
    expect(() => assertEngagementReport(report)).not.toThrow();
    expect(
      parseCsv(exportEngagementCsv(report))
        .filter(
          (row) =>
            row.record_type === "survey_answer" &&
            row.question_id === "toString",
        )
        .every((row) => row.answer === ""),
    ).toBe(true);
    report.aggregate.survey.questions[1].answeredAccounts = 1;
    expect(() => assertEngagementReport(report)).toThrow("totals do not match");
  });
  it("exports correct denominators, active survey IDs, timestamps, skips and map coordinates deterministically", () => {
    const report = engagementReportFixture();
    const csv = exportEngagementCsv(report);
    expect(csv).toBe(exportEngagementCsv(structuredClone(report)));
    const rows = parseCsv(csv);
    const support = rows.find(
      (row) => row.record_type === "vote_total" && row.vote_code === "support",
    )!;
    expect(support).toMatchObject({
      count: "1",
      denominator: "2",
      percent: "50",
      vote_label: "I see promise here",
      snapshot_id: "snapshot-qa-only",
      scenario_revision: "7",
    });
    expect(
      rows.find(
        (row) =>
          row.record_type === "question_total" &&
          row.question_id === "context" &&
          row.measure === "skipped_accounts",
      ),
    ).toMatchObject({ count: "1", denominator: "2" });
    expect(
      rows.find(
        (row) =>
          row.record_type === "survey_answer" &&
          row.respondent === "Account 3" &&
          row.question_id === "context",
      ),
    ).toMatchObject({
      measure: "skipped",
      answer: "",
      submitted_at: "2026-11-05T12:00:00.000Z",
    });
    expect(
      rows.find(
        (row) =>
          row.record_type === "comment" && row.respondent === "Account 1",
      ),
    ).toMatchObject({
      longitude: "-112.0712345",
      latitude: "33.4512345",
      moderation: "pending",
    });
    expect(
      rows.find((row) => row.measure === "excluded_current_records"),
    ).toMatchObject({ count: "2" });
    expect(
      rows.find((row) => row.measure === "superseded_records"),
    ).toMatchObject({ count: "3" });
  });
  it("escapes multiline CSV and formula cells while omitting extra identity and historical fields", async () => {
    const report = engagementReportFixture();
    report.comments[0].text =
      '=HYPERLINK("https://example.invalid", "not executed")\nSecond line, "quoted"';
    Object.assign(report, {
      userId: "private-user-id",
      email: "private@example.invalid",
      historicalRecords: [{ text: "EXCLUDED SECRET HISTORY" }],
    });
    Object.assign(report.comments[0], {
      author: "Private Real Name",
      userId: "private-user-id",
      email: "private@example.invalid",
    });
    report.aggregate.survey.questions[1].textResponses = [
      { text: "UNUSED STALE AGGREGATE TEXT" },
    ];
    const csv = exportEngagementCsv(report);
    expect(
      parseCsv(csv).find((row) => row.record_type === "comment")!.text,
    ).toBe(`'${report.comments[0].text}`);
    const pdf = pdfPageText(await renderEngagementPdf(report))
      .join(" ")
      .replace(/\s+/g, " ");
    for (const secret of [
      "private-user-id",
      "private@example.invalid",
      "Private Real Name",
      "EXCLUDED SECRET HISTORY",
      "UNUSED STALE AGGREGATE TEXT",
    ]) {
      expect(csv).not.toContain(secret);
      expect(pdf).not.toContain(secret);
    }
    expect(pdf).toContain('Second line, "quoted"');
    expect(pdf).toContain("1 comment includes a map location");
    expect(pdf).toContain("1 account answered; 1 account skipped");
    for (const dangerous of [
      "+SUM(1,1)",
      "-1+2",
      "@SUM(A1)",
      " \t=SUM(1)",
      "\tstarts with tab",
      "\nstarts with newline",
    ]) {
      report.comments[0].text = dangerous;
      expect(
        parseCsv(exportEngagementCsv(report)).find(
          (row) => row.record_type === "comment",
        )!.text,
      ).toBe(`'${dangerous}`);
    }
  });
  it("renders the complete actual multi-page PDF with repeated vote headers and full long text", async () => {
    const report = engagementReportFixture(true);
    const pdf = await renderEngagementPdf(report);
    const pages = pdfPageText(pdf);
    expect(
      pages.every((page) => page.trim().length > 150),
      "no footer-only blank pages",
    ).toBe(true);
    pages.forEach((page, i) =>
      expect(page).toContain(`${i + 1} / ${pages.length}`),
    );
    const text = pages.join(" ").replace(/\s+/g, " ");
    expect(pages.length).toBeGreaterThan(6);
    for (const value of [
      "Public engagement report",
      "Revision 7",
      "self-selected",
      "not a representative",
      "Pending moderation",
      "END LONG COMMENT QA.",
      "END LONG ANSWER QA.",
      "END LONG SOURCE QA.",
      "longitude -112.0712345",
      "priority",
      "Skipped",
      "42 included voting accounts",
    ])
      expect(text).toContain(value);
    expect(
      pages.filter(
        (page) =>
          page.includes("Account label") && page.includes("Submitted UTC"),
      ).length,
    ).toBeGreaterThan(1);
    expect(text).not.toContain("�");
  });
  it("distinguishes zero participation from zero support and rejects mismatched or unsafe records", async () => {
    const empty = engagementReportFixture();
    empty.comments = [];
    empty.responses = [];
    Object.assign(empty.aggregate, {
      participatingAccounts: 0,
      includedRecords: 0,
      pendingIncludedRecords: 0,
      totalHistoricalRecords: 5,
      comments: { count: 0, accounts: 0, pinnedCount: 0 },
      votes: { accounts: 0, support: 0, concern: 0, neutral: 0 },
    });
    empty.aggregate.survey.accounts = 0;
    empty.aggregate.survey.questions.forEach((question) => {
      question.answeredAccounts = 0;
      question.skippedAccounts = 0;
      question.options?.forEach((option) => {
        option.count = 0;
      });
      question.textResponses = [];
    });
    const row = parseCsv(exportEngagementCsv(empty)).find(
      (item) => item.record_type === "vote_total",
    )!;
    expect(row).toMatchObject({ count: "0", denominator: "0", percent: "" });
    expect(pdfPageText(await renderEngagementPdf(empty)).join(" ")).toContain(
      "Not applicable",
    );
    const mismatch = engagementReportFixture();
    mismatch.aggregate.votes.support++;
    expect(() => assertEngagementReport(mismatch)).toThrow(
      "totals do not match",
    );
    const unsafe = engagementReportFixture();
    unsafe.comments[0].respondentLabel = "Real Person Name";
    expect(() => exportEngagementCsv(unsafe)).toThrow("totals do not match");
  });
  it("refuses excessive work without truncating stored input and bounds concurrent native rendering", async () => {
    const oversized = engagementReportFixture();
    oversized.comments[0].text = "x".repeat(
      engagementReportLimits.pdfCharacters + 1,
    );
    await expect(renderEngagementPdf(oversized)).rejects.toMatchObject({
      statusCode: 413,
      code: "ENGAGEMENT_REPORT_TOO_LARGE",
    });
    expect(oversized.comments[0].text.length).toBe(
      engagementReportLimits.pdfCharacters + 1,
    );
    oversized.comments[0].text = "x".repeat(
      engagementReportLimits.csvCharacters + 1,
    );
    expect(() => exportEngagementCsv(oversized)).toThrow(
      "No responses were truncated",
    );
    const outcomes = await Promise.allSettled([
      renderEngagementPdf(engagementReportFixture()),
      renderEngagementPdf(engagementReportFixture()),
      renderEngagementPdf(engagementReportFixture()),
    ]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(
      2,
    );
    expect(outcomes.find((row) => row.status === "rejected")).toMatchObject({
      reason: { statusCode: 503, code: "ENGAGEMENT_REPORT_BUSY" },
    });
    await expect(
      renderEngagementPdf(engagementReportFixture()),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
