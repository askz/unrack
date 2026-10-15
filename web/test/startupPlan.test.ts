import { test } from "node:test";
import assert from "node:assert/strict";
import { demoRequested, startupPlan } from "../src/state/startup.ts";

test("the ESP32 build always starts with the bridge", () => {
  assert.equal(startupPlan({ bridge: true, demoAvailable: false, demoRequested: true }), "bridge");
});

test("where the demo is not available (Android app), only a granted device is bound", () => {
  assert.equal(startupPlan({ bridge: false, demoAvailable: false, demoRequested: false }), "device");
  assert.equal(startupPlan({ bridge: false, demoAvailable: false, demoRequested: true }), "device");
});

test("the web build binds a granted device, else starts the demo", () => {
  assert.equal(startupPlan({ bridge: false, demoAvailable: true, demoRequested: false }), "device-or-demo");
});

test("?demo goes straight to the demo", () => {
  assert.equal(startupPlan({ bridge: false, demoAvailable: true, demoRequested: true }), "demo");
});

test("?demo and its alias ?mock ask for the demo", () => {
  assert.equal(demoRequested("?demo"), true);
  assert.equal(demoRequested("?mock"), true);
  assert.equal(demoRequested("?foo=1&demo"), true);
  assert.equal(demoRequested(""), false);
  assert.equal(demoRequested("?demonstration"), false);
});
