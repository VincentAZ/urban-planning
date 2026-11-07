import { afterEach, expect, it, vi } from "vitest";
import { fiscalFixture } from "../../../../packages/models/src/fiscal-fixture";
import { previewFiscalStudy } from "./fiscal-task";

afterEach(() => vi.unstubAllGlobals());
it("terminates a cancelled preview and never lets its late worker reply resolve a replacement", async () => {
  const instances: FakeWorker[] = [];
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    onmessageerror?: () => void;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  const f = fiscalFixture(),
    controller = new AbortController();
  const old = previewFiscalStudy(
    f.place,
    f.project.fiscalStudy!,
    f.scenario,
    controller.signal,
  );
  const rejection = expect(old).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejection;
  expect(instances[0].terminate).toHaveBeenCalledOnce();
  const current = previewFiscalStudy(f.place, f.project.fiscalStudy!, {
    ...f.scenario,
    revision: f.scenario.revision + 1,
  });
  instances[0].onmessage?.({
    data: { value: { inputHash: "late-old-reply" } },
  });
  const value = { inputHash: "replacement-current-reply" };
  instances[1].onmessage?.({ data: { value } });
  await expect(current).resolves.toEqual(value);
  expect(instances[1].terminate).toHaveBeenCalledOnce();
});
