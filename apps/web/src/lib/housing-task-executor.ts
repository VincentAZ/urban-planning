import {
  createHousingAffordabilityScenario,
  housingAffordabilityReviewInputHash,
  housingAffordabilityScenarioSchema,
  housingIncomeLimitPackHash,
  installHousingIncomeLimitPack,
} from "@urban/core";
import { resolveHousingAffordability } from "@urban/models";
import type { HousingTask } from "./housing-task";
export function executeHousingTask(task: HousingTask) {
  if (task.kind === "preview") {
    const affordability = createHousingAffordabilityScenario(
      task.place,
      task.scenario,
      task.input,
      task.review,
    );
    return {
      affordability,
      result: resolveHousingAffordability(
        task.place,
        { ...task.scenario, affordability },
        { housingIncomeLimits: task.catalog },
      ),
    };
  } else {
    const scenario = task.project.scenarios.find(
      (s) => s.id === task.project.activeScenarioId,
    );
    if (!scenario || scenario.id === "baseline")
      throw new Error("Choose an editable proposal.");
    housingAffordabilityScenarioSchema.parse(task.affordability);
    if (
      housingAffordabilityReviewInputHash(
        task.place,
        scenario,
        task.affordability,
      ) !== task.affordability.review.inputHash
    )
      throw new Error(
        "The housing inputs changed. Review them again before applying.",
      );
    let project = task.project;
    const hashes = new Set(
      [
        ...task.affordability.baselineGroups,
        ...task.affordability.proposalGroups,
      ].map((g) => g.areaHash),
    );
    for (const hash of hashes) {
      const pack = task.catalog[hash];
      if (!pack)
        throw new Error("A reviewed income-limit area is unavailable.");
      if (housingIncomeLimitPackHash(pack) !== hash)
        throw new Error("Income-limit area identity changed.");
      project = installHousingIncomeLimitPack(project, pack);
      if (!project.housingIncomeLimits?.[hash])
        throw new Error("Income-limit area identity changed.");
    }
    return project;
  }
}
