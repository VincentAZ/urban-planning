/** Offline projection of retained SUMO internal geometry; no graph editing or route generation. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { canonicalJSON, type Position } from "@urban/core";
import { commuteBytesHash, commuteHash } from "./commute-routing-valhalla.js";
import type { CommuteNativeIndex } from "./commute-routing.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const artifactSchema = z
  .object({
    version: z.literal(2),
    networkHash: hash,
    projectionHash: hash,
    projectionReceipt: z
      .object({
        binarySha256: hash,
        args: z.array(z.string().max(200)).max(20),
        networkXmlHash: hash,
        inputSha256: hash,
        outputSha256: hash,
      })
      .strict(),
    output: z.string().max(64 * 1024 ** 2),
  })
  .strict();
export type CommuteProjectionArtifact = z.infer<typeof artifactSchema>;
function inputs(index: CommuteNativeIndex) {
  const projection = index.xmlProjection;
  if (!projection)
    throw new Error("Native XML must retain its coordinate projection.");
  if (
    !/^\+proj=utm \+zone=(?:[1-9]|[1-5]\d|60)(?: \+south)? \+ellps=WGS84 \+datum=WGS84 \+units=m \+no_defs$/.test(
      projection.parameters,
    )
  )
    throw new Error(
      "Native projection is outside the explicit offline WGS84 UTM profile.",
    );
  const rows = [...index.rawInternalShapes],
    points = rows.flatMap(([, shape]) => shape);
  if (points.length > 500000)
    throw new Error(
      "Internal geometry projection exceeds500,000 points; nothing was omitted.",
    );
  const input = points
    .map(
      (p) =>
        `${p[0] - projection.netOffset[0]} ${p[1] - projection.netOffset[1]}\n`,
    )
    .join("");
  if (Buffer.byteLength(input) > 32 * 1024 ** 2)
    throw new Error("Internal geometry projection input exceeds32MiB.");
  const args = [
    "-f",
    "%.12f",
    ...projection.parameters.split(" "),
    "+to",
    "+proj=longlat",
    "+datum=WGS84",
  ];
  return { rows, points, input, args };
}
function install(
  index: CommuteNativeIndex,
  artifact: CommuteProjectionArtifact,
): CommuteNativeIndex {
  const { rows, points, input, args } = inputs(index),
    receipt = artifact.projectionReceipt;
  if (
    artifact.networkHash !== index.networkHash ||
    receipt.networkXmlHash !== index.networkHash ||
    commuteHash(receipt) !== artifact.projectionHash ||
    canonicalJSON(receipt.args) !== canonicalJSON(args) ||
    commuteBytesHash(input) !== receipt.inputSha256 ||
    commuteBytesHash(artifact.output) !== receipt.outputSha256
  )
    throw new Error(
      "Cached native projection does not match its exact XML, settings, input and output hashes.",
    );
  const coordinates = (
    artifact.output.trim() ? artifact.output.trim().split("\n") : []
  ).map((line) => {
    const values = line.trim().split(/\s+/).map(Number);
    if (
      values.length < 2 ||
      !values.slice(0, 2).every(Number.isFinite) ||
      Math.abs(values[0]) > 180 ||
      Math.abs(values[1]) > 90
    )
      throw new Error("Invalid projected native coordinate.");
    return [values[0], values[1]] as Position;
  });
  if (coordinates.length !== points.length)
    throw new Error("Offline projection omitted native coordinates.");
  const shapes = new Map<string, Position[]>();
  let offset = 0;
  for (const [id, shape] of rows) {
    shapes.set(id, coordinates.slice(offset, offset + shape.length));
    offset += shape.length;
  }
  return {
    ...index,
    internalShapes: shapes,
    projectionReceipt: receipt,
    projectionHash: artifact.projectionHash,
    projectionOutput: artifact.output,
  };
}
/** Replay is pure: no process or network call. The caller supplies a confined, hash-verified retained artifact. */
export function restoreCommuteNativeGeometry(
  index: CommuteNativeIndex,
  bytes: Buffer,
): CommuteNativeIndex {
  if (bytes.length > 64 * 1024 ** 2)
    throw new Error("Projection artifact exceeds64MiB.");
  return install(
    index,
    artifactSchema.parse(JSON.parse(bytes.toString("utf8"))),
  );
}
export function commuteProjectionArtifact(
  index: CommuteNativeIndex,
): CommuteProjectionArtifact {
  if (
    !index.projectionHash ||
    !index.projectionReceipt ||
    index.projectionOutput === null
  )
    throw new Error("A complete retained projection is required.");
  return {
    version: 2,
    networkHash: index.networkHash,
    projectionHash: index.projectionHash,
    projectionReceipt: index.projectionReceipt,
    output: index.projectionOutput,
  };
}
export async function projectCommuteNativeGeometry(
  index: CommuteNativeIndex,
): Promise<CommuteNativeIndex> {
  const { input, args } = inputs(index),
    binary = "/usr/bin/cs2cs";
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PROJ_NETWORK: "OFF" },
      }),
      chunks: Buffer[] = [];
    let bytes = 0,
      errors = 0,
      failed = false;
    const stop = (error: Error) => {
      if (failed) return;
      failed = true;
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(
      () => stop(new Error("Offline geometry projection exceeded30seconds.")),
      30000,
    );
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("data", (b: Buffer) => {
      bytes += b.length;
      if (bytes > 64 * 1024 ** 2)
        stop(new Error("Projection output exceeds64MiB."));
      else chunks.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      errors += b.length;
      if (errors > 65536)
        stop(new Error("Projection error output exceeds limit."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0 || errors)
        reject(new Error("Offline retained-geometry projection failed."));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
  const projectionReceipt = {
    binarySha256: commuteBytesHash(await readFile(binary)),
    args,
    networkXmlHash: index.networkHash,
    inputSha256: commuteBytesHash(input),
    outputSha256: commuteBytesHash(output),
  };
  return install(index, {
    version: 2,
    networkHash: index.networkHash,
    projectionReceipt,
    projectionHash: commuteHash(projectionReceipt),
    output: output.toString("utf8"),
  });
}
