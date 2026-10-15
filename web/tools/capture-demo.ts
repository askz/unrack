// Records docs/demo.webp, the README's animated screenshot: the Pages build of the app on
// the demo device, walking through six pages with one small edit on each. Needs Chrome or
// Chromium (CHROME_PATH, else google-chrome-stable or chromium on the PATH) and ffmpeg
// with the libwebp_anim encoder.
//
//   npm run capture:demo
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";

const VIEWPORT = { width: 1280, height: 800 };
const FPS = 12;
// Lossless: the lossy animation encoder keeps the previous frame wherever pixels differ only
// a little, which leaves ghosts of the last page on the dark, low-contrast panels. With
// -lossless 1, ffmpeg's -quality is the compression effort, not the image quality.
const WEBP_EFFORT = 70;
const WEB_DIR = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(WEB_DIR, "../docs/demo.webp");
const BASE_PATH = "/opendsp-4x4/";
const STEP_TIMEOUT_MS = 5000;

interface Point { x: number; y: number }
interface Frame { timestamp: number; data: string }

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function commandPath(name: string): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) return fromEnv;
  for (const name of ["google-chrome-stable", "chromium"]) {
    const path = commandPath(name);
    if (path) return path;
  }
  throw new Error("Chrome not found: set CHROME_PATH, or install google-chrome-stable or chromium");
}

function checkFfmpeg(): void {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("ffmpeg not found on the PATH");
  if (!result.stdout.includes("libwebp_anim")) throw new Error("this ffmpeg has no libwebp_anim encoder");
}

function build(): void {
  const result = spawnSync("npm", ["run", "build"], { cwd: WEB_DIR, stdio: "inherit" });
  if (result.status !== 0) throw new Error("npm run build failed");
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function startPreview(port: number): ChildProcess {
  const vite = join(WEB_DIR, "node_modules/.bin/vite");
  return spawn(vite, ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: WEB_DIR, stdio: "ignore" });
}

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`the preview server did not answer at ${url}`);
}

/** Runs in the page: a dot that follows the pointer, so clicks and drags show in the recording. */
function installCursor(): void {
  let x = -100;
  let y = -100;
  let pressed = false;
  const dot = document.createElement("div");
  dot.style.cssText = [
    "position:fixed", "left:0", "top:0", "width:18px", "height:18px", "margin:-9px 0 0 -9px", "border-radius:50%",
    "background:rgba(255,255,255,.85)", "border:2px solid rgba(0,0,0,.6)", "box-shadow:0 0 6px rgba(0,0,0,.5)",
    "pointer-events:none", "z-index:2147483647",
  ].join(";");
  const place = () => { dot.style.transform = `translate(${x}px, ${y}px) scale(${pressed ? 0.7 : 1})`; };
  addEventListener("pointermove", (event) => { x = event.clientX; y = event.clientY; place(); }, true);
  addEventListener("pointerdown", () => { pressed = true; place(); }, true);
  addEventListener("pointerup", () => { pressed = false; place(); }, true);
  addEventListener("DOMContentLoaded", () => { document.body.append(dot); place(); });
}

/** Moves the mouse in visible, eased steps and remembers where it is. */
class Pointer {
  private readonly page: Page;
  private at: Point = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

  constructor(page: Page) {
    this.page = page;
  }

  async glide(to: Point, durationMs = 450): Promise<void> {
    const from = this.at;
    const steps = Math.max(1, Math.round(durationMs / 16));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t * t * (3 - 2 * t);
      await this.page.mouse.move(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease);
      await this.page.waitForTimeout(16);
    }
    this.at = to;
  }

  async click(target: Locator): Promise<void> {
    await this.glide(await centreOf(target));
    await this.page.mouse.down();
    await this.page.waitForTimeout(90);
    await this.page.mouse.up();
  }

  async drag(from: Point, to: Point, durationMs: number): Promise<void> {
    await this.glide(from);
    await this.page.mouse.down();
    await this.glide(to, durationMs);
    await this.page.mouse.up();
  }
}

async function centreOf(target: Locator): Promise<Point> {
  await target.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
  await target.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
  const box = await target.boundingBox();
  if (!box) throw new Error("the control has no box on screen");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    throw new Error(`step "${name}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

const tab = (page: Page, view: string) => page.locator(`[role="tab"][data-view="${view}"]`);

async function walkThrough(page: Page): Promise<void> {
  const pointer = new Pointer(page);
  const wait = (ms: number) => page.waitForTimeout(ms);

  await step("Overview: mute and unmute Out3", async () => {
    await wait(1200);
    const mute = page.locator('button[title^="Mute Out3"]').first();
    await pointer.click(mute);
    await wait(1100);
    await pointer.click(mute);
    await wait(900);
  });

  await step("Out 1: drag a PEQ handle", async () => {
    await pointer.click(tab(page, "4"));
    await wait(700);
    const handle = page.getByRole("button", { name: "Band 3", exact: true });
    const start = await centreOf(handle);
    await pointer.drag(start, { x: start.x + 110, y: start.y - 45 }, 1300);
    await wait(1200);
  });

  await step("Setup: 2.1 Outdoor, then the 2.2 layout", async () => {
    await pointer.click(tab(page, "setup"));
    await wait(600);
    const preset = page.getByLabel("Preset", { exact: true });
    await pointer.glide(await centreOf(preset));
    await preset.selectOption({ label: "2.1 Outdoor" });
    await wait(1300);
    await pointer.click(page.locator("button.card", { hasText: "Stereo tops and stereo subs" }));
    await wait(1400);
  });

  await step("Time alignment: switch it on and drag the point", async () => {
    const toggle = page.locator('button[title="Time alignment"]');
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await pointer.click(toggle);
    await wait(900);
    const slider = page.getByRole("slider", { name: "Alignment point" });
    await centreOf(slider);
    const box = await slider.boundingBox();
    if (!box) throw new Error("the alignment point has no box on screen");
    const y = box.y + box.height * 0.5;
    await pointer.drag({ x: box.x + box.width * 0.2, y }, { x: box.x + box.width * 0.8, y }, 1800);
    await wait(1300);
  });

  await step("System", async () => {
    await pointer.click(tab(page, "system"));
    await wait(2600);
  });

  await step("Settings: light theme and back", async () => {
    await pointer.click(tab(page, "settings"));
    await wait(700);
    const theme = page.getByRole("group", { name: "Theme" });
    await pointer.click(theme.getByRole("button", { name: "Light", exact: true }));
    await wait(1400);
    await pointer.click(theme.getByRole("button", { name: "Dark", exact: true }));
    await wait(700);
    await pointer.click(tab(page, "overview"));
    await wait(500);
  });
}

async function startRecording(page: Page): Promise<() => Promise<Frame[]>> {
  const cdp = await page.context().newCDPSession(page);
  const frames: Frame[] = [];
  cdp.on("Page.screencastFrame", (event) => {
    frames.push({ timestamp: event.metadata.timestamp ?? Date.now() / 1000, data: event.data });
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
  return async () => {
    await cdp.send("Page.stopScreencast");
    return frames;
  };
}

/** The frames at a steady rate: each one is the last screencast frame at or before its time. */
function resample(frames: Frame[], fps: number): Frame[] {
  if (frames.length === 0) throw new Error("the screencast sent no frames");
  const start = frames[0]!.timestamp;
  const end = frames[frames.length - 1]!.timestamp;
  const steady: Frame[] = [];
  let index = 0;
  for (let t = start; t <= end; t += 1 / fps) {
    while (index + 1 < frames.length && frames[index + 1]!.timestamp <= t) index++;
    steady.push(frames[index]!);
  }
  return steady;
}

function encode(frameDir: string): void {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", join(frameDir, "frame-%05d.png"),
    "-c:v", "libwebp_anim", "-lossless", "1", "-quality", String(WEBP_EFFORT), "-compression_level", "6", "-loop", "0", OUTPUT,
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("ffmpeg could not encode the WebP");
}

async function main(): Promise<void> {
  const chromePath = findChrome();
  checkFfmpeg();
  build();
  const port = await freePort();
  const server = startPreview(port);
  const frameDir = mkdtempSync(join(tmpdir(), "opendsp-capture-"));
  const browser = await chromium.launch({ executablePath: chromePath });
  try {
    const url = `http://127.0.0.1:${port}${BASE_PATH}?demo`;
    await waitForServer(url);
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: "dark" });
    const page = await context.newPage();
    await page.addInitScript(installCursor);
    await page.goto(url);
    await step("open the demo", async () => {
      await page.getByText("Demo: a simulated DSP").waitFor({ timeout: STEP_TIMEOUT_MS });
      await page.locator('button[title^="Mute Out3"]').first().waitFor({ timeout: STEP_TIMEOUT_MS });
    });
    const stop = await startRecording(page);
    await walkThrough(page);
    const frames = resample(await stop(), FPS);
    frames.forEach((frame, i) => {
      writeFileSync(join(frameDir, `frame-${String(i + 1).padStart(5, "0")}.png`), Buffer.from(frame.data, "base64"));
    });
    encode(frameDir);
    const sizeMb = statSync(OUTPUT).size / 1e6;
    console.log(`${OUTPUT}: ${frames.length} frames, ${(frames.length / FPS).toFixed(1)} s, ${sizeMb.toFixed(2)} MB`);
  } finally {
    await browser.close();
    server.kill();
    rmSync(frameDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
