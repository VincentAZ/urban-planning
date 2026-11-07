import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

/** Small report-specific layout: measured text, repeated table headers, embedded fonts. */
export function engagementPdfLayout(title: string, generatedAt: string) {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 48, right: 48, bottom: 76, left: 48 },
    bufferPages: true,
    info: {
      Title: title,
      Author: "Urban Planning",
      Subject:
        "Self-selected public engagement responses to a published scenario",
      CreationDate: new Date(generatedAt),
    },
  });
  doc.registerFont(
    "Body",
    fileURLToPath(new URL("../assets/fonts/DejaVuSans.ttf", import.meta.url)),
  );
  doc.registerFont(
    "Bold",
    fileURLToPath(
      new URL("../assets/fonts/DejaVuSans-Bold.ttf", import.meta.url),
    ),
  );
  const left = 48,
    width = 516,
    bottom = 710;
  const font = (size = 10, bold = false, color = "#30483d") =>
    doc
      .font(bold ? "Bold" : "Body")
      .fontSize(size)
      .fillColor(color);
  const room = (height: number) => {
    if (doc.y + height > bottom) doc.addPage();
  };
  const paragraph = (text: string, size = 10, color = "#30483d") => {
    for (const block of text.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
      if (!block.trim()) continue;
      font(size, false, color);
      const height = doc.heightOfString(block, { width, lineGap: 2.5 });
      if (height < 220) room(height + 9);
      font(size, false, color);
      doc.text(block, left, doc.y, { width, lineGap: 2.5 });
      doc.y += 9;
    }
  };
  const heading = (text: string, size = 17, newPage = false) => {
    if (newPage) doc.addPage();
    font(size, true, "#000000");
    room(doc.heightOfString(text, { width }) + 64);
    font(size, true, "#000000");
    doc.y += 7;
    doc.text(text, left, doc.y, { width, lineGap: 2 });
    doc.y += 10;
  };
  const wrap = (
    text: string,
    available: number,
    size: number,
    bold: boolean,
  ) => {
    font(size, bold);
    const lines: string[] = [];
    for (const block of text.split(/\r?\n/)) {
      let line = "";
      for (const word of block.split(/\s+/)) {
        if (!word) continue;
        if (doc.widthOfString(line ? `${line} ${word}` : word) <= available) {
          line = line ? `${line} ${word}` : word;
          continue;
        }
        if (line) lines.push(line);
        line = "";
        for (const character of word) {
          if (line && doc.widthOfString(line + character) > available) {
            lines.push(line);
            line = "";
          }
          line += character;
        }
      }
      lines.push(line);
    }
    return lines.length ? lines : [""];
  };
  const table = (headers: string[], rows: string[][], columns: number[]) => {
    const size = 9,
      padding = 8,
      lineHeight = 13;
    const headerLines = headers.map((value, i) =>
      wrap(value, columns[i] - padding * 2, size, true),
    );
    const headerHeight =
      Math.max(...headerLines.map((lines) => lines.length)) * lineHeight +
      padding * 2;
    const draw = (
      cells: string[][],
      isHeader: boolean,
      shade: boolean,
      start = 0,
      length?: number,
    ) => {
      const count = length ?? Math.max(...cells.map((lines) => lines.length));
      const y = doc.y,
        height = count * lineHeight + padding * 2;
      let x = left;
      columns.forEach((column, i) => {
        doc
          .rect(x, y, column, height)
          .fillAndStroke(
            isHeader ? "#334b40" : shade ? "#f3f5ef" : "#ffffff",
            "#d7ded5",
          );
        font(size, isHeader, isHeader ? "#ffffff" : "#263f36");
        cells[i].slice(start, start + count).forEach((line, j) =>
          doc.text(line, x + padding, y + padding + j * lineHeight, {
            width: column - padding * 2,
            lineBreak: false,
          }),
        );
        x += column;
      });
      doc.y = y + height;
    };
    const wrappedRows = rows.map((row) =>
      row.map((text, i) => wrap(text, columns[i] - padding * 2, size, false)),
    );
    const totalHeight =
      headerHeight +
      wrappedRows.reduce(
        (height, cells) =>
          height +
          Math.max(...cells.map((lines) => lines.length)) * lineHeight +
          padding * 2,
        0,
      );
    room(totalHeight <= 300 ? totalHeight : headerHeight + 44);
    draw(headerLines, true, false);
    wrappedRows.forEach((cells, index) => {
      const length = Math.max(...cells.map((lines) => lines.length));
      if (
        length * lineHeight + padding * 2 <= bottom - 48 - headerHeight &&
        doc.y + length * lineHeight + padding * 2 > bottom
      ) {
        doc.addPage();
        draw(headerLines, true, false);
      }
      let start = 0;
      while (start < length) {
        let capacity = Math.floor((bottom - doc.y - padding * 2) / lineHeight);
        if (capacity < 1) {
          doc.addPage();
          draw(headerLines, true, false);
          capacity = Math.floor((bottom - doc.y - padding * 2) / lineHeight);
        }
        const count = Math.min(capacity, length - start);
        draw(cells, false, index % 2 === 0, start, count);
        start += count;
        if (start < length) {
          doc.addPage();
          draw(headerLines, true, false);
        }
      }
    });
    doc.y += 14;
  };
  const finish = (revision: number) => {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bodyMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .moveTo(left, 738)
        .lineTo(left + width, 738)
        .lineWidth(0.5)
        .strokeColor("#cdd7c8")
        .stroke();
      font(8, false, "#526557");
      doc.text(
        `Urban Planning | Public engagement | Revision ${revision}`,
        left,
        749,
        { lineBreak: false },
      );
      doc.text(`${i + 1} / ${range.count}`, 490, 749, {
        width: 74,
        align: "right",
        lineBreak: false,
      });
      doc.page.margins.bottom = bodyMargin;
    }
    doc.end();
  };
  return { doc, paragraph, heading, table, finish };
}
