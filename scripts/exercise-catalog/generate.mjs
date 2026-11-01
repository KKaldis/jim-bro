// Expand the workout catalog with the StrengthLevel exercises we don't have,
// and build the id->icon map. Emits (into packages/shared/src/data/):
//   - exercises-extra.ts   : the missing exercises as catalog entries
//   - exercise-icons.ts    : EXERCISE_ICONS (catalog id -> icon slug), one per SL lift
//
// Muscle mapping is bodypart-level (StrengthLevel only exposes a coarse
// `bodypart`), refined by name keywords. Equipment/type derived from category +
// name. Run: node scripts/exercise-catalog/generate.mjs
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCatalogByNorm,
  CATALOG_MACHINES,
  readCatalog,
  resolveCatalogId,
} from "../lib/catalog-map.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, "../../packages/shared/src/data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const curl = (u) =>
  execSync(`curl -sL --max-time 30 -A "${UA}" "${u}"`, { maxBuffer: 1e8 }).toString();

// Slug -> catalog-id mapping lives in scripts/lib/catalog-map.mjs, shared with
// scripts/strength-standards/generate.mjs so ids stay consistent between them.
const EQUIP = {
  Barbell: "barbell",
  Dumbbell: "dumbbell",
  Machine: "machine",
  Cable: "cable",
  Bodyweight: "bodyweight",
};

function exType(name) {
  const n = name.toLowerCase();
  const isolation =
    /(curl|extension|raise|fly|flye|pushdown|kickback|shrug|adduction|abduction|wrist|pullover|crunch|twist|pec deck|reverse hyper|calf|lateral|front raise|rear delt|leg raise|face pull)/.test(
      n,
    );
  return isolation ? "isolation" : "compound";
}

// Bodypart-level primary muscle, refined by name. secondary left empty (coarse).
function primaryMuscles(bp, name) {
  const n = name.toLowerCase();
  switch (bp) {
    case "Chest":
      return ["pectoralis_major_sternal"];
    case "Back":
      if (/shrug|trap/.test(n)) return ["trapezius"];
      if (/deadlift|hyperextension|back extension|good morning|pull-through|erector/.test(n))
        return ["erector_spinae"];
      return ["latissimus_dorsi"];
    case "Shoulders":
      if (/lateral|side raise/.test(n)) return ["lateral_deltoid"];
      if (/rear|reverse|face pull/.test(n)) return ["posterior_deltoid"];
      return ["anterior_deltoid"];
    case "Biceps":
      return ["biceps_brachii"];
    case "Triceps":
      return ["triceps_brachii"];
    case "Core":
      if (/oblique|twist|side/.test(n)) return ["external_obliques"];
      return ["rectus_abdominis"];
    case "Forearms":
      if (/reverse|extensor/.test(n)) return ["forearm_extensors"];
      return ["forearm_flexors"];
    case "Legs":
      if (/calf|calve/.test(n)) return ["gastrocnemius"];
      if (/leg curl|hamstring|nordic|good morning/.test(n)) return ["biceps_femoris"];
      if (/glute|hip thrust|bridge|kickback|hip extension|hyperextension|frog/.test(n))
        return ["gluteus_maximus"];
      if (/abduction/.test(n)) return ["gluteus_medius"];
      if (/adduction/.test(n)) return ["gracilis"];
      return ["rectus_femoris"];
    case "Whole Body":
      if (/row/.test(n)) return ["latissimus_dorsi"];
      if (/deadlift/.test(n)) return ["erector_spinae"];
      if (/shrug/.test(n)) return ["trapezius"];
      if (/calf/.test(n)) return ["gastrocnemius"];
      if (/carry|farmer|hold|walk/.test(n)) return ["forearm_flexors"];
      if (/clean|snatch|jerk|thruster|squat|lunge|jump|burpee|step|pistol|sit|wall ball/.test(n))
        return ["rectus_femoris"];
      return ["erector_spinae"];
    default:
      return ["rectus_abdominis"];
  }
}

const exercises = JSON.parse(
  curl(
    "https://strengthlevel.com/api/exercises?limit=500&exercise.fields=category,name_url,bodypart,count,icon_url&standard=true",
  ),
).data;

const catalog = readCatalog();
const existingIds = new Set(catalog.map((c) => c.id));
const byNorm = buildCatalogByNorm(catalog);

const extra = [];
const iconMap = {}; // catalog id -> slug
const iconSlugs = []; // slugs to download

for (const ex of exercises) {
  const id = resolveCatalogId(ex.name_url, ex.name, byNorm);
  iconMap[id] = ex.name_url;
  iconSlugs.push(ex.name_url);
  if (existingIds.has(id)) continue; // already in catalog — icon only
  existingIds.add(id); // guard against dup slugs mapping to same id
  extra.push({
    id,
    name: ex.name,
    type: exType(ex.name),
    equipment: EQUIP[ex.category] ?? "bodyweight",
    machine_id: CATALOG_MACHINES[id],
    primary_muscles: primaryMuscles(ex.bodypart, ex.name),
    secondary_muscles: [],
  });
}

// ---- emit exercises-extra.ts ----
const entry = (e) =>
  `  {\n    id: ${JSON.stringify(e.id)},\n    name: ${JSON.stringify(e.name)},\n    type: ${JSON.stringify(
    e.type,
  )},\n    equipment: ${JSON.stringify(e.equipment)},\n${
    e.machine_id ? `    machine_id: ${JSON.stringify(e.machine_id)},\n` : ""
  }    primary_muscles: ${JSON.stringify(e.primary_muscles)},\n    secondary_muscles: [],\n  },`;

const extraTs = `// AUTO-GENERATED by scripts/exercise-catalog/generate.mjs — DO NOT EDIT BY HAND.
// The StrengthLevel exercises not already hand-curated in exercises.ts, so the
// workout catalog covers all ${exercises.length} lifts that have strength standards. Muscle
// mapping is bodypart-level (coarse) — refine specific heads by hand as needed.
import type { Exercise } from "../workout-types.ts";

export const EXTRA_EXERCISES: Exercise[] = [
${extra.map(entry).join("\n")}
];
`;
fs.writeFileSync(path.join(DATA, "exercises-extra.ts"), extraTs);

// ---- emit exercise-icons.ts ----
const iconEntries = Object.keys(iconMap)
  .sort()
  .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(iconMap[id])},`)
  .join("\n");
const iconTs = `// AUTO-GENERATED by scripts/exercise-catalog/generate.mjs — DO NOT EDIT BY HAND.
// Maps a catalog exercise id to its icon slug. The web app renders the PNG at
// /exercise-icons/<slug>.png (black silhouette; inverted in dark mode).
export const EXERCISE_ICONS: Record<string, string> = {
${iconEntries}
};

/** Public URL of an exercise's silhouette icon, or null if it has none. */
export function exerciseIconUrl(exerciseId: string): string | null {
  const slug = EXERCISE_ICONS[exerciseId];
  return slug ? \`/exercise-icons/\${slug}.png\` : null;
}
`;
fs.writeFileSync(path.join(DATA, "exercise-icons.ts"), iconTs);

// ---- emit slug list for the icon downloader ----
fs.writeFileSync(path.join(__dirname, "icon-slugs.json"), JSON.stringify([...new Set(iconSlugs)]));

console.error(
  `${exercises.length} SL exercises · ${extra.length} new catalog entries · ${Object.keys(iconMap).length} icons mapped`,
);
console.error(`wrote exercises-extra.ts, exercise-icons.ts, icon-slugs.json`);
