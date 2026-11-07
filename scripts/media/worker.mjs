/** Trusted offline runner. Its only input is a schema-validated frozen scene/recipe. */
import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

const OUT = "/out",
  RENDERER = "/renderer";
const FILE_CAP = 192 * 1024 ** 2;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, message) => Object.assign(new Error(message), { code });
const progress = (stage, completedFrames) =>
  process.stdout.write(JSON.stringify({ stage, completedFrames }) + "\n");
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sort(value[k])]),
    );
  return value;
}
async function bounded(path, cap) {
  if ((await stat(path)).size > cap)
    throw fail(
      "MEDIA_OUTPUT_TOO_LARGE",
      "Media output exceeds its byte limit.",
    );
  const bytes = await readFile(path);
  if (bytes.length > cap)
    throw fail(
      "MEDIA_OUTPUT_TOO_LARGE",
      "Media output exceeds its byte limit.",
    );
  return bytes;
}
async function command(bin, args) {
  const child = spawn(bin, args, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    bytes = 0;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) child.kill("SIGKILL");
      else output += chunk.toString();
    });
  const [code] = await once(child, "close");
  if (code !== 0 || bytes > 256 * 1024)
    throw fail("MEDIA_ENCODER_FAILED", "The bounded media verifier failed.");
  return output;
}
function encoder(width, height) {
  const child = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "image2pipe",
      "-framerate",
      "30",
      "-vcodec",
      "png",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
      "-movflags",
      "+faststart",
      "-map_metadata",
      "-1",
      "-metadata",
      "creation_time=1970-01-01T00:00:00Z",
      "-fs",
      String(FILE_CAP - 1024 ** 2),
      "-f",
      "mp4",
      join(OUT, "output.mp4"),
    ],
    { shell: false, stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 256 * 1024) child.kill("SIGKILL");
  });
  let inputError;
  child.stdin.on("error", (error) => {
    inputError = error;
  });
  const done = once(child, "close").then(([code]) => {
    if (code !== 0 || stderrBytes > 256 * 1024 || inputError)
      throw fail(
        "MEDIA_ENCODER_FAILED",
        "The media encoder failed; no partial movie was accepted.",
      );
  });
  // Keep early failure observed while frames are still being rendered.
  done.catch(() => {});
  return {
    child,
    done,
    async write(bytes) {
      if (inputError || child.exitCode !== null)
        throw fail(
          "MEDIA_ENCODER_FAILED",
          "The media encoder stopped before all frames.",
        );
      if (!child.stdin.write(bytes))
        await Promise.race([once(child.stdin, "drain"), done]);
    },
    end() {
      child.stdin.end();
      return done;
    },
  };
}
let browser, server, encoding;
try {
  const request = JSON.parse(
    (await bounded("/input/request.json", 40 * 1024 ** 2)).toString(),
  );
  const { scene, recipe, frameCount, runtimeIdentity, scheduledCameras } =
    request;
  if (
    !Array.isArray(scheduledCameras) ||
    scheduledCameras.length !== frameCount
  )
    throw fail(
      "MEDIA_INPUT_INVALID",
      "The complete authoritative camera schedule is required.",
    );
  if (
    !Number.isInteger(frameCount) ||
    frameCount < 1 ||
    frameCount > 30000 ||
    !["png", "mp4"].includes(recipe.format)
  )
    throw fail("MEDIA_INPUT_INVALID", "Invalid bounded media request.");
  const profile = JSON.parse(
    (
      await bounded(join(RENDERER, "renderer-manifest.json"), 1024 * 1024)
    ).toString(),
  );
  const { rendererHash, ...base } = profile;
  if (
    sha(canonical(base)) !== rendererHash ||
    rendererHash !== runtimeIdentity.rendererHash
  )
    throw fail("MEDIA_RENDERER_CHANGED", "The exact renderer profile changed.");
  const assets = new Map();
  for (const item of profile.files) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(item.path) ||
      item.path.includes("..")
    )
      throw fail("MEDIA_RENDERER_INVALID", "Invalid renderer inventory.");
    const bytes = await bounded(join(RENDERER, item.path), 32 * 1024 ** 2);
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256)
      throw fail("MEDIA_RENDERER_CHANGED", "A renderer asset changed.");
    assets.set("/" + item.path, bytes);
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".ttf": "font/ttf",
    ".woff2": "font/woff2",
    ".png": "image/png",
  };
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const data = assets.get(path);
    if (req.method !== "GET" || !data) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader(
      "Content-Type",
      Object.entries(types).find(([ext]) => path.endsWith(ext))?.[1] ??
        "application/octet-stream",
    );
    res.setHeader("Content-Length", data.length);
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.end(data);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--enable-webgl",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-background-networking",
      "--disable-component-update",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: recipe.width, height: recipe.height },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  let blocked = false,
    pageFailed = false;
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (
      url.startsWith(origin + "/") ||
      url.startsWith("blob:") ||
      url.startsWith("data:")
    )
      return route.continue();
    blocked = true;
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.on("pageerror", () => {
    pageFailed = true;
  });
  await page.goto(origin + "/" + profile.entry, {
    waitUntil: "load",
    timeout: 30000,
  });
  await page.waitForFunction(() => !!window.urbanMediaRenderer, {
    timeout: 30000,
  });
  const loaded = await page.evaluate(
    async ({ scene, recipe }) => window.urbanMediaRenderer.load(scene, recipe),
    { scene, recipe },
  );
  if (
    loaded.sceneHash !== scene.sceneHash ||
    loaded.recipeHash !== sha(canonical(recipe)) ||
    loaded.frameCount !== frameCount
  )
    throw fail(
      "MEDIA_SCENE_MISMATCH",
      "The rendered scene does not match the reviewed export.",
    );
  if (blocked || pageFailed)
    throw fail(
      "MEDIA_RENDERER_FAILED",
      "The offline renderer did not initialize cleanly.",
    );
  const frames = [];
  let cached;
  if (recipe.format === "mp4") encoding = encoder(recipe.width, recipe.height);
  const holdStarts = new Map();
  if (recipe.format === "mp4") {
    let start = 0;
    for (const stop of recipe.stops) {
      holdStarts.set(start, { end: start + stop.holdFrames });
      start += stop.holdFrames + stop.transitionFrames;
    }
  }
  let holdStart = -1,
    holdEnd = -1;
  for (let index = 0; index < frameCount; index++) {
    const hold = holdStarts.get(index);
    if (hold) {
      holdStart = index;
      holdEnd = hold.end;
    }
    let bytes, receipt;
    if (index > holdStart && index < holdEnd && cached?.index === holdStart) {
      bytes = cached.bytes;
      receipt = {
        ...cached.receipt,
        index,
        timestampMicroseconds: Math.floor((index * 1_000_000) / 30),
        durationMicroseconds:
          Math.floor(((index + 1) * 1_000_000) / 30) -
          Math.floor((index * 1_000_000) / 30),
        reusedFromFrame: holdStart,
      };
    } else {
      const ack = await page.evaluate(
        ({ index, camera }) =>
          window.urbanMediaRenderer.renderFrame(index, camera),
        { index, camera: scheduledCameras[index] },
      );
      if (
        blocked ||
        pageFailed ||
        ack.index !== index ||
        ack.sceneHash !== scene.sceneHash ||
        ack.recipeHash !== loaded.recipeHash ||
        ack.width !== recipe.width ||
        ack.height !== recipe.height
      )
        throw fail(
          "MEDIA_FRAME_MISMATCH",
          "A frame did not match its exact scene, index or dimensions.",
        );
      const output = page.locator("#urban-media-output");
      const box = await output.boundingBox();
      if (
        !box ||
        box.x !== 0 ||
        box.y !== 0 ||
        box.width !== recipe.width ||
        box.height !== recipe.height
      )
        throw fail(
          "MEDIA_DIMENSION_MISMATCH",
          "The compositor changed its requested output dimensions.",
        );
      bytes = await output.screenshot({
        type: "png",
        animations: "disabled",
        timeout: 30000,
      });
      if (
        bytes.length > 32 * 1024 ** 2 ||
        bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
        bytes.readUInt32BE(16) !== recipe.width ||
        bytes.readUInt32BE(20) !== recipe.height
      )
        throw fail(
          "MEDIA_DIMENSION_MISMATCH",
          "The PNG does not have the requested dimensions.",
        );
      await page.evaluate(
        (index) => window.urbanMediaRenderer.assertFrame(index),
        index,
      );
      if (blocked || pageFailed)
        throw fail(
          "MEDIA_RENDERER_FAILED",
          "The captured frame lost renderer integrity.",
        );
      const {
        sceneHash,
        recipeHash,
        generation,
        drawSerial,
        requestedCamera,
        actualCamera,
        width,
        height,
        timestampMicroseconds,
        durationMicroseconds,
      } = ack;
      receipt = {
        index,
        sceneHash,
        recipeHash,
        generation,
        drawSerial,
        requestedCamera,
        actualCamera,
        width,
        height,
        timestampMicroseconds,
        durationMicroseconds,
        pixelHash: sha(bytes),
      };
      if (index === holdStart) cached = { index, bytes, receipt };
      if (index === 0)
        await writeFile(
          join(OUT, recipe.format === "png" ? "output.png" : "thumbnail.png"),
          bytes,
          { mode: 0o600, flag: "wx" },
        );
    }
    frames.push(receipt);
    if (encoding) await encoding.write(bytes);
    if (
      index === 0 ||
      (index + 1) % Math.max(30, Math.ceil(frameCount / 100)) === 0 ||
      index + 1 === frameCount
    ) {
      progress("rendering", index + 1);
      if (
        encoding &&
        (await stat(join(OUT, "output.mp4")).catch(() => ({ size: 0 }))).size >
          FILE_CAP
      )
        throw fail(
          "MEDIA_OUTPUT_TOO_LARGE",
          "The encoded movie exceeds its byte limit.",
        );
    }
  }
  progress("encoding", frameCount);
  if (encoding) await encoding.end();
  progress("verifying", frameCount);
  let probe = null;
  if (recipe.format === "mp4") {
    await bounded(join(OUT, "output.mp4"), FILE_CAP);
    probe = JSON.parse(
      await command("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_frames",
        "-show_entries",
        "stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,duration:format=duration",
        "-of",
        "json",
        join(OUT, "output.mp4"),
      ]),
    );
    const stream = probe.streams?.[0];
    if (
      probe.streams?.length !== 1 ||
      stream.codec_name !== "h264" ||
      stream.width !== recipe.width ||
      stream.height !== recipe.height ||
      stream.r_frame_rate !== "30/1" ||
      stream.avg_frame_rate !== "30/1" ||
      Number(stream.nb_read_frames) !== frameCount ||
      Math.abs(Number(stream.duration) - frameCount / 30) > 0.001
    )
      throw fail(
        "MEDIA_VIDEO_MISMATCH",
        "The encoded movie omitted frames or changed its duration or format.",
      );
  }
  await writeFile(join(OUT, "frames.json"), canonical(frames), {
    mode: 0o600,
    flag: "wx",
  });
  const result = {
    ok: true,
    frameCount,
    width: recipe.width,
    height: recipe.height,
    chromium: browser.version(),
    ffmpeg: (await command("ffmpeg", ["-version"])).split("\n")[0],
    probe,
  };
  await browser.close();
  browser = null;
  await new Promise((resolve) => server.close(resolve));
  server = null;
  await writeFile(join(OUT, "response.json"), JSON.stringify(result), {
    mode: 0o600,
    flag: "wx",
  });
} catch (error) {
  encoding?.child.kill("SIGKILL");
  await browser?.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  await writeFile(
    join(OUT, "response.json"),
    JSON.stringify({
      ok: false,
      error: {
        code: error.code?.startsWith("MEDIA_")
          ? error.code
          : "MEDIA_RENDERER_FAILED",
        message: error.code?.startsWith("MEDIA_")
          ? error.message
          : "The isolated media renderer failed. No partial output was accepted.",
      },
    }),
    { mode: 0o600 },
  ).catch(() => {});
  process.exitCode = 1;
}
