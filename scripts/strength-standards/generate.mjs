// Regenerate packages/shared/src/data/strength-standards.ts from strengthlevel.com.
//
// Reverse-engineered from StrengthLevel's public pages: every exercise page at
// /strength-standards/{slug}/kg server-renders exact "By Bodyweight" tables
// (male + female) and "By Age" tables. Bodyweight brackets are identical across
// all exercises (male 50..140, female 40..120, step 5), so we factor that axis
// out. The age adjustment is a single per-sex multiplier curve (verified stable
// across 226 weight exercises, sd <= 0.017), so we store one curve, not 287.
//
// Usage:
//   node scripts/strength-standards/generate.mjs           # scrape live + write
//   node scripts/strength-standards/generate.mjs --raw F   # reuse a cached raw json
//
// Network scrape is polite (throttled). Output is deterministic given the source.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogByNorm, resolveCatalogId } from "../lib/catalog-map.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../../packages/shared/src/data/strength-standards.ts");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const curl = (url) =>
  execSync(`curl -sL --max-time 30 -A "${UA}" "${url}"`, { maxBuffer: 1e8 }).toString();

const MALE_BW = [
  50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 135, 140,
];
const FEMALE_BW = [40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120];

// Slug -> catalog-id mapping lives in scripts/lib/catalog-map.mjs, shared with
// scripts/exercise-catalog/generate.mjs so the two never drift.
const cellVal = (c) => {
  c = c.replace(/&lt;/g, "<").trim();
  if (c.includes("<")) return 0; // "< 1" -> below one rep/kg
  const m = c.match(/-?\+?\d+(\.\d+)?/);
  return m ? Number(m[0].replace("+", "")) : null;
};
const isLoadCell = (c) => /kg/.test(c);

function parseTables(html) {
  return [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => {
    const trs = [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((t) =>
      [...t[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
        c[1]
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    );
    return { header: trs[0] || [], rows: trs.slice(1) };
  });
}

function classifyExercise(ex, tables) {
  const bw = tables.filter((t) => (t.header[0] || "").toLowerCase() === "bw");
  const load = bw.filter((t) => t.rows.some((r) => r.slice(1).some(isLoadCell)));
  const plain = bw.filter((t) => !t.rows.some((r) => r.slice(1).some(isLoadCell)));
  if (load.length >= 2) return { metric: "bodyweight_load", tabs: load };
  if (plain.length >= 2)
    return { metric: ex.category === "Bodyweight" ? "reps" : "weight", tabs: plain };
  return null;
}

// level values only (drop the leading BW column), aligned to the fixed brackets.
const levelRows = (table) => table.rows.map((r) => r.slice(1, 6).map(cellVal));

async function main() {
  const rawArg = process.argv.indexOf("--raw");
  let raw;
  if (rawArg !== -1) {
    raw = JSON.parse(fs.readFileSync(process.argv[rawArg + 1], "utf8"));
  } else {
    const exercises = JSON.parse(
      curl(
        "https://strengthlevel.com/api/exercises?limit=500&exercise.fields=category,name_url,bodypart,count&standard=true",
      ),
    ).data;
    raw = [];
    for (let i = 0; i < exercises.length; i++) {
      const ex = exercises[i];
      const html = curl(`https://strengthlevel.com/strength-standards/${ex.name_url}/kg`);
      raw.push({ ...ex, tables: parseTables(html) });
      if (i % 25 === 0) console.error(`[${i}/${exercises.length}] ${ex.name_url}`);
      await sleep(120);
    }
  }

  const catalogByNorm = buildCatalogByNorm();

  const entries = [];
  for (const ex of raw) {
    const cls = classifyExercise(ex, ex.tables);
    if (!cls) {
      console.error(`SKIP (no BW table): ${ex.name_url}`);
      continue;
    }
    const male = levelRows(cls.tabs[0]);
    const female = levelRows(cls.tabs[1]);
    if (male.length !== MALE_BW.length || female.length !== FEMALE_BW.length) {
      console.error(`SKIP (bracket mismatch): ${ex.name_url} m=${male.length} f=${female.length}`);
      continue;
    }
    // Every lift resolves to a catalog exercise: an existing hand-curated one
    // (via override / name match) or one added to exercises-extra.ts with id =
    // snake_case(slug). See scripts/lib/catalog-map.mjs.
    const catalog_id = resolveCatalogId(ex.name_url, ex.name, catalogByNorm);
    entries.push({
      slug: ex.name_url,
      name: ex.name,
      category: ex.category,
      bodypart: ex.bodypart,
      metric: cls.metric,
      catalog_id,
      male,
      female,
    });
  }

  // Age multiplier curve, derived per sex by averaging value/peak(age25) across
  // all five levels and all weight exercises. Verified stable (sd <= 0.017).
  const AGES = [15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
  function ageCurve(sexIdx) {
    const acc = Object.fromEntries(AGES.map((a) => [a, []]));
    for (const ex of raw) {
      const cls = classifyExercise(ex, ex.tables);
      if (!cls || cls.metric !== "weight") continue;
      const ageT = ex.tables.filter((t) => (t.header[0] || "").toLowerCase() === "age");
      const t = ageT[sexIdx];
      if (!t) continue;
      const byAge = {};
      for (const r of t.rows) byAge[cellVal(r[0])] = r.slice(1, 6).map(cellVal);
      const peak = byAge[25];
      if (!peak) continue;
      for (const a of AGES) {
        if (!byAge[a]) continue;
        const rr = byAge[a]
          .map((x, i) => (peak[i] > 0 ? x / peak[i] : null))
          .filter((x) => x != null);
        if (rr.length) acc[a].push(rr.reduce((s, x) => s + x, 0) / rr.length);
      }
    }
    return AGES.map((a) => {
      const arr = acc[a];
      return +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(4);
    });
  }
  const maleCurve = ageCurve(0);
  const femaleCurve = ageCurve(1);

  const mapped = entries.filter((e) => e.catalog_id).length;
  console.error(`\n${entries.length} exercises, ${mapped} mapped to catalog`);

  // ---- emit TS ----
  const rowStr = (rows) => "[" + rows.map((r) => `[${r.join(",")}]`).join(",") + "]";
  const body = entries
    .map(
      (e) =>
        `  { slug: ${JSON.stringify(e.slug)}, name: ${JSON.stringify(e.name)}, category: ${JSON.stringify(
          e.category,
        )}, bodypart: ${JSON.stringify(e.bodypart)}, metric: ${JSON.stringify(e.metric)}, catalog_id: ${
          e.catalog_id ? JSON.stringify(e.catalog_id) : "null"
        }, male: ${rowStr(e.male)}, female: ${rowStr(e.female)} },`,
    )
    .join("\n");

  const ts = `// AUTO-GENERATED by scripts/strength-standards/generate.mjs — DO NOT EDIT BY HAND.
// Source: strengthlevel.com strength standards (${entries.length} exercises).
// Levels are [Beginner, Novice, Intermediate, Advanced, Elite] = the lift (kg for
// "weight"/"bodyweight_load", rep count for "reps") a lifter of the given
// bodyweight is stronger than 5% / 20% / 50% / 80% / 95% of lifters at.
// "bodyweight_load" values are ADDED kg (negative = assisted). 0 means "< 1".

export type StrengthMetric = "weight" | "reps" | "bodyweight_load";

// [beginner, novice, intermediate, advanced, elite]
export type StrengthLevelRow = [number, number, number, number, number];

export type StrengthStandardEntry = {
  slug: string;
  name: string;
  category: "Barbell" | "Dumbbell" | "Machine" | "Cable" | "Bodyweight";
  bodypart: string;
  metric: StrengthMetric;
  /** Our workout-catalog ExerciseId when this lift exists there, else null. */
  catalog_id: string | null;
  /** One row per MALE_BODYWEIGHTS_KG bracket. */
  male: StrengthLevelRow[];
  /** One row per FEMALE_BODYWEIGHTS_KG bracket. */
  female: StrengthLevelRow[];
};

export const MALE_BODYWEIGHTS_KG: number[] = [${MALE_BW.join(", ")}];
export const FEMALE_BODYWEIGHTS_KG: number[] = [${FEMALE_BW.join(", ")}];

// Age -> strength multiplier vs the 25-40 peak (StrengthLevel age adjustment).
export const STRENGTH_AGE_MULTIPLIERS: { age: number; male: number; female: number }[] = [
${AGES.map((a, i) => `  { age: ${a}, male: ${maleCurve[i]}, female: ${femaleCurve[i]} },`).join("\n")}
];

export const STRENGTH_STANDARDS: StrengthStandardEntry[] = [
${body}
];
`;
  fs.writeFileSync(OUT, ts);
  console.error(`wrote ${OUT} (${(ts.length / 1024).toFixed(0)} KB)`);
}
main();
