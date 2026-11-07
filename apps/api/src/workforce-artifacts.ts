import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  link,
  unlink,
  readdir,
  stat,
  readFile,
  statfs,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { canonicalJSON, workforceContentHash } from "@urban/core";
import type { CapturedWorkforceResult } from "./workforce-runner.js";
import { ApiError } from "./errors.js";

export const WORKFORCE_ARCHIVE_LIMITS = {
  fileBytes: 64 * 1024 ** 2,
  totalBytes: 2 * 1024 ** 3,
} as const;
/** Private immutable archive. No route accepts a filesystem path or returns this directory. */
export class WorkforceArchive {
  private directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  async assertCapacity() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.directory, { withFileTypes: true });
    let bytes = 0;
    for (const file of files) {
      if (!file.isFile())
        throw new ApiError(
          503,
          "WORKFORCE_ARCHIVE_INVALID",
          "The private workforce archive contains an unexpected entry.",
        );
      bytes += (await stat(join(this.directory, file.name))).size;
    }
    const fs = await statfs(this.directory);
    if (
      bytes + WORKFORCE_ARCHIVE_LIMITS.fileBytes >
        WORKFORCE_ARCHIVE_LIMITS.totalBytes ||
      fs.bavail * fs.bsize < 2 * WORKFORCE_ARCHIVE_LIMITS.fileBytes
    )
      throw new ApiError(
        503,
        "WORKFORCE_ARCHIVE_FULL",
        "The private evidence archive needs operator maintenance before another run. Existing evidence was retained.",
      );
  }
  async put(value: CapturedWorkforceResult) {
    const bytes = Buffer.from(canonicalJSON(value));
    if (bytes.length > WORKFORCE_ARCHIVE_LIMITS.fileBytes)
      throw new ApiError(
        413,
        "WORKFORCE_ARTIFACT_TOO_LARGE",
        "The complete routing evidence exceeds the archive limit. No evidence was truncated.",
      );
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== (await workforceContentHash(value)))
      throw new Error("Workforce canonical hashing disagrees.");
    await this.assertCapacity();
    const destination = join(this.directory, `${hash}.json`);
    const temporary = join(this.directory, `${hash}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.verify(hash, bytes.length);
      }
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
    return { hash, bytes: bytes.length };
  }
  async verify(hash: string, bytes: number) {
    await this.readVerified(hash, bytes);
  }
  async readVerified(hash: string, bytes: number): Promise<Buffer> {
    if (
      !/^[a-f0-9]{64}$/.test(hash) ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > WORKFORCE_ARCHIVE_LIMITS.fileBytes
    )
      throw new ApiError(
        503,
        "WORKFORCE_ARTIFACT_UNAVAILABLE",
        "The captured routing archive reference is invalid.",
      );
    try {
      const path = join(this.directory, `${hash}.json`);
      if ((await stat(path)).size !== bytes) throw new Error("size");
      const raw = await readFile(path);
      if (
        raw.length !== bytes ||
        createHash("sha256").update(raw).digest("hex") !== hash
      )
        throw new Error("hash");
      return raw;
    } catch {
      throw new ApiError(
        503,
        "WORKFORCE_ARTIFACT_UNAVAILABLE",
        "The complete private routing archive is missing or changed. Saved summary tables remain available; no replacement was invented.",
      );
    }
  }
}
