import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCUMULATOR_RESET_MS, SCROLL_GUARD_MS, ScrollGuard, WheelController, wheelMultiplier, wheelPixels, type WheelSample,
} from "../src/ui/wheel.ts";

const sample = (patch: Partial<WheelSample>): WheelSample => ({
  deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...patch,
});

function setup() {
  let now = 1000;
  const clock = () => now;
  const guard = new ScrollGuard(clock);
  const controller = new WheelController(guard, clock);
  return { guard, controller, advance: (ms: number) => { now += ms; } };
}

test("wheel deltas become upward pixels in every delta mode", () => {
  assert.equal(wheelPixels(sample({ deltaY: -100 })), 100);
  assert.equal(wheelPixels(sample({ deltaY: 3, deltaMode: 1 })), -120);
  assert.equal(wheelPixels(sample({ deltaY: 1, deltaMode: 2 })), -800);
  assert.equal(wheelPixels(sample({ deltaX: 100, shiftKey: true })), -100, "Shift+wheel reported as horizontal");
});

test("Shift is coarse and Alt is fine", () => {
  assert.equal(wheelMultiplier({ shiftKey: true, altKey: false }), 10);
  assert.equal(wheelMultiplier({ shiftKey: false, altKey: true }), 0.1);
  assert.equal(wheelMultiplier({ shiftKey: false, altKey: false }), 1);
});

test("each mouse-wheel notch is one step, whatever its size", () => {
  const { controller, advance } = setup();
  assert.deepEqual(controller.handle(sample({ deltaY: -100 })), { consume: true, steps: 1, multiplier: 1 });
  advance(50);
  assert.equal(controller.handle(sample({ deltaY: -53 })).steps, 1);
  advance(50);
  assert.equal(controller.handle(sample({ deltaY: 3, deltaMode: 1 })).steps, -1);
  advance(50);
  assert.deepEqual(controller.handle(sample({ deltaY: -100, shiftKey: true })), { consume: true, steps: 1, multiplier: 10 });
});

test("small trackpad deltas add up to steps", () => {
  const { controller, advance } = setup();
  const steps: number[] = [];
  for (let i = 0; i < 10; i++) {
    steps.push(controller.handle(sample({ deltaY: -12 })).steps);
    advance(16);
  }
  assert.equal(steps.reduce((sum, s) => sum + s, 0), 2, "120 px is two 50 px steps");
  assert.ok(steps.every((s) => s === 0 || s === 1));
});

test("the trackpad remainder is dropped after a pause or a change of direction", () => {
  const { controller, advance } = setup();
  controller.handle(sample({ deltaY: -40 }));
  advance(ACCUMULATOR_RESET_MS + 1);
  assert.equal(controller.handle(sample({ deltaY: -40 })).steps, 0, "40 + 40 would be a step without the reset");
  advance(10);
  assert.equal(controller.handle(sample({ deltaY: 40 })).steps, 0, "reversing starts from zero");
  advance(10);
  assert.equal(controller.handle(sample({ deltaY: 40 })).steps, -1);
});

test("wheel input is left to the page while the page is scrolling", () => {
  const { guard, controller, advance } = setup();
  guard.noteScroll();
  advance(SCROLL_GUARD_MS - 1);
  assert.deepEqual(controller.handle(sample({ deltaY: -100 })), { consume: false, steps: 0, multiplier: 1 });
  advance(2);
  assert.equal(controller.handle(sample({ deltaY: -100 })).consume, true);
});

test("Ctrl and Meta wheel (browser zoom, pinch) are never taken", () => {
  const { controller } = setup();
  assert.equal(controller.handle(sample({ deltaY: -100, ctrlKey: true })).consume, false);
  assert.equal(controller.handle(sample({ deltaY: -100, metaKey: true })).consume, false);
});
