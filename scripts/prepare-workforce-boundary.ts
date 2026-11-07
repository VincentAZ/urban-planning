import { resolve } from "node:path";
import { downloadWorkforceRegionBoundary } from "../apps/api/src/data/workforce-boundary";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2)
  if (
    !["--state", "--directory"].includes(args[i]) ||
    !args[i + 1] ||
    args[i + 1].startsWith("--")
  )
    throw new Error("Use --state 04 and/or --directory PATH.");
const value = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const result = await downloadWorkforceRegionBoundary(
  value("--state", "04"),
  resolve(value("--directory", ".local/workforce/boundaries")),
);
const polygons =
  result.boundary.geometry.type === "Polygon"
    ? [result.boundary.geometry.coordinates]
    : result.boundary.geometry.coordinates;
process.stdout.write(
  JSON.stringify({
    filename: result.filename,
    sha256: result.sha256,
    bytes: result.bytes,
    counties: result.boundary.countyGeoids,
    parts: polygons.length,
    vertices: polygons.flat(2).length,
    sources: result.boundary.sources,
  }) + "\n",
);
