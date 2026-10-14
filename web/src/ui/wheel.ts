// Mouse-wheel adjustment of the control under the pointer (no focus needed). While
// the page is scrolling, wheel events are left to the page so scrolling past a fader
// does not change it. A mouse notch is one step; small trackpad deltas add up.

export const LINE_PX = 40;
export const PAGE_PX = 800;
/** A pixel delta this large is one mouse-wheel notch; smaller ones (trackpads) accumulate. */
export const NOTCH_PX = 50;
export const ACCUMULATOR_RESET_MS = 300;
export const SCROLL_GUARD_MS = 400;

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface WheelDecision {
  /** The event belongs to the control (prevent the page from scrolling). */
  consume: boolean;
  steps: number;
  multiplier: number;
}

type Clock = () => number;
const defaultClock: Clock = () => performance.now();

/** Movement in pixels, positive for wheel up (increase). Shift+wheel may arrive as deltaX. */
export function wheelPixels(event: WheelSample): number {
  const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1;
  return -delta * scale;
}

export function wheelMultiplier(event: Pick<WheelSample, "shiftKey" | "altKey">): number {
  if (event.shiftKey) return 10;
  if (event.altKey) return 0.1;
  return 1;
}

export class ScrollGuard {
  private readonly now: Clock;
  private readonly windowMs: number;
  private lastScrollAt = Number.NEGATIVE_INFINITY;

  constructor(now: Clock = defaultClock, windowMs = SCROLL_GUARD_MS) {
    this.now = now;
    this.windowMs = windowMs;
  }

  noteScroll(): void {
    this.lastScrollAt = this.now();
  }

  get scrolling(): boolean {
    return this.now() - this.lastScrollAt < this.windowMs;
  }
}

export class WheelController {
  private readonly guard: ScrollGuard;
  private readonly now: Clock;
  private total = 0;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(guard: ScrollGuard, now: Clock = defaultClock) {
    this.guard = guard;
    this.now = now;
  }

  handle(event: WheelSample): WheelDecision {
    const multiplier = wheelMultiplier(event);
    if (event.ctrlKey || event.metaKey || this.guard.scrolling) return { consume: false, steps: 0, multiplier };
    const pixels = wheelPixels(event);
    const at = this.now();
    if (at - this.lastAt > ACCUMULATOR_RESET_MS || Math.sign(pixels) !== Math.sign(this.total)) this.total = 0;
    this.lastAt = at;
    if (Math.abs(pixels) >= NOTCH_PX) {
      this.total = 0;
      return { consume: true, steps: Math.sign(pixels), multiplier };
    }
    this.total += pixels;
    const steps = Math.trunc(this.total / NOTCH_PX) || 0; // no -0
    this.total -= steps * NOTCH_PX;
    return { consume: true, steps, multiplier };
  }
}

export const scrollGuard = new ScrollGuard();
let guardInstalled = false;

function installScrollGuard(): void {
  if (guardInstalled || typeof document === "undefined") return;
  guardInstalled = true;
  // scroll does not bubble: listen in the capture phase to see every scroll container
  document.addEventListener("scroll", () => scrollGuard.noteScroll(), { capture: true, passive: true });
}

export interface WheelTarget {
  /** Whether this event is for the control (default: always). */
  accepts?(event: WheelEvent): boolean;
  step(steps: number, multiplier: number, event: WheelEvent): void;
}

/** Listen for wheel events on `element`; returns the cleanup (fits a Svelte $effect). */
export function attachWheel(element: Element, target: WheelTarget): () => void {
  installScrollGuard();
  const controller = new WheelController(scrollGuard);
  const onWheel = (event: Event): void => {
    const wheel = event as WheelEvent;
    if (target.accepts && !target.accepts(wheel)) return;
    const decision = controller.handle(wheel);
    if (!decision.consume) return;
    wheel.preventDefault();
    if (decision.steps !== 0) target.step(decision.steps, decision.multiplier, wheel);
  };
  element.addEventListener("wheel", onWheel, { passive: false });
  return () => element.removeEventListener("wheel", onWheel);
}
