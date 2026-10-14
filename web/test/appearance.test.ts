import { test } from "node:test";
import assert from "node:assert/strict";
import { appearanceVars } from "../src/ui/appearance.ts";
import { CHANNEL_PALETTE, defaultSettings, parseSettings } from "../src/state/settings.ts";

test("density sets the control height and the gaps", () => {
  const height = (density: string) => appearanceVars(parseSettings({ density }), false).vars["--control-h"];
  assert.equal(height("compact"), "24px");
  assert.equal(height("comfortable"), "28px");
  assert.equal(height("touch"), "40px");
  const gap = (density: string) => Number.parseInt(appearanceVars(parseSettings({ density }), false).vars["--gap"]!, 10);
  assert.ok(gap("compact") < gap("comfortable") && gap("comfortable") < gap("touch"));
});

test("text size sets the root font size", () => {
  const size = (textSize: string) => appearanceVars(parseSettings({ textSize }), false).vars["font-size"];
  assert.equal(size("small"), "12px");
  assert.equal(size("normal"), "13px");
  assert.equal(size("large"), "15px");
});

test("channel colours become --ch-N", () => {
  const colors = [...defaultSettings().colors];
  colors[5] = CHANNEL_PALETTE[9];
  const { vars } = appearanceVars(parseSettings({ colors }), false);
  assert.equal(vars["--ch-5"], CHANNEL_PALETTE[9]);
  assert.equal(vars["--ch-0"], CHANNEL_PALETTE[0]);
  assert.equal(vars["--ch-7"], CHANNEL_PALETTE[7]);
});

test("the system theme follows the browser preference; fixed themes ignore it", () => {
  assert.equal(appearanceVars(parseSettings({ theme: "system" }), true).theme, "light");
  assert.equal(appearanceVars(parseSettings({ theme: "system" }), false).theme, "dark");
  assert.equal(appearanceVars(parseSettings({ theme: "dark" }), true).theme, "dark");
  assert.equal(appearanceVars(parseSettings({ theme: "light" }), false).theme, "light");
});
