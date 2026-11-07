import {
  createDevelopmentBackup,
  verifyDevelopmentBackup,
} from "../apps/api/src/storage-backup.js";

const usage =
  "Usage: corepack pnpm exec tsx scripts/storage-backup.ts --source <state.json> --out <new-directory>\n       corepack pnpm exec tsx scripts/storage-backup.ts --verify <backup-directory>";
try {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--verify") {
    const manifest = await verifyDevelopmentBackup(args[1]);
    process.stdout.write(
      `Backup verified: ${manifest.counts.records} records, ${manifest.counts.baselines} baselines, ${manifest.counts.projectVersions} saved versions.\n`,
    );
  } else if (
    args.length === 4 &&
    args[0] === "--source" &&
    args[2] === "--out"
  ) {
    const manifest = await createDevelopmentBackup({
      sourceStatePath: args[1],
      destinationDirectory: args[3],
    });
    process.stdout.write(
      `Private backup created and verified: ${manifest.counts.records} records, ${manifest.counts.baselines} baselines, ${manifest.counts.projectVersions} saved versions.\n`,
    );
    process.stdout.write(
      "Preserve the entire backup directory. Rehearse restoration into a separate directory before switching LOCAL_STATE_PATH; never replace a running database.\n",
    );
  } else throw new Error(usage);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Backup failed."}\n`,
  );
  process.exitCode = 1;
}
