import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  baselineIdentity,
  canonicalJSON,
  validatePlace,
  type Place,
} from "@urban/core";
import { ApiError, notFound } from "./errors.js";

export class PlaceCatalog {
  constructor(private directory = resolve("public/data")) {}
  async list() {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const places: Place[] = [];
    for (const name of names.filter(
      (n) =>
        /^[a-z0-9_-]+\.json$/i.test(n) &&
        n !== "manifest.json" &&
        !n.endsWith("-source.json") &&
        !n.startsWith("acs-"),
    )) {
      const data = JSON.parse(
        await readFile(resolve(this.directory, name), "utf8"),
      ) as Place;
      if (
        data.id &&
        data.center &&
        Array.isArray(data.buildings) &&
        Array.isArray(data.roads)
      )
        places.push(data);
    }
    return places;
  }
  async get(id: string): Promise<Place> {
    // Resolve against manifests, never concatenate an untrusted URL segment into a filesystem path.
    const places = await this.list();
    const place = places.find(
      (p) =>
        p.id === id ||
        p.zip === id ||
        (id === "phoenix" && p.city.toLowerCase() === "phoenix"),
    );
    if (!place) throw notFound();
    return place;
  }
  async getSnapshot(id: string, sha256: string): Promise<Place> {
    if (!/^[a-f0-9]{64}$/.test(sha256))
      throw new ApiError(
        400,
        "BASELINE_IDENTITY",
        "A valid baseline snapshot hash is required.",
      );
    try {
      const place = validatePlace(
        JSON.parse(
          await readFile(
            resolve(this.directory, "snapshots", `${sha256}.json`),
            "utf8",
          ),
        ),
      );
      if (place.id !== id || (await baselineIdentity(place)).sha256 !== sha256)
        throw new ApiError(
          409,
          "BASELINE_CORRUPT",
          "The archived baseline does not match its identity. Your project was not saved.",
        );
      return place;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const current = await this.get(id);
    if ((await baselineIdentity(current)).sha256 === sha256) return current;
    throw new ApiError(
      409,
      "BASELINE_UNAVAILABLE",
      "This exact baseline is not available on the server. Keep your complete project export; choose a server with this snapshot or explicitly start a new project from current data.",
    );
  }
  /** Publish a complete prepared bundle only after immutable data and provenance are durable. */
  async put(place: Place, sourceRecord: unknown) {
    if (!/^[a-z0-9_-]+$/.test(place.id))
      throw new Error("Invalid prepared place ID.");
    validatePlace(place);
    const identity = await baselineIdentity(place);
    const source = canonicalJSON(sourceRecord);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const append = async (folder: string, hash: string, contents: string) => {
      await mkdir(resolve(this.directory, folder), { recursive: true });
      const filename = resolve(this.directory, folder, `${hash}.json`);
      try {
        await writeFile(filename, contents, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readFile(filename, "utf8")) !== contents)
          throw new Error(
            "An immutable source archive failed its integrity check.",
          );
      }
    };
    await append("sources", sourceHash, source);
    await append("snapshots", identity.sha256, canonicalJSON(place));
    const manifest = canonicalJSON({
      schemaVersion: 1,
      identity,
      sourceSha256: sourceHash,
      sourceFile: `/data/sources/${sourceHash}.json`,
      file: `/data/snapshots/${identity.sha256}.json`,
      preparedAt: place.loadedAt,
    });
    await append("manifests", identity.sha256, manifest);
    await mkdir(this.directory, { recursive: true });
    const destination = resolve(this.directory, `${place.id}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, canonicalJSON(place));
    await rename(temporary, destination);
    return identity;
  }
}
