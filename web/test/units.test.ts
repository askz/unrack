import { test } from "node:test";
import assert from "node:assert/strict";
import { celsiusToShown, metresToShown, shownToCelsius, shownToMetres } from "../src/ui/units.ts";

test("distance and temperature units convert both ways", () => {
  assert.equal(metresToShown(3, "m"), 3);
  assert.ok(Math.abs(metresToShown(3.048, "ft") - 10) < 1e-9);
  assert.ok(Math.abs(shownToMetres(10, "ft") - 3.048) < 1e-9);
  assert.equal(shownToMetres(3, "m"), 3);
  assert.equal(celsiusToShown(20, "F"), 68);
  assert.equal(shownToCelsius(68, "F"), 20);
  assert.equal(celsiusToShown(20, "C"), 20);
});
