// Emit the English catalog locale (apps/web/src/i18n/locales/en/catalog.json)
// from the shared workout data: exercise + machine names and muscle / group /
// target labels, keyed by id. The shared data stays the source of truth — rerun
// this after adding or renaming catalog entries, then add the same keys to the
// other locales' catalog.json. Run: bun run scripts/exercise-catalog/gen-locale.ts
import path from "node:path";
import { EXERCISES } from "../../packages/shared/src/data/exercises.ts";
import { MACHINES } from "../../packages/shared/src/data/machines.ts";
import {
  MUSCLE_GROUPS,
  MUSCLE_TARGETS,
  MUSCLES,
} from "../../packages/shared/src/data/muscle-groups.ts";

const OUT = path.resolve(import.meta.dir, "../../apps/web/src/i18n/locales/en/catalog.json");

const byId = <T extends { id: string }>(xs: T[], label: (x: T) => string) =>
  Object.fromEntries(xs.map((x) => [x.id, label(x)]));

const catalog = {
  exercises: byId(EXERCISES, (e) => e.name),
  machines: byId(MACHINES, (m) => m.name),
  muscles: byId(MUSCLES, (m) => m.label),
  muscleGroups: byId(MUSCLE_GROUPS, (g) => g.label),
  muscleTargets: byId(MUSCLE_TARGETS, (t) => t.label),
};

await Bun.write(OUT, JSON.stringify({ catalog }, null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
