import { describe, it, expect, vi } from "vitest";
import type { Store } from "./store.js";
import { mediaServiceFromEnvironment } from "./media-config.js";
import { MediaRuntime } from "./media-runtime.js";
const fakeStore = () =>
  ({
    read: vi.fn(() => {
      throw new Error("Configuration must not read storage");
    }),
    transaction: vi.fn(() => {
      throw new Error("Configuration must not write storage");
    }),
  }) as unknown as Store;
describe("explicit media operator configuration", () => {
  it("stays disabled without any environment and does not inspect Docker or storage", async () => {
    const store = fakeStore(),
      service = mediaServiceFromEnvironment(store, {});
    expect(service.options.enabled).toBe(false);
    expect(service.options.executor).toBeUndefined();
    const cap = await service.capabilities();
    expect(cap.enabled).toBe(false);
    expect(cap.configured).toBe(false);
    expect(cap.cost.perExportProviderChargeCents).toBeNull();
    expect(store.read).not.toHaveBeenCalled();
  });
  it("does not enable missing runtime or missing cost declaration implicitly", () => {
    const s = mediaServiceFromEnvironment(fakeStore(), {
      MEDIA_ENABLED: "true",
    });
    expect(s.options.enabled).toBe(true);
    expect(s.options.executor).toBeUndefined();
    expect(s.options.capacity).toBeUndefined();
    const bad = mediaServiceFromEnvironment(fakeStore(), {
      MEDIA_ENABLED: "true",
      MEDIA_CAPACITY_ENVIRONMENT: "paid",
      MEDIA_CAPACITY_STATEMENT:
        "An explicit statement cannot invent a billing mode.",
    });
    expect(bad.options.capacity).toBeUndefined();
  });
  it("accepts an explicit pinned runtime and fixed capacity without launching it", () => {
    const store = fakeStore(),
      service = mediaServiceFromEnvironment(store, {
        MEDIA_ENABLED: "true",
        MEDIA_IMAGE_ID: "sha256:" + "a".repeat(64),
        MEDIA_RENDERER_DIRECTORY: "/tmp/synthetic-renderer",
        MEDIA_WORK_ROOT: "/tmp/synthetic-work",
        MEDIA_ARCHIVE_DIRECTORY: "/tmp/synthetic-archive",
        MEDIA_CAPACITY_ENVIRONMENT: "deployment",
        MEDIA_CAPACITY_STATEMENT:
          "Explicit fixture deployment capacity; no external per-render provider.",
      });
    expect(service.options.executor).toBeInstanceOf(MediaRuntime);
    expect(service.options.capacity?.environment).toBe("deployment");
    expect(service.archive.directory).toBe("/tmp/synthetic-archive");
    expect(store.read).not.toHaveBeenCalled();
  });
  it("leaves optional media unavailable for an invalid image without breaking application construction", async () => {
    const store = fakeStore();
    const service = mediaServiceFromEnvironment(store, {
      MEDIA_ENABLED: "true",
      MEDIA_IMAGE_ID: "renderer:latest",
      MEDIA_RENDERER_DIRECTORY: "/tmp/synthetic-renderer",
    });
    expect(service.options.executor).toBeUndefined();
    const cap = await service.capabilities();
    expect(cap.enabled).toBe(false);
    expect(cap.configured).toBe(false);
    expect(cap.reason).toMatch(/MEDIA_IMAGE_ID.*immutable/);
    expect(store.read).not.toHaveBeenCalled();
    expect(
      () =>
        new MediaRuntime({
          image: "renderer:latest",
          rendererDirectory: "/tmp/synthetic-renderer",
          workRoot: "/tmp/synthetic-work",
        }),
    ).toThrow(/immutable media image/);
  });
});
