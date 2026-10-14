// Reactive browser settings, saved to localStorage on every change.
import { defaultSettings, loadSettings, parseSettings, saveSettings, type Settings } from "./settings.ts";
import { browserStorage } from "./storage.ts";

class SettingsStore {
  private readonly storage = browserStorage();
  value = $state<Settings>(loadSettings(this.storage));

  update(patch: Partial<Settings>): void {
    this.value = parseSettings({ ...$state.snapshot(this.value), ...patch });
    saveSettings(this.storage, this.value);
  }

  reset(): void {
    this.value = defaultSettings();
    saveSettings(this.storage, this.value);
  }
}

export const settings = new SettingsStore();
