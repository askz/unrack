// URL-hash names of the views: #overview, #setup, #in-a … #in-d, #out-1 … #out-4,
// #system, #settings.
import { OUT_BASE } from "./model.ts";

export type View = "overview" | "setup" | "system" | "settings" | number;

const NAMED_VIEWS: readonly string[] = ["overview", "setup", "system", "settings"];
const INPUT_HASHES = ["in-a", "in-b", "in-c", "in-d"];

export function viewToHash(view: View): string {
  if (typeof view !== "number") return view;
  return view < OUT_BASE ? INPUT_HASHES[view]! : `out-${view - OUT_BASE + 1}`;
}

/** The view a hash or stored name stands for; null when it names none. */
export function parseView(text: string): View | null {
  const name = text.replace(/^#/, "").toLowerCase();
  if (NAMED_VIEWS.includes(name)) return name as View;
  const input = INPUT_HASHES.indexOf(name);
  if (input >= 0) return input;
  const output = /^out-([1-4])$/.exec(name);
  if (output) return OUT_BASE + Number(output[1]) - 1;
  return null;
}

export function hashToView(hash: string): View {
  return parseView(hash) ?? "overview";
}

/**
 * The view to open at startup: the URL hash when it names a view (a reload keeps the
 * view), else the stored last view when the setting says so, else the Overview.
 */
export function initialView(hash: string, startView: "last" | "overview", stored: string | null): View {
  const fromHash = parseView(hash);
  if (fromHash !== null) return fromHash;
  if (startView === "last" && stored !== null) return parseView(stored) ?? "overview";
  return "overview";
}
