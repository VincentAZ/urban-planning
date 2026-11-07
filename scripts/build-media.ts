import { build } from "vite";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJSON } from "../packages/core/src/canonical.js";

const root = resolve("dist/media-render");
await build({ configFile: resolve("vite.media.config.ts") });
const files: { path: string; bytes: number; sha256: string }[] = [];
async function collect(directory: string, prefix = "") {
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name),
      info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error("Renderer assets cannot be symbolic links.");
    if (info.isDirectory()) await collect(path, `${prefix}${name}/`);
    else if (info.isFile()) {
      const bytes = await readFile(path);
      files.push({
        path: `${prefix}${name}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } else throw new Error("Unsupported renderer asset.");
  }
}
await collect(root);
const profile = {
  version: 1,
  profileVersion: "citymap-media-1.0.0",
  entry: "media-render.html",
  files,
};
const rendererHash = createHash("sha256")
  .update(canonicalJSON(profile))
  .digest("hex");
await writeFile(
  join(root, "renderer-manifest.json"),
  JSON.stringify({ ...profile, rendererHash }, null, 2) + "\n",
);
console.log(
  `Built private media renderer: ${rendererHash} (${files.length} exact assets).`,
);
