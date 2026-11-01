/**
 * Steps tools: the daily pedometer aggregate.
 */
import { UserStorage } from "../../storage.ts";
import { todayIso } from "./shared.ts";

export async function doGetSteps(storage: UserStorage, input: Record<string, unknown>) {
  const to = typeof input.to === "string" && input.to.trim() ? input.to.trim() : todayIso();
  const from = typeof input.from === "string" && input.from.trim() ? input.from.trim() : to;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error("from/to must be YYYY-MM-DD");
  }
  if (from > to) throw new Error("from must be <= to");
  const days = await storage.readStepsRange(from, to);
  const total = days.reduce((acc, d) => acc + d.steps, 0);
  const daysWithSteps = days.filter((d) => d.steps > 0).length;
  return {
    from,
    to,
    days,
    total,
    days_with_steps: daysWithSteps,
    average: daysWithSteps > 0 ? Math.round(total / daysWithSteps) : 0,
  };
}

// Set a day's absolute step total (overwrites), optionally with a daily goal.
export async function doLogSteps(storage: UserStorage, input: Record<string, unknown>) {
  const date = typeof input.date === "string" && input.date.trim() ? input.date.trim() : todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  const stepsRaw = input.steps;
  if (typeof stepsRaw !== "number" || !Number.isFinite(stepsRaw) || stepsRaw < 0) {
    throw new Error("steps must be a non-negative number");
  }
  let goal: number | null | undefined;
  if (input.goal != null) {
    const g = Number(input.goal);
    if (!Number.isFinite(g) || g < 0) throw new Error("goal must be a non-negative number");
    goal = Math.round(g);
  }
  const saved = await storage.upsertSteps(date, Math.round(stepsRaw), goal);
  return { logged: saved };
}

// Remove a day's step row entirely (the day reverts to 0 / no goal).
export async function doDeleteSteps(storage: UserStorage, input: Record<string, unknown>) {
  const date = String(input.date ?? "").trim();
  if (!date) throw new Error("date required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  const removed = await storage.deleteSteps(date);
  return { removed, date };
}
