import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// base: "./" for the Android WebView build (VITE_TARGET=android — assets resolve
// under the WebViewAssetLoader path); "/" for the ESP32-hosted build (VITE_TARGET=esp,
// output in dist-esp, see tools/build-esp.ts); "/opendsp-4x4/" for the GitHub Pages
// project site and `vite preview` of it; "/" for local dev.
const target = process.env.VITE_TARGET;

export default defineConfig(({ command, isPreview }) => ({
  base: target === "android" ? "./" : target === "esp" || (command !== "build" && !isPreview) ? "/" : "/opendsp-4x4/",
  build: target === "esp" ? { outDir: "dist-esp" } : undefined,
  plugins: [svelte()],
}));
