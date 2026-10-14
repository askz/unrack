// Display units chosen in Settings. Values are stored metric and converted at the edges.
import type { Settings } from "../state/settings.ts";

/** "m" or "ft". */
export type DistanceUnit = Settings["distanceUnit"];
/** "C" or "F". */
export type TemperatureUnit = Settings["temperatureUnit"];

const FEET_PER_METRE = 1 / 0.3048;

/** A stored distance (m) in the display unit. */
export const metresToShown = (metres: number, unit: DistanceUnit): number => (unit === "m" ? metres : metres * FEET_PER_METRE);
/** A distance typed in the display unit, in metres. */
export const shownToMetres = (shown: number, unit: DistanceUnit): number => (unit === "m" ? shown : shown / FEET_PER_METRE);
/** A stored temperature (°C) in the display unit. */
export const celsiusToShown = (celsius: number, unit: TemperatureUnit): number => (unit === "C" ? celsius : (celsius * 9) / 5 + 32);
/** A temperature typed in the display unit, in °C. */
export const shownToCelsius = (shown: number, unit: TemperatureUnit): number => (unit === "C" ? shown : ((shown - 32) * 5) / 9);
