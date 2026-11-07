import { readTrafficClock } from "./traffic-draft";

/** Display at native output precision; an unchanged field retains its exact input. */
export function trafficDemandClock(seconds: number): string {
  const rounded = Math.round(seconds * 1e6) / 1e6;
  const hours = Math.floor(rounded / 3600),
    minutes = Math.floor((rounded % 3600) / 60);
  const rest = Number((rounded % 60).toFixed(6));
  const secondText = rest < 10 ? `0${rest}` : String(rest);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}${rest ? `:${secondText}` : ""}`;
}
export function readTrafficDemandClock(
  value: string,
  original: number,
  label: string,
): number {
  if (value === trafficDemandClock(original)) return original;
  const match = /^(\d{1,2}:\d{2}:\d{2})\.(\d{1,9})$/.exec(value.trim());
  if (!match) return readTrafficClock(value, label);
  const whole = readTrafficClock(match[1], label),
    fraction = Number(`0.${match[2]}`);
  if (whole + fraction > 86400)
    throw new Error(`${label}: enter a time between 00:00 and 24:00.`);
  return whole + fraction;
}
