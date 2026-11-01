// Unit helpers for the manual Calculators page. The user's profile stores every
// measurement in metric (kg / cm); the calculator inputs are shown and edited in
// the user's chosen unit system, then converted back to metric before calling
// the shared @fa/shared compute functions (which are all metric). This mirrors
// how the agent's tools handle imperial input — the result cards render their
// own (mostly kg) output unchanged, exactly as they do from chat.
//
// Plate racking is the one exception: its math is unit-agnostic and the card
// shows whatever unit it's given, so that calculator passes display-unit numbers
// straight through (see registry.ts).

export type Units = "metric" | "imperial";

export const CM_PER_IN = 2.54;
export const LB_PER_KG = 2.2046226218;

export const round1 = (n: number) => Math.round(n * 10) / 10;

export function weightUnit(u: Units): "kg" | "lb" {
  return u === "imperial" ? "lb" : "kg";
}
export function lengthUnit(u: Units): "cm" | "in" {
  return u === "imperial" ? "in" : "cm";
}

// Stored metric → the value shown in the field (rounded for legibility).
export function kgToDisplay(kg: number, u: Units): number {
  return u === "imperial" ? round1(kg * LB_PER_KG) : round1(kg);
}
export function cmToDisplay(cm: number, u: Units): number {
  return u === "imperial" ? round1(cm / CM_PER_IN) : round1(cm);
}

// Field value (display unit) → metric, for the shared compute functions.
export function kgFromDisplay(v: number, u: Units): number {
  return u === "imperial" ? v / LB_PER_KG : v;
}
export function cmFromDisplay(v: number, u: Units): number {
  return u === "imperial" ? v * CM_PER_IN : v;
}
