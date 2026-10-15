// Packs the ESP32 build of the web app into firmware/www/ for the LittleFS image.
//
//   npm run build:esp
//
// Runs `vite build` with VITE_TARGET=esp (output dist-esp/), then writes every file
// gzip-compressed as firmware/www/<path>.gz plus a VERSION file. The firmware build
// (idf.py build) turns firmware/www/ into build/www.bin, which can be flashed or
// uploaded from the device's web page.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(webDir, "dist-esp");
const wwwDir = join(webDir, "..", "firmware", "www");
const KEEP = new Set([".gitkeep"]);

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function version(): string {
  const { version: base } = JSON.parse(readFileSync(join(webDir, "package.json"), "utf8")) as { version: string };
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: webDir, encoding: "utf8" }).trim();
  return `${base}+${commit}`;
}

execFileSync("npx", ["vite", "build"], {
  cwd: webDir,
  stdio: "inherit",
  env: { ...process.env, VITE_TARGET: "esp" },
});

for (const entry of readdirSync(wwwDir)) {
  if (!KEEP.has(entry)) rmSync(join(wwwDir, entry), { recursive: true, force: true });
}

let total = 0;
for (const file of listFiles(distDir)) {
  const target = join(wwwDir, `${relative(distDir, file)}.gz`);
  mkdirSync(dirname(target), { recursive: true });
  const packed = gzipSync(readFileSync(file), { level: 9 });
  writeFileSync(target, packed);
  total += packed.length;
}
writeFileSync(join(wwwDir, "VERSION"), version());
console.log(`firmware/www: ${(total / 1024).toFixed(0)} KiB gzipped, version ${version()}`);
