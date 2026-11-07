import { expect, it, vi } from "vitest";
import { captureMapImage } from "./capture";

it("keeps the full map frame and burns the rendered revision and source credits into the exported PNG", () => {
  const context = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  const output = {
    width: 0,
    height: 0,
    getContext: () => context,
    toDataURL: vi.fn(() => "data:image/png;base64,test"),
  } as unknown as HTMLCanvasElement;
  const source = {
    width: 1200,
    height: 800,
    clientWidth: 1200,
  } as HTMLCanvasElement;
  expect(
    captureMapImage(
      source,
      {
        scenarioName: "More homes",
        revision: 7,
        extentLabel: "Roosevelt Row reference area",
        satellite: false,
      },
      () => output,
    ),
  ).toBe("data:image/png;base64,test");
  expect(context.drawImage).toHaveBeenCalledWith(source, 0, 0);
  expect(output.width).toBe(source.width);
  expect(output.height).toBeGreaterThan(source.height + 90);
  const text = context.fillText.mock.calls.map((call) => call[0]).join(" ");
  expect(text).toContain("More homes · Revision 7");
  expect(text).toContain("© OpenStreetMap contributors");
  expect(text).toContain("ODbL 1.0");
  expect(text).toContain("may be estimated");
  expect(text).not.toContain("MapTiler");
  expect(text).not.toContain("Census");
  expect(
    context.fillText.mock.calls.every((call) => call[2] > source.height),
  ).toBe(true);
  expect(output.toDataURL).toHaveBeenCalledWith("image/png");
});

it("credits the captured Census boundary alongside OSM geometry for exact ZCTA exports", () => {
  const context = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  const output = {
    getContext: () => context,
    toDataURL: () => "data:image/png",
  } as unknown as HTMLCanvasElement;
  captureMapImage(
    { width: 1200, height: 800, clientWidth: 1200 } as HTMLCanvasElement,
    {
      scenarioName: "Chicago homes",
      revision: 3,
      extentLabel: "Census 2020 ZCTA 60601 · exact statistical ZIP area",
      censusBoundaryVintage: "2020",
      satellite: false,
    },
    () => output,
  );
  const text = context.fillText.mock.calls.map((call) => call[0]).join(" ");
  expect(text).toContain("Chicago homes · Revision 3");
  expect(text).toContain("© OpenStreetMap contributors");
  expect(text).toContain(
    "Study boundary: U.S. Census Bureau · 2020 ZIP Code Tabulation Area · Public data",
  );
});

it("includes imagery provider credit and the terms caveat when an imagery layer is configured", () => {
  const context = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  const output = {
    getContext: () => context,
    toDataURL: () => "data:image/png",
  } as unknown as HTMLCanvasElement;
  captureMapImage(
    { width: 1200, height: 800, clientWidth: 1200 } as HTMLCanvasElement,
    {
      scenarioName: "A",
      revision: 1,
      extentLabel: "Reference area",
      satellite: true,
    },
    () => output,
  );
  const text = context.fillText.mock.calls.map((call) => call[0]).join(" ");
  expect(text).toContain("© MapTiler / imagery providers");
  expect(text).toContain("Redistribution is subject to");
});

it("exports a split frame with both scenario revisions and honest left/right coverage", () => {
  const context = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 6 }),
  };
  const output = {
    getContext: () => context,
    toDataURL: () => "data:image/png",
  } as unknown as HTMLCanvasElement;
  const source = {
    width: 1200,
    height: 800,
    clientWidth: 600,
  } as HTMLCanvasElement;
  captureMapImage(
    source,
    {
      scenarioName: "More homes",
      revision: 7,
      extentLabel: "Captured study area",
      satellite: false,
      reveal: { scenarioName: "Captured baseline", revision: 0, percent: 25 },
    },
    () => output,
  );
  expect(context.drawImage).toHaveBeenCalledWith(source, 0, 0);
  expect(context.fillRect).toHaveBeenCalledWith(298, 0, 4, 800);
  const texts = context.fillText.mock.calls.map((call) => call[0]).join(" ");
  expect(texts).toContain("Before / after comparison · Same camera");
  expect(texts).toContain(
    "Left / before: Captured baseline · Revision 0 · 25% of view",
  );
  expect(texts).toContain(
    "Right / after: More homes · Revision 7 · 75% of view",
  );
  expect(texts).toContain("© OpenStreetMap contributors");
  expect(texts).toContain("Before · r0");
  expect(texts).toContain("After · r7");
});
