import { fiscalFixture } from "../../../packages/models/src/fiscal-fixture.js";
export function fiscalApiFixture(publicRedistribution = true) {
  const fixture = fiscalFixture();
  for (const source of fixture.profile.sources)
    source.rights = {
      version: 1,
      privateUse: true,
      cache: true,
      analyze: true,
      privateDisplay: true,
      export: true,
      historicalRetention: true,
      publicRedistribution,
      declaredBy: "synthetic-test-reviewer",
      declaredAt: new Date().toISOString(),
    };
  return fixture;
}
