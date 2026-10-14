import type { StorageLike } from "./settings.ts";

/** The browser's localStorage, or null where there is none or access is denied. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage access denied (privacy settings)
  }
}
