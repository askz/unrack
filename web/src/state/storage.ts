// The browser's localStorage, or null where there is none or access is denied.
import type { StorageLike } from "./settings.ts";

export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage access denied (privacy settings)
  }
}
