import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { trafficContentHash } from "@urban/core";
import { trafficNativeSettings } from "./native-settings.js";

describe("native settings identity and retained conversion precision", () => {
  it("keeps absent timing out of legacy settings and binds explicit controls and all native inputs", async () => {
    const input = {
      workerSha256: "a".repeat(64),
      overlays: [],
      submittedVehiclesHash: "b".repeat(64),
      mappedCountsHash: "c".repeat(64),
    };
    const legacy = trafficNativeSettings(input);
    expect(legacy).not.toHaveProperty("signalTimings");
    expect(
      await trafficContentHash(
        trafficNativeSettings({ ...input, signalTimings: [] }),
      ),
    ).not.toBe(await trafficContentHash(legacy));
    for (const key of [
      "workerSha256",
      "submittedVehiclesHash",
      "mappedCountsHash",
    ] as const)
      expect(
        await trafficContentHash(
          trafficNativeSettings({ ...input, [key]: "d".repeat(64) }),
        ),
      ).not.toBe(await trafficContentHash(legacy));
  });
  it("uses the actual bounded worker precision parser with equals syntax and last-option precedence", () => {
    // Execute only this pure function's AST; importing the native worker would start processing.
    const result = execFileSync(
      "python3",
      [
        "-c",
        `import ast,json
from pathlib import Path
module=ast.parse(Path('scripts/traffic-worker.py').read_text())
node=next(n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='captured_precision')
namespace={}
exec(compile(ast.Module(body=[node],type_ignores=[]),'<worker-precision>','exec'),namespace)
f=namespace['captured_precision']
cases=[[],['--precision','6'],['--precision=6'],['--precision=2','--precision','6'],['--precision','6','--precision=2']]
values=[f(case) for case in cases]
for case in [['--precision'],['--precision=4'],['--precision','bad']]:
 try: f(case); values.append('incorrectly accepted')
 except ValueError: values.append('rejected')
print(json.dumps(values))`,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual([
      "2",
      "6",
      "6",
      "6",
      "2",
      "rejected",
      "rejected",
      "rejected",
    ]);
  });
});
