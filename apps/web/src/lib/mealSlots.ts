// Canonical meal slots, in day order. Slots are free text, so these are the
// suggestions offered in pickers and the order used when grouping meals.
export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;

export function isMealSlot(slot: string): boolean {
  return (MEAL_SLOTS as readonly string[]).includes(slot);
}

// Sort key for a slot: canonical slots in day order, then any free-text slot.
export function slotRank(slot: string): number {
  const i = (MEAL_SLOTS as readonly string[]).indexOf(slot.toLowerCase());
  return i === -1 ? MEAL_SLOTS.length : i;
}

// Compare optional HH:MM times; untimed entries sort last.
export function compareTime(a?: string, b?: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}
