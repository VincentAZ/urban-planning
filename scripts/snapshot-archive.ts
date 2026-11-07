import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  baselineIdentity,
  canonicalJSON,
  type Place,
} from "../packages/core/src/index";

/** Content-addressed snapshots are append-only, including the bundle being replaced. */
export async function archivePlace(
  place: Place,
  directory = resolve("public/data"),
) {
  const identity = await baselineIdentity(place);
  const archive = resolve(directory, "snapshots");
  await mkdir(archive, { recursive: true });
  const filename = resolve(archive, `${identity.sha256}.json`);
  try {
    await writeFile(filename, canonicalJSON(place), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(filename, "utf8")) as Place;
    if ((await baselineIdentity(existing)).sha256 !== identity.sha256)
      throw new Error(
        "An archived baseline is corrupt; ingestion stopped without replacing it.",
      );
  }
  return { identity, file: `/data/snapshots/${identity.sha256}.json` };
}
