import { parseArgs } from "node:util";
import { prepareHousingCatalog } from "../apps/api/src/data/housing";
const { values } = parseArgs({
  options: {
    "source-dir": { type: "string" },
    "output-dir": { type: "string" },
    "declared-by": { type: "string" },
    "prepared-at": { type: "string" },
  },
});
if (!values["source-dir"] || !values["output-dir"] || !values["declared-by"])
  throw new Error(
    "Usage: prepare-housing --source-dir <retained official originals> --output-dir <new directory> --declared-by <operator rights reviewer> [--prepared-at <UTC timestamp>]",
  );
console.log(
  JSON.stringify(
    await prepareHousingCatalog({
      sourceDirectory: values["source-dir"],
      outputDirectory: values["output-dir"],
      declaredBy: values["declared-by"],
      preparedAt: values["prepared-at"],
    }),
    null,
    2,
  ),
);
