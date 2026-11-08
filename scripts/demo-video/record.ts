/** Drives the real app and records each demo scene with the Chromium screencast.
 *
 *   corepack pnpm exec tsx scripts/demo-video/record.ts [--dry]
 *
 * --dry runs every interaction with no holds or capture and saves a screenshot per scene.
 * Requires the demo environment from docs/DEMO.md. Nothing here is mocked: the only
 * injected DOM is the recording cursor and the full-screen view of the exported PDF.
 */
import { chromium, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dry = process.argv.includes("--dry");
const stopAfter = process.argv.find((arg) => arg.startsWith("--stop-after="))?.split("=")[1];
class StopAfter extends Error {}
const out = resolve(".local/demo-video");
const shots = resolve(out, "dry");
mkdirSync(shots, { recursive: true });
interface Beat { start: number; duration: number; text: string }
const timing = JSON.parse(readFileSync(resolve(out, "timing.json"), "utf8")) as Record<
  string,
  { beats: Beat[]; total: number }
>;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const cursorScript = () => {
  addEventListener("DOMContentLoaded", () => {
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.style.cssText =
      "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(960px,540px);";
    cursor.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 11-7 1.5L9.5 22z" fill="#123" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.append(cursor);
    addEventListener("mousemove", (e) => {
      cursor.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
    }, true);
    addEventListener("mousedown", (e) => {
      const ring = document.createElement("div");
      ring.style.cssText = `position:fixed;left:${e.clientX - 18}px;top:${e.clientY - 18}px;width:36px;height:36px;border-radius:50%;border:3px solid #2f6f5e;z-index:2147483646;pointer-events:none;transition:transform .45s ease-out,opacity .45s ease-out;`;
      document.body.append(ring);
      requestAnimationFrame(() => { ring.style.transform = "scale(1.7)"; ring.style.opacity = "0"; });
      setTimeout(() => ring.remove(), 500);
    }, true);
  });
};

class Director {
  private frames: { t: number; file: string }[] = [];
  private compress: { a: number; b: number; target: number; label: string }[] = [];
  private t0 = 0;
  private dir = "";
  private recording = false;
  private id = "";
  private cdp!: Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>;
  mouse = { x: 960, y: 540 };
  constructor(readonly page: Page) {}
  async attach() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on("Page.screencastFrame", (frame) => {
      void this.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      if (!this.recording) return;
      const file = `${String(this.frames.length).padStart(6, "0")}.jpg`;
      writeFileSync(resolve(this.dir, file), Buffer.from(frame.data, "base64"));
      this.frames.push({ t: frame.metadata.timestamp ?? Date.now() / 1000, file });
    });
  }
  private effective(now = Date.now() / 1000) {
    let e = now - this.t0;
    for (const c of this.compress) e -= c.b - c.a - c.target;
    return e;
  }
  async begin(id: string) {
    this.id = id;
    if (dry) return;
    this.dir = resolve(out, "frames", id);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.compress = [];
    this.recording = true;
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
    this.t0 = Date.now() / 1000;
  }
  /** Waits until narration beat `index` starts. */
  async beat(index: number, early = 0) {
    if (dry) return;
    const start = timing[this.id].beats[index].start - early;
    const late = this.effective() - start;
    if (late > 0.6) console.warn(`  ${this.id}: beat ${index} late by ${late.toFixed(1)}s`);
    if (late < 0) await sleep(-late * 1000);
  }
  /** Runs a genuine long wait, and shortens only its footage to `target` seconds. */
  async fast(label: string, target: number, run: () => Promise<void>) {
    const a = Date.now() / 1000;
    await run();
    const b = Date.now() / 1000;
    console.log(`  ${this.id}: ${label} took ${(b - a).toFixed(1)}s real time`);
    if (dry) return;
    this.compress.push({ a, b, target: Math.min(target, b - a), label });
  }
  async end() {
    await this.finish();
    if (stopAfter === this.id) throw new StopAfter();
  }
  private async finish() {
    if (dry) {
      await sleep(1500);
      await this.page.screenshot({ path: resolve(shots, `${this.id}.png`) });
      console.log("ok", this.id);
      return;
    }
    const left = timing[this.id].total + 0.7 - this.effective();
    if (left > 0) await sleep(left * 1000);
    else console.warn(`  ${this.id}: runs ${(-left).toFixed(1)}s past its narration`);
    const end = Date.now() / 1000;
    await this.cdp.send("Page.stopScreencast");
    this.recording = false;
    const map = (t: number) => {
      let e = t - this.t0;
      for (const c of this.compress) {
        if (t >= c.b) e -= c.b - c.a - c.target;
        else if (t > c.a) e -= (t - c.a) * (1 - c.target / (c.b - c.a));
      }
      return Math.max(0, e);
    };
    const kept: { e: number; file: string }[] = [];
    for (const f of this.frames) {
      const e = map(f.t);
      if (!kept.length || e - kept[kept.length - 1].e >= 1 / 45) kept.push({ e, file: f.file });
    }
    const total = map(end);
    const lines = ["ffconcat version 1.0"];
    kept.forEach((f, i) => {
      if (i === 0 && f.e > 0) lines.push(`file '${f.file}'`, `duration ${f.e.toFixed(4)}`);
      lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, (kept[i + 1]?.e ?? total) - f.e).toFixed(4)}`);
    });
    lines.push(`file '${kept[kept.length - 1].file}'`);
    writeFileSync(resolve(this.dir, "frames.ffconcat"), lines.join("\n"));
    let shift = 0;
    const notes = this.compress.map((c) => {
      const start = c.a - this.t0 - shift;
      shift += c.b - c.a - c.target;
      return { start, end: start + c.target, realSeconds: Math.round(c.b - c.a), label: c.label };
    });
    writeFileSync(resolve(this.dir, "scene.json"), JSON.stringify({ duration: total, notes }));
    console.log(`ok ${this.id}: ${total.toFixed(1)}s, ${kept.length} frames, ${(kept.length / total).toFixed(0)} fps avg`);
  }
  /** Moves the visible cursor over a smooth path. */
  async glide(x: number, y: number, ms = 550) {
    const steps = Math.max(8, Math.round(ms / 16));
    const from = { ...this.mouse };
    for (let i = 1; i <= steps; i++) {
      const p = i / steps, ease = p * p * (3 - 2 * p);
      await this.page.mouse.move(from.x + (x - from.x) * ease, from.y + (y - from.y) * ease);
      await sleep(ms / steps);
    }
    this.mouse = { x, y };
  }
  async click(target: Locator, ms = 420) {
    await target.waitFor({ state: "visible" });
    await expect(target).toBeEnabled({ timeout: 90_000 });
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    await this.glide(box.x + box.width / 2, box.y + box.height / 2, ms);
    await target.click();
  }
  async wheel(delta: number, times: number, gap = 90) {
    for (let i = 0; i < times; i++) {
      await this.page.mouse.wheel(0, delta);
      await sleep(gap);
    }
  }
  /** Rotates or pans with the map's real drag handling. */
  async drag(dx: number, dy: number, ms = 1800, right = false) {
    await this.page.mouse.down({ button: right ? "right" : "left" });
    const start = { ...this.mouse };
    await this.glide(start.x + dx, start.y + dy, ms);
    await this.page.mouse.up({ button: right ? "right" : "left" });
  }
  hold(ms: number) { return sleep(dry ? Math.min(ms, 200) : ms); }
}

const account = JSON.parse(readFileSync(resolve(out, "account.json"), "utf8")) as { name: string };
const storage = JSON.parse(readFileSync(resolve(out, "storage.json"), "utf8")) as { cookies: never[] };

async function main() {
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--ignore-gpu-blocklist", "--enable-webgl", "--use-gl=angle", "--use-angle=gl-egl"],
  });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    acceptDownloads: true,
    storageState: { cookies: storage.cookies, origins: [] },
  });
  await context.addInitScript(cursorScript);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => console.warn("PAGEERROR", e.message.slice(0, 200)));
  const d = new Director(page);
  await d.attach();
  try {
    await scenes(page, d);
  } catch (error) {
    if (!(error instanceof StopAfter)) {
      await page.screenshot({ path: resolve(out, "failure.png") }).catch(() => {});
      throw error;
    }
  } finally {
    await browser.close();
  }
}

async function scenes(page: Page, d: Director) {
  const tab = (name: string) => page.getByRole("button", { name, exact: true }).first();
  const dialog = () => page.getByRole("dialog").last();
  const closeDialog = () => d.click(dialog().getByRole("button", { name: "Close dialog", exact: true }));
  const settled = async () => {
    await expect(page.locator(".scorecard-scroll")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
    await expect(page.locator(".city-map-loading")).toHaveCount(0, { timeout: 30_000 });
  };

  // Off camera: open the prepared area and save it to the demo account.
  await page.goto("/".replace("/", "http://127.0.0.1:5173/"));
  await page.waitForSelector(".maplibregl-canvas", { timeout: 40_000 });
  await expect(page.locator(".account-button")).toContainText(account.name);
  await sleep(3000);
  await tab("Explore another place").click();
  await page.getByRole("textbox", { name: "Search places or buildings" }).fill("85004");
  await page.getByRole("button", { name: "Search places", exact: true }).click();
  await page.getByRole("button", { name: "Open prepared area" }).first().click();
  await expect(page.locator(".map-disclosure")).toContainText("Census 2020 ZCTA 85004", { timeout: 30_000 });
  await settled();
  await page.getByRole("button", { name: "Open project home" }).click();
  await page.getByRole("button", { name: "Save current project to account", exact: true }).click();
  await page.getByText("Project saved to your private workspace.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await sleep(7000); // Let the save toast leave and the map finish drawing.

  const map = (await page.locator(".maplibregl-canvas").first().boundingBox())!;
  const mapX = (f: number) => map.x + map.width * f;
  const mapY = (f: number) => map.y + map.height * f;

  await d.begin("hook");
  await d.glide(mapX(0.5), mapY(0.52), 1200);
  await d.beat(1);
  await d.wheel(-100, 26, 130);
  await d.beat(3);
  await d.drag(-160, 0, 2400, true);
  await d.end();

  await d.begin("place");
  await expect(page.getByRole("region", { name: "Community context" })).toContainText("90% MOE");
  await d.beat(2, 1.2);
  await d.click(tab("2D plan"));
  await d.hold(800);
  await d.click(tab("Satellite"));
  await d.hold(1000);
  await d.click(tab("3D city"));
  await d.beat(3);
  await d.glide(mapX(0.5), mapY(0.5));
  await page.mouse.click(mapX(0.5), mapY(0.5));
  await d.hold(900);
  await d.click(page.locator(".building-inspector summary").filter({ hasText: "Sources and site context" }));
  await d.hold(1500);
  await d.end();

  const streetSearch = async (name: string) => {
    const search = page.getByRole("textbox", { name: "Find a street", exact: true });
    await search.waitFor();
    await search.fill("");
    await d.click(search);
    await search.pressSequentially(name, { delay: dry ? 0 : 25 });
  };

  await d.begin("proposal");
  await d.click(tab("Build"));
  await d.click(page.locator(".building-library").getByRole("button", { name: /Apartments/ }));
  await d.glide(mapX(0.411), mapY(0.44));
  await page.mouse.click(mapX(0.411), mapY(0.44));
  const editor = page.locator('[aria-label="Building editor"]');
  await editor.waitFor();
  await d.hold(700);
  await d.click(editor.getByRole("button", { name: "Apply building", exact: true }));
  await settled();
  await d.beat(1);
  await d.click(tab("Mobility"));
  await d.hold(200);
  const street = page.locator('[aria-label="Streets in this scenario"]').getByRole("button").filter({ hasText: "osm-way-1069097895" });
  await streetSearch("North 2nd");
  await d.click(street);
  await page.getByText("Protected bike lane").first().waitFor();
  await d.click(page.getByText("Protected bike lane").first());
  await d.click(page.getByRole("button", { name: /Apply street changes/ }));
  await settled();
  await d.beat(2);
  await d.click(page.getByRole("button", { name: "Before / after", exact: true }));
  const slider = page.getByRole("slider", { name: "Before / after reveal", exact: true });
  await slider.waitFor();
  const track = (await slider.boundingBox())!;
  await d.glide(track.x + track.width / 2, track.y + track.height / 2);
  await d.drag(-260, 0, 800);
  await d.drag(460, 0, 1000);
  await d.hold(300);
  await d.end();
  await page.getByRole("button", { name: "Back to scenario", exact: true }).click();

  await d.begin("scorecard");
  await d.beat(1);
  await expect(page.locator(".scorecard-scroll")).toContainText("+48");
  await d.beat(2);
  await d.click(page.locator(".scorecard-scroll button").filter({ hasText: "Homes" }).first());
  await d.hold(2200);
  await d.beat(3);
  await d.end();
  const metricClose = page.getByRole("button", { name: /Close dialog|Back/ }).first();
  if (await metricClose.count()) await metricClose.click();

  await d.begin("planner");
  await d.click(tab("Layers"));
  await d.click(page.getByRole("button", { name: /^(Explore flood evidence|Review flood exposure)$/ }));
  await d.click(dialog().getByRole("button", { name: "Attach flood map", exact: true }));
  await dialog().getByText(/Map attached/).waitFor({ timeout: 40_000 });
  await expect(dialog().getByText("Calculating footprint intersections…")).toHaveCount(0, { timeout: 30_000 });
  await d.beat(1);
  const floodText = await dialog().innerText();
  if (!/Proposal · potential homes\s*0/.test(floodText) || !/Captured baseline · potential homes\s*0/.test(floodText))
    throw new Error("Narration says no homes are in a mapped flood zone, but the screen disagrees.");
  await d.beat(2, 0.5);
  await closeDialog();
  await page.getByRole("combobox", { name: "Scorecard domain", exact: true }).selectOption("Housing");
  await d.click(page.getByRole("button", { name: "Review housing affordability", exact: true }));
  const hud = dialog().getByRole("textbox", { name: "Area or jurisdiction name", exact: true });
  await d.click(hud);
  await hud.pressSequentially("Phoenix", { delay: dry ? 0 : 70 });
  await d.click(dialog().getByRole("button", { name: "Search HUD areas", exact: true }));
  await d.click(dialog().getByRole("button", { name: /^Review Phoenix-Mesa-Chandler/ }));
  await dialog().getByRole("region", { name: "Published annual income limits" }).waitFor();
  await dialog().getByRole("region", { name: "Published annual income limits" }).scrollIntoViewIfNeeded();
  await d.beat(3);
  await d.end();
  await closeDialog();
  const discard = page.getByRole("button", { name: /Discard draft/ });
  if (await discard.count()) await discard.first().click();
  await page.getByRole("combobox", { name: "Scorecard domain", exact: true }).selectOption({ index: 0 });

  // Off camera: the flood tint and legend would crowd the rest of the map shots.
  await tab("Layers").click();
  await page.getByText("Captured flood zones", { exact: true }).first().click();
  await sleep(800);

  await d.begin("economic");
  await d.click(tab("Economy"));
  await d.click(tab("Readiness"));
  await d.click(page.getByRole("button", { name: /Explore workforce|Open workforce/ }));
  const shed = page.getByRole("dialog", { name: "Who can reach this site?", exact: true });
  await shed.waitFor();
  const saveToRun = shed.getByRole("button", { name: "Save project to run" });
  const run = shed.getByRole("button", { name: "Run workforce shed" });
  await expect.poll(async () => (await saveToRun.count()) > 0 || (await run.isEnabled()), { timeout: 30_000 }).toBe(true);
  if (await saveToRun.count()) await d.click(saveToRun);
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await d.beat(1);
  await d.click(run);
  const adopt = shed.getByRole("button", { name: "Save capture to scenario", exact: true });
  await d.fast("workforce routing", 3, async () => {
    await adopt.waitFor({ timeout: 420_000 });
  });
  await d.beat(2);
  await d.hold(1200);
  await d.click(adopt);
  await expect(shed).toContainText("Saved with this scenario", { timeout: 30_000 });
  await d.hold(1000);
  await d.click(shed.getByRole("button", { name: "Done", exact: true }));
  await d.click(tab("Incentives"));
  await d.click(page.getByRole("button", { name: /^(Build a fiscal study|Open fiscal study)$/ }));
  await d.beat(3);
  await d.hold(4300);
  await closeDialog();
  if (await discard.count()) await discard.first().click();
  await d.beat(4);
  await d.click(tab("Retail gaps"));
  await d.hold(1200);
  await d.end();

  await d.begin("traffic");
  await d.click(tab("Mobility"));
  await d.click(page.getByRole("button", { name: "Open traffic workbench", exact: true }));
  const quick = page.getByRole("button", { name: "Quick run: simulate rush hour", exact: true });
  await expect(quick).toBeEnabled({ timeout: 60_000 });
  await d.beat(1);
  await d.click(quick);
  await d.fast("SUMO rush-hour simulation", 5, async () => {
    await expect(quick).toBeHidden({ timeout: 280_000 });
    await expect(page.locator(".city-map-activity")).toContainText(/SUMO-simulated vehicles · 7:00–8:00/, { timeout: 30_000 });
  });
  const label = (await page.locator(".city-map-activity").textContent()) ?? "";
  console.log("  traffic label:", label.trim());
  await streetSearch("North Central");
  await d.click(page.locator('[aria-label="Streets in this scenario"]').getByRole("button").filter({ hasText: "osm-way-436945743" }));
  await d.click(page.locator(".speed-button"));
  await expect(page.locator(".speed-button")).toHaveText(/5×/);
  await d.click(tab("2D plan"));
  await d.glide(mapX(0.5), mapY(0.5));
  await d.wheel(100, 8, 130);
  await d.drag(120, -170, 900);
  await d.beat(3);
  await d.glide(1740, 620);
  await d.beat(4);
  await d.beat(5);
  await d.glide(mapX(0.66), mapY(0.38));
  await d.wheel(-100, 7, 130);
  await d.glide(1740, 620);
  await d.hold(1500);
  await d.end();

  await d.begin("report");
  await d.click(page.getByRole("button", { name: "Export", exact: true }).first());
  const take = page.getByRole("dialog", { name: "Take the story with you.", exact: true });
  const downloading = page.waitForEvent("download", { timeout: 180_000 });
  await expect(take).toContainText("Editable report · Word");
  await d.hold(2500);
  await d.click(take.getByRole("button", { name: /^Staff report · PDF/ }));
  let pdfPath = "";
  await d.fast("staff report PDF", 2, async () => {
    const download = await downloading;
    pdfPath = resolve(out, "staff-report.pdf");
    await download.saveAs(pdfPath);
  });
  execFileSync("pdftoppm", ["-f", "1", "-l", "1", "-r", "90", "-png", "-singlefile", pdfPath, resolve(out, "report-page")]);
  const png = readFileSync(resolve(out, "report-page.png")).toString("base64");
  await page.evaluate((data) => {
    const view = document.createElement("div");
    view.style.cssText = "position:fixed;inset:0;background:#20302b;display:flex;align-items:center;justify-content:center;z-index:2147483000;";
    view.innerHTML = `<img src="data:image/png;base64,${data}" style="height:96vh;box-shadow:0 12px 50px #0008"/>`;
    document.body.append(view);
  }, png);
  await d.beat(2);
  await d.end();
}
main().catch((error) => { console.error(String(error).slice(0, 600)); process.exit(1); });
