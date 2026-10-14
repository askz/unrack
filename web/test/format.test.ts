import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDb, formatHz, parseNumber } from "../src/ui/format.ts";
import { hashToView, initialView, viewToHash } from "../src/state/viewHash.ts";

test("views round-trip through the URL hash", () => {
  for (const view of ["overview", "setup", "system", "settings", 0, 3, 4, 7] as const) assert.equal(hashToView(`#${viewToHash(view)}`), view);
  assert.equal(viewToHash(4), "out-1");
  assert.equal(viewToHash(1), "in-b");
  assert.equal(hashToView("#nonsense"), "overview");
  assert.equal(hashToView(""), "overview");
});

test("the first view: the URL hash, else the last view if the setting asks for it", () => {
  assert.equal(initialView("#out-2", "overview", "setup"), 5, "a hash always wins");
  assert.equal(initialView("", "last", "setup"), "setup");
  assert.equal(initialView("", "overview", "setup"), "overview");
  assert.equal(initialView("#", "last", "in-c"), 2);
  assert.equal(initialView("", "last", null), "overview");
  assert.equal(initialView("", "last", "bogus"), "overview");
  assert.equal(initialView("#bogus", "last", "system"), "system", "an unknown hash counts as none");
});

test("formatHz picks a precision per decade", () => {
  assert.equal(formatHz(40.33), "40.3");
  assert.equal(formatHz(309.4), "309");
  assert.equal(formatHz(2020), "2.02k");
  assert.equal(formatHz(10159), "10.2k");
});

test("formatDb is signed and never shows -0.0", () => {
  assert.equal(formatDb(3), "+3.0");
  assert.equal(formatDb(-6.5), "-6.5");
  assert.equal(formatDb(-0.01), "0.0");
  assert.equal(formatDb(0), "0.0");
});

test("parseNumber accepts units, comma decimals and k multipliers", () => {
  assert.equal(parseNumber("1.5"), 1.5);
  assert.equal(parseNumber(" -6,5 dB"), -6.5);
  assert.equal(parseNumber("1.2k"), 1200);
  assert.equal(parseNumber("1k2"), 1200);
  assert.equal(parseNumber("80Hz"), 80);
  assert.equal(parseNumber(".5"), 0.5);
  assert.equal(parseNumber("abc"), null);
  assert.equal(parseNumber(""), null);
  assert.equal(parseNumber("1.2.3"), null);
});
