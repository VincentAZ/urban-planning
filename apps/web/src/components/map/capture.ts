export interface MapCaptureMetadata {
  scenarioName: string;
  revision: number;
  extentLabel: string;
  censusBoundaryVintage?: "2020";
  satellite: boolean;
  imageryAttribution?: string;
  flood?: { hash: string; capturedAt: string; imported?: boolean };
  reveal?: { scenarioName: string; revision: number; percent: number };
}

/** Append provenance to the actual GPU frame; HTML map controls are not in that frame. */
export function captureMapImage(
  source: HTMLCanvasElement,
  metadata: MapCaptureMetadata,
  createCanvas = () => document.createElement("canvas"),
): string {
  const output = createCanvas();
  const context = output.getContext("2d");
  if (!context) throw new Error("Image export is unavailable in this browser.");
  const scale = source.width / (source.clientWidth || source.width);
  const inset = 18 * scale,
    lineWidth = Math.max(1, source.width - inset * 2);
  const rows: { text: string; size: number; bold: boolean; color: string }[] =
    [];
  const add = (text: string, size: number, bold = false, color = "#51645a") => {
    context.font = `${bold ? "600" : "400"} ${size * scale}px Arial, sans-serif`;
    let row = "";
    for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
      const candidate = row ? `${row} ${word}` : word;
      if (row && context.measureText(candidate).width > lineWidth) {
        rows.push({ text: row, size, bold, color });
        row = word;
      } else row = candidate;
    }
    if (row) rows.push({ text: row, size, bold, color });
  };
  if (metadata.reveal) {
    add("Before / after comparison · Same camera", 17, true, "#203b30");
    add(
      `Left / before: ${metadata.reveal.scenarioName} · Revision ${metadata.reveal.revision} · ${Math.round(metadata.reveal.percent)}% of view`,
      12,
      true,
    );
    add(
      `Right / after: ${metadata.scenarioName} · Revision ${metadata.revision} · ${Math.round(100 - metadata.reveal.percent)}% of view`,
      12,
      true,
    );
  } else {
    add(
      `${metadata.scenarioName} · Revision ${metadata.revision}`,
      17,
      true,
      "#203b30",
    );
  }
  add(metadata.extentLabel, 12);
  add(
    "Planning illustration · Building attributes and activity may be estimated. See the scenario report for methods and sources.",
    11,
  );
  add(
    "Geometry: © OpenStreetMap contributors · ODbL 1.0 · openstreetmap.org/copyright",
    11,
  );
  if (metadata.censusBoundaryVintage)
    add(
      `Study boundary: U.S. Census Bureau · ${metadata.censusBoundaryVintage} ZIP Code Tabulation Area · Public data · census.gov`,
      11,
    );
  if (metadata.flood) {
    add(
      `Flood overlay: ${metadata.flood.imported ? "Imported evidence, not server verified" : "Captured FEMA effective NFHL"} · ${metadata.flood.capturedAt} · ${metadata.flood.hash}`,
      10,
    );
    add(
      "Blue: SFHA; dark blue: floodway; teal: 0.2%; gray: other mapped; amber: undetermined. Missing coverage is unknown. Footprint screening, not a regulatory determination.",
      10,
    );
  }
  if (metadata.satellite)
    add(
      `Imagery: ${metadata.imageryAttribution ?? "© MapTiler / imagery providers"}. Redistribution is subject to the imagery provider’s terms.`,
      11,
    );
  const footerHeight = Math.ceil(
    inset * 2 + rows.reduce((sum, row) => sum + (row.size + 6) * scale, 0),
  );
  output.width = source.width;
  output.height = source.height + footerHeight;
  context.drawImage(source, 0, 0);
  if (metadata.reveal) {
    const x = (source.width * metadata.reveal.percent) / 100;
    context.fillStyle = "#fffef4";
    context.fillRect(x - scale, 0, 2 * scale, source.height);
    context.font = `600 ${13 * scale}px Arial, sans-serif`;
    context.textBaseline = "top";
    const badge = (text: string, left: number, available: number) => {
      if (available < 90 * scale) return;
      const width = Math.min(
        available,
        context.measureText(text).width + 20 * scale,
      );
      context.fillStyle = "#fffef4";
      context.fillRect(left, inset, width, 30 * scale);
      context.fillStyle = "#203b30";
      context.fillText(
        text,
        left + 10 * scale,
        inset + 7 * scale,
        width - 20 * scale,
      );
    };
    badge(`Before · r${metadata.reveal.revision}`, inset, x - 2 * inset);
    badge(
      `After · r${metadata.revision}`,
      x + inset,
      source.width - x - 2 * inset,
    );
  }
  context.fillStyle = "#f8f7ef";
  context.fillRect(0, source.height, output.width, footerHeight);
  context.fillStyle = "#a1b19b";
  context.fillRect(0, source.height, output.width, 2 * scale);
  context.textBaseline = "top";
  let y = source.height + inset;
  for (const row of rows) {
    context.font = `${row.bold ? "600" : "400"} ${row.size * scale}px Arial, sans-serif`;
    context.fillStyle = row.color;
    context.fillText(row.text, inset, y, lineWidth);
    y += (row.size + 6) * scale;
  }
  return output.toDataURL("image/png");
}
