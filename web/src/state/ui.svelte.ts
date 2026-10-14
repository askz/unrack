// View state that is not device state: which tab is open (mirrored in the URL hash,
// e.g. #out-1, so reloads keep the view, and remembered for the next start) and which
// EQ band is selected per output.
import { CHANNEL_COUNT } from "./model.ts";
import { settings } from "./settings.svelte.ts";
import { hashToView, initialView, viewToHash, type View } from "./viewHash.ts";

export type { View };

const LAST_VIEW_KEY = "opendsp-4x4.last-view";

function readLastView(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(LAST_VIEW_KEY);
  } catch {
    return null;
  }
}

function storeLastView(view: View): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(LAST_VIEW_KEY, viewToHash(view));
  } catch {
    // storage unavailable: the next start opens the default view
  }
}

class UiState {
  view = $state<View>(typeof location === "undefined" ? "overview" : initialView(location.hash, settings.value.startView, readLastView()));
  selectedBand = $state<Record<number, number>>({});

  constructor() {
    if (typeof window === "undefined") return;
    window.addEventListener("hashchange", () => {
      this.view = hashToView(location.hash);
      storeLastView(this.view);
    });
  }

  open(view: View): void {
    if (typeof view === "number" && (view < 0 || view >= CHANNEL_COUNT)) return;
    this.view = view;
    storeLastView(view);
    const hash = `#${viewToHash(view)}`;
    if (typeof location !== "undefined" && location.hash !== hash) history.replaceState(null, "", hash);
  }

  bandOf(ch: number): number {
    return this.selectedBand[ch] ?? 0;
  }

  selectBand(ch: number, band: number): void {
    this.selectedBand[ch] = band;
  }
}

export const ui = new UiState();
