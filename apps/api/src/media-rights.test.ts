import { describe, it, expect } from "vitest";
import { createProject } from "@urban/models";
import { type Source } from "@urban/core";
import { workforcePlaceFixture } from "../../../tests/fixtures/workforce.js";
import {
  assertMediaPrivateExport,
  assertMediaMetadataPrivacy,
} from "./media-rights.js";
import { prepareMediaScene } from "./media-scene-task.js";
const rights: Source["rights"] = {
  version: 1,
  privateUse: true,
  privateDisplay: true,
  export: false,
  cache: true,
  analyze: true,
  historicalRetention: true,
  publicRedistribution: false,
  declaredBy: "test",
  declaredAt: "2026-11-06T00:00:00.000Z",
};
describe("media private source permissions", () => {
  it("retains private display/export restrictions after a current citation loses its rights", () => {
    const place = structuredClone(workforcePlaceFixture),
      project = createProject(place),
      scenario = project.scenarios[1];
    const source: Source = {
      id: "media-source",
      name: "Restricted fixture",
      url: "",
      vintage: "test",
      license: "Test",
      kind: "user-supplied",
      rights,
    };
    scenario.sources = [source];
    expect(() => assertMediaPrivateExport(project, place, scenario)).toThrow(
      /permission declaration/,
    );
    project.scenarios[0].sources = [source];
    scenario.sources = [{ ...source, rights: undefined }];
    expect(() => assertMediaPrivateExport(project, place, scenario)).toThrow(
      /permission declaration/,
    );
    scenario.sources = [{ ...source, rights: { ...rights, export: true } }];
    expect(() =>
      assertMediaPrivateExport(project, place, scenario),
    ).not.toThrow();
  });
  it("does not expose credential-bearing source citations through a prepared scene", () => {
    const place = structuredClone(workforcePlaceFixture),
      project = createProject(place),
      scenario = project.scenarios[1];
    place.sources[0] = {
      id: "citation",
      name: "Synthetic citation",
      vintage: "test",
      license: "Test",
      kind: "user-supplied",
      url: "https://example.test/source?api_key=private-value",
    };
    expect(() =>
      prepareMediaScene({
        projectId: project.id,
        projectVersion: 1,
        place,
        scenario,
        createdAt: new Date().toISOString(),
      }),
    ).toThrow(/credential-bearing/);
  });
  it("rejects nested capture URLs and structured import credentials without echoing their values", () => {
    for (const value of [
      {
        accessibility: {
          captures: {
            car: {
              capture: {
                files: [{ url: "https://user:private@example.test/evidence" }],
              },
            },
          },
        },
      },
      {
        traffic: {
          capture: {
            originalDemand: {
              commute: {
                files: [
                  {
                    url: "https://example.test/record?X-Amz-Credential=private",
                  },
                ],
              },
            },
          },
        },
      },
      {
        files: [{ url: "https://example.test/evidence#access_token=private" }],
      },
      {
        source: {
          import: { recipe: { provider: { authorization: "Bearer private" } } },
        },
      },
      {
        source: {
          import: { recipe: { inputPath: "/home/private/source.csv" } },
        },
      },
      {
        source: {
          import: {
            recipe: { endpoint: "https://example.test/source?api_key=private" },
          },
        },
      },
      { files: [{ url: "file:///home/private/source.csv" }] },
      { files: [{ url: "C:\\private\\source.csv" }] },
      { files: [{ url: "https:/example.test/?token=private" }] },
      { files: [{ url: "https:\\example.test\\?token=private" }] },
      { files: [{ url: "//user:private@example.test/evidence" }] },
    ]) {
      expect(() => assertMediaMetadataPrivacy(value)).toThrow(
        /Retained media source metadata/,
      );
      try {
        assertMediaMetadataPrivacy(value);
      } catch (error) {
        expect((error as Error).message).not.toContain("Bearer private");
      }
    }
  });
  it("preserves public citation filters, relative archive names and ordinary authored prose exactly", () => {
    const metadata = {
      files: [{ url: "https://example.test/source?year=2023&county=04013" }],
      source: {
        import: {
          recipe: { member: "layers/source.csv", publicId: "source-1" },
        },
      },
      caption:
        "An authored example mentions /home without making it a file locator.",
      callout: "https://example.com is our source for this authored caption.",
      narration:
        "https://example.com/?token=example is discussed as authored prose, not used as a source locator.",
    };
    const before = JSON.stringify(metadata);
    expect(() => assertMediaMetadataPrivacy(metadata)).not.toThrow();
    expect(JSON.stringify(metadata)).toBe(before);
  });
});
