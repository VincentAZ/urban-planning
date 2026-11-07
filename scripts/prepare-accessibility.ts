import {
  prepareAccessibilityDestinationPack,
  writeAccessibilityDestinationPack,
} from "../apps/api/src/data/accessibility";

const [
  sourceDirectory,
  blocksFile,
  blocksSha256,
  blockSourceDirectory,
  outputDirectory,
] = process.argv.slice(2);
if (
  !sourceDirectory ||
  !blocksFile ||
  !blocksSha256 ||
  !blockSourceDirectory ||
  !outputDirectory ||
  process.argv.length !== 7
)
  throw new Error(
    "Usage: tsx scripts/prepare-accessibility.ts SOURCE_DIRECTORY COMPLETE_BLOCKS_JSON BLOCKS_SHA256 BLOCK_SOURCE_DIRECTORY OUTPUT_DIRECTORY",
  );
const pack = await prepareAccessibilityDestinationPack({
  sourceDirectory,
  blocksFile,
  blocksSha256,
  blockSourceDirectory,
});
console.log(
  JSON.stringify(
    await writeAccessibilityDestinationPack(pack, outputDirectory),
    null,
    2,
  ),
);
